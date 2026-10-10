import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { NotificationChannelCatalogRecordV1Schema, NotificationChannelCatalogMutationV1Schema,
  NOTIFICATION_CHANNELS_ROUTE_V1, type NotificationChannelCatalogRecordV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createNotificationConfigurationAction } from './notificationConfigurationAction';
import { accountSettingsParse, AttentionDeliveryPolicyV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import { deriveAccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { prepareLegacyNotificationChannelCatalogV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID } from '@happier-dev/protocol/account/settings/notificationChannels';
import { PushTokensRemoteAlertProjectionV2Schema } from '@happier-dev/protocol/push/pushTokenRegistration';

installDisconnectedServerSocketBoundary();
afterEach(resetRuntimeFetch);

const desktopPermission = vi.hoisted(() => ({ granted: false, requests: 0 }));
// Native notification plugin calls are the OS permission boundary.
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => desktopPermission.granted,
  requestPermission: async () => { desktopPermission.requests += 1; desktopPermission.granted = true; return 'granted'; },
  sendNotification: () => {},
}));

it('requests desktop permission only with present-human authority and reports the refreshed OS state', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => undefined });
  desktopPermission.granted = false; desktopPermission.requests = 0;
  try {
    const execute = createNotificationConfigurationAction(null);
    expect(await execute({ actionId: 'notifications.desktop.permission.request', input: {},
      context: { surface: 'agent', authority: 'account_automation' } })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(desktopPermission.requests).toBe(0);
    expect(await execute({ actionId: 'notifications.desktop.permission.request', input: {},
      context: { surface: 'ui', authority: 'present_user' } })).toEqual({ status: 'granted' });
    expect(await execute({ actionId: 'notifications.desktop.permission.read', input: {}, context: {} })).toEqual({ status: 'granted' });
  } finally { vi.unstubAllGlobals(); }
});

describe('notification configuration Action authority', () => {
  it('removes only the addressed registration on the captured Home without exposing token material in the operand or receipt', async () => {
    const deletions: string[] = [];
    const token = 'ExponentPushToken[private-registration]';
    setRuntimeFetch(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/push-tokens') return Response.json({ tokens: [
        { id: 'registration-a', token, createdAt: 1, updatedAt: 2 },
        { id: 'registration-b', token: 'ExponentPushToken[other]', createdAt: 1, updatedAt: 2 },
      ] });
      if (init?.method === 'DELETE') { deletions.push(String(url)); return Response.json({ success: true }); }
      if (parsed.pathname === '/health' || parsed.pathname === '/v1/auth/ping') return Response.json({});
      if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 0 }));
      if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (parsed.pathname === '/v2/account/settings') return Response.json({ version: 0, content: { t: 'plain', v: {} } });
      if (parsed.pathname === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json({ status: 'present', revision: 0,
        content: { t: 'plain', v: { v: 1, channels: [] } } });
      return Response.json({ error: 'unexpected' }, { status: 404 });
    });
    const home = await upsertServerProfileOnly({ serverUrl: 'https://native-push-owner.example.test', name: 'Native push owner' });
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'native-push-owner' })).toString('base64url')}.signature`,
    });
    const account = await captureLazyActionAccountContext(home.id);
    try {
      const execute = createNotificationConfigurationAction(account);
      expect(await execute({ actionId: 'notifications.push.tokens.remove', input: { tokenId: 'registration-a' }, context: {} }))
        .toEqual({ tokenId: 'registration-a', removed: true });
      expect(deletions).toEqual([`${home.serverUrl}/v1/push-tokens/${encodeURIComponent(token)}`]);
      expect(await execute({ actionId: 'notifications.push.tokens.remove', input: { tokenId: 'missing' }, context: {} }))
        .toMatchObject({ ok: false, errorCode: 'push_token_not_found' });
      expect(deletions).toHaveLength(1);
    } finally { account.dispose(); }
  });

  it('updates an existing endpoint through its catalog CAS without rewriting Settings or material', async () => {
    const accountId = 'notification-action-owner';
    let record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, id: 'workflow-hook',
      kind: 'webhook', url: 'https://original.example.test/hook', enabled: true, topics: {},
      readyIncludeMessageText: false, requestIncludeMessageText: true, signingSecretRef: null }] });
    let revision = 3;
    let sourceVersion = 7;
    const settingsWrites: unknown[] = [];
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
      if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: sourceVersion }));
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings' && init?.method === 'POST') {
        settingsWrites.push(JSON.parse(String(init.body))); sourceVersion += 1;
        return Response.json({ success: true, version: sourceVersion });
      }
      if (path === '/v2/account/settings') return Response.json({ version: sourceVersion, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
      if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
      if (path === NOTIFICATION_CHANNELS_ROUTE_V1 && init?.method === 'POST') {
        const mutation = NotificationChannelCatalogMutationV1Schema.parse(JSON.parse(String(init.body)));
        expect(mutation.expectedRevision).toBe(revision);
        expect(mutation.content?.t).toBe('plain');
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain catalog mutation');
        record = mutation.content.v; revision += 1;
        return Response.json({ status: 'updated', revision, cursor: revision });
      }
      if (path === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json({ status: 'present', revision, content: { t: 'plain', v: record } });
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    // Finite Actions support an explicitly captured inactive Home. Do not activate
    // the Home or hydrate the focused Sync singleton merely to issue this Action.
    const home = await upsertServerProfileOnly({ serverUrl: 'https://notification-action-home.example.test', name: 'Notification Action' });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
    const context = await captureLazyActionAccountContext(home.id);
    try {
      await createNotificationConfigurationAction(context)({ actionId: 'notifications.webhooks.update',
        input: { channelId: 'workflow-hook', patch: { url: 'https://updated.example.test/hook' } },
        context: { serverId: home.id, surface: 'ui' } });
      expect(record.channels[0]).toMatchObject({ id: 'workflow-hook', url: 'https://updated.example.test/hook', signingSecretRef: null });
      expect(settingsWrites).toEqual([]);
      expect(sourceVersion).toBe(7);
    } finally { context.dispose(); }
  });
});

type BuiltinMembership = 'present' | 'empty' | 'deleted' | 'absent';
async function withBuiltinCatalog<T>(membership: BuiltinMembership, run: (fixture: Readonly<{
  execute: NonNullable<ReturnType<typeof createNotificationConfigurationAction>>;
  context: Awaited<ReturnType<typeof captureLazyActionAccountContext>>;
  readRecord: () => NotificationChannelCatalogRecordV1; readRaw: () => Record<string, unknown>;
  settingsWrites: unknown[]; pairedRequests: unknown[];
}>) => Promise<T>, refuse: 'settings-conflict' | 'conflict' | null = null, sparsePolicy = false) {
  const accountId = `notification-builtin-${membership}-${refuse ?? 'admitted'}`;
  const legacy = { v: 1, pushEnabled: false, ready: false, permissionRequest: false, userActionRequest: false,
    connectedServiceAccountSwitch: false, connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: false,
    readyIncludeMessageText: false, requestIncludeMessageText: false, foregroundBehavior: 'full' };
  const source = prepareLegacyNotificationChannelCatalogV1({ accountId, raw: { notificationsSettingsV1: legacy }, settingsSecretsReadKeys: [] });
  if (source.status !== 'ready') throw new Error('Expected an unsigned predecessor builtin');
  const initialRecord = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: membership === 'present' ? source.record.channels : [] });
  let record = initialRecord;
  let authority: 'present' | 'deleted' | 'absent' = membership === 'deleted' || membership === 'absent' ? membership : 'present';
  let revision = 3;
  let version = 7;
  const originalPolicy = accountSettingsParse({ notificationsSettingsV1: legacy }).attentionDeliveryPolicyV1;
  const policy = AttentionDeliveryPolicyV1Schema.parse({ ...originalPolicy,
    events: { ...originalPolicy.events, ready: { ...originalPolicy.events.ready, previewBehavior: 'status_only' } },
    channels: { ...originalPolicy.channels, webhook: { ...originalPolicy.channels.webhook, enabled: false } },
    mutePhoneWhenComputerFocused: true,
  });
  let raw: Record<string, unknown> = { attentionDeliveryPolicyV1: sparsePolicy ? { v: 1, channels: { expo_push: { enabled: false } } } : policy, notificationsSettingsV1: legacy,
    sessionRemoteAlertsEnabled: true, futurePreference: { retained: 'opaque sibling' },
    ...(membership === 'absent' ? { notificationChannelsV1: [] } : {}),
  };
  const settingsWrites: unknown[] = [];
  const pairedRequests: unknown[] = [];
  setRuntimeFetch(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: version }));
    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
    if (path === '/v1/push-tokens') return Response.json(PushTokensRemoteAlertProjectionV2Schema.parse({
      v: 2, accountRemoteAlerts: { status: 'current', settingsVersion: version }, tokens: [],
    }));
    if (path === '/v1/artifacts') return Response.json([]);
    if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
    if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
    if (path === '/v2/account/settings' && init?.method === 'POST') {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
      settingsWrites.push(mutation);
      if (mutation.expectedVersion !== version) return Response.json({ success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: raw } });
      if (mutation.content?.t === 'encrypted') throw new Error('Plain storage cannot accept an encrypted Settings mutation');
      raw = mutation.content?.v ?? {}; version += 1;
      return Response.json({ success: true, version });
    }
    if (path === '/v2/account/settings') return Response.json({ version, content: { t: 'plain', v: raw } });
    if (path === NOTIFICATION_CHANNELS_ROUTE_V1 && init?.method === 'POST') {
      const mutation = NotificationChannelCatalogMutationV1Schema.parse(JSON.parse(String(init.body)));
      if (mutation.settingsMutation) pairedRequests.push(mutation);
      if (mutation.expectedRevision !== (authority === 'absent' ? 'absent' : revision) || refuse === 'conflict') return Response.json({ status: 'conflict', revision });
      const paired = mutation.settingsMutation;
      if (paired && (paired.expectedSettingsVersion !== version || refuse === 'settings-conflict')) return Response.json({ status: 'settings-conflict', revision });
      if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain catalog mutation');
      if (paired?.content?.t === 'encrypted') throw new Error('Expected Plain paired Settings');
      if (paired) {
        const nextRaw = paired.content?.v ?? {};
        expect(paired.remoteAlertPolicy).toEqual(deriveAccountRemoteAlertPolicyV1(nextRaw));
        raw = nextRaw; version += 1;
      }
      record = mutation.content.v; revision += 1; authority = 'present';
      return Response.json({ status: 'updated', revision, cursor: revision, ...(paired ? { settingsVersion: version } : {}) });
    }
    if (path === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json(authority === 'present'
      ? { status: 'present', revision, content: { t: 'plain', v: record } }
      : authority === 'deleted' ? { status: 'deleted', revision } : { status: 'absent' });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  const home = await upsertServerProfileOnly({ serverUrl: `https://${accountId}.example.test`, name: 'Builtin Action' });
  await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
    token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
  });
  const context = await captureLazyActionAccountContext(home.id);
  try { return await run({ execute: createNotificationConfigurationAction(context), context,
    readRecord: () => record, readRaw: () => raw, settingsWrites, pairedRequests }); }
  finally { context.dispose(); }
}

describe('builtin push configuration Action authority', () => {
  it('pairs enabled-only intent without materializing absent finite policy defaults', async () => {
    await withBuiltinCatalog('present', async fixture => {
      const before = fixture.readRaw();
      expect(await fixture.execute({ actionId: 'notifications.expoPush.update', input: { patch: { enabled: true } },
        context: { serverId: fixture.context.serverId, surface: 'ui' } })).toEqual({ channelId: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID });
      expect(fixture.readRaw()).toEqual({ ...before, attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: true } } } });
      expect(fixture.readRecord().channels[0]).toMatchObject({ enabled: true });
      expect(fixture.settingsWrites).toEqual([]);
    }, null, true);
  });
  it('pairs a sparse imported builtin edit with corresponding Account preferences without loosening global rules or raw siblings', async () => {
    await withBuiltinCatalog('present', async fixture => {
      const before = fixture.readRaw();
      const originalPolicy = accountSettingsParse(before).attentionDeliveryPolicyV1;
      const originalChannel = fixture.readRecord().channels[0];
      if (!originalChannel || originalChannel.kind !== 'expo_push') throw new Error('Expected the imported builtin');
      const result = await fixture.execute({ actionId: 'notifications.expoPush.update', input: { patch: {
        enabled: true, topics: { connectedServiceQuotaBlocked: true }, readyIncludeMessageText: true,
      } }, context: { serverId: fixture.context.serverId, surface: 'ui' } });
      expect(result).toEqual({ channelId: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID });
      expect(fixture.readRecord().channels).toEqual([{ ...originalChannel, enabled: true,
        topics: { ...originalChannel.topics, connectedServiceQuotaBlocked: true }, readyIncludeMessageText: true }]);
      const raw = fixture.readRaw();
      const policy = accountSettingsParse(raw).attentionDeliveryPolicyV1;
      expect(policy.channels.expo_push.enabled).toBe(true);
      expect(policy.channels.expo_push.previewBehavior).toBe('include_preview');
      expect(policy.channels.expo_push.events.connected_service_quota_blocked.enabled).toBe(true);
      expect(policy.events.connected_service_quota_blocked.enabled).toBe(true);
      expect(policy.channels.expo_push.events.connected_service_quota_recovered).toEqual(originalPolicy.channels.expo_push.events.connected_service_quota_recovered);
      expect(policy.events.ready).toEqual(originalPolicy.events.ready);
      expect(policy.channels.webhook).toEqual(originalPolicy.channels.webhook);
      expect(policy.privacy).toEqual(originalPolicy.privacy);
      expect(raw.futurePreference).toEqual(before.futurePreference);
      expect(raw.sessionRemoteAlertsEnabled).toBe(true);
      expect(fixture.pairedRequests).not.toHaveLength(0);
      expect(fixture.settingsWrites).toEqual([]);
      await fixture.execute({ actionId: 'notifications.expoPush.update', input: { patch: { topics: {
        ready: true, permissionRequest: true, userActionRequest: true, connectedServiceAccountSwitch: true,
        connectedServiceQuotaBlocked: true, connectedServiceQuotaRecovered: true,
      }, requestIncludeMessageText: true } }, context: { serverId: fixture.context.serverId, surface: 'ui' } });
      const allTopicsPolicy = accountSettingsParse(fixture.readRaw()).attentionDeliveryPolicyV1;
      for (const event of ['ready', 'permission_request', 'user_action_request', 'connected_service_account_switch',
        'connected_service_quota_blocked', 'connected_service_quota_recovered'] as const) {
        expect(allTopicsPolicy.events[event].enabled).toBe(true);
        expect(allTopicsPolicy.channels.expo_push.events[event].enabled).toBe(true);
      }
      expect(allTopicsPolicy.events.ready.previewBehavior).toBe('status_only');
      expect(allTopicsPolicy.channels.expo_push.events.permission_request.previewBehavior).toBe('include_preview');
      expect(allTopicsPolicy.channels.expo_push.events.user_action_request.previewBehavior).toBe('include_preview');
      expect(allTopicsPolicy.channels.webhook).toEqual(originalPolicy.channels.webhook);
      expect(allTopicsPolicy.privacy).toEqual(originalPolicy.privacy);
      expect(fixture.readRaw().futurePreference).toEqual(before.futurePreference);
      expect(fixture.settingsWrites).toEqual([]);
    });
  });

  it.each(['empty', 'deleted', 'absent'] as const)('does not recreate %s builtin membership or admit its finite preference', async membership => {
    await withBuiltinCatalog(membership, async fixture => {
      const before = fixture.readRaw();
      let result: unknown;
      try { result = await fixture.execute({ actionId: 'notifications.expoPush.update', input: { patch: { enabled: true } },
        context: { serverId: fixture.context.serverId, surface: 'ui' } }); }
      catch (error) { result = error; }
      expect(result).not.toEqual({ channelId: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID });
      expect(fixture.readRecord().channels).toEqual([]);
      expect(accountSettingsParse(fixture.readRaw()).attentionDeliveryPolicyV1.channels.expo_push.enabled).toBe(false);
      expect(fixture.readRaw().futurePreference).toEqual(before.futurePreference);
      expect(fixture.pairedRequests).toEqual([]);
      expect(fixture.settingsWrites).toEqual([]);
    });
  });

  it.each(['settings-conflict', 'conflict'] as const)('does not report paired preferences applied after %s', async refusal => {
    await withBuiltinCatalog('present', async fixture => {
      const beforeRecord = fixture.readRecord();
      const beforeRaw = fixture.readRaw();
      let outcome: unknown;
      try { outcome = await fixture.execute({ actionId: 'notifications.expoPush.update', input: { patch: { enabled: true } },
        context: { serverId: fixture.context.serverId, surface: 'ui' } }); }
      catch (error) { outcome = error; }
      expect(fixture.pairedRequests).not.toHaveLength(0);
      expect(outcome).not.toEqual({ channelId: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID });
      expect(fixture.readRecord()).toEqual(beforeRecord);
      expect(fixture.readRaw()).toEqual(beforeRaw);
      expect(fixture.settingsWrites).toEqual([]);
    }, refusal);
  });
});
