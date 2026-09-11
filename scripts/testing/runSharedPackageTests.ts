import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runYarnCommand } from './lib/runYarnCommand.ts';
import {
  selectSharedPackageTestCommands,
  type SharedPackageTestMode,
} from './lib/sharedPackageTestCommands.ts';

export { selectSharedPackageTestCommands, SHARED_PACKAGE_TEST_COMMANDS } from './lib/sharedPackageTestCommands.ts';

export interface RunSharedPackageTestsOptions {
  rootDir?: string;
  commands?: readonly CommandSuiteEntry[];
  mode?: SharedPackageTestMode;
  maxConcurrent?: number;
  runCommand?: (command: CommandSuiteEntry) => Promise<void>;
}

export async function runSharedPackageTests(
  options: RunSharedPackageTestsOptions = {},
): Promise<readonly CommandSuiteEntry[]> {
  const rootDir = options.rootDir ?? process.cwd();
  return runCommandSuite({
    commands: options.commands ?? selectSharedPackageTestCommands(options.mode ?? 'local'),
    maxConcurrent: options.maxConcurrent,
    suiteName: 'Shared package test suite',
    runCommand: options.runCommand ?? ((command) => runYarnCommand(command, rootDir)),
  });
}

export function parseSharedPackageTestMode(args: readonly string[]): SharedPackageTestMode {
  if (args.length === 0) return 'local';
  if (args.length === 2 && args[0] === '--mode' && (args[1] === 'local' || args[1] === 'ci')) {
    return args[1];
  }
  throw new Error('Usage: runSharedPackageTests.ts [--mode local|ci]');
}

async function main(): Promise<void> {
  await runSharedPackageTests({ mode: parseSharedPackageTestMode(process.argv.slice(2)) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
