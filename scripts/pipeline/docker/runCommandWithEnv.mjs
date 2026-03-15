// @ts-check

import { execFileSync as nodeExecFileSync } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

/**
 * @param {{
 *   cmd: string;
 *   args: string[];
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: 'inherit' | 'pipe';
 *   execFileSync?: typeof nodeExecFileSync;
 * }} input
 */
export function runCommandWithEnv(input) {
  const cmd = String(input?.cmd ?? '').trim();
  const args = Array.isArray(input?.args) ? input.args.map((arg) => String(arg)) : [];
  const env = input?.env ?? process.env;
  const stdio = input?.stdio ?? 'inherit';
  const execFileSync = input?.execFileSync ?? nodeExecFileSync;

  const invocation = resolveWindowsCommandInvocation({
    command: cmd,
    args,
    env,
  });

  execFileSync(invocation.command, invocation.args, {
    env,
    stdio,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}
