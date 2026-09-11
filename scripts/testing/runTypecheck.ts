import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runYarnCommand } from './lib/runYarnCommand.ts';

export const ROOT_TYPECHECK_COMMANDS = [
  { id: 'build-packages', args: ['-s', 'build:packages'] },
  { id: 'prepare-workspaces', args: ['-s', 'prepare:typecheck:workspaces'] },
  {
    id: 'public-sdk',
    args: [
      'turbo',
      'run',
      'typecheck:finite',
      '--continue=always',
      '--filter=@happier-dev/plugin-sdk',
      '--filter=@happier-dev/sdk',
    ],
  },
  {
    id: 'source-workspaces',
    args: [
      'turbo',
      'run',
      'typecheck:source:finite',
      '--continue=always',
      '--filter=@happier-dev/terminal-native',
      '--filter=@happier-dev/plugin-ui',
      '--filter=@happier-dev/app',
      '--filter=@happier-dev/cli',
      '--filter=@happier-dev/server',
      '--filter=@happier-dev/tests',
    ],
  },
] as const satisfies readonly CommandSuiteEntry[];

export interface RunRootTypecheckOptions {
  rootDir?: string;
  commands?: readonly CommandSuiteEntry[];
  runCommand?: (command: CommandSuiteEntry) => Promise<void>;
}

export async function runRootTypecheck(
  options: RunRootTypecheckOptions = {},
): Promise<readonly CommandSuiteEntry[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const commands = options.commands ?? ROOT_TYPECHECK_COMMANDS;
  return runCommandSuite({
    commands,
    maxConcurrent: 1,
    suiteName: 'Root typecheck suite',
    runCommand: options.runCommand ?? ((command) => runYarnCommand(command, rootDir)),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRootTypecheck().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
