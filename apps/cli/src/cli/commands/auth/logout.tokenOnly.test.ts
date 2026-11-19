import { accountSettingsParse } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const settingsFixture = vi.hoisted(() => ({ homeDir: '', confirm: 'y' }));

const {
  clearCredentialsMock,
  isDaemonStopIncompleteErrorMock,
  readStoredCredentialsMock,
  rmSyncMock,
  stopDaemonMock,
  stopAllDaemonsBestEffortMock,
} = vi.hoisted(() => ({
  clearCredentialsMock: vi.fn(async () => undefined),
  isDaemonStopIncompleteErrorMock: vi.fn((error: unknown) => (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'daemon_stop_incomplete'
  )),
  readStoredCredentialsMock: vi.fn<() => Promise<StoredCredentials | null>>(async () => ({
    token: 'plain-token',
    encryption: null as null,
  })),
  rmSyncMock: vi.fn(),
  stopDaemonMock: vi.fn(async () => ({ status: 'stopped' as const, method: 'graceful' as const })),
  stopAllDaemonsBestEffortMock: vi.fn(async () => undefined),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => true,
  rmSync: (...args: unknown[]) => rmSyncMock(...args),
}));

// The terminal is a system boundary: a readline interface that answers "y" to the confirmation.
vi.mock('node:readline', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    createInterface: () => Object.assign(new EventEmitter(), {
      question: (_prompt: string, resolve: (answer: string) => void) => resolve(settingsFixture.confirm),
      close: vi.fn(),
    }),
  };
});

vi.mock('@/persistence', async importOriginal => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  clearCredentials: () => clearCredentialsMock(),
  readStoredCredentials: () => readStoredCredentialsMock(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerId: 'plain-server',
    get happyHomeDir() { return settingsFixture.homeDir; },
    get settingsFile() { return join(settingsFixture.homeDir, 'settings.json'); },
    get privateKeyFile() { return join(settingsFixture.homeDir, 'access.key'); },
  },
}));

vi.mock('@/daemon/controlClient', () => ({
  isDaemonStopIncompleteError: (error: unknown) => isDaemonStopIncompleteErrorMock(error),
  stopDaemon: () => stopDaemonMock(),
}));

vi.mock('@/daemon/multiDaemon', () => ({
  stopAllDaemonsBestEffort: () => stopAllDaemonsBestEffortMock(),
}));

import { handleAuthLogout } from './logout';
import { readAccountChangesCursors, readSettings, type StoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

describe('happier auth logout token-only authentication', () => {
  beforeEach(async () => {
    settingsFixture.homeDir = await createTempDir('happier-plain-logout-');
    await writeFile(join(settingsFixture.homeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 6, onboardingCompleted: true, machineIdByServerId: { 'plain-server': 'machine' },
      lastChangesCursorByServerIdByAccountId: { 'plain-server': { account: 7 }, other: { account: 9 } },
    }));
  });

  afterEach(async () => {
    await removeTempDir(settingsFixture.homeDir);
    resetActiveAccountSettingsSnapshotForTests();
    isDaemonStopIncompleteErrorMock.mockClear();
    stopDaemonMock.mockReset();
    stopDaemonMock.mockResolvedValue({ status: 'stopped', method: 'graceful' });
    stopAllDaemonsBestEffortMock.mockReset();
    stopAllDaemonsBestEffortMock.mockResolvedValue(undefined);
    rmSyncMock.mockReset();
  });

  it('clears an obsolete stored credential only after confirmation', async () => {
    const persistence = await vi.importActual<typeof import('@/persistence')>('@/persistence');
    const env = createEnvKeyScope(['HAPPIER_TOKEN', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE']);
    env.patch({ HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const keyPath = join(settingsFixture.homeDir, 'access.key');
    const payload = Buffer.from(JSON.stringify({ sub: 'obsolete-account', extras: {} })).toString('base64url');
    const obsoleteKey = JSON.stringify({ token: `hdr.${payload}.sig` });
    readStoredCredentialsMock
      .mockImplementationOnce(persistence.readStoredCredentials)
      .mockImplementationOnce(persistence.readStoredCredentials);
    clearCredentialsMock.mockImplementationOnce(persistence.clearCredentials);
    try {
      await writeFile(keyPath, obsoleteKey);
      settingsFixture.confirm = 'n';
      await handleAuthLogout([]);
      await expect(readFile(keyPath, 'utf8')).resolves.toBe(obsoleteKey);

      settingsFixture.confirm = 'y';
      await handleAuthLogout([]);
      await expect(readFile(keyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      settingsFixture.confirm = 'y';
      readStoredCredentialsMock.mockReset().mockResolvedValue({ token: 'plain-token', encryption: null });
      clearCredentialsMock.mockReset().mockResolvedValue(undefined);
      log.mockRestore();
      env.restore();
    }
  });

  it('clears a token-only credential instead of reporting logged out', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleAuthLogout([]);

      expect(readStoredCredentialsMock).toHaveBeenCalledTimes(1);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
      expect((await readSettings()).machineIdByServerId?.['plain-server']).toBeUndefined();
      expect(await readAccountChangesCursors()).toEqual({ other: { account: 9 } });
      expect(rmSyncMock).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('Not currently authenticated');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('invalidates Account Settings custody and reports incomplete logout when daemon stop cannot be confirmed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'account:a',
    });
    stopDaemonMock.mockRejectedValueOnce(Object.assign(new Error('daemon stop failed'), {
      code: 'daemon_stop_incomplete',
      reason: 'force_kill_unconfirmed',
      pid: 12345,
    }));

    try {
      await expect(handleAuthLogout([])).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'force_kill_unconfirmed',
        pid: 12345,
      });

      expect(getActiveAccountSettingsSnapshot()).toBeNull();
      expect(clearCredentialsMock).toHaveBeenCalled();
      expect(isDaemonStopIncompleteErrorMock).toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('Successfully logged out');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not remove the local home or report success when logout --all cannot stop every daemon', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const incomplete = Object.assign(new Error('daemon stop incomplete'), {
      code: 'daemon_stop_incomplete',
      reason: 'graceful_stop_unconfirmed',
      pid: 54321,
    });
    stopAllDaemonsBestEffortMock.mockRejectedValueOnce(incomplete);

    try {
      await expect(handleAuthLogout(['--all'])).rejects.toBe(incomplete);

      expect(stopAllDaemonsBestEffortMock).toHaveBeenCalledTimes(1);
      expect(rmSyncMock).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('Successfully logged out');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('removes the complete local home only after explicit logout --all stops every daemon', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleAuthLogout(['--all']);

      expect(stopAllDaemonsBestEffortMock).toHaveBeenCalledTimes(1);
      expect(rmSyncMock).toHaveBeenCalledExactlyOnceWith(
        settingsFixture.homeDir,
        { recursive: true, force: true },
      );
      expect(
        stopAllDaemonsBestEffortMock.mock.invocationCallOrder[0]!,
      ).toBeLessThan(rmSyncMock.mock.invocationCallOrder[0]!);
    } finally {
      logSpy.mockRestore();
    }
  });
});
