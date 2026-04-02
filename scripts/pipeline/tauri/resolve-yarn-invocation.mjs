// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * @param {typeof execFileSync} execImpl
 * @param {string} cmd
 * @param {string[]} args
 * @returns {boolean}
 */
function canExec(execImpl, cmd, args) {
  try {
    execImpl(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ platform: NodeJS.Platform; execImpl: typeof execFileSync; nodeExecPath: string }} opts
 * @returns {string | ''}
 */
function resolveCorepackPath(opts) {
  // Prefer PATH resolution first.
  if (canExec(opts.execImpl, 'corepack', ['--version'])) return 'corepack';

  // On some runners, corepack isn't on PATH even though it's shipped next to node.
  const nodeDir = path.dirname(opts.nodeExecPath);
  const candidates =
    opts.platform === 'win32'
      ? ['corepack.cmd', 'corepack.exe', 'corepack']
      : ['corepack'];

  for (const name of candidates) {
    const abs = path.join(nodeDir, name);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch {
      // ignore
    }
  }

  return '';
}

/**
 * @param {{
 *   platform?: NodeJS.Platform;
 *   execFileSync?: typeof execFileSync;
 *   nodeExecPath?: string;
 * }} [opts]
 * @returns {{ cmd: string; prefixArgs: string[] }}
 */
export function resolveYarnInvocation(opts) {
  const platform = opts?.platform ?? process.platform;
  const execImpl = opts?.execFileSync ?? execFileSync;
  const nodeExecPath = opts?.nodeExecPath ?? process.execPath;

  if (platform === 'win32') {
    // Prefer an absolute-path yarn shim next to node.exe. This is how `corepack enable`
    // installs yarn on GitHub-hosted Windows runners, and using an absolute path avoids
    // PATH resolution issues inside Git-Bash-hosted Node processes.
    const nodeDir = path.dirname(nodeExecPath);
    const yarnCmdNearNode = path.join(nodeDir, 'yarn.cmd');
    try {
      if (fs.existsSync(yarnCmdNearNode) && fs.statSync(yarnCmdNearNode).isFile()) {
        return { cmd: yarnCmdNearNode, prefixArgs: [] };
      }
    } catch {
      // ignore
    }

    // Prefer a PATH-resolved yarn.cmd invoked through cmd.exe.
    // This avoids Corepack's internal `spawn('yarn')` checks which can fail on Windows runners.
    if (canExec(execImpl, 'cmd.exe', ['/D', '/S', '/C', 'yarn --version'])) {
      return { cmd: 'yarn.cmd', prefixArgs: [] };
    }
  }

  // If yarn is already available, prefer it (assumes workflows used Corepack to pin it).
  if (canExec(execImpl, 'yarn', ['--version'])) {
    return { cmd: 'yarn', prefixArgs: [] };
  }

  const corepackPath = resolveCorepackPath({ platform, execImpl, nodeExecPath });
  if (corepackPath) {
    return { cmd: corepackPath, prefixArgs: ['yarn'] };
  }

  throw new Error('Unable to locate Yarn (yarn/corepack). Ensure Node Corepack is available and enabled in the workflow.');
}
