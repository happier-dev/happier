import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import * as persistence from '@/persistence';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { dispatchActiveAccountMachineVitalsAlertNotificationAsync } from './activeAccountNotification';

afterEach(() => { vi.restoreAllMocks(); clearActiveAccountSettingsSnapshot(); });

it.each(['current', 'retired'] as const)('hydrates the daemon usage-alert catalog on demand and preserves Account retirement (%s)', async lifetime => {
  const home = 'https://vitals-notification.test';
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'vitals-owner' })).toString('base64url')}.signature`, encryption: null };
  const channel = NotificationChannelRecordV1Schema.parse({ v: 1, id: 'vitals-push', kind: 'expo_push', topics: { machines: true } });
  let channelReads = 0;
  const deliveries: unknown[][] = [];
  // Credential storage, Home HTTP and push are system boundaries. Catalog
  // hydration, Account currentness, dispatch and the actual notifier stay real.
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe(home);
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.pathname === '/v1/account/entity-rows/notification-channels') {
      channelReads++;
      if (lifetime === 'retired') clearActiveAccountSettingsSnapshot();
      return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, channels: [channel] } } } };
    }
    if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
    if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (url.pathname === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
    const empty = emptyAccountSettingsHistoryCaptureResponse(url.pathname);
    if (empty) return empty;
    throw new Error(`Unexpected notification HTTP boundary: ${url.pathname}`);
  });
  await runWithServerHttpBaseUrl(home, async () => {
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const input = { credentials, machineId: 'vitals-machine', guardEnabled: false, latest: null,
      transition: { episode: { kind: 'alert' as const, rule: 'cpu' as const, state: 'fired' as const, at: 60_000 },
        since: 0, evidence: { abovePct: 80, sustainMs: 60_000, busyPct: 90 } },
      pluginNotifications: null,
      expoPushSender: { sendToAllDevicesAsync: async (...args: unknown[]) => { deliveries.push(args); return true; } } };
    if (lifetime === 'retired') {
      await expect(dispatchActiveAccountMachineVitalsAlertNotificationAsync(input)).rejects.toMatchObject({
        code: 'notification_channel_catalog_unavailable', reason: 'scope-retired' });
      expect(deliveries).toEqual([]);
    } else {
      await expect(dispatchActiveAccountMachineVitalsAlertNotificationAsync(input)).resolves.toMatchObject({ deliveredChannels: 1 });
      expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog?.status).toBe('ready');
      expect(deliveries[0]?.[2]).toMatchObject({ machineVitals: { topic: 'resource_limit', phase: 'started', machineId: 'vitals-machine' } });
      const reads = channelReads;
      await dispatchActiveAccountMachineVitalsAlertNotificationAsync({ ...input,
        transition: { ...input.transition, episode: { ...input.transition.episode, state: 'recovered', at: 120_000 } } });
      expect(channelReads).toBe(reads);
      expect(deliveries).toHaveLength(2);
    }
  });
});
