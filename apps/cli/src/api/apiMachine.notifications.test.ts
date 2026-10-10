import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import * as persistence from '@/persistence';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from './apiMachine';

describe('ApiMachine notification catalog lifecycle', () => {
  it('reopens notification channels on their row-only Account hint without advancing preferences', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'notification-row-account' })).toString('base64url')}.signature`, encryption: null };
    const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const readCursor = vi.spyOn(persistence, 'readAccountChangesCursor').mockResolvedValue(0);
    const writeCursor = vi.spyOn(persistence, 'writeAccountChangesCursor').mockResolvedValue(undefined);
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1, settingsVersion: 7,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
      notificationChannelCatalog: { status: 'ready', revision: 1, channels: [], diagnostics: [] } });
    // Only HTTP and device-local credential/cursor persistence are substituted.
    // The Machine catch-up, catalog loader, mode admission and publication stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'notification-row-account' } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/notification-channels') return { status: 200, data: { status: 'deleted', revision: 2 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v2/changes') return { status: 200, data: { changes: [{ cursor: 4, kind: 'account',
        entityId: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, changedAt: 1, hint: { notificationChannels: true, revision: 2 } }], nextCursor: 4 } };
      throw new Error(`Unexpected notification observer boundary: ${path}`);
    });
    const machine: Machine = { id: 'notification-row-machine', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient(credentials.token, machine);
    const settingsHint = vi.fn();
    client.onAccountSettingsVersionHint(settingsHint);
    try {
      await (client as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> }).syncChangesOnConnect({ reason: 'live' });
      expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toMatchObject({ status: 'ready', revision: 2, channels: [] });
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
      expect(settingsHint).not.toHaveBeenCalled();
    } finally {
      await client.shutdown(); get.mockRestore(); stored.mockRestore(); readCursor.mockRestore(); writeCursor.mockRestore();
      clearActiveAccountSettingsSnapshot();
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });
});
