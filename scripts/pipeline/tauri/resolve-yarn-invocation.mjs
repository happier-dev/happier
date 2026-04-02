// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {boolean}
 */
function canExec(cmd, args) {
  try {
    execFileSync(cmd, args, {
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
 * @returns {string | ''}
 */
function resolveCorepackPath() {
  // Prefer PATH resolution first.
  if (canExec('corepack', ['--version'])) return 'corepack';

  // On some runners, corepack isn't on PATH even though it's shipped next to node.
  const nodeDir = path.dirname(process.execPath);
  const candidates =
    process.platform === 'win32'
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
 * @returns {{ cmd: string; prefixArgs: string[] }}
 */
export function resolveYarnInvocation() {
  // If yarn is already available, prefer it (assumes workflows used Corepack to pin it).
  if (canExec('yarn', ['--version'])) {
    return { cmd: 'yarn', prefixArgs: [] };
  }

  const corepackPath = resolveCorepackPath();
  if (corepackPath) {
    return { cmd: corepackPath, prefixArgs: ['yarn'] };
  }

  throw new Error('Unable to locate Yarn (yarn/corepack). Ensure Node Corepack is available and enabled in the workflow.');
}

