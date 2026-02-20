import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeAutoUpdateNotice } from './autoUpdateNotice';

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('maybeAutoUpdateNotice', () => {
  it('prints a throttled update notice and updates notifiedAt', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-update-'));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1000,
      });

      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('update available'));
      expect(spawnDetached).toHaveBeenCalled();

      const updated = JSON.parse(readFileSync(cachePath, 'utf8'));
      expect(updated.notifiedAt).toBe(100_000);
    } finally {
      stderr.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does nothing when update checks are disabled', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spawnDetached = vi.fn();
    try {
      maybeAutoUpdateNotice({
        argv: ['start'],
        isTTY: true,
        homeDir: '/tmp/nowhere',
        cliRootDir: '/repo/apps/cli',
        env: { HAPPIER_CLI_UPDATE_CHECK: '0' },
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1000,
      });

      expect(stderr).not.toHaveBeenCalled();
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('does not crash when spawnDetached throws', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-update-'));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        maybeAutoUpdateNotice({
          argv: ['start'],
          isTTY: true,
          homeDir,
          cliRootDir: '/repo/apps/cli',
          env: {},
          nowMs: 100_000,
          spawnDetached: () => {
            throw new Error('boom');
          },
          notifyIntervalMs: 1000,
          checkIntervalMs: 0,
        }),
      ).not.toThrow();
    } finally {
      stderr.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not spawn background checks for --version invocations', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spawnDetached = vi.fn();

    const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-update-'));
    try {
      maybeAutoUpdateNotice({
        argv: ['--version'],
        isTTY: true,
        homeDir,
        cliRootDir: '/repo/apps/cli',
        env: {},
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1000,
      });

      expect(stderr).not.toHaveBeenCalled();
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not print an update notice for self commands when argv includes flag values', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-update-'));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1_000_000,
      });

      expect(stderr).not.toHaveBeenCalled();
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not print an update notice for self commands when argv includes short-flag values', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-update-'));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1_000_000,
      });

      expect(stderr).not.toHaveBeenCalled();
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not print an update notice for self commands with leading boolean long flags', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-update-'));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        nowMs: 100_000,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1_000_000,
      });

      expect(stderr).not.toHaveBeenCalled();
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not spawn multiple concurrent background checks', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-update-'));
    try {
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
        nowMs: 100_001,
        spawnDetached,
        notifyIntervalMs: 1000,
        checkIntervalMs: 1000,
      });

      expect(spawnDetached).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
