import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { maybeAutoUpdateNotice } from './autoUpdateNotice';

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function withUpdateHomeDir<T>(fn: (homeDir: string) => T): T {
  return withTempDirSync('happy-cli-update-', fn);
}

describe('maybeAutoUpdateNotice', () => {
  it('prints a throttled update notice and updates notifiedAt', () => {
    withUpdateHomeDir((homeDir) => {
      const output = captureConsoleText();
      try {
        const cacheDir = join(homeDir, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const cachePath = join(cacheDir, 'update.json');
        writeJson(cachePath, {
          checkedAt: 1,
          latest: '9.9.9',
          current: '1.0.0',
          runtimeVersion: null,
          invokerVersion: '1.0.0',
          updateAvailable: true,
          notifiedAt: null,
        });

        const spawnDetached = vi.fn();

        maybeAutoUpdateNotice({
          argv: ['start'],
          isTTY: true,
          homeDir,
          cliRootDir: '/repo/apps/cli',
          env: {},
          publicReleaseRing: 'stable',
          nowMs: 100_000,
          spawnDetached,
          notifyIntervalMs: 1000,
          checkIntervalMs: 1000,
        });

        expect(output.text()).toContain('update available');
        expect(spawnDetached).toHaveBeenCalled();

        const updated = JSON.parse(readFileSync(cachePath, 'utf8'));
        expect(updated.notifiedAt).toBe(100_000);
      } finally {
        output.restore();
      }
    });
  });

  it('does nothing when update checks are disabled', () => {
    const output = captureConsoleText();
    const spawnDetached = vi.fn();
    try {
      maybeAutoUpdateNotice({
        argv: ['start'],
        isTTY: true,
        homeDir: '/tmp/nowhere',
        cliRootDir: '/repo/apps/cli',
        env: { HAPPIER_CLI_UPDATE_CHECK: '0' },
        publicReleaseRing: 'stable',
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1000,
      });

      expect(output.lines).toHaveLength(0);
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });


  it('prefers the installed package-dist entrypoint for background update checks', () => {
    withUpdateHomeDir((homeDir) => {
      const output = captureConsoleText();
      try {
        const cliRootDir = join(homeDir, 'cli', 'current');
        mkdirSync(join(cliRootDir, 'package-dist'), { recursive: true });
        writeFileSync(join(cliRootDir, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
        const cacheDir = join(homeDir, 'cache');
        mkdirSync(cacheDir, { recursive: true });

        const spawnDetached = vi.fn();

        maybeAutoUpdateNotice({
          argv: ['start'],
          isTTY: true,
          homeDir,
          cliRootDir,
          env: {},
          publicReleaseRing: 'stable',
          nowMs: 100_000,
          spawnDetached,
          notifyIntervalMs: 1000,
          checkIntervalMs: 0,
        });

        expect(spawnDetached).toHaveBeenCalledWith({
          script: join(cliRootDir, 'package-dist', 'index.mjs'),
          args: ['self', 'check', '--quiet'],
          cwd: cliRootDir,
          env: expect.objectContaining({ HAPPIER_CLI_UPDATE_CHECK_SPAWNED: '1' }),
        });
        expect(output.lines).toHaveLength(0);
      } finally {
        output.restore();
      }
    });
  });
  it('does not crash when spawnDetached throws', () => {
    withUpdateHomeDir((homeDir) => {
      const output = captureConsoleText();
      try {
        expect(() =>
          maybeAutoUpdateNotice({
            argv: ['start'],
            isTTY: true,
            homeDir,
            cliRootDir: '/repo/apps/cli',
            env: {},
            publicReleaseRing: 'stable',
            nowMs: 100_000,
            spawnDetached: () => {
              throw new Error('boom');
            },
            notifyIntervalMs: 1000,
            checkIntervalMs: 0,
          }),
        ).not.toThrow();
      } finally {
        output.restore();
      }
    });
  });

  it('does not spawn background checks for --version invocations', () => {
    const output = captureConsoleText();
    const spawnDetached = vi.fn();

    try {
      withUpdateHomeDir((homeDir) => {
        maybeAutoUpdateNotice({
          argv: ['--version'],
          isTTY: true,
          homeDir,
          cliRootDir: '/repo/apps/cli',
          env: {},
          publicReleaseRing: 'stable',
          nowMs: 100_000,
          spawnDetached,
          notifyIntervalMs: 1000,
          checkIntervalMs: 1000,
        });
      });

      expect(output.lines).toHaveLength(0);
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('does not print an update notice for self commands when argv includes flag values', () => {
    withUpdateHomeDir((homeDir) => {
      const output = captureConsoleText();
      try {
        const cacheDir = join(homeDir, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const cachePath = join(cacheDir, 'update.json');
        writeJson(cachePath, {
          checkedAt: 99_000,
          latest: '9.9.9',
          current: '1.0.0',
          runtimeVersion: null,
          invokerVersion: '1.0.0',
          updateAvailable: true,
          notifiedAt: null,
        });

        const spawnDetached = vi.fn();

        maybeAutoUpdateNotice({
          argv: ['--config', '/path/to/config', 'self', 'check'],
          isTTY: true,
          homeDir,
          cliRootDir: '/repo/apps/cli',
          env: {},
          publicReleaseRing: 'stable',
          nowMs: 100_000,
          spawnDetached,
          notifyIntervalMs: 1000,
          checkIntervalMs: 1_000_000,
        });

        expect(output.lines).toHaveLength(0);
        expect(spawnDetached).not.toHaveBeenCalled();
      } finally {
        output.restore();
      }
    });
  });

  it('does not print an update notice for self commands when argv includes short-flag values', () => {
    withUpdateHomeDir((homeDir) => {
      const output = captureConsoleText();
      try {
        const cacheDir = join(homeDir, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const cachePath = join(cacheDir, 'update.json');
        writeJson(cachePath, {
          checkedAt: 99_000,
          latest: '9.9.9',
          current: '1.0.0',
          runtimeVersion: null,
          invokerVersion: '1.0.0',
          updateAvailable: true,
          notifiedAt: null,
        });

        const spawnDetached = vi.fn();

        maybeAutoUpdateNotice({
          argv: ['-c', '/path/to/config', 'self', 'check'],
          isTTY: true,
          homeDir,
          cliRootDir: '/repo/apps/cli',
          env: {},
          publicReleaseRing: 'stable',
          nowMs: 100_000,
          spawnDetached,
          notifyIntervalMs: 1000,
          checkIntervalMs: 1_000_000,
        });

        expect(output.lines).toHaveLength(0);
        expect(spawnDetached).not.toHaveBeenCalled();
      } finally {
        output.restore();
      }
    });
  });

  it('does not print an update notice for self commands with leading boolean long flags', () => {
    withUpdateHomeDir((homeDir) => {
      const output = captureConsoleText();
      try {
        const cacheDir = join(homeDir, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const cachePath = join(cacheDir, 'update.json');
        writeJson(cachePath, {
          checkedAt: 99_000,
          latest: '9.9.9',
          current: '1.0.0',
          runtimeVersion: null,
          invokerVersion: '1.0.0',
          updateAvailable: true,
          notifiedAt: null,
        });

        const spawnDetached = vi.fn();

        maybeAutoUpdateNotice({
          argv: ['--force', 'self', 'check'],
          isTTY: true,
          homeDir,
          cliRootDir: '/repo/apps/cli',
          env: {},
          publicReleaseRing: 'stable',
          nowMs: 100_000,
          spawnDetached,
          notifyIntervalMs: 1000,
          checkIntervalMs: 1_000_000,
        });

        expect(output.lines).toHaveLength(0);
        expect(spawnDetached).not.toHaveBeenCalled();
      } finally {
        output.restore();
      }
    });
  });

  it('does not spawn multiple concurrent background checks', () => {
    withUpdateHomeDir((homeDir) => {
      const cacheDir = join(homeDir, 'cache');
      mkdirSync(cacheDir, { recursive: true });
      const cachePath = join(cacheDir, 'update.json');
      writeJson(cachePath, {
        checkedAt: 1,
        latest: null,
        current: null,
        runtimeVersion: null,
        invokerVersion: null,
        updateAvailable: false,
        notifiedAt: null,
      });

      const spawnDetached = vi.fn();

      maybeAutoUpdateNotice({
        argv: ['start'],
        isTTY: true,
        homeDir,
        cliRootDir: '/repo/apps/cli',
        env: { HAPPIER_CLI_UPDATE_CHECK_LOCK_TTL_MS: '60000' },
        publicReleaseRing: 'stable',
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1000,
      });
      maybeAutoUpdateNotice({
        argv: ['start'],
        isTTY: true,
        homeDir,
        cliRootDir: '/repo/apps/cli',
        env: { HAPPIER_CLI_UPDATE_CHECK_LOCK_TTL_MS: '60000' },
        publicReleaseRing: 'stable',
        nowMs: 100_001,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1000,
      });

      expect(spawnDetached).toHaveBeenCalledTimes(1);
    });
  });

  it('scopes update cache + background checks by public release ring (dev lane)', () => {
    withUpdateHomeDir((homeDir) => {
      const output = captureConsoleText();
      try {
        const cacheDir = join(homeDir, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const cachePath = join(cacheDir, 'update.dev.json');
        writeJson(cachePath, {
          checkedAt: 1,
          latest: '9.9.9-dev.1',
          current: '1.0.0-dev.0',
          runtimeVersion: null,
          invokerVersion: '1.0.0-dev.0',
          updateAvailable: true,
          notifiedAt: null,
        });

        const spawnDetached = vi.fn();

        maybeAutoUpdateNotice({
          argv: ['start'],
          isTTY: true,
          homeDir,
          cliRootDir: '/repo/apps/cli',
          env: {},
          publicReleaseRing: 'publicdev',
          nowMs: 100_000,
          spawnDetached,
          notifyIntervalMs: 1000,
          checkIntervalMs: 0,
        });

        expect(output.text()).toContain('update available');
        expect(spawnDetached).toHaveBeenCalledWith(expect.objectContaining({
          args: expect.arrayContaining(['self', 'check', '--quiet', '--dev']),
        }));
      } finally {
        output.restore();
      }
    });
  });
});
