import { accountSettingsParse } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  clearCredentialsMock,
  isDaemonStopIncompleteErrorMock,
  readStoredCredentialsMock,
  rmSyncMock,
  stopDaemonMock,
  stopAllDaemonsBestEffortMock,
  updateSettingsMock,
} = vi.hoisted(() => ({
  clearCredentialsMock: vi.fn(async () => undefined),
  isDaemonStopIncompleteErrorMock: vi.fn((error: unknown) => (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'daemon_stop_incomplete'
  )),
  readStoredCredentialsMock: vi.fn(async () => ({
    token: 'plain-token',
    encryption: null as null,
  })),
  rmSyncMock: vi.fn(),
  stopDaemonMock: vi.fn(async () => ({ status: 'stopped' as const, method: 'graceful' as const })),
  stopAllDaemonsBestEffortMock: vi.fn(async () => undefined),
  updateSettingsMock: vi.fn(async (_mutate: unknown) => undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: () => true,
  rmSync: (...args: unknown[]) => rmSyncMock(...args),
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, resolve: (answer: string) => void) => resolve('y'),
    close: vi.fn(),
  }),
}));

vi.mock('@/persistence', () => ({
  clearCredentials: () => clearCredentialsMock(),
  readStoredCredentials: () => readStoredCredentialsMock(),
  updateSettings: (mutate: unknown) => updateSettingsMock(mutate),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerId: 'plain-server',
    happyHomeDir: '/tmp/happier-logout-token-only-test',
  },
}));

vi.mock('@/daemon/controlClient', () => ({
  isDaemonStopIncompleteError: (error: unknown) => isDaemonStopIncompleteErrorMock(error),
  stopDaemon: () => stopDaemonMock(),
}));

vi.mock('@/daemon/multiDaemon', () => ({
  stopAllDaemonsBestEffort: () => stopAllDaemonsBestEffortMock(),
}));

vi.mock('./clearServerScopedAuthState', () => ({
  clearServerScopedAuthStateInSettings: (settings: unknown) => settings,
}));

import { handleAuthLogout } from './logout';
import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

describe('happier auth logout token-only authentication', () => {
  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    isDaemonStopIncompleteErrorMock.mockClear();
    stopDaemonMock.mockReset();
    stopDaemonMock.mockResolvedValue({ status: 'stopped', method: 'graceful' });
    stopAllDaemonsBestEffortMock.mockReset();
    stopAllDaemonsBestEffortMock.mockResolvedValue(undefined);
    rmSyncMock.mockReset();
  });

  it('clears a token-only credential instead of reporting logged out', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleAuthLogout([]);

      expect(readStoredCredentialsMock).toHaveBeenCalledTimes(1);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
      expect(updateSettingsMock).toHaveBeenCalledTimes(1);
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
});
