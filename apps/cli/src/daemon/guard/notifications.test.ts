import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  commitActiveNotificationChannelCatalog, getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { PinnedHttpStreamRequest, PinnedHttpStreamResponse } from '@/network/pinnedHttp';
import type { TerminalGuardResource } from '@/terminal/pty/sessions';
import { createGuardNotifications } from './notifications';

// Only OS DNS and the outbound socket are replaced; daemon admission, Account
// publication, catalog/material acquisition, policy and payload remain real.
const network = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<readonly { address: string; family: number }[]>>(),
  open: vi.fn<(request: PinnedHttpStreamRequest) => Promise<PinnedHttpStreamResponse>>(),
}));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('@/network/pinnedHttp', () => ({ openPinnedHttpStream: network.open }));

const credentials = { token: 'guard-notification-account', encryption: null };
const target = { serverId: 'home', machineId: 'guard-machine', installationId: 'guard-installation' };
const channel = NotificationChannelRecordV1Schema.parse({ v: 1, id: 'guard-hook', kind: 'webhook', enabled: true,
  url: 'https://hooks.example.test/guard', signingSecretRef: null, topics: { machines: true } });

function publishAccount() {
  setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
    settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [channel] },
    savedSecretCatalogState: 'ready', savedSecretResources: [],
  });
}

function fixture() {
  const home = new AbortController();
  const terminalWork = new AbortController();
  const notifications = createGuardNotifications({ credentials, requesterAccountId: 'alice',
    readTarget: () => target, signal: home.signal, expoPushSender: null,
    notifySessionWarning: async () => { throw new Error('Unexpected Session terminal'); },
  });
  const terminal: TerminalGuardResource = { terminalId: randomUUID(), terminalKey: 'terminal',
    pid: 100, foregroundPid: 100, cwd: '/project', lastActivityAtMs: 1, ended: false,
    finiteHold: false, stopPending: false, stopUnconfirmed: false,
    custody: { ...target, kind: 'machine', requesterAccountId: 'alice', rootPath: '/project' } };
  return { home, terminalWork,
    episode: () => notifications.notifyEpisode({ episodeId: randomUUID(), freedBytes: 0, outOfSteps: true, entries: [] }),
    terminal: () => notifications.notifyWarning({ terminal: { ...terminal, terminalId: randomUUID() },
      stopAt: 120_000, idleMs: 90_000, signal: terminalWork.signal }),
  };
}

beforeEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  publishAccount();
  network.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  network.open.mockReset().mockImplementation(async () => ({ status: 204, headers: {}, contentLength: 0,
    read: async () => null, cancel: () => undefined }));
});
afterEach(() => resetActiveAccountSettingsSnapshotForTests());

describe('daemon guard notification callbacks', () => {
  it.each(['episode', 'terminal'] as const)('%s retains its Account source across publication before notification preparation resumes', async entry => {
    const f = fixture();
    const pending = f[entry]();
    const snapshot = getActiveAccountSettingsSnapshot()!;
    setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: 2,
      settings: { ...snapshot.settings, analyticsOptOut: true } });
    await expect(pending).resolves.toBeUndefined();
    expect(network.open.mock.calls).toHaveLength(1);
  });

  it.each(['episode', 'terminal'] as const)('%s refuses Account retirement before notification preparation resumes', async entry => {
    const f = fixture();
    const pending = f[entry]();
    clearActiveAccountSettingsSnapshot();
    await expect(pending).rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable' });
    expect(network.open.mock.calls).toHaveLength(0);
  });

  it.each(['episode', 'terminal'] as const)('%s retains an admitted send across an unrelated Account publication', async entry => {
    const f = fixture();
    network.lookup.mockImplementationOnce(async () => {
      const snapshot = getActiveAccountSettingsSnapshot()!;
      setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: 2,
        settings: { ...snapshot.settings, analyticsOptOut: true } });
      return [{ address: '93.184.216.34', family: 4 }];
    });
    await expect(f[entry]()).resolves.toBeUndefined();
    expect(network.open.mock.calls).toHaveLength(1);
    const request = network.open.mock.calls[0]![0];
    expect(JSON.parse(Buffer.from(request.body!).toString('utf8'))).toMatchObject({
      topic: entry === 'episode' ? 'machine_guard_activity' : 'guard_stop_warning',
    });
  });

  it.each(['episode', 'terminal'] as const)('%s uses a changed catalog on the next send', async entry => {
    const f = fixture();
    network.lookup.mockImplementationOnce(async () => {
      const snapshot = getActiveAccountSettingsSnapshot()!;
      expect(commitActiveNotificationChannelCatalog({ scopeKey: snapshot.scopeKey!,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog: { status: 'ready', revision: 2,
        diagnostics: [], channels: [{ ...channel, url: 'https://hooks.example.test/updated' }] } })).toBe(true);
      return [{ address: '93.184.216.34', family: 4 }];
    });
    await f[entry]();
    await f[entry]();
    expect(network.open.mock.calls.map(([request]) => request.url)).toEqual([
      'https://hooks.example.test/guard', 'https://hooks.example.test/updated',
    ]);
  });

  it.each(['episode', 'terminal'] as const)('%s refuses a retired Account before the socket effect', async entry => {
    const f = fixture();
    network.lookup.mockImplementationOnce(async () => {
      clearActiveAccountSettingsSnapshot();
      return [{ address: '93.184.216.34', family: 4 }];
    });
    await expect(f[entry]()).rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable', reason: 'scope-retired' });
    expect(network.open.mock.calls).toHaveLength(0);
  });

  it.each(['episode', 'terminal'] as const)('%s honors cancellation before notification preparation', async entry => {
    const f = fixture();
    f.home.abort();
    await expect(f[entry]()).rejects.toBeInstanceOf(Error);
    expect(network.open.mock.calls).toHaveLength(0);
  });

  it('honors terminal policy cancellation while notification preparation is pending', async () => {
    const f = fixture();
    const preparing = f.terminal();
    f.terminalWork.abort();
    await expect(preparing).rejects.toBeInstanceOf(Error);
    expect(network.open.mock.calls).toHaveLength(0);
  });
});
