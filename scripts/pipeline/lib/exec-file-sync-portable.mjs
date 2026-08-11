// @ts-check

import * as childProcess from 'node:child_process';

import { buildWindowsCmdShimInvocation } from '../../workspaces/execYarnCommand.mjs';

/**
 * `execFileSync` wrapper that works on Windows when the resolved command is a `.cmd`/`.bat`.
 *
 * GitHub Actions Node toolcache often resolves Corepack or Yarn to a `.cmd` shim, which cannot be
 * spawned directly (CreateProcess). Invoke that shim through an explicitly encoded `cmd.exe`
 * command so paths and secrets remain distinct arguments.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {childProcess.ExecFileSyncOptionsWithStringEncoding | childProcess.ExecFileSyncOptionsWithBufferEncoding | childProcess.ExecFileSyncOptions} options
 * @param {{ execFileSync?: typeof childProcess.execFileSync }} [impl]
 */
export function execFileSyncPortable(cmd, args, options, impl) {
  const execImpl = impl?.execFileSync ?? childProcess.execFileSync;
  const needsShell = /\.(cmd|bat)$/i.test(cmd);

  if (needsShell && !(options && 'shell' in options)) {
    const invocation = buildWindowsCmdShimInvocation(cmd, args);
    return execImpl(invocation.command, invocation.args, {
      ...options,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  }

  return execImpl(cmd, args, {
    ...options,
    shell: options && 'shell' in options ? options.shell : needsShell,
  });
}
