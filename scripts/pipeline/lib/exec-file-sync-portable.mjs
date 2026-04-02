// @ts-check

import * as childProcess from 'node:child_process';

/**
 * `execFileSync` wrapper that works on Windows when the resolved command is a `.cmd`/`.bat`.
 *
 * GitHub Actions Node toolcache often resolves Corepack to `corepack.cmd`, which cannot be spawned
 * directly (CreateProcess) without a shell.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {childProcess.ExecFileSyncOptionsWithStringEncoding | childProcess.ExecFileSyncOptionsWithBufferEncoding | childProcess.ExecFileSyncOptions} options
 * @param {{ execFileSync?: typeof childProcess.execFileSync }} [impl]
 */
export function execFileSyncPortable(cmd, args, options, impl) {
  const execImpl = impl?.execFileSync ?? childProcess.execFileSync;
  const needsShell = /\.(cmd|bat)$/i.test(cmd);

  return execImpl(cmd, args, {
    ...options,
    shell: options && 'shell' in options ? options.shell : needsShell,
  });
}

