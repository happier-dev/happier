import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { dispatchConnectedServiceQuotaLifecycleNotificationAsync as dispatchNotification } from './dispatchConnectedServiceQuotaLifecycleNotification';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { decodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { x25519 } from '@noble/curves/ed25519';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decryptWithDataKey } from '@/api/encryption';

const artifactNetwork = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('axios', () => ({ default: artifactNetwork }));

function dispatchConnectedServiceQuotaLifecycleNotificationAsync(params: Parameters<typeof dispatchNotification>[0]) {
  // Channel entities are a genuine Account boundary, authored separately from policy preferences.
  return dispatchNotification({ notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [],
    channels: [NotificationChannelRecordV1Schema.parse({ v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: {} })] }, ...params });
}

function usageSnapshot(observedAtMs: number, used: number, resetAtMs = 1000) {
  const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
  return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
    providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs, fetchedAtMs: observedAtMs,
    staleAfterMs: 10000, source: 'providerHttp', confidence: 'confirmed', meters: [{ meterId: 'weekly', label: 'Window',
      used, limit: 100, unit: 'count', utilizationPct: used, resetsAt: resetAtMs, resetAtMs, windowDurationMs: 1000,
      status: 'ok', confidence: 'exact' }] });
}

function accountToken(accountId: string): string {
  // The authenticated HTTP boundary is mocked; its Account subject uses the real token reader.
  return `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
}

type SendToAllDevicesAsync = (title: string, body: string, data: Record<string, unknown>) => Promise<boolean>;

function buildSettings(topics: Readonly<{ blocked: boolean; recovered: boolean }>) {
  return accountSettingsParse({
    attentionDeliveryPolicyV1: {
      channels: {
        expo_push: {
          enabled: true,
          previewBehavior: 'include_preview',
          events: {
            connected_service_quota_blocked: { enabled: topics.blocked },
            connected_service_quota_recovered: { enabled: topics.recovered },
          },
        },
      },
    },
  });
}

describe('dispatchConnectedServiceQuotaLifecycleNotificationAsync', () => {
  it('commits opted-in witnessed notices through the keyless plain Account Artifact owner, never hydration or unavailable E2EE material', async () => {
    const created: Array<Record<string, unknown>> = [];
    artifactNetwork.post.mockImplementation(async (_url, wire: Record<string, unknown>) => {
      // Model the actual Artifact create boundary's unique id, including after dismissal.
      if (created.some(row => row.id === wire.id)) return { status: 409, data: { error: 'conflict' } };
      created.push(wire);
      return { status: 200, data: { id: wire.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const store = createAccountArtifactStore({ credentials: { token: accountToken('owner'), encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const base = { settings: accountSettingsParse({ usageQuotaNotificationsV1: { pace: true } }), pluginNotifications: null,
      notificationChannelCatalog: { status: 'ready' as const, revision: 1, diagnostics: [], channels: [] },
      usageNoticeArtifactStore: { accountId: 'owner', store }, nowMs: () => 600, dedupeWindowMs: 0 };
    const transition = { phase: 'observed' as const, serviceId: 'happier.agent.codex/openai-codex', profileId: 'account',
      previous: usageSnapshot(500, 40), snapshot: usageSnapshot(600, 70) };
    await dispatchNotification({ ...base, transition: { ...transition, previous: null } });
    expect(created).toEqual([]);
    await dispatchNotification({ ...base, transition });
    expect(created).toHaveLength(1);
    expect(created[0].dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
    expect(decodePlainArtifactStoredContent(String(created[0].header))).toMatchObject({ kind: 'usage_notice.v1', status: 'open',
      notice: { kind: 'pace', evidence: { meterId: 'weekly', observedAtMs: 600, previousObservedAtMs: 500 } } });
    expect(JSON.stringify(created[0])).not.toContain('sessionId');
    await dispatchNotification({ ...base, transition });
    expect(created).toHaveLength(1);
    await expect(dispatchNotification({ ...base, usageNoticeArtifactStore: { accountId: 'owner', store: createAccountArtifactStore({
      credentials: { token: accountToken('owner'), encryption: null }, getAccountEncryptionMode: async () => 'e2ee' }) }, transition }))
      .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
    expect(created).toHaveLength(1);
    const secret = new Uint8Array(32).fill(7);
    const encryptedStore = createAccountArtifactStore({ credentials: { token: accountToken('other-owner'), encryption: {
      type: 'dataKey', machineKey: secret, publicKey: x25519.getPublicKey(secret) } }, getAccountEncryptionMode: async () => 'e2ee' });
    await dispatchNotification({ ...base, usageNoticeArtifactStore: { accountId: 'other-owner', store: encryptedStore }, transition });
    expect(created).toHaveLength(2);
    expect(JSON.stringify(created[1])).not.toContain('weekly');
    const key = openEncryptedDataKeyEnvelopeV1({ envelope: Buffer.from(String(created[1].dataEncryptionKey), 'base64'),
      recipientSecretKeyOrSeed: secret });
    expect(key).not.toBeNull();
    expect(decryptWithDataKey(Buffer.from(String(created[1].header), 'base64'), key!)).toMatchObject({
      kind: 'usage_notice.v1', notice: { kind: 'pace', evidence: { meterId: 'weekly' } } });
    await dispatchNotification({ ...base, usageNoticeArtifactStore: { accountId: 'other-owner', store: encryptedStore }, transition });
    expect(created).toHaveLength(2);
    const differentSecret = new Uint8Array(32).fill(8);
    const differentEncryptedStore = createAccountArtifactStore({ credentials: { token: accountToken('other-owner'), encryption: {
      type: 'dataKey', machineKey: differentSecret, publicKey: x25519.getPublicKey(differentSecret) } },
      getAccountEncryptionMode: async () => 'e2ee' });
    await dispatchNotification({ ...base, usageNoticeArtifactStore: { accountId: 'other-owner', store: differentEncryptedStore }, transition });
    expect(created).toHaveLength(3);
    expect(created[2].id).not.toBe(created[1].id);
    expect(JSON.stringify(created[2])).not.toContain('weekly');
    // Recovery-secret and data-key credentials represent the same Account key,
    // not separate machines or separate notice occurrences.
    const recoverySecret = new Uint8Array(32).fill(9);
    const legacyStore = createAccountArtifactStore({ credentials: { token: accountToken('legacy-owner'), encryption: { type: 'legacy', secret: recoverySecret } },
      getAccountEncryptionMode: async () => 'e2ee' });
    await dispatchNotification({ ...base, usageNoticeArtifactStore: { accountId: 'legacy-owner', store: legacyStore }, transition });
    expect(created).toHaveLength(4);
    const accountKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const accountKeyStore = createAccountArtifactStore({ credentials: { token: accountToken('legacy-owner'), encryption: {
      type: 'dataKey', machineKey: accountKey, publicKey: x25519.getPublicKey(accountKey) } }, getAccountEncryptionMode: async () => 'e2ee' });
    await dispatchNotification({ ...base, usageNoticeArtifactStore: { accountId: 'legacy-owner', store: accountKeyStore }, transition });
    expect(created).toHaveLength(4);
  });
  it('refuses a notice occurrence scope different from the authenticated Account before any Artifact write', async () => {
    const created: Array<Record<string, unknown>> = [];
    artifactNetwork.post.mockImplementation(async (_url, wire: Record<string, unknown>) => {
      created.push(wire);
      return { status: 200, data: { id: wire.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const store = createAccountArtifactStore({ credentials: { token: accountToken('owner'), encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    await expect(dispatchNotification({ settings: accountSettingsParse({ usageQuotaNotificationsV1: { pace: true } }),
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [] }, pluginNotifications: null,
      usageNoticeArtifactStore: { accountId: 'foreign', store },
      transition: { phase: 'observed', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account',
        previous: usageSnapshot(500, 40), snapshot: usageSnapshot(600, 70) }, nowMs: () => 600, dedupeWindowMs: 0 }))
      .rejects.toMatchObject({ code: 'usage_notice_account_scope_mismatch' });
    expect(created).toEqual([]);
  });
  it('requires user thresholds for depletion, almost-out, ending and credit expiry, and rejects stale or changed credit evidence', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const notificationChannelCatalog = { status: 'ready' as const, revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
      v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: { connectedServiceUsage: true },
    })] };
    const preferences = { depletion: true, almostOutRemainingFraction: 0.1, endingBeforeMs: 500, creditExpiryBeforeMs: 1000 };
    const previous = { ...usageSnapshot(100, 10), recoveryCredits: { availableCount: 1, credits: [{ id: 'credit', kind: 'quota_reset' as const,
      status: 'available' as const, expiresAtMs: 1500 }] } };
    const snapshot = { ...usageSnapshot(600, 95), recoveryCredits: previous.recoveryCredits };
    const emit = async (settings: ReturnType<typeof accountSettingsParse>, current = snapshot) => {
      await dispatchNotification({ settings, notificationChannelCatalog, pluginNotifications: null,
        expoPushSender: { sendToAllDevicesAsync: async (_title, _body, data) => { sent.push(data); return true; } },
        transition: { phase: 'observed', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account', previous, snapshot: current },
        nowMs: () => 600, dedupeWindowMs: 0 });
    };
    await emit(accountSettingsParse({}));
    expect(sent).toEqual([]);
    const settings = accountSettingsParse({ usageQuotaNotificationsV1: preferences,
      attentionDeliveryPolicyV1: { channels: { expo_push: { previewBehavior: 'include_preview' } } } });
    await emit(settings, { ...snapshot, state: 'stale_data' });
    expect(sent).toEqual([]);
    await emit(settings);
    expect(sent.map(event => event.kind)).toEqual(['depletion', 'almost_out', 'ending', 'credit_expiry']);
    expect(sent.at(-1)).toMatchObject({ evidence: { creditId: 'credit', expiresAtMs: 1500, observedAtMs: 600, previousObservedAtMs: 100 } });
    sent.length = 0;
    await emit(settings, { ...snapshot, recoveryCredits: { availableCount: 1, credits: [{ ...previous.recoveryCredits.credits[0], expiresAtMs: 1600 }] } });
    expect(sent.map(event => event.kind)).toEqual(['depletion', 'almost_out', 'ending']);
  });
  it('witnesses actual credit expiry with zero lead, but never hydration, changed identity or consumed credits', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const settings = accountSettingsParse({ usageQuotaNotificationsV1: { creditExpiryBeforeMs: 0 },
      attentionDeliveryPolicyV1: { channels: { expo_push: { previewBehavior: 'include_preview' } } } });
    const notificationChannelCatalog = { status: 'ready' as const, revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
      v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: { connectedServiceUsage: true },
    })] };
    const prior = { ...usageSnapshot(1400, 1, 2000), recoveryCredits: { availableCount: 1,
      credits: [{ id: 'credit', kind: 'quota_reset' as const, status: 'available' as const, expiresAtMs: 1500 }] } };
    const expired = { ...usageSnapshot(1600, 2, 2000), recoveryCredits: { availableCount: 0,
      credits: [{ ...prior.recoveryCredits.credits[0], status: 'expired' as const }] } };
    const emit = async (previous: ReturnType<typeof usageSnapshot> | null, snapshot: ReturnType<typeof usageSnapshot>) => {
      await dispatchNotification({ settings, notificationChannelCatalog, pluginNotifications: null,
        expoPushSender: { sendToAllDevicesAsync: async (_title, _body, data) => { sent.push(data); return true; } },
        transition: { phase: 'observed', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account', previous, snapshot },
        nowMs: () => snapshot.observedAtMs, dedupeWindowMs: 0 });
    };
    await emit(null, expired);
    await emit(prior, { ...expired, recoveryCredits: { availableCount: 0, credits: [{ ...expired.recoveryCredits.credits[0], id: 'different' }] } });
    await emit(prior, { ...expired, recoveryCredits: { availableCount: 0, credits: [{ ...expired.recoveryCredits.credits[0], expiresAtMs: 1550 }] } });
    await emit(prior, { ...expired, recoveryCredits: { availableCount: 0, credits: [{ ...expired.recoveryCredits.credits[0], expiresAtMs: null }] } });
    await emit(prior, { ...expired, recoveryCredits: { availableCount: 0, credits: [{ ...expired.recoveryCredits.credits[0], kind: 'rate_limit_reset' }] } });
    await emit(prior, { ...expired, recoveryCredits: { availableCount: 0, credits: [{ ...expired.recoveryCredits.credits[0], status: 'unknown' }] } });
    await emit(prior, { ...expired, recoveryCredits: { availableCount: 0, credits: [{ ...expired.recoveryCredits.credits[0], redeemedAtMs: 1450 }] } });
    await emit(prior, { ...expired, observedAtMs: 1450, fetchedAtMs: 1450 });
    await emit({ ...prior, recoveryCredits: { availableCount: 0, credits: [{ ...prior.recoveryCredits.credits[0], status: 'redeemed' }] } }, expired);
    expect(sent).toEqual([]);
    await emit(prior, expired);
    expect(sent).toMatchObject([{ kind: 'credit_expiry', evidence: { creditId: 'credit', expiresAtMs: 1500,
      previousObservedAtMs: 1400, observedAtMs: 1600 } }]);
    await emit(expired, { ...expired, observedAtMs: 1700, fetchedAtMs: 1700 });
    expect(sent).toHaveLength(1);
  });
  it('primes hydration, emits witnessed opted-in crossings once, and suppresses repeats in the same window', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const settings = accountSettingsParse({ usageQuotaNotificationsV1: { pace: true, reset: true, unused: true },
      attentionDeliveryPolicyV1: { channels: { expo_push: { previewBehavior: 'include_preview' } } } });
    const notificationChannelCatalog = { status: 'ready' as const, revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
      v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: { connectedServiceUsage: true },
    })] };
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 1, loadedAtMs: 500,
      settingsSecretsReadKeys: [], scopeKey: 'usage-crossing-test', notificationChannelCatalog });
    const emit = async (previous: ReturnType<typeof usageSnapshot> | null, snapshot: ReturnType<typeof usageSnapshot>) => {
      await dispatchConnectedServiceQuotaLifecycleNotificationAsync({ settings, notificationChannelCatalog,
        expoPushSender: { sendToAllDevicesAsync: async (_title, _body, data) => { sent.push(data); return true; } },
        transition: { ...{sessionIds: ['session'], groupId: 'pool', activeProfileId: 'account', resetAtMs: 1000, reason: 'observation'},
          phase: 'observed', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account', previous, snapshot },
        nowMs: () => snapshot.observedAtMs, dedupeWindowMs: 0 });
    };
    try {
      await emit(null, usageSnapshot(500, 40));
      expect(sent).toEqual([]);
      await emit(usageSnapshot(500, 40), usageSnapshot(600, 70));
      expect(sent).toMatchObject([{ topic: 'connected_service_usage', kind: 'pace', evidence: { meterId: 'weekly', resetAtMs: 1000,
        windowStartAtMs: 0, observedAtMs: 600, previousObservedAtMs: 500, usedFraction: 0.7 } }]);
      await emit(usageSnapshot(600, 70), usageSnapshot(700, 80));
      expect(sent.map(event => event.kind)).toEqual(['pace']);
      // Zero elapsed has no pace ratio, but the provider still witnessed the exact rollover.
      await emit(usageSnapshot(900, 80), usageSnapshot(1000, 0, 2000));
      expect(sent.map(event => event.kind)).toEqual(['pace', 'reset', 'unused']);
      expect(sent[1]).toMatchObject({ evidence: { windowStartAtMs: 1000, resetAtMs: 2000, observedAtMs: 1000 } });
      expect(sent[1].evidence).not.toHaveProperty('pace');
      await emit(usageSnapshot(1000, 0, 2000), usageSnapshot(1100, 1, 2000));
      expect(sent.map(event => event.kind)).toEqual(['pace', 'reset', 'unused']);
      await emit(usageSnapshot(2900, 80, 3000), usageSnapshot(3100, 1, 4000));
      expect(sent.map(event => event.kind)).toEqual(['pace', 'reset', 'unused', 'reset', 'unused']);
      await emit(usageSnapshot(3100, 1, 4000), usageSnapshot(3200, 2, 4000));
      expect(sent.map(event => event.kind)).toEqual(['pace', 'reset', 'unused', 'reset', 'unused']);
      // A known window start and an exact closing boundary witness a reset
      // independently of whether the prior observation can supply a pace ratio.
      await emit(usageSnapshot(4000, 0, 5000), usageSnapshot(5000, 0, 6000));
      await emit(usageSnapshot(7000, 80, 7000), usageSnapshot(7100, 1, 8000));
      expect(sent.map(event => event.kind)).toEqual(['pace', 'reset', 'unused', 'reset', 'unused', 'reset', 'reset']);
    } finally { clearActiveAccountSettingsSnapshot(); }
  });
  it('delivers an explicitly opted-in pace edge with its actual window evidence and honors status-only privacy', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const settings = accountSettingsParse({ usageQuotaNotificationsV1: { pace: true }, attentionDeliveryPolicyV1: {
      channels: { expo_push: { previewBehavior: 'status_only' } },
    } });
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 1, loadedAtMs: 600,
      settingsSecretsReadKeys: [], scopeKey: 'usage-notification-test',
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
        v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: { connectedServiceUsage: true },
      })] } });
    try {
    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({ settings,
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
        v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: {},
      })] },
      expoPushSender: { sendToAllDevicesAsync: async (_title, _body, data) => { sent.push(data); return true; } },
      transition: { phase: 'observed', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account',
        previous: usageSnapshot(500, 40), snapshot: usageSnapshot(600, 70) },
      nowMs: () => 600, dedupeWindowMs: 0,
    });
    expect(sent).toEqual([]);
    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({ settings,
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
        v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: { connectedServiceUsage: true },
      })] },
      expoPushSender: { sendToAllDevicesAsync: async (_title, _body, data) => { sent.push(data); return true; } },
      transition: { phase: 'observed', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account',
        previous: usageSnapshot(500, 40), snapshot: usageSnapshot(600, 70) },
      nowMs: () => 600, dedupeWindowMs: 0,
    });
    expect(sent).toEqual([{ topic: 'connected_service_usage', kind: 'pace' }]);
    } finally { clearActiveAccountSettingsSnapshot(); }
  });
  it('dispatches a quota-blocked notification per affected session with retry timing from the known reset', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => { return true; });

    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
      settings: buildSettings({ blocked: true, recovered: true }),
      settingsSecretsReadKeys: [],
      expoPushSender: { sendToAllDevicesAsync },
      transition: {
        phase: 'blocked',
        serviceId: 'happier.agent.codex/openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        sessionIds: ['sess-1', 'sess-2'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: 90_000,
        reason: 'connected_service_group_quota_exhausted',
      },
      nowMs: () => 30_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
    const [, , data] = sendToAllDevicesAsync.mock.calls[0] ?? [];
    expect(data).toMatchObject({
      topic: 'connected_service_quota_blocked',
      sessionId: 'sess-1',
      serviceId: 'happier.agent.codex/openai-codex',
      serviceDisplayName: 'ChatGPT',
      groupId: 'main',
      profileId: 'primary',
      issueFingerprint: 'quota-blocked:openai-codex:main',
      retryAfterMs: 60_000,
    });
  });

  it('suppresses dispatch when the quota-blocked topic is disabled on the channel', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => { return true; });

    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
      settings: buildSettings({ blocked: false, recovered: true }),
      settingsSecretsReadKeys: [],
      expoPushSender: { sendToAllDevicesAsync },
      transition: {
        phase: 'blocked',
        serviceId: 'happier.agent.codex/openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        sessionIds: ['sess-1'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: null,
        reason: 'connected_service_group_quota_exhausted',
      },
      nowMs: () => 30_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('dispatches the quota-recovered topic on the recovered edge without retry timing', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => { return true; });

    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
      settings: buildSettings({ blocked: true, recovered: true }),
      settingsSecretsReadKeys: [],
      expoPushSender: { sendToAllDevicesAsync },
      transition: {
        phase: 'recovered',
        serviceId: 'happier.agent.codex/openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        sessionIds: ['sess-1'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: null,
        reason: 'fresh_quota_evidence',
      },
      nowMs: () => 30_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    const [, , data] = sendToAllDevicesAsync.mock.calls[0] ?? [];
    expect(data).toMatchObject({
      topic: 'connected_service_quota_recovered',
      sessionId: 'sess-1',
      serviceId: 'happier.agent.codex/openai-codex',
      serviceDisplayName: 'ChatGPT',
      profileId: 'backup',
      retryAfterMs: null,
    });
  });
});
