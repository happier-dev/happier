import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  LiveActivityRemoteUpdateRequestV1Schema,
  type LiveActivityRemoteUpdateRequestV1,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import type {
  PinnedHttpStreamRequest,
  PinnedHttpStreamResponse,
} from '@/network/pinnedHttp';
import {
  dispatchActivityNotificationAsync as dispatchActivityNotification,
  listActivityNotificationChannels as listNotificationChannels,
  resolveActivityNotificationPolicyEvent,
} from './dispatchActivityNotification';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createStablePluginNotificationsOwner, type PluginNotificationSenderBinding } from '@/plugins/runtime/invocation/services/notifications';
import { createWorkflowRunReviewEntryNotificationHandler } from './dispatchWorkflowRunUpdateNotification';
import { NotificationChannelRecordV1Schema, openNotificationChannelCatalogContentV1,
  sealNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { prepareLegacyNotificationChannelCatalogV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { createAccountArtifactStore, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { notificationSettingsFixture as accountSettingsParse, notificationCatalogFixture } from './activityNotification.testkit';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

function dispatchActivityNotificationAsync(params: Parameters<typeof dispatchActivityNotification>[0]) {
  return dispatchActivityNotification({ ...(!params.notificationChannelCatalog && params.settings
    ? notificationCatalogFixture(params.settings, params.settingsSecretsReadKeys) : {}), ...params });
}

function listActivityNotificationChannels(params: Parameters<typeof listNotificationChannels>[0]) {
  return listNotificationChannels({ ...(!params.notificationChannelCatalog && params.settings
    ? notificationCatalogFixture(params.settings) : {}), ...params });
}

const fetchSessionNotificationContext = async (sessionId: string) => createSessionNotificationContextFixture(sessionId);

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('dispatchActivityNotificationAsync', () => {
  it('refuses the private notice write when its Account retires during the real Artifact mode read', async () => {
    let current = true;
    let started: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => {
      started?.(); await held;
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    const written: unknown[] = [];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, data: { id: string }) => {
      written.push(data); return { status: 200, data: { id: data.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const accountId = 'retiring-notice-account';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    let drain: Promise<unknown> | undefined;
    try {
      const result = dispatchActivityNotification({ settings: accountSettingsParse({ usageQuotaNotificationsV1: { pace: true } }),
        notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [] },
        isCurrent: () => current, pluginNotifications: null, nowMs: () => 600,
        usageNoticeArtifactStore: { accountId, store: createCredentialedAccountArtifactStore(credentials) },
        event: { topic: 'connected_service_usage', kind: 'pace', serviceId: 'happier.agent.codex/openai-codex', profileId: 'work',
          issueFingerprint: 'retirement-during-artifact-mode', evidence: { recordId: 'paug_v1_account_retirement', meterId: 'weekly',
            windowStartAtMs: 0, resetAtMs: 1000, windowDurationMs: 1000, observedAtMs: 600, previousObservedAtMs: 500,
            usedFraction: 0.7, elapsedFraction: 0.6, pace: 7 / 6, projectedResetUtilizationFraction: 7 / 6,
            qualification: 'confirmed', sampleCount: 1 } } });
      const outcome = result.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      drain = outcome;
      const first = await Promise.race([entered.then(() => ({ entered: true as const })), outcome]);
      if (!('entered' in first)) {
        if (!first.ok) throw first.error;
        throw new Error('Notice dispatch settled before Artifact mode admission');
      }
      current = false; release?.();
      expect(await outcome).toMatchObject({ ok: false, error: { code: 'notification_channel_catalog_unavailable', reason: 'scope-retired' } });
      expect(written).toEqual([]);
    } finally { release?.(); await drain; get.mockRestore(); post.mockRestore(); }
  });
  it('dedupes usage occurrences within their captured Account, never across requester Accounts', async () => {
    const settings = accountSettingsParse({ usageQuotaNotificationsV1: { pace: true },
      attentionDeliveryPolicyV1: { channels: { badge: { enabled: false } } } });
    const notificationChannelCatalog = { status: 'ready' as const, revision: 1, diagnostics: [],
      channels: [NotificationChannelRecordV1Schema.parse({ v: 1, id: 'usage-account-dedupe', kind: 'expo_push',
        topics: { connectedServiceUsage: true } })] };
    const event = { topic: 'connected_service_usage' as const, kind: 'pace' as const, serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'same-profile', issueFingerprint: 'requester-account-dedupe-occurrence', evidence: {
        recordId: 'paug_v1_same-account', meterId: 'weekly', windowStartAtMs: 0, resetAtMs: 1000, windowDurationMs: 1000,
        observedAtMs: 600, previousObservedAtMs: 500, usedFraction: 0.7, elapsedFraction: 0.6, pace: 7 / 6,
        projectedResetUtilizationFraction: 7 / 6, qualification: 'confirmed' as const, sampleCount: 1 } };
    const delivered: string[] = [];
    const emit = (accountId: string) => dispatchActivityNotification({ settings, notificationChannelCatalog,
      pluginNotifications: null, event, nowMs: () => 600,
      usageNoticeArtifactStore: { accountId, store: createAccountArtifactStore({
        credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null },
        getAccountEncryptionMode: async () => 'plain' }) },
      expoPushSender: { sendToAllDevicesAsync: async () => { delivered.push(accountId); return true; } } });
    await emit('usage-account-alice');
    await emit('usage-account-alice');
    await emit('usage-account-bob');
    expect(delivered).toEqual(['usage-account-alice', 'usage-account-bob']);
  });
  it('refuses an unsigned plugin effect when its Account retires during platform discovery', async () => {
    const settings = accountSettingsParse({});
    const send = vi.fn(async (request: Parameters<PluginNotificationSenderBinding['send']>[0]) => ({ deliveryId: request.deliveryId, channelId: request.channelId,
      status: 'accepted' as const, evidence: 'provider' as const }));
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 4, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: 'notification-discovery-account',
      notificationChannelCatalog: { status: 'ready', revision: 9, diagnostics: [], channels: [] } });
    const pluginNotifications = createStablePluginNotificationsOwner({ categories: [],
      channels: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
        definition: { id: 'digest', kind: 'plugin', title: 'Digest', configurable: true, defaultEnabled: true } }],
      activateChannel: async () => {}, readChannel: () => ({ occurrenceId: 'current',
        isCurrent: async () => { clearActiveAccountSettingsSnapshot(); return true; }, send }),
    });
    try {
      await expect(dispatchActivityNotification({ settings, pluginNotifications,
        event: { topic: 'notify_me', message: 'Private Account content' } }))
        .rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable', reason: 'scope-retired' });
      expect(send).not.toHaveBeenCalled();
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('refuses an unsigned plugin effect when its Account retires during channel activation', async () => {
    const settings = accountSettingsParse({});
    const send = vi.fn(async (request: Parameters<PluginNotificationSenderBinding['send']>[0]) => ({
      deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted' as const, evidence: 'provider' as const,
    }));
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 4, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: 'notification-activation-account',
      notificationChannelCatalog: { status: 'ready', revision: 9, diagnostics: [], channels: [] } });
    const pluginNotifications = createStablePluginNotificationsOwner({ categories: [],
      channels: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
        definition: { id: 'digest', kind: 'plugin', title: 'Digest', configurable: true, defaultEnabled: true } }],
      // Channel activation is an external plugin-runtime boundary; its binding
      // can remain current after the dispatching Account has retired.
      activateChannel: async () => { clearActiveAccountSettingsSnapshot(); },
      readChannel: () => ({ occurrenceId: 'current', isCurrent: () => true, send }),
    });
    try {
      await expect(dispatchActivityNotification({ settings, pluginNotifications,
        event: { topic: 'notify_me', message: 'Private Account content' } }))
        .rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable', reason: 'scope-retired' });
      expect(send).not.toHaveBeenCalled();
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('preserves typed Account retirement refusal between acknowledged push channels', async () => {
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 4, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: 'notification-between-push-channels-account',
      notificationChannelCatalog: { status: 'ready', revision: 9, diagnostics: [], channels: ['first', 'second'].map(id =>
        NotificationChannelRecordV1Schema.parse({ v: 1, kind: 'expo_push', id, topics: {} })) } });
    // The device delivery boundary acknowledges the first channel, then retires
    // the captured Account. No internal dispatcher/currentness owner is mocked.
    const sendToAllDevicesAsync = vi.fn(async () => { clearActiveAccountSettingsSnapshot(); return true; });
    try {
      await expect(dispatchActivityNotification({ settings, pluginNotifications: null,
        event: { topic: 'notify_me', message: 'Private Account content' }, expoPushSender: { sendToAllDevicesAsync } }))
        .rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable', reason: 'scope-retired' });
      expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('preserves typed Account retirement refusal during unsigned webhook DNS admission', async () => {
    const settings = accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1, channels: { webhook: { enabled: true } } } });
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 4, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: 'notification-webhook-dns-account',
      notificationChannelCatalog: { status: 'ready', revision: 9, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
        v: 1, kind: 'webhook', id: 'unsigned-dns-channel', topics: {}, url: 'https://receiver.example/hook', signingSecretRef: null,
      })] } });
    // DNS and the socket are genuine boundaries; the dispatcher, destination
    // admission and captured Account lifetime guard remain real.
    const resolveAddresses = vi.fn(async () => { clearActiveAccountSettingsSnapshot(); return ['93.184.216.34']; });
    const openPinnedStream = vi.fn(async (): Promise<PinnedHttpStreamResponse> => { throw new Error('Retired Account reached socket'); });
    try {
      await expect(dispatchActivityNotification({ settings, pluginNotifications: null,
        event: { topic: 'notify_me', message: 'Private Account content' }, webhookNetwork: { resolveAddresses, openPinnedStream } }))
        .rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable', reason: 'scope-retired' });
      expect(resolveAddresses).toHaveBeenCalled();
      expect(openPinnedStream).not.toHaveBeenCalled();
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('refuses an unavailable catalog without substituting push or an empty picker', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => true);
    const params = { settings: accountSettingsParse({}), notificationChannelCatalog: {
      status: 'unavailable' as const, reason: 'authority-not-confirmed' as const,
    }, pluginNotifications: null, expoPushSender: { sendToAllDevicesAsync } };
    await expect(dispatchActivityNotificationAsync({ ...params, event: { topic: 'notify_me', message: 'ready' } }))
      .rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable', reason: 'authority-not-confirmed' });
    await expect(listActivityNotificationChannels(params))
      .rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable' });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('preserves an authoritative empty catalog even with registered push tokens', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => true);
    const params = { settings: accountSettingsParse({ notificationsSettingsV1: { pushEnabled: true },
      attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: true } } },
      notificationChannelsV1: [{ kind: 'expo_push', id: 'builtin:expo_push' }],
    }), notificationChannelCatalog: {
      status: 'ready' as const, channels: [], revision: 3, diagnostics: [],
    }, pluginNotifications: null, expoPushSender: { sendToAllDevicesAsync },
      pushTokenReader: { fetchPushTokens: async () => [{ id: 'device', token: 'ExponentPushToken[test]', createdAt: 1, updatedAt: 1 }] } };
    await expect(dispatchActivityNotificationAsync({ ...params, event: { topic: 'notify_me', message: 'ready' } }))
      .resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    // A retained Workflow selection and enabled legacy preferences cannot
    // recreate membership in an authoritative empty destination.
    await expect(dispatchActivityNotificationAsync({ ...params, channels: ['builtin:expo_push'],
      event: { topic: 'notify_me', message: 'retained selection' } }))
      .resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    await expect(listActivityNotificationChannels(params)).resolves.toEqual([]);
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('re-enables an imported disabled push row without overriding row guards or Account privacy', async () => {
    const imported = prepareLegacyNotificationChannelCatalogV1({ accountId: 'push-reenable-account', settingsSecretsReadKeys: [],
      raw: { notificationsSettingsV1: { pushEnabled: false, ready: true, permissionRequest: false,
        readyIncludeMessageText: false, requestIncludeMessageText: false } } });
    if (imported.status !== 'ready') throw new Error('Expected a complete legacy push source');
    const initial = imported.record.channels[0];
    if (!initial || initial.kind !== 'expo_push') throw new Error('Expected the retained builtin push identity');
    const updated = NotificationChannelRecordV1Schema.parse({ ...initial, enabled: true });
    const reopened = openNotificationChannelCatalogContentV1({ mode: 'plain', material: null,
      content: sealNotificationChannelCatalogContentV1({ mode: 'plain', material: null, record: { v: 1, channels: [updated] } }) });
    if (reopened.status !== 'opened') throw new Error('Expected a readable updated destination');
    const destination = reopened.record.channels[0]!;
    const sendToAllDevicesAsync = vi.fn(async (_title: string, _body: string) => true);
    const event = { topic: 'ready' as const, sessionId: 'push-reenable-session', sessionTitle: 'Private Session title',
      waitingForCommandLabel: 'Private waiting label', assistantPreviewText: 'Private assistant preview' };
    const dispatch = (channel: typeof destination, policy: Readonly<{ enabled?: boolean; statusOnly?: boolean }>) =>
      dispatchActivityNotification({ settings: accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1,
        channels: { expo_push: { enabled: policy.enabled ?? true } },
        privacy: { defaultPreviewBehavior: policy.statusOnly ? 'status_only' : 'include_preview' },
      } }), notificationChannelCatalog: { status: 'ready', revision: 4, diagnostics: [], channels: [channel] },
      event, expoPushSender: { sendToAllDevicesAsync }, pluginNotifications: null, fetchSessionNotificationContext });
    await expect(dispatch(initial, {})).resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    await expect(dispatch(destination, {})).resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    // The endpoint's retained preview restriction survives an enabled-only patch.
    expect(sendToAllDevicesAsync.mock.calls[0]?.[1]).not.toContain(event.assistantPreviewText);
    expect(destination).toMatchObject({ id: initial.id, topics: { permissionRequest: false }, readyIncludeMessageText: false });
    await expect(dispatch(NotificationChannelRecordV1Schema.parse({ ...destination, readyIncludeMessageText: true }), { statusOnly: true }))
      .resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(JSON.stringify(sendToAllDevicesAsync.mock.calls[1])).not.toContain('Private');
    await expect(dispatch(destination, { enabled: false })).resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    await expect(dispatch(NotificationChannelRecordV1Schema.parse({ ...destination, topics: { ...destination.topics, ready: false } }), {}))
      .resolves.toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
  });

  it('admits all selected signing references before delivering any channel', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => true);
    const catalog = { status: 'ready' as const, revision: 3, diagnostics: [], channels: [
      NotificationChannelRecordV1Schema.parse({ v: 1, kind: 'expo_push', id: 'builtin:expo_push', topics: {} }),
      NotificationChannelRecordV1Schema.parse({ v: 1, kind: 'webhook', id: 'unavailable-signer', topics: {},
        url: 'https://hooks.example.test/happier', signingSecretRef: 'happier:shared-secret:v1:missing' }),
    ] };
    await expect(dispatchActivityNotificationAsync({ settings: accountSettingsParse({ attentionDeliveryPolicyV1: {
      v: 1, channels: { webhook: { enabled: true } },
    } }), notificationChannelCatalog: catalog,
      savedSecretMaterializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources: [],
        resourceCatalogState: 'ready' }), expoPushSender: { sendToAllDevicesAsync }, pluginNotifications: null,
      event: { topic: 'notify_me', message: 'ready' },
    })).rejects.toMatchObject({ code: 'saved_secret_resolution_failed' });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('refuses partial channel inventory instead of delivering its valid neighbors', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => true);
    await expect(dispatchActivityNotificationAsync({ settings: accountSettingsParse({}), pluginNotifications: null,
      notificationChannelCatalog: { status: 'partial', revision: 3, channels: [NotificationChannelRecordV1Schema.parse({
        v: 1, kind: 'expo_push', id: 'builtin:expo_push', topics: {},
      })], diagnostics: [{ channelId: 'broken-hook', reason: 'invalid-stored-content' }] },
      expoPushSender: { sendToAllDevicesAsync }, event: { topic: 'notify_me', message: 'ready' },
    })).rejects.toMatchObject({ code: 'notification_channel_catalog_unavailable' });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });
  it('delivers each newly committed review hold in one Run without a time veto', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => true);
    const settings = accountSettingsParse({});
    const notify = createWorkflowRunReviewEntryNotificationHandler({
      getSettingsSnapshot: () => ({ settings, ...notificationCatalogFixture(settings) }),
      expoPushSender: { sendToAllDevicesAsync },
    });
    // Each callback denotes a different post-commit invocation hold; the producer
    // owns replay admission, so Activity must not conflate them by Run/update kind.
    await notify({ runId: 'two-review-holds' });
    await notify({ runId: 'two-review-holds' });
    expect(sendToAllDevicesAsync.mock.calls).toHaveLength(2);
    expect(sendToAllDevicesAsync).toHaveBeenLastCalledWith(expect.any(String), expect.any(String),
      expect.objectContaining({ runId: 'two-review-holds', updateKind: 'review_required' }), expect.anything());
  });

  it('marks push unavailable until a token is registered and preserves configured webhook availability in quiet hours', async () => {
    const settings = accountSettingsParse({ notificationChannelsV1: [
      { id: 'configured-hook', kind: 'webhook', enabled: true, url: 'https://hooks.example.test/happier' },
      { id: 'disabled-hook', kind: 'webhook', enabled: false, url: 'https://hooks.example.test/happier' },
    ], attentionDeliveryPolicyV1: { v: 1,
      quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }] },
    } });
    expect(await listActivityNotificationChannels({ settings, pluginNotifications: null,
      pushTokenReader: { fetchPushTokens: async () => [] },
    })).toEqual([
      { value: 'builtin:expo_push', label: 'Push notifications', disabled: true },
      { value: 'configured-hook', label: 'configured-hook', disabled: false },
      { value: 'disabled-hook', label: 'disabled-hook', disabled: true },
    ]);
    expect((await listActivityNotificationChannels({ settings, pluginNotifications: null,
      pushTokenReader: { fetchPushTokens: async () => [{ id: 'device', token: 'ExponentPushToken[test]', createdAt: 1, updatedAt: 1 }] },
    }))[0]).toMatchObject({ value: 'builtin:expo_push', disabled: false });
  });

  it('projects disabled Notify me policy through the same channel owner, including real plugin channels', async () => {
    const pluginNotifications = createStablePluginNotificationsOwner({ categories: [],
      channels: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
        definition: { id: 'digest', kind: 'plugin', title: 'Digest', configurable: true, defaultEnabled: true } }],
      activateChannel: async () => {},
      readChannel: () => ({ occurrenceId: 'current', isCurrent: () => true,
        send: async (request) => ({ deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted', evidence: 'provider' }) }),
    });
    const read = (enabled: boolean) => listActivityNotificationChannels({ pluginNotifications,
      settings: accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1, events: { notify_me: { enabled } } } }),
      pushTokenReader: { fetchPushTokens: async () => [] },
    });
    expect((await read(false)).every((channel) => channel.disabled)).toBe(true);
    expect((await read(true)).some((channel) => channel.value !== 'builtin:expo_push' && !channel.disabled)).toBe(true);
  });

  it('restricts Notify me channels, applies previews and suppresses request replays', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1 }, notificationChannelsV1: [{
      id: 'notify-hook', kind: 'webhook', enabled: true, url: 'https://hooks.example.test/happier',
    }] });
    const params = {
      settings, expoPushSender: { sendToAllDevicesAsync }, webhookNetwork,
      nowMs: () => 50_000,
      event: { topic: 'notify_me' as const, title: 'Digest', message: 'Private summary', actionRequestId: 'notify-replay-1',
        open: { kind: 'workflow_run' as const, runId: 'run-1' } },
      channels: ['builtin:expo_push'],
    };
    expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith('Digest', 'Private summary', expect.objectContaining({ runId: 'run-1' }), expect.anything());
    expect(webhookRequests).toHaveLength(0);
    expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(await dispatchActivityNotificationAsync({ ...params, channels: ['removed-channel'], event: { ...params.event, actionRequestId: 'removed-id' } }))
      .toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(await dispatchActivityNotificationAsync({ ...params, channels: undefined, event: { ...params.event, actionRequestId: 'all-id' } }))
      .toEqual({ attemptedChannels: 2, deliveredChannels: 2 });
    expect(webhookRequestBody(webhookRequests[0]).navigation).toEqual({ runId: 'run-1' });
  });

  it('suppresses Notify me in quiet hours and never discloses previews under status-only policy', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const event = { topic: 'notify_me' as const, title: 'Private title', message: 'Private message' };
    expect(await dispatchActivityNotificationAsync({
      settings: accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1, events: { notify_me: { enabled: false } } } }),
      event, expoPushSender: { sendToAllDevicesAsync },
    })).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(await dispatchActivityNotificationAsync({
      settings: accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1, privacy: { defaultPreviewBehavior: 'status_only' } } }),
      event, expoPushSender: { sendToAllDevicesAsync },
    })).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(JSON.stringify(sendToAllDevicesAsync.mock.calls)).not.toContain('Private');
    expect(await dispatchActivityNotificationAsync({
      settings: accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1,
        quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '00:00', endLocalTime: '01:00' }] },
        events: { notify_me: { quietHoursBehavior: 'suppress' } },
      }, notificationChannelsV1: [{ id: 'quiet-hook', kind: 'webhook', enabled: true, url: 'https://hooks.example.test/happier' }] }),
      event, channels: ['quiet-hook'], webhookNetwork, nowMs: () => 50_000,
    })).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(webhookRequests).toHaveLength(0);
  });

  it('delivers a restricted plugin channel through the real owner with policy-redacted content', async () => {
    const sent: unknown[] = [];
    const pluginNotifications = createStablePluginNotificationsOwner({
      categories: [],
      channels: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
        definition: { id: 'digest', kind: 'plugin', title: 'Digest', configurable: true, defaultEnabled: true } }],
      activateChannel: async () => {},
      readChannel: () => ({ occurrenceId: 'current', isCurrent: () => true,
        send: async (request) => { sent.push(request); return { deliveryId: request.deliveryId,
          channelId: request.channelId, status: 'accepted', evidence: 'provider' }; } }),
    });
    const settings = accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1,
      privacy: { defaultPreviewBehavior: 'title_only' },
    } });
    const event = { topic: 'notify_me' as const, title: 'Digest', message: 'Private body' };
    expect(await dispatchActivityNotificationAsync({ settings, event,
      channels: ['acme.delivery/digest'], pluginNotifications,
    })).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sent).toEqual([expect.objectContaining({ title: 'Digest', body: '' })]);
    expect(JSON.stringify(sent)).not.toContain('Private body');
    expect(await dispatchActivityNotificationAsync({ settings, event,
      channels: ['removed-plugin/channel'], pluginNotifications,
    })).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(await dispatchActivityNotificationAsync({ settings: accountSettingsParse({
      attentionDeliveryPolicyV1: { v: 1, events: { notify_me: { enabled: false } } },
    }), event, channels: ['acme.delivery/digest'], pluginNotifications,
    })).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sent).toHaveLength(1);
  });

  it.each(['expo_push', 'local_notification'] as const)(
    'applies the declared %s policy to a contributed notification channel',
    async (kind) => {
      const sent: unknown[] = [];
      const pluginNotifications = createStablePluginNotificationsOwner({
        categories: [],
        channels: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
          definition: { id: 'declared-channel', kind, title: 'Declared channel', configurable: true, defaultEnabled: true } }],
        activateChannel: async () => {},
        readChannel: () => ({ occurrenceId: 'current', isCurrent: () => true,
          send: async (request) => { sent.push(request); return { deliveryId: request.deliveryId,
            channelId: request.channelId, status: 'accepted', evidence: 'provider' }; } }),
      });
      const params = { event: { topic: 'notify_me' as const, message: 'Digest', actionRequestId: `declared-${kind}` },
        channels: ['acme.delivery/declared-channel'], pluginNotifications };
      expect(await dispatchActivityNotificationAsync({ ...params, settings: accountSettingsParse({
        attentionDeliveryPolicyV1: { v: 1, channels: { [kind]: { enabled: false }, plugin: { enabled: true } } },
      }) })).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
      expect(sent).toHaveLength(0);
      expect(await dispatchActivityNotificationAsync({ ...params, settings: accountSettingsParse({
        attentionDeliveryPolicyV1: { v: 1, channels: { [kind]: { enabled: true }, plugin: { enabled: false } } },
      }) })).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
      expect(sent).toEqual([expect.objectContaining({ body: 'Digest' })]);
    },
  );
  // `fetch` stays stubbed as a guard: webhook delivery must go through the
  // pinned transport, so any call here is a regression back to unpinned dispatch.
  const fetchSpy = vi.fn();
  const webhookRequests: PinnedHttpStreamRequest[] = [];
  const webhookNetwork = {
    resolveAddresses: async () => ['93.184.216.34'],
    openPinnedStream: async (request: PinnedHttpStreamRequest): Promise<PinnedHttpStreamResponse> => {
      webhookRequests.push(request);
      return Object.freeze({
        status: 202,
        headers: {},
        contentLength: 0,
        read: async () => null,
        cancel: () => undefined,
      });
    },
  };

  function webhookRequestBody(request: PinnedHttpStreamRequest | undefined): Record<string, unknown> {
    return JSON.parse(Buffer.from(request?.body ?? new Uint8Array()).toString('utf8'));
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(logger.debug).mockReset();
    fetchSpy.mockReset();
    webhookRequests.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies current Session candidacy before Expo, Live Activity and webhook delivery', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const allowed = createSessionNotificationContextFixture('session-candidacy');
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: { v: 1, liveActivityRemoteUpdates: { enabled: true, preferredMode: 'direct_apns' } },
      notificationChannelsV1: [{
        v: 1, id: 'candidacy-hook', kind: 'webhook', enabled: true,
        url: 'https://hooks.example.test/happier', topics: { ready: true },
      }],
    });
    const dispatch = (context: typeof allowed | null, readerAvailable = true) => dispatchActivityNotificationAsync({
      settings, webhookNetwork, expoPushSender: { sendToAllDevicesAsync },
      liveActivityRemoteSender: { serverId: 'home', sendLiveActivityRemoteUpdateAsync },
      fetchSessionNotificationContext: readerAvailable ? async () => context : undefined,
      event: { topic: 'ready', sessionId: allowed.id, waitingForCommandLabel: 'Agent' },
    });
    const contexts = [
      null,
      { ...allowed, id: 'another-session' },
      { ...allowed, archivedAt: 1 },
      { ...allowed, viewer: undefined },
      { ...allowed, effectiveAccess: { ...allowed.effectiveAccess, capabilities: { ...allowed.effectiveAccess.capabilities, readTranscript: false } } },
      { ...allowed, viewer: { ...allowed.viewer!, follow: { follows: false, notificationLevel: 'none' as const } } },
    ];
    for (const context of contexts) {
      expect(await dispatch(context)).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    }
    expect(await dispatch(allowed, false)).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(sendLiveActivityRemoteUpdateAsync).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(0);
    expect(await dispatch(allowed)).toEqual({ attemptedChannels: 3, deliveredChannels: 3 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledOnce();
    expect(sendLiveActivityRemoteUpdateAsync).toHaveBeenCalledOnce();
    expect(webhookRequests).toHaveLength(1);
  });

  it('uses the connected-service account policy for credential health notifications', () => {
    expect(resolveActivityNotificationPolicyEvent({
      topic: 'connected_service_credential_health',
      sessionId: 'session-credential-policy',
      serviceId: 'openai-codex',
      profileId: 'work',
      status: 'reconnect_required',
    })).toBe('connected_service_account_switch');
  });

  it('keeps full permission details only in channels that include request text', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({ notificationChannelsV1: [true, false, undefined].map((include, index) => ({
      v: 1, id: `hook-${index}`, kind: 'webhook', enabled: true,
      url: 'https://hooks.example.test/happier', requestIncludeMessageText: include,
      topics: { permissionRequest: true },
    })) });
    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext, settings, webhookNetwork, expoPushSender: { sendToAllDevicesAsync }, event: {
      topic: 'permission_request', sessionId: 's1', requestId: 'p1', toolName: 'Bash',
      toolInput: { command: 'git diff -- apps/cli/src/main.ts', justification: 'Review the complete patch' },
    } });
    const payloads = webhookRequests.map((request) => JSON.parse(Buffer.from(request.body ?? new Uint8Array()).toString('utf8')));
    expect(payloads).toHaveLength(3);
    expect(payloads[0].content.body).toContain('git diff -- apps/cli/src/main.ts');
    expect(payloads[0].request.toolDetails).toContain('Review the complete patch');
    expect(payloads[1].content.body).not.toContain('git diff');
    expect(payloads[1].request.toolDetails).toBeNull();
    expect(payloads[2].request.toolDetails).toContain('Review the complete patch');
    expect(payloads[2].content.body).toContain('git diff -- apps/cli/src/main.ts');
  });

  it('falls back to the builtin expo push channel when explicit channels are missing', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-1',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-1' },
      { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
    );
    expect(webhookRequests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, 'session-reset'])('delivers automatic reset receipts without inventing a session (%s)', async (sessionId) => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const event = {
      topic: 'connected_service_quota_recovered' as const,
      recoveryReason: 'automatic_quota_reset' as const,
      sessionId,
      serviceId: 'acme.accounts/work',
      serviceDisplayName: 'Work account',
      groupId: 'team',
      profileId: 'primary',
      issueFingerprint: `reset-receipt-${sessionId ?? 'startup'}`,
    };
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: { expo_push: { enabled: true } },
        liveActivityRemoteUpdates: { enabled: true, preferredMode: 'direct_apns', defaultStaleAfterSeconds: 900 },
      },
      notificationChannelsV1: [{
        v: 1, id: 'reset-webhook', kind: 'webhook', enabled: true,
        url: 'https://hooks.example.test/happier',
        topics: { ready: false, permissionRequest: false, userActionRequest: false, connectedServiceQuotaRecovered: true },
        readyIncludeMessageText: false,
      }],
    });
    const dispatch = () => dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings, event, webhookNetwork, expoPushSender: { sendToAllDevicesAsync }, nowMs: () => 100_000,
      liveActivityRemoteSender: { serverId: 'server-reset', sendLiveActivityRemoteUpdateAsync },
    });

    const result = await dispatch();
    expect(result, JSON.stringify(vi.mocked(logger.debug).mock.calls)).toEqual({ attemptedChannels: sessionId ? 3 : 2, deliveredChannels: sessionId ? 3 : 2 });
    expect(sendToAllDevicesAsync.mock.calls[0]).toEqual([
      expect.stringContaining('reset credit used'),
      expect.stringContaining('primary in pool team'),
      expect.objectContaining({ recoveryReason: 'automatic_quota_reset', issueFingerprint: event.issueFingerprint, sessionId }),
      expect.any(Object),
    ]);
    expect(webhookRequestBody(webhookRequests[0])).toMatchObject({
      topic: 'connected_service_quota_recovered',
      content: { body: expect.stringContaining('automatically used a reset credit') },
    });
    expect(webhookRequestBody(webhookRequests[0]).session).toEqual(sessionId ? { sessionId, title: null } : undefined);
    if (sessionId) {
      expect(sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0].activityKey.sessionId).toBe(sessionId);
    } else {
      expect(sendLiveActivityRemoteUpdateAsync).not.toHaveBeenCalled();
    }
    expect(await dispatch()).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
  });

  it('dispatches connected-service account switch notifications with structured quota context', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'connected_service_account_switch',
        sessionId: 'session-switch',
        sessionTitle: 'Review branch',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        fromProfileLabel: 'main@example.test',
        toProfileLabel: 'backup@example.test',
        fromUsagePercent: 100,
        toUsagePercent: 20,
        reason: 'usage_limit',
        limitCategory: 'usage_limit',
        retryAfterMs: 60_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      expect.stringContaining('OpenAI'),
      expect.objectContaining({
        sessionId: 'session-switch',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        fromProfileLabel: 'main@example.test',
        toProfileLabel: 'backup@example.test',
        fromUsagePercent: 100,
        toUsagePercent: 20,
        limitCategory: 'usage_limit',
        retryAfterMs: 60_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
      }),
      { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
    );
    const firstSendCall = sendToAllDevicesAsync.mock.calls[0] as unknown[] | undefined;
    const body = firstSendCall?.[1];
    expect(body).toContain('provider reported');
    expect(body).toContain('main@example.test');
    expect(body).toContain('backup@example.test');
    expect(body).not.toContain('openai-codex');
  });

  it('dispatches connected-service credential health notifications without raw provider details', async () => {
    const sendToAllDevicesAsync = vi.fn(async (
      _title: string,
      _body: string,
      _data: Record<string, unknown>,
      _options?: unknown,
    ) => { return true; });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'connected_service_credential_health',
        sessionId: 'session-credential',
        sessionTitle: 'Investigate auth',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        profileId: 'work',
        profileLabel: 'work@example.test',
        status: 'reconnect_required',
        reason: JSON.stringify({
          error: 'invalid_grant',
          refresh_token: 'secret-refresh-token',
          access_token: 'secret-access-token',
          authorization: 'Bearer secret-authorization-token',
        }),
        providerStatus: 400,
        providerErrorCode: [
          "Cannot find module '/private/node_modules/provider-adapter.js'",
          'Require stack:',
          '/private/app/node_modules/@happier-dev/provider/index.js',
          'OAuth error: invalid_grant',
        ].join('\n'),
        action: {
          kind: 'open_url',
          url: 'https://provider.example.test/reconnect?access_token=secret-url-token',
        },
      } satisfies ActivityNotificationEvent,
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    const [title, body, data] = sendToAllDevicesAsync.mock.calls[0] ?? [];
    expect(title).toBe('Investigate auth');
    expect(body).toContain('OpenAI');
    expect(body).not.toContain('openai-codex');
    expect(body).toContain('work@example.test');
    expect(body).toContain('reconnect');
    expect(body).toContain('invalid_grant');
    const delivered = JSON.stringify({ body, data });
    expect(delivered).not.toContain('secret-refresh-token');
    expect(delivered).not.toContain('secret-access-token');
    expect(delivered).not.toContain('secret-authorization-token');
    expect(delivered).not.toContain('secret-url-token');
    expect(delivered).not.toContain('node_modules');
    expect(delivered).not.toContain('Require stack');
    expect(data).toMatchObject({
      topic: 'connected_service_credential_health',
      sessionId: 'session-credential',
      serviceId: 'openai-codex',
      serviceDisplayName: 'OpenAI',
      profileId: 'work',
      profileLabel: 'work@example.test',
      status: 'reconnect_required',
      reason: 'invalid_grant',
      providerStatus: 400,
      providerErrorCode: 'invalid_grant',
      action: { kind: 'open_url', url: 'https://provider.example.test/reconnect' },
    });
  });

  it('dedupes connected-service account switch notifications inside the dedupe window', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const event = {
      topic: 'connected_service_account_switch' as const,
      sessionId: 'session-switch',
      serviceId: 'openai-codex',
      groupId: 'dedupe-main',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
    };

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => 1_000,
      dedupeWindowMs: 60_000,
      event,
    });
    const duplicate = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => 2_000,
      dedupeWindowMs: 60_000,
      event,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(duplicate).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
  });

  it('does not dedupe connected-service account switches with different reasons or target profiles', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const event = {
      topic: 'connected_service_account_switch' as const,
      sessionId: 'session-switch',
      serviceId: 'openai-codex',
      serviceDisplayName: 'OpenAI',
      groupId: 'dedupe-variant',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
    };

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => 1_000,
      dedupeWindowMs: 60_000,
      event,
    });
    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => 2_000,
      dedupeWindowMs: 60_000,
      event: {
        ...event,
        fromProfileId: 'backup',
        toProfileId: 'tertiary',
        reason: 'soft_threshold',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
  });

  it('suppresses disabled connected-service account switch Expo push topics', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-primary',
          kind: 'expo_push',
          enabled: true,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
            connectedServiceAccountSwitch: false,
            connectedServiceQuotaBlocked: true,
            connectedServiceQuotaRecovered: true,
          },
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      dedupeWindowMs: 0,
      event: {
        topic: 'connected_service_account_switch',
        sessionId: 'session-switch-disabled',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('dispatches connected-service quota blocked and recovered notifications', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'connected_service_quota_blocked',
        sessionId: 'session-quota',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        issueFingerprint: 'issue-1',
        groupId: 'main',
        profileId: 'primary',
        limitCategory: 'usage_limit',
      },
    });
    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({}),
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'connected_service_quota_recovered',
        sessionId: 'session-quota',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        issueFingerprint: 'issue-1',
        groupId: 'main',
        profileId: 'primary',
        limitCategory: 'usage_limit',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('OpenAI'),
      expect.stringContaining('OpenAI'),
      expect.objectContaining({ topic: 'connected_service_quota_blocked', issueFingerprint: 'issue-1', serviceDisplayName: 'OpenAI' }),
      { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
    );
    expect(sendToAllDevicesAsync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('OpenAI'),
      expect.stringContaining('OpenAI'),
      expect.objectContaining({ topic: 'connected_service_quota_recovered', issueFingerprint: 'issue-1', serviceDisplayName: 'OpenAI' }),
      { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
    );
  });

  it('suppresses Expo push delivery during account quiet hours', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => Date.parse('2026-05-03T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-quiet',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps webhook delivery active during account quiet hours by default', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => Date.parse('2026-05-03T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-webhook',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suppresses webhook delivery during quiet hours when policy opts in', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
        channels: {
          webhook: {
            quietHoursBehavior: 'suppress',
          },
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => Date.parse('2026-05-03T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-webhook-quiet',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suppresses policy-disabled Expo push channels even when legacy channel rows are enabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: { enabled: false },
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-enabled',
          kind: 'expo_push',
          enabled: true,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-disabled',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('does not let an enabled policy revive a disabled Expo push entity', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: {
            enabled: true,
            events: {
              ready: { enabled: true },
            },
          },
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-stale-disabled',
          kind: 'expo_push',
          enabled: false,
          topics: {
            ready: false,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-enabled',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('does not let an enabled push policy manufacture absent catalog membership', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: {
            enabled: true,
            events: {
              ready: { enabled: true },
            },
          },
        },
      },
      notificationChannelsV1: [],
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-policy-only',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it.each(['status_only', 'title_only', 'include_preview'] as const)(
    'preserves the %s privacy decision across rich push and webhook content',
    async (previewBehavior) => {
      const sendToAllDevicesAsync = vi.fn(async (_title: string, _body: string, _data: Record<string, unknown>) => { return true; });
      const privateTitle = 'Private acquisition plan';
      const privatePreview = 'Private release credentials review';
      const settings = accountSettingsParse({
        attentionDeliveryPolicyV1: {
          v: 1,
          privacy: { defaultPreviewBehavior: previewBehavior },
          events: {
            permission_request: { previewBehavior },
            user_action_request: { previewBehavior },
          },
        },
        notificationChannelsV1: [{
          v: 1, id: 'privacy-hook', kind: 'webhook', enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: { ready: true, permissionRequest: true, userActionRequest: true },
          readyIncludeMessageText: true, requestIncludeMessageText: true,
        }],
      });
      const events: ActivityNotificationEvent[] = [
        { ...{ committedLocalId: 'ready-local-1', committedSequence: 42 },
          topic: 'ready', sessionId: 'privacy-session', sessionTitle: privateTitle,
          waitingForCommandLabel: 'Agent', assistantPreviewText: privatePreview },
        ...(['permission_request', 'user_action_request'] as const).map((topic) => ({
          topic, sessionId: 'privacy-session', sessionTitle: privateTitle,
          requestId: `${topic}-privacy`, toolName: 'Bash', toolDetails: privatePreview,
        })),
      ];
      for (const event of events) {
        await dispatchActivityNotificationAsync({ fetchSessionNotificationContext, settings, event, webhookNetwork, expoPushSender: { sendToAllDevicesAsync } });
      }
      expect(sendToAllDevicesAsync.mock.calls).toHaveLength(events.length);
      expect(sendToAllDevicesAsync.mock.calls[0]?.[2]).toMatchObject({
        activityEventLocalId: 'ready-local-1',
        activityEvent: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 42 },
      });
      expect(webhookRequests).toHaveLength(events.length);
      for (const output of [
        ...sendToAllDevicesAsync.mock.calls,
        ...webhookRequests.map(webhookRequestBody),
      ]) {
        const serialized = JSON.stringify(output);
        expect(serialized.includes(privateTitle)).toBe(previewBehavior !== 'status_only');
        expect(serialized.includes(privatePreview)).toBe(previewBehavior === 'include_preview');
      }
    },
  );

  it('retains a surface status-only override for connected-service Session titles', async () => {
    const sendToAllDevicesAsync = vi.fn(async (_title: string, _body: string, _data: Record<string, unknown>) => { return true; });
    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings: accountSettingsParse({ attentionDeliveryPolicyV1: {
        v: 1, privacy: { surfaces: { expo_push: 'status_only' } },
      } }),
      dedupeWindowMs: 0,
      expoPushSender: { sendToAllDevicesAsync },
      event: { topic: 'connected_service_account_switch', sessionId: 'privacy-session',
        sessionTitle: 'Private acquisition plan', serviceId: 'service', groupId: 'pool',
        fromProfileId: 'first', toProfileId: 'second', reason: 'manual' },
    });
    expect(sendToAllDevicesAsync).toHaveBeenCalled();
    expect(JSON.stringify(sendToAllDevicesAsync.mock.calls)).not.toContain('Private acquisition plan');
  });

  it.each(['status_only', 'title_only', 'include_preview'] as const)(
    'applies %s to connected-service details while retaining routing identities', async (previewBehavior) => {
      const privateLabel = 'private-account@example.test';
      const privateDiagnostic = 'private-provider-diagnostic';
      const sendToAllDevicesAsync = vi.fn(async (_title: string, _body: string, _data: Record<string, unknown>) => { return true; });
      const settings = accountSettingsParse({
        attentionDeliveryPolicyV1: { v: 1, privacy: { defaultPreviewBehavior: previewBehavior } },
        notificationChannelsV1: [{
          v: 1, id: 'service-privacy', kind: 'webhook', enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: { connectedServiceAccountSwitch: true, connectedServiceQuotaRecovered: true },
        }],
      });
      const common = { sessionId: 'service-session', sessionTitle: 'Private Session', serviceId: 'service', serviceDisplayName: privateLabel };
      const events: ActivityNotificationEvent[] = [
        { ...common, topic: 'connected_service_account_switch', groupId: 'pool-id',
          fromProfileId: 'first-id', toProfileId: 'second-id', fromProfileLabel: privateLabel,
          toProfileLabel: privateLabel, fromUsagePercent: 87, reason: 'manual' },
        { ...common, topic: 'connected_service_credential_health', profileId: 'profile-id',
          profileLabel: privateLabel, status: 'reconnect_required', reason: privateDiagnostic,
          providerErrorCode: privateDiagnostic },
        { ...common, topic: 'connected_service_quota_recovered', recoveryReason: 'automatic_quota_reset',
          profileId: 'profile-id', groupId: 'pool-id', issueFingerprint: 'issue-id' },
      ];
      for (const event of events) {
        await dispatchActivityNotificationAsync({ settings, event, dedupeWindowMs: 0,
          webhookNetwork, expoPushSender: { sendToAllDevicesAsync } });
      }
      expect(sendToAllDevicesAsync.mock.calls).toHaveLength(3);
      expect(webhookRequests).toHaveLength(3);
      for (const output of [...sendToAllDevicesAsync.mock.calls, ...webhookRequests.map(webhookRequestBody)]) {
        expect(JSON.stringify(output).includes(privateLabel)).toBe(previewBehavior === 'include_preview');
        if (previewBehavior === 'status_only') expect(JSON.stringify(output)).not.toContain('Private Session');
      }
      const calls = sendToAllDevicesAsync.mock.calls;
      expect(calls[0]?.[0].includes('Private Session')).toBe(previewBehavior !== 'status_only');
      expect(calls[0]?.[2]).toMatchObject({ sessionId: 'service-session', serviceId: 'service', groupId: 'pool-id', fromProfileId: 'first-id', toProfileId: 'second-id' });
      expect(calls[1]?.[2]).toMatchObject({ profileId: 'profile-id', status: 'reconnect_required' });
      expect(JSON.stringify(calls[1]).includes(privateDiagnostic)).toBe(previewBehavior === 'include_preview');
      expect(calls[2]?.[2]).toMatchObject({ profileId: 'profile-id', groupId: 'pool-id', issueFingerprint: 'issue-id', recoveryReason: 'automatic_quota_reset' });
      expect(calls[2]?.[1].includes('profile-id')).toBe(previewBehavior === 'include_preview');
      expect(calls[2]?.[1].includes('pool-id')).toBe(previewBehavior === 'include_preview');
    },
  );

  it('passes resolved silent sound options to Expo push senders', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'none',
        },
      },
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-silent',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-silent' },
      { sound: null, priority: 'high', androidSoundId: 'none' },
    );
  });

  it('maps bundled policy sounds to Expo notification filenames and Android sound channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'soft',
          eventSoundIds: {
            permission_request: 'urgent',
          },
        },
      },
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-sound',
        requestId: 'request-1',
        sessionTitle: 'Review branch',
        toolName: 'Bash',
        toolDetails: 'Run git status',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ sessionId: 'session-sound', kind: 'permission' }),
      { sound: 'happier_urgent.wav', priority: 'high', androidSoundId: 'urgent' },
    );
  });

  it('does not pass unsupported custom sound ids to Expo push senders', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'custom:imported-tone',
        },
      },
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-custom-sound',
        sessionTitle: 'Review branch',
        requestId: 'request-custom-sound',
        toolName: 'Bash',
        toolDetails: 'Run git status',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      expect.stringContaining('Bash'),
      expect.objectContaining({ sessionId: 'session-custom-sound', kind: 'permission' }),
      { sound: null, priority: 'high', androidSoundId: 'none' },
    );
  });

  it('sends a Live Activity remote update as its own delivery channel', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
          defaultStaleAfterSeconds: 900,
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-live',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 2, deliveredChannels: 2 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-live' },
      { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
    );
    expect(sendLiveActivityRemoteUpdateAsync).toHaveBeenCalledTimes(1);
    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(LiveActivityRemoteUpdateRequestV1Schema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      v: 1,
      createdAt: Date.parse('2026-05-04T12:00:00.000Z'),
      transportMode: 'direct_apns',
      event: 'update',
      activityKey: {
        serverId: 'server-a',
        sessionId: 'session-live',
        activityName: 'HappierFocusLiveActivity',
      },
      contentState: {
        version: 1,
        generatedAt: Date.parse('2026-05-04T12:00:00.000Z'),
        staleAt: Date.parse('2026-05-04T12:15:00.000Z'),
        sessionId: 'session-live',
        title: 'Review branch',
        previewText: 'The branch is ready to review.',
        attentionState: 'unread',
      },
    });
    expect(request).not.toHaveProperty('interruptiveAlert');
  });

  it('omits Live Activity preview text when policy allows title only', async () => {
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: { enabled: false },
        },
        privacy: {
          defaultPreviewBehavior: 'include_preview',
          surfaces: {
            live_activity: 'title_only',
          },
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-private',
        sessionTitle: 'Private project',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'secret transcript detail',
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(request?.contentState?.previewText).toBeNull();
    expect(request?.contentState?.title).toBe('Private project');
    expect(JSON.stringify(request)).not.toContain('secret transcript detail');
  });

  it('filters title-only permission details from Live Activity state and alert intent', async () => {
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: { enabled: false },
          live_activity: { events: { permission_request: { previewBehavior: 'title_only' } } },
        },
        privacy: {
          defaultPreviewBehavior: 'include_preview',
          surfaces: {
            live_activity: 'title_only',
          },
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
        },
      },
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'permission_request',
        sessionId: 'session-private-permission',
        sessionTitle: 'Private project',
        requestId: 'permission-private',
        toolName: 'Bash',
        toolDetails: 'Run command containing private-token',
      },
    });

    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(request?.contentState?.title).toBe('Private project');
    expect(request?.contentState?.subtitle).toBeNull();
    expect(request?.contentState?.previewText).toBeNull();
    expect(request?.contentState?.statusText).toBe('Permission required');
    expect(request?.event === 'update' ? request.interruptiveAlert?.body : undefined).toBe('Permission required');
    expect(JSON.stringify(request)).not.toContain('Bash');
    expect(JSON.stringify(request)).not.toContain('private-token');
  });

  it('keeps quiet Live Activity freshness updates non-interruptive', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: { live_activity: { events: { permission_request: { previewBehavior: 'include_preview' } } } },
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
          quietHoursBehavior: 'silent',
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'permission_request',
        sessionId: 'session-quiet-live',
        sessionTitle: 'Production fix',
        requestId: 'permission-1',
        toolName: 'Bash',
        toolInput: { command: 'npm test && echo secret-token' },
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('interruptiveAlert');
    expect(request?.contentState?.attentionState).toBe('permission_required');
    expect(request?.contentState?.previewText).toContain('npm test && echo secret-token');
  });

  it('dispatches only to enabled explicit channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: { expo_push: { enabled: true }, webhook: { enabled: true } },
        privacy: { defaultPreviewBehavior: 'status_only' },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-disabled',
          kind: 'expo_push',
          enabled: false,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-2',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(1);
    const request = webhookRequests[0];
    expect(request?.url).toBe('https://hooks.example.test/happier');
    expect(request?.method).toBe('POST');
    expect(request?.validatedAddresses).toEqual(['93.184.216.34']);
    expect(request?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
    });
    const payload = webhookRequestBody(request);
    expect(payload.content).toEqual({
      title: 'Session',
      body: 'Session is waiting for your command',
    });
    expect(payload.session).toEqual({ sessionId: 'session-2', title: null });
    expect(JSON.stringify(payload)).not.toContain('Deployment is complete.');

    // Allowing previews globally cannot reopen this endpoint's retained
    // assistant-text restriction, while the finite policy admits its title.
    await dispatchActivityNotification({
      fetchSessionNotificationContext,
      ...notificationCatalogFixture(settings),
      settings: accountSettingsParse({ attentionDeliveryPolicyV1: {
        v: 1,
        channels: { expo_push: { enabled: true }, webhook: { enabled: true } },
        privacy: { defaultPreviewBehavior: 'include_preview' },
      } }),
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-2-preview',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(2);
    const previewAllowedPayload = webhookRequestBody(webhookRequests[1]);
    expect(previewAllowedPayload.content).toEqual({
      title: 'Deploy fix',
      body: 'Gemini is waiting for your command',
    });
    expect(previewAllowedPayload.session).toEqual({ sessionId: 'session-2-preview', title: 'Deploy fix' });
    expect(JSON.stringify(previewAllowedPayload)).not.toContain('Deployment is complete.');
  });

  it('omits request previews when the webhook explicitly disables them', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: { expo_push: { enabled: false }, webhook: { enabled: true } },
        events: { permission_request: { previewBehavior: 'include_preview' } },
        privacy: { defaultPreviewBehavior: 'include_preview' },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: false,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
          requestIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-3',
        sessionTitle: 'Fix prod issue',
        requestId: 'request-9',
        toolName: 'Bash',
        toolInput: { command: 'git status --short && echo secret-token' },
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(1);
    const payload = webhookRequestBody(webhookRequests[0]);
    expect(webhookRequests[0]?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
    });
    expect(payload.request).toMatchObject({
      requestId: 'request-9',
      kind: 'permission',
      toolName: 'Bash',
      toolDetails: null,
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('decrypts encrypted webhook signing secrets when settings secret read keys are provided', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(7));
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: { expo_push: { enabled: false }, webhook: { enabled: true } },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            encryptedValue: encryptSecretStringV1(
              'sealed-webhook-secret',
              settingsSecretsKey,
              (length) => new Uint8Array(length).fill(3),
            ),
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      settingsSecretsReadKeys: [settingsSecretsKey],
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-4',
        sessionTitle: 'Ship release',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'Release branch is ready.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(webhookRequests).toHaveLength(1);
    expect(webhookRequests[0]?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
    });
  });

  it('redacts transport error details before logging failed notification dispatches', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {
      throw {
        isAxiosError: true,
        name: 'AxiosError',
        message: 'Request failed with status code 401',
        config: {
          method: 'post',
          url: 'https://api.example.test/v1/push-tokens?token=query-secret',
          headers: { Authorization: 'Bearer authorization-secret' },
          data: { body: 'private notification body' },
        },
        response: { status: 401 },
      };
    });
    const settings = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
      },
    });

    await dispatchActivityNotificationAsync({ fetchSessionNotificationContext,
      settings,
      webhookNetwork,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-log-redaction',
        sessionTitle: 'Private title',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'private notification body',
      },
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[activityNotifications] Failed to dispatch outbound notification',
      expect.objectContaining({
        name: 'AxiosError',
        status: 401,
        method: 'POST',
        url: 'https://api.example.test/v1/push-tokens',
      }),
    );
    const logged = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(logged).not.toContain('Authorization');
    expect(logged).not.toContain('authorization-secret');
    expect(logged).not.toContain('query-secret');
    expect(logged).not.toContain('private notification body');
  });
});
