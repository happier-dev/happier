import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { resolveJunctionFreeCurrentPath } from './resolveJunctionFreeCurrentPath.js';

describe('resolveJunctionFreeCurrentPath', () => {
  it('uses current.version to bypass the current pointer', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-junction-free-current-'));
    const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'publicdev',
      processEnv: env,
    });

    try {
      await mkdir(layout.installRoot, { recursive: true });
      await writeFile(join(layout.installRoot, 'current.version'), '0.2.5-dev.102.1\n', 'utf8');

      expect(resolveJunctionFreeCurrentPath(layout)).toBe(
        join(layout.versionsDir, '0.2.5-dev.102.1'),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('falls back to currentPath when current.version is absent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-junction-free-current-missing-'));
    const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'publicdev',
      processEnv: env,
    });

    try {
      expect(resolveJunctionFreeCurrentPath(layout)).toBe(layout.currentPath);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not treat path-shaped marker contents as a version id', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-junction-free-current-unsafe-'));
    const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'publicdev',
      processEnv: env,
    });

    try {
      await mkdir(layout.installRoot, { recursive: true });
      await writeFile(join(layout.installRoot, 'current.version'), '..\\outside\n', 'utf8');

      expect(resolveJunctionFreeCurrentPath(layout)).toBe(layout.currentPath);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
