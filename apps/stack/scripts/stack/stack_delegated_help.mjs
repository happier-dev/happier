import { join } from 'node:path';

import { run } from '../utils/proc/proc.mjs';
import { printResult } from '../utils/cli/cli.mjs';
import { resolveTopLevelNodeScriptFile } from './command_arguments.mjs';
import { getStackHelpUsageLine } from './help_text.mjs';
import { withStackEnv } from './stack_environment.mjs';
import { stackExistsSync } from '../utils/stack/stacks.mjs';

const DELEGATED_STACK_COMMANDS = new Set(['dev', 'start', 'build', 'typecheck', 'lint', 'test', 'review', 'doctor', 'mobile', 'mobile-dev-client']);

function resolveStackOnlyFlags(command) {
  if (command === 'build' || command === 'typecheck' || command === 'lint' || command === 'test' || command === 'review') {
    return ['--repo=default|main|active|dev|<owner/...>|<path>', '--repo-dir=<path>'];
  }
  if (command === 'dev' || command === 'start') {
    return ['--background', '--bg'];
  }
  return [];
}

export async function printDelegatedStackHelpIfAvailable({ rootDir, command, stackName, json }) {
  const normalizedCommand = (command ?? '').toString().trim();
  if (!normalizedCommand) return false;
  if (!DELEGATED_STACK_COMMANDS.has(normalizedCommand)) return false;

  const delegatedScript = resolveTopLevelNodeScriptFile(normalizedCommand);
  if (!delegatedScript) return false;

  const usageLine = getStackHelpUsageLine(normalizedCommand);
  const stackOnlyFlags = resolveStackOnlyFlags(normalizedCommand);

  if (json) {
    printResult({
      json,
      data: {
        ok: true,
        cmd: normalizedCommand,
        stackName: stackName || null,
        usage: usageLine,
        stackFlags: stackOnlyFlags,
        delegatedHelp: delegatedScript,
      },
      text: null,
    });
    return true;
  }

  const headerLines = [
    `[stack ${normalizedCommand}] usage:`,
    ...(usageLine ? [`  ${usageLine}`] : []),
    ...(stackOnlyFlags.length
      ? [
          '',
          'stack-only flags:',
          ...stackOnlyFlags.map((flag) => `  ${flag}`),
        ]
      : []),
    '',
    `${normalizedCommand} flags (delegated):`,
    '',
  ];
  process.stdout.write(headerLines.join('\n') + '\n');

  const runDelegatedHelp = async (env) => {
    await run(process.execPath, [join(rootDir, 'scripts', delegatedScript), '--help'], { cwd: rootDir, env });
  };

  if (stackName && stackExistsSync(stackName)) {
    await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        await runDelegatedHelp(env);
      },
    });
    return true;
  }

  await runDelegatedHelp(process.env);
  return true;
}
