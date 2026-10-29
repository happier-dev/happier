import { copyFileSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import { resolveDesiredShimTargets } from './resolveDesiredShimTargets.js';

export interface SyncInstalledFirstPartyShimsResult {
  shimPaths: string[];
}

export async function syncInstalledFirstPartyShims(
  params: Parameters<typeof resolveDesiredShimTargets>[0],
): Promise<SyncInstalledFirstPartyShimsResult> {
  const targets = await resolveDesiredShimTargets(params);

  if (params.sourceLaunch) {
    for (const { shimPath, binaryPath, args = [] } of targets) {
      const quote = process.platform === 'win32'
        ? (value: string) => `"${value.replaceAll('%', '%%')}"`
        : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const invocation = [binaryPath, ...args].map(quote).join(' ');
      const script = process.platform === 'win32'
        ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${invocation} %*\r\nexit /b %errorlevel%\r\n`
        : `#!/bin/sh\nexec ${invocation} "$@"\n`;
      await mkdir(dirname(shimPath), { recursive: true });
      // A Session can invoke the stable command while its daemon reloads.
      const temporaryPath = `${shimPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, script, { mode: 0o755, flag: 'wx' });
        await rename(temporaryPath, shimPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    }
    return { shimPaths: targets.map(target => target.shimPath) };
  }

  if (process.platform === 'win32') {
    for (const { shimPath, binaryPath } of targets) {
      mkdirSync(dirname(shimPath), { recursive: true });
      rmSync(shimPath, { force: true, recursive: true });
      try {
        linkSync(binaryPath, shimPath);
      } catch {
        copyFileSync(binaryPath, shimPath);
      }
    }
    return {
      shimPaths: targets.map((target) => target.shimPath),
    };
  }

  await Promise.all(targets.map(async ({ shimPath, binaryPath }) => {
    await mkdir(dirname(shimPath), { recursive: true });
    await rm(shimPath, { force: true, recursive: true });
    await symlink(relative(dirname(shimPath), binaryPath), shimPath);
  }));

  return {
    shimPaths: targets.map((target) => target.shimPath),
  };
}
