import color from 'colorette';
import dateTime from 'date-time';
import fs from 'fs';
import ms from 'pretty-ms';
import onExit from 'signal-exit';
import * as rollup from '../../src/node-entry';
import { MergedRollupOptions, RollupWatcher } from '../../src/rollup/types';
import relativeId from '../../src/utils/relativeId';
import { handleError, stderr } from '../logging';
import { BatchWarnings } from './batchWarnings';
import { getConfigPath } from './getConfigPath';
import loadAndParseConfigFile from './loadConfigFile';
import loadConfigFromCommand from './loadConfigFromCommand';
import { getResetScreen } from './resetScreen';
import { printTimings } from './timings';

export default async function watch(command: any) {
	process.env.ROLLUP_WATCH = 'true';
	const isTTY = process.stderr.isTTY;
	const silent = command.silent;
	let configs: MergedRollupOptions[];
	let warnings: BatchWarnings;
	let watcher: RollupWatcher;
	let configWatcher: fs.FSWatcher;
	const configFile = command.config ? getConfigPath(command.config) : null;

	onExit(close);
	process.on('uncaughtException', close);
	// only listen to stdin if it is a pipe
	if (!process.stdin.isTTY) {
		process.stdin.on('end', close);
	}

	if (configFile) {
		if (configFile.startsWith('node:')) {
			({ options: configs, warnings } = await loadAndParseConfigFile(configFile, command));
		} else {
			let reloadingConfig = false;
			let aborted = false;
			let configFileData: string | null = null;

			configWatcher = fs.watch(configFile, (event: string) => {
				if (event === 'change') reloadConfigFile();
			});

			await reloadConfigFile();

			async function reloadConfigFile() {
				try {
					const newConfigFileData = fs.readFileSync(configFile!, 'utf-8');
					if (newConfigFileData === configFileData) {
						return;
					}
					if (reloadingConfig) {
						aborted = true;
						return;
					}
					if (configFileData) {
						stderr(`\nReloading updated config...`);
					}
					configFileData = newConfigFileData;
					reloadingConfig = true;
					({ options: configs, warnings } = await loadAndParseConfigFile(configFile!, command));
					reloadingConfig = false;
					if (aborted) {
						aborted = false;
						reloadConfigFile();
					} else {
						if (watcher) {
							watcher.close();
						}
						start(configs);
					}
				} catch (err) {
					configs = [];
					reloadingConfig = false;
					handleError(err, true);
				}
			}
		}
	} else {
		({ options: configs, warnings } = await loadConfigFromCommand(command));
		start(configs);
	}

	// tslint:disable-next-line:no-unnecessary-type-assertion
	const resetScreen = getResetScreen(configs!, isTTY);

	function start(configs: MergedRollupOptions[]) {
		watcher = rollup.watch(configs as any);

		watcher.on('event', (event) => {
			switch (event.code) {
				case 'ERROR':
					warnings.flush();
					handleError(event.error, true);
					break;

				case 'START':
					if (!silent) {
						resetScreen(color.underline(`rollup v${rollup.VERSION}`));
					}
					break;

				case 'BUNDLE_START':
					if (!silent) {
						let input = event.input;
						if (typeof input !== 'string') {
							input = Array.isArray(input)
								? input.join(', ')
								: Object.keys(input as Record<string, string>)
										.map((key) => (input as Record<string, string>)[key])
										.join(', ');
						}
						stderr(
							color.cyan(
								`bundles ${color.bold(input)} → ${color.bold(
									event.output.map(relativeId).join(', ')
								)}...`
							)
						);
					}
					break;

				case 'BUNDLE_END':
					warnings.flush();
					if (!silent)
						stderr(
							color.green(
								`created ${color.bold(event.output.map(relativeId).join(', '))} in ${color.bold(
									ms(event.duration)
								)}`
							)
						);
					if (event.result && event.result.getTimings) {
						printTimings(event.result.getTimings());
					}
					break;

				case 'END':
					if (!silent && isTTY) {
						stderr(`\n[${dateTime()}] waiting for changes...`);
					}
			}
		});
	}

	function close(err: Error) {
		process.removeListener('uncaughtException', close);
		// removing a non-existent listener is a no-op
		process.stdin.removeListener('end', close);

		if (watcher) watcher.close();
		if (configWatcher) configWatcher.close();

		if (err) {
			stderr(err);
			process.exit(1);
		}
	}
}
