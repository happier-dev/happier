import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { NotificationChannelCatalogReadResponseV1Schema, openNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { homeDomainActionTransportV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeBase64 } from '@/api/encryption';
import { WebhookNotificationChannelV1Schema } from '@happier-dev/protocol/account/settings/notificationChannels';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliNotificationChannelStore } from './notificationChannelStore';

describe('notification catalog initial signing resource transfer', () => {
  it.each(['plain', 'e2ee'] as const)('atomically initializes signed channel identities with exact resource packets in persisted %s mode', async mode => {
    const accountId = 'cli-initial-signed-account';
    const secret = new Uint8Array(32).fill(4);
    // Retained keys do not turn a persisted plain Account into an E2EE Account.
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
      encryption: { type: 'legacy' as const, secret } };
    const home = 'https://initial-signed-home.example';
    const values = [' first exact signing bytes\n', '\tsecond exact signing bytes '];
    const channels = values.map((value, index) => WebhookNotificationChannelV1Schema.parse({ kind: 'webhook',
      id: `initial-signed-${index}`, url: `https://receiver.example/hook-${index}`, signingSecret: { _isSecretValue: true, value } }));
    const resourceIds = channels.map(channel => deriveSavedSecretImportResourceIdV1({ accountId,
      source: { kind: 'notification-channel-signing-secret', channelId: channel.id } }));
    const raw = { notificationChannelsV1: channels, preferredLanguage: 'de' };
    const material = mode === 'plain' ? null : { type: 'legacy' as const, secret };
    const settingsVersion = 7;
    const source: AccountSettingsStoredContentEnvelope = mode === 'plain' ? { t: 'plain', v: raw } : { t: 'encrypted',
      c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: credentials.encryption, payload: raw,
        randomBytes: length => new Uint8Array(length).fill(6) }) };
    let row = NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'absent' });
    const mutations: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
    const operationContext = runWithServerHttpBaseUrl(home, () => createInvocationSavedSecretOperationContextV1({ credentials,
      serverHttpBaseUrl: home, isCurrent: async () => true,
      snapshot: { source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) } }));
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: credentials.encryption }).contentPublicKeyFingerprint);
    // Only the captured Home HTTP/feature boundaries are substituted; shared
    // source preparation, resource packet codecs, census and promotion stay real.
    const features = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(new URL(String(input)).origin).toBe(home);
      return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} })),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe(home);
      if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: { mode, version: 1,
        settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: mode === 'plain' ? null : fingerprint, updatedAt: 1 } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: source } };
      if (url.pathname === '/v1/account/entity-rows/notification-channels') return { status: 200, data: row };
      if (url.pathname === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
        complete: true, referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [] } };
      if (url.pathname === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 'absent' } };
      if (url.pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
      if (url.pathname === '/v1/account/saved-secrets/resources/materials') {
        // Fresh admission is deliberately unavailable after the atomic commit:
        // destination readiness must survive without unsafe source cleanup.
        return mutations.length ? { status: 503, data: {} } : { status: 200, data: { resources: [] } };
      }
      if (url.pathname.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected initial signing boundary: ${url.pathname}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(String(input)).toBe(`${home}${homeDomainActionTransportV1('secrets.shared.promote').path}`);
      const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
      expect(mutation.expectedSettingsVersion).toBe(7);
      expect(mutation.nextSettings).toBeNull();
      expect(mutation.referenceCensus).not.toHaveProperty('scope');
      expect(mutation.referenceCensus).toMatchObject({ accountMode: mode,
        profiles: { referenceGuardRevision: 'absent', rows: [] },
        remoteHosts: { revision: 'absent', resourceRefs: [] },
        notificationChannels: { revision: 'absent', resourceRefs: [] } });
      const channelMutation = mutation.notificationChannelMutation;
      expect(channelMutation).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 7,
        savedSecretRevisions: resourceIds.map(resourceId => ({ resourceRef: `happier:shared-secret:v1:${resourceId}`, revision: 1 })) });
      if (!channelMutation?.content) throw new Error('Missing atomic notification channel content');
      row = NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'present', revision: 1, content: channelMutation.content });
      mutations.push(mutation);
      return { status: 200, data: { resourceId: mutation.resourceId, settingsVersion, notificationChannelRevision: 1 } };
    });
    try {
      const catalog = await runWithServerHttpBaseUrl(home, () => createCliNotificationChannelStore({ credentials, operationContext })
        .readNotificationChannelCatalog());
      expect(catalog).toMatchObject({ status: 'ready', revision: 1, cleanup: { status: 'cleanup-pending' },
        channels: channels.map((channel, index) => ({ id: channel.id, signingSecretRef: `happier:shared-secret:v1:${resourceIds[index]}` })) });
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0]!;
      const resources = [mutation, ...(mutation.additionalSavedSecretResources ?? [])];
      expect(resources.map(resource => resource.resourceId)).toEqual(resourceIds);
      for (const [index, resource] of resources.entries()) {
        expect(resource.encryptionMode).toBe(mode);
        if (mode === 'plain') {
          expect(resource.keyEnvelopes).toEqual([]);
          expect(openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode,
            storedContent: resource.storedContent })?.value).toBe(values[index]);
        } else {
          const envelope = resource.keyEnvelopes?.[0];
          expect(envelope?.recipientAccountId).toBe(accountId);
          if (!envelope) throw new Error('Missing resource owner envelope');
          const dataKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope.encryptedDataKey),
            recipientSecretKeyOrSeed: deriveAccountMachineKeyFromRecoverySecret(secret) });
          if (!dataKey) throw new Error('Resource owner envelope cannot reopen');
          try { expect(openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode,
            storedContent: resource.storedContent, resourceDataKey: dataKey })?.value).toBe(values[index]); }
          finally { dataKey.fill(0); }
        }
      }
      const opened = openNotificationChannelCatalogContentV1({ mode, material, content: mutation.notificationChannelMutation!.content });
      expect(opened).toMatchObject({ status: 'opened', record: { channels: channels.map((channel, index) => ({
        id: channel.id, signingSecretRef: `happier:shared-secret:v1:${resourceIds[index]}` })) } });
      expect(JSON.stringify(opened)).not.toContain('exact signing bytes');
    } finally { post.mockRestore(); get.mockRestore(); features.mockRestore(); secret.fill(0); }
  });
});

describe('notification catalog historical signing recovery', () => {
  it.each(['exact', 'changed-after-admission', 'unavailable', 'unsigned-unavailable'] as const)(
    'requires freshly reopened owned signing bytes before removing historical source (%s)', async state => {
      const accountId = 'cli-notification-history-account';
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
      const home = 'https://notification-history-home.example';
      const value = ' exact historical signing bytes\n';
      const channel = WebhookNotificationChannelV1Schema.parse({ kind: 'webhook', id: 'retained-history-channel',
        url: 'https://receiver.example/hook', signingSecret: { _isSecretValue: true, value } });
      const resourceId = deriveSavedSecretImportResourceIdV1({ accountId,
        source: { kind: 'notification-channel-signing-secret', channelId: channel.id } });
      const operationContext = runWithServerHttpBaseUrl(home, () => createInvocationSavedSecretOperationContextV1({ credentials,
        serverHttpBaseUrl: home, isCurrent: async () => true,
        snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1,
          settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) } }));
      const removable = state === 'exact' || state === 'unsigned-unavailable';
      let recorded: AccountSettingsStoredContentEnvelope = { t: 'plain', v: {
        notificationChannelsV1: [state === 'unsigned-unavailable' ? { ...channel, signingSecret: null } : channel], preferredLanguage: 'de' } };
      let materialReads = 0;
      const mutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
      // HTTP, including the authenticated feature descriptor, is the only
      // substituted boundary. Source preparation, history proofs, Account
      // custody and SavedSecret hydration/materialization stay real.
      const features = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        expect(new URL(String(input)).origin).toBe(home);
        return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} })),
          { status: 200, headers: { 'content-type': 'application/json' } });
      });
      const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
        const url = new URL(String(input));
        expect(url.origin).toBe(home);
        const path = url.pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
          settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
        if (path === '/v1/account/entity-rows/notification-channels') return { status: 200, data: {
          status: 'present', revision: 2, content: { t: 'plain', v: { v: 1, channels: [] } } } };
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        if (path === '/v1/account/saved-secrets/resources/materials') {
          materialReads += 1;
          if (state === 'unavailable' || state === 'unsigned-unavailable') return { status: 503, data: {} };
          return { status: 200, data: { resources: [{ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
            entry: { ref: `happier:shared-secret:v1:${resourceId}`, source: 'shared_resource', relationship: 'owner',
              name: 'Signing', kind: 'other', ownerAccountId: accountId, revision: 3, materialStatus: 'ready',
              capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: { v: 1,
              name: 'Signing', kind: 'other', value: state === 'changed-after-admission' && materialReads > 1 ? 'changed material' : value } }),
          }] } };
        }
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 4,
          createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] } };
        if (path === '/v2/account/settings/history/4') return { status: 200, data: { version: 4,
          createdAt: '2026-01-01T00:00:00.000Z', content: recorded } };
        if (path.startsWith('/v1/account/entity-rows/')) return { status: 404, data: {} };
        throw new Error(`Unexpected captured notification history boundary: ${path}`);
      });
      const post = vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
        expect(String(input)).toBe(`${home}/v2/account/settings/history/4/mutate`);
        const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(body);
        if (mutation.operation.kind !== 'normalize') throw new Error('Expected historical normalization');
        expect(mutation.expectedContent).toEqual(recorded);
        mutations.push(mutation);
        recorded = mutation.operation.content!;
        return { status: 200, data: { status: 'applied' } };
      });
      try {
        const catalog = await runWithServerHttpBaseUrl(home, () => createCliNotificationChannelStore({ credentials, operationContext })
          .readNotificationChannelCatalog());
        expect(catalog).toMatchObject({ status: 'ready', revision: 2,
          cleanup: { status: removable ? 'complete' : 'cleanup-pending' } });
        expect(mutations).toHaveLength(removable ? 1 : 0);
        if (removable) {
          expect(recorded).toEqual({ t: 'plain', v: { preferredLanguage: 'de' } });
          if (state === 'exact') expect(mutations[0]!.operation).toMatchObject({ savedSecretTransfers: [{ source: {
            kind: 'notification-channel-signing-secret', channelId: channel.id }, resourceId, expectedRevision: 3 }] });
          else expect(mutations[0]!.operation.savedSecretTransfers ?? []).toEqual([]);
          expect(JSON.stringify(mutations[0]!.operation)).not.toContain('historical signing bytes');
        }
        expect(operationContext.readSnapshot()?.settingsVersion).toBe(7);
      } finally { post.mockRestore(); get.mockRestore(); features.mockRestore(); }
    },
  );
});
