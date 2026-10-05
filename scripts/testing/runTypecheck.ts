import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runYarnCommand } from './lib/runYarnCommand.ts';

const ROOT_TYPE_TEST_COMMAND = {
  id: 'type-tests',
  args: [
    'tsc', '--noEmit',
    '-p', 'packages/protocol/tsconfig.json',
    '-p', 'packages/plugins/triage/tsconfig.json',
  ],
} as const satisfies CommandSuiteEntry;

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
  ROOT_TYPE_TEST_COMMAND,
] as const satisfies readonly CommandSuiteEntry[];

const ROOT_COMPILER_TYPECHECK_COMMANDS: readonly CommandSuiteEntry[] = [
  ...ROOT_TYPECHECK_COMMANDS.slice(0, 2),
  ROOT_TYPE_TEST_COMMAND,
  ...[
    'packages/plugin-sdk/tsconfig.json',
    'packages/plugin-sdk/tsconfig.tests.json',
    'packages/sdk/tsconfig.tests.json',
    'packages/terminal-native/tsconfig.json',
    'packages/plugin-ui/tsconfig.json',
    'apps/ui/tsconfig.json',
    'apps/cli/tsconfig.json',
    'apps/server/tsconfig.json',
    'packages/tests/tsconfig.json',
  ].map((project) => ({ id: project, args: ['tsc', '-p', project, '--noEmit'] })),
];

export interface RunRootTypecheckOptions {
  rootDir?: string;
  commands?: readonly CommandSuiteEntry[];
  compilerOnly?: boolean;
  runCommand?: (command: CommandSuiteEntry) => Promise<void>;
}

export async function runRootTypecheck(
  options: RunRootTypecheckOptions = {},
): Promise<readonly CommandSuiteEntry[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const commands = options.commands ?? (options.compilerOnly ? ROOT_COMPILER_TYPECHECK_COMMANDS : ROOT_TYPECHECK_COMMANDS);
  return runCommandSuite({
    commands,
    maxConcurrent: 1,
    suiteName: 'Root typecheck suite',
    runCommand: options.runCommand ?? ((command) => runYarnCommand(command, rootDir)),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRootTypecheck({ compilerOnly: process.argv.includes('--compiler-only') }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
