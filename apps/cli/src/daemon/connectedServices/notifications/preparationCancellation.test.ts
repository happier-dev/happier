import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { ConnectedServiceCredentialHttpClient } from '@/api/client/connectedServiceCredentialApi';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { readSavedSecretCatalogForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { dispatchConnectedServiceCredentialHealthNotificationAsync } from './dispatchConnectedServiceCredentialHealthNotification';

describe('connected-service notification preparation cancellation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('joins the aborted profile read and never continues to notification delivery', async () => {
    const controller = new AbortController();
    const reason = new Error('profile preparation cancelled');
    let observedSignal: AbortSignal | undefined;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
      observedSignal = config?.signal as AbortSignal | undefined;
      controller.abort(reason);
      throw reason;
    });
    const api = new ConnectedServiceCredentialHttpClient({ token: 'notification-cancellation' });
    const request = {
      settings: accountSettingsParse({}), signal: controller.signal,
      listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
      source: { sessionId: 'session', serviceId: 'openai-codex' as const, profileId: 'profile', status: 'reconnect_required' as const },
    };
    await expect(dispatchConnectedServiceCredentialHealthNotificationAsync(request)).rejects.toBe(reason);
    expect(observedSignal).toBe(controller.signal);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('cancels catalog preparation through the real hydration HTTP read, then accepts a later dispatch', async () => {
    const home = 'https://notification-cancellation.example';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'notification-owner' })).toString('base64url')}.signature`, encryption: null };
    const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: home, isCurrent: async () => true });
    const controller = new AbortController();
    const reason = new Error('catalog preparation cancelled');
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
      observedSignal = config?.signal as AbortSignal | undefined;
      controller.abort(reason);
      throw reason;
    });
    const request = { settings: snapshot.settings, operationContext, pluginNotifications: null,
      event: { topic: 'notify_me' as const, message: 'notification' } };
    await expect(dispatchActivityNotificationAsync({ ...request, signal: controller.signal })).rejects.toBe(reason);
    expect(observedSignal).toBe(controller.signal);
    const send = vi.fn(async () => true);
    await expect(dispatchActivityNotificationAsync({ ...request, operationContext: undefined,
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [
        NotificationChannelRecordV1Schema.parse({ v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: {} }),
      ] }, expoPushSender: { sendToAllDevicesAsync: send }, dedupeWindowMs: 0,
    })).resolves.toMatchObject({ deliveredChannels: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('joins an admitted send and its occurrence settlement after cancellation', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let sends = 0;
    let settled = false;
    const dispatch = dispatchActivityNotificationAsync({ settings: accountSettingsParse({}), signal: controller.signal,
      pluginNotifications: null, event: { topic: 'notify_me', message: 'notification' },
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: ['one', 'two'].map(id =>
        NotificationChannelRecordV1Schema.parse({ v: 1, id, kind: 'expo_push', enabled: true, topics: {} })) },
      expoPushSender: { sendToAllDevicesAsync: async () => {
        sends += 1;
        if (sends === 1) { controller.abort(); entered(); await held; }
        return true;
      } },
    }).finally(() => { settled = true; });
    await sending;
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(dispatch).resolves.toMatchObject({ deliveredChannels: 2 });
    expect(sends).toBe(2);
  });

  it('cancels saved-secret preparation currentness before reading notification signing materials', async () => {
    const home = 'https://notification-secret-cancellation.example';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'notification-owner' })).toString('base64url')}.signature`, encryption: null };
    const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: home,
      isCurrent: async signal => { await fetchAccountEncryptionCurrentness({ token: credentials.token, serverBaseUrl: home, signal }); return true; } });
    const controller = new AbortController();
    const reason = new Error('signing material preparation cancelled');
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
      observedSignal = config?.signal as AbortSignal | undefined;
      controller.abort(reason);
      throw reason;
    });
    await expect(readSavedSecretCatalogForOperation({ expectedScopeKey: snapshot.scopeKey, operationContext,
      signal: controller.signal, refreshCatalog: true })).rejects.toBe(reason);
    expect(observedSignal).toBe(controller.signal);
  });
});
