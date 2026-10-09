import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from '@/app/api/routes/account/accountRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { NotificationChannelCatalogRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID } from '@happier-dev/protocol/account/settings/notificationChannels';
import { AttentionDeliveryPolicyV1Schema } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { createSavedSecretResourceInTx, deleteSavedSecretResourceInTx, promoteSavedSecretResourceInTx, updateSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { decodeBase64 } from 'privacy-kit';
import { storePlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { notificationChannelCatalogRowDomain, validateNotificationChannelReferenceCensusInTx } from './channelRows';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

function capturedEmptyPlainReferenceCensus() {
  return { accountMode: 'plain' as const, profileTransferRevision: 'absent' as const,
    profiles: { referenceGuardRevision: 'absent' as const, rows: [] }, artifacts: [],
    catalogs: { mcp: 'absent' as const, acp: 'absent' as const, providerConnections: 'absent' as const,
      connectedConfigurations: 'absent' as const, connectedPurposes: 'absent' as const },
    remoteHosts: { revision: 'absent' as const, resourceRefs: [] } };
}

describe('notification channel row authority (SQLite)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-notification-channels-', initEncrypt: true }); }, 120_000);
  afterAll(async () => { await harness?.close(); });
  it('admits source currentness once, then edits its row without preference/history writes', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
    const other = await db.account.create({ data: { encryptionMode: 'plain' } });
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    const url = '/v1/account/entity-rows/notification-channels';
    const headers = { 'x-test-user-id': account.id };
    const content = { t: 'plain', v: { v: 1, channels: [] } };
    try {
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
      expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 6, content } })).json())
        .toEqual({ status: 'settings-conflict', revision: 7 });
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
      expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 7, content } })).json())
        .toMatchObject({ status: 'updated', revision: 0 });
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content });
      expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': other.id } })).json()).toEqual({ status: 'absent' });
      expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 1, content: null } })).json())
        .toEqual({ status: 'conflict', revision: 0 });
      expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
      expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
      expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 0, content: null } })).json())
        .toMatchObject({ status: 'updated', revision: 1 });
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'deleted', revision: 1 });
    } finally { await app.close(); }
  });
  it('commits signing material and its channel reference together, with no Settings or history write', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4 } });
    const ref = formatSharedSavedSecretRefV1('webhook-atomic');
    const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, topics: {}, id: 'hook', kind: 'webhook', url: 'https://example.test/hook', signingSecretRef: ref }] });
    const input = { accountId: owner.id, resourceId: 'webhook-atomic', displayName: 'Signing key', kind: 'token' as const,
      encryptionMode: 'plain' as const, storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Signing key', kind: 'token' as const, value: 'private' } },
      profileMutations: [], expectedSettingsVersion: 4, nextSettings: null,
      referenceCensus: { ...capturedEmptyPlainReferenceCensus(), notificationChannels: { revision: 'absent' as const, resourceRefs: [] } },
      notificationChannelMutation: { expectedRevision: 'absent' as const, sourceSettingsVersion: 4, content: { t: 'plain' as const, v: record }, savedSecretRevisions: [{ resourceRef: ref, revision: 1 }] } };
    const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, input));
    expect(result).toMatchObject({ ok: true, value: { resourceId: input.resourceId } });
    const row = await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: '@happier/account/notification-channels/v1/catalog' } } });
    expect(row?.version).toBe(0);
    expect(row?.value && JSON.parse(Buffer.from(row.value).toString('utf8'))).toEqual({ t: 'plain', v: record });
    expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(4);
    expect(await db.accountSettingsSnapshot.count({ where: { accountId: owner.id } })).toBe(0);
    expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, input))).toEqual(result);
  });
  it('refuses deletion from the current channel reference census without relying on the Settings root', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const resourceId = 'webhook-in-use';
    const ref = formatSharedSavedSecretRefV1(resourceId);
    expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Signing key', kind: 'token', encryptionMode: 'plain',
      storedContent: { t: 'plain', v: { v: 1, name: 'Signing key', kind: 'token', value: 'private' } } }))).toMatchObject({ ok: true });
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    try {
      const content = { t: 'plain', v: NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, topics: {}, id: 'used', kind: 'webhook', url: 'https://example.test/hook', signingSecretRef: ref }] }) };
      const request = { method: 'POST' as const, url: '/v1/account/entity-rows/notification-channels', headers: { 'x-test-user-id': owner.id } };
      const mutation = { expectedRevision: 'absent', sourceSettingsVersion: 0, content };
      expect((await app.inject({ ...request, payload: mutation })).json()).toEqual({ status: 'references-conflict' });
      expect((await app.inject({ ...request, payload: { ...mutation, savedSecretRevisions: [{ resourceRef: ref, revision: 0 }] } })).json())
        .toEqual({ status: 'references-conflict' });
      expect((await app.inject({ ...request, payload: { ...mutation, savedSecretRevisions: [{ resourceRef: ref, revision: 1 }] } })).json())
        .toMatchObject({ status: 'updated' });
      expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, expectedRevision: 1, expectedSettingsVersion: 0,
        referenceCensus: { ...capturedEmptyPlainReferenceCensus(), notificationChannels: { revision: 0, resourceRefs: [ref] } } })))
        .toEqual({ ok: false, error: 'resource_in_use' });
      expect(await db.savedSecretResource.count({ where: { id: resourceId } })).toBe(1);
    } finally { await app.close(); }
  });
  it('rejects a stale catalog capture before creating its signing resource', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    const url = '/v1/account/entity-rows/notification-channels';
    const headers = { 'x-test-user-id': owner.id };
    const empty = { t: 'plain', v: { v: 1, channels: [] } };
    try {
      expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 0, content: empty } })).json()).toMatchObject({ status: 'updated', revision: 0 });
      expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 0, content: empty } })).json()).toMatchObject({ status: 'updated', revision: 1 });
      const ref = formatSharedSavedSecretRefV1('webhook-stale');
      const input = { accountId: owner.id, resourceId: 'webhook-stale', displayName: 'Signing key', kind: 'token' as const, encryptionMode: 'plain' as const,
        storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Signing key', kind: 'token' as const, value: 'private' } },
        profileMutations: [], expectedSettingsVersion: 0, nextSettings: null,
        referenceCensus: { ...capturedEmptyPlainReferenceCensus(), notificationChannels: { revision: 0, resourceRefs: [] } },
        notificationChannelMutation: { expectedRevision: 0, content: { t: 'plain' as const, v: NotificationChannelCatalogRecordV1Schema.parse({ v: 1,
          channels: [{ v: 1, topics: {}, id: 'stale', kind: 'webhook', url: 'https://example.test/hook', signingSecretRef: ref }] }) }, savedSecretRevisions: [{ resourceRef: ref, revision: 1 }] } };
      expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, input))).toEqual({ ok: false, error: 'references_conflict' });
      expect(await db.savedSecretResource.count({ where: { id: input.resourceId } })).toBe(0);
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 1, content: empty });
      expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(0);
    } finally { await app.close(); }
  });
  it('normalizes channel history only under its exact destination catalog revision', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3 } });
    const previous = { t: 'plain' as const, v: { preferredLanguage: 'de', notificationChannelsV1: [
      { v: 1, id: 'old-hook', kind: 'webhook', url: 'https://example.test/hook', signingSecret: null },
    ] } };
    const cleaned = { t: 'plain', v: { preferredLanguage: 'de' } };
    await db.accountSettingsSnapshot.create({ data: { accountId: owner.id, version: 1, encryptionMode: 'plain', contentKind: 'plain',
      settingsDbValue: storePlainAccountSettingsDbValue({ accountId: owner.id, content: previous }) } });
    const catalog = encodeAccountScopedKvJson({ t: 'plain', v: { v: 1, channels: [] } });
    if (catalog === null) throw new Error('Notification catalog fixture encoding failed');
    await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/notification-channels/v1/catalog', version: 2, value: decodeBase64(catalog) } });
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    try {
      const mutation = { expectedSettingsVersion: 3, expectedProfileTransferRevision: 'absent',
        expectedEncryptionCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null }, expectedContent: previous,
        operation: { kind: 'normalize', removedRoots: ['notificationChannelsV1'], transferredPrivateCatalogRevisions: { notificationChannels: 1 }, content: cleaned } };
      const request = { method: 'POST' as const, url: '/v2/account/settings/history/1/mutate', headers: { 'x-test-user-id': owner.id } };
      expect((await app.inject({ ...request, payload: mutation })).json()).toEqual({ status: 'conflict' });
      expect((await app.inject({ ...request, payload: { ...mutation, operation: { ...mutation.operation,
        transferredPrivateCatalogRevisions: { notificationChannels: 2 } } } })).json()).toEqual({ status: 'applied' });
      expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(3);
    } finally { await app.close(); }
  });
  it('keeps partial stored channels readable but refuses to certify their secret inventory', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const content = { t: 'plain', v: { v: 1, channels: [{ v: 1, id: 'unknown', kind: 'future-channel' }] } };
    const encoded = encodeAccountScopedKvJson(content);
    if (encoded === null) throw new Error('Partial notification catalog fixture encoding failed');
    await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/notification-channels/v1/catalog', version: 2, value: decodeBase64(encoded) } });
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/notification-channels', headers: { 'x-test-user-id': owner.id } })).json())
        .toEqual({ status: 'present', revision: 2, content });
      expect(await inTx(tx => validateNotificationChannelReferenceCensusInTx(tx, { accountId: owner.id,
        capture: { revision: 2, resourceRefs: [] } }))).toEqual({ status: 'invalid-stored-content' });
      expect(await inTx(tx => validateNotificationChannelReferenceCensusInTx(tx, { accountId: owner.id })))
        .toEqual({ status: 'references-conflict' });
    } finally { await app.close(); }
  });
  it('refuses hidden reference carriers while keeping additive stored channels readable', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const knownRef = formatSharedSavedSecretRefV1('known-signing-key');
    const hiddenRef = formatSharedSavedSecretRefV1('unrepresented-signing-key');
    const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, topics: {},
      id: 'readable', kind: 'webhook', url: 'https://example.test/hook', signingSecretRef: knownRef }] });
    const content = { t: 'plain', v: { ...record, channels: [{ ...record.channels[0], future: { signingSecretRef: hiddenRef } }] } };
    const encoded = encodeAccountScopedKvJson(content);
    if (encoded === null) throw new Error('Hidden notification carrier fixture encoding failed');
    await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/notification-channels/v1/catalog', version: 2, value: decodeBase64(encoded) } });
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/notification-channels', headers: { 'x-test-user-id': owner.id } })).json())
        .toEqual({ status: 'present', revision: 2, content });
      expect(await inTx(tx => validateNotificationChannelReferenceCensusInTx(tx, { accountId: owner.id,
        capture: { revision: 2, resourceRefs: [knownRef] } }))).toEqual({ status: 'invalid-stored-content' });
      expect(notificationChannelCatalogRowDomain.parseMigrationStoredEnvelope(content)).toBeNull();
      expect((await app.inject({ method: 'POST', url: '/v1/account/entity-rows/notification-channels',
        headers: { 'x-test-user-id': owner.id }, payload: { expectedRevision: 2, content: null } })).json())
        .toEqual({ status: 'invalid-stored-content' });
      expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/notification-channels', headers: { 'x-test-user-id': owner.id } })).json())
        .toEqual({ status: 'present', revision: 2, content });
      const envelopeCarrierContent = { t: 'plain', v: record, future: { signingSecretRef: hiddenRef } };
      const envelopeCarrierEncoded = encodeAccountScopedKvJson(envelopeCarrierContent);
      if (envelopeCarrierEncoded === null) throw new Error('Hidden envelope carrier fixture encoding failed');
      await db.userKVStore.update({ where: { accountId_key: { accountId: owner.id, key: '@happier/account/notification-channels/v1/catalog' } },
        data: { version: 3, value: decodeBase64(envelopeCarrierEncoded) } });
      expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/notification-channels', headers: { 'x-test-user-id': owner.id } })).json())
        .toEqual({ status: 'present', revision: 3, content: envelopeCarrierContent });
      expect(await inTx(tx => validateNotificationChannelReferenceCensusInTx(tx, { accountId: owner.id,
        capture: { revision: 3, resourceRefs: [knownRef] } }))).toEqual({ status: 'invalid-stored-content' });
      expect(notificationChannelCatalogRowDomain.parseMigrationStoredEnvelope(envelopeCarrierContent)).toBeNull();
      const additiveContent = { t: 'plain', v: { ...record, channels: [{ ...record.channels[0], future: { color: 'green' } }] },
        future: { color: 'green' } };
      const additiveEncoded = encodeAccountScopedKvJson(additiveContent);
      if (additiveEncoded === null) throw new Error('Additive notification fixture encoding failed');
      await db.userKVStore.update({ where: { accountId_key: { accountId: owner.id, key: '@happier/account/notification-channels/v1/catalog' } },
        data: { version: 4, value: decodeBase64(additiveEncoded) } });
      expect(await inTx(tx => validateNotificationChannelReferenceCensusInTx(tx, { accountId: owner.id,
        capture: { revision: 4, resourceRefs: [knownRef] } }))).toEqual({ status: 'ready', resourceRefs: [knownRef] });
      expect(notificationChannelCatalogRowDomain.parseMigrationStoredEnvelope(additiveContent)).toEqual({ t: 'plain', v: record });
    } finally { await app.close(); }
  });
  it('binds signing-secret history proofs to their owned deterministic resource, revision, and exact retained value', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3 } });
    const source = { kind: 'notification-channel-signing-secret' as const, channelId: 'retained-hook' };
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id, source });
    const storedContent = { t: 'plain' as const, v: { v: 1 as const, name: 'Retained signing key', kind: 'token' as const, value: 'private' } };
    expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
      displayName: 'Retained signing key', kind: 'token', encryptionMode: 'plain', storedContent }))).toMatchObject({ ok: true, value: { revision: 1 } });
    const previous = { t: 'plain' as const, v: { preferredLanguage: 'de', notificationChannelsV1: [{ v: 1, topics: {},
      id: source.channelId, kind: 'webhook', url: 'https://example.test/hook', signingSecret: { _isSecretValue: true, value: 'private' } }] } };
    await db.accountSettingsSnapshot.create({ data: { accountId: owner.id, version: 1, encryptionMode: 'plain', contentKind: 'plain',
      settingsDbValue: storePlainAccountSettingsDbValue({ accountId: owner.id, content: previous }) } });
    const encoded = encodeAccountScopedKvJson({ t: 'plain', v: { v: 1, channels: [] } });
    if (encoded === null) throw new Error('Signed history catalog fixture encoding failed');
    await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/notification-channels/v1/catalog', version: 0, value: decodeBase64(encoded) } });
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    try {
      const request = { method: 'POST' as const, url: '/v2/account/settings/history/1/mutate', headers: { 'x-test-user-id': owner.id } };
      const mutation = { expectedSettingsVersion: 3, expectedProfileTransferRevision: 'absent', expectedContent: previous,
        expectedEncryptionCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null },
        operation: { kind: 'normalize', removedRoots: ['notificationChannelsV1'], transferredPrivateCatalogRevisions: { notificationChannels: 0 },
          content: { t: 'plain', v: { preferredLanguage: 'de' } } } };
      const proof = { source, resourceId, expectedRevision: 1 };
      const wrongTarget = deriveSavedSecretImportResourceIdV1({ accountId: `${owner.id}-different-account`, source });
      expect((await app.inject({ ...request, payload: { ...mutation, operation: { ...mutation.operation,
        savedSecretTransfers: [{ ...proof, resourceId: wrongTarget }] } } })).json()).toEqual({ status: 'invalid_content' });
      expect(await inTx(tx => updateSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, expectedRevision: 1,
        displayName: 'Retained signing key', kind: 'token', storedContent: { ...storedContent,
          v: { ...storedContent.v, value: 'different-private' } } }))).toMatchObject({ ok: true, value: { revision: 2 } });
      expect((await app.inject({ ...request, payload: { ...mutation, operation: { ...mutation.operation,
        savedSecretTransfers: [proof] } } })).json()).toEqual({ status: 'conflict' });
      expect((await app.inject({ ...request, payload: { ...mutation, operation: { ...mutation.operation,
        savedSecretTransfers: [{ ...proof, expectedRevision: 2 }] } } })).json()).toEqual({ status: 'invalid_content' });
      expect(await inTx(tx => updateSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, expectedRevision: 2,
        displayName: 'Retained signing key', kind: 'token', storedContent }))).toMatchObject({ ok: true, value: { revision: 3 } });
      expect((await app.inject({ ...request, payload: { ...mutation, operation: { ...mutation.operation,
        savedSecretTransfers: [{ ...proof, expectedRevision: 3 }] } } })).json()).toEqual({ status: 'applied' });
      expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(3);
    } finally { await app.close(); }
  });
  it('pairs present built-in channel edits with finite Settings CAS without reseeding empty or deleted catalogs', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3 } });
    const finiteSettings = (enabled: boolean) => ({ t: 'plain' as const, v: { preferredLanguage: 'de',
      notificationsSettingsV1: { pushEnabled: enabled },
      attentionDeliveryPolicyV1: AttentionDeliveryPolicyV1Schema.parse({ channels: { expo_push: { enabled } } }) } });
    const disabledSettings = finiteSettings(false);
    const enabledSettings = finiteSettings(true);
    await db.account.update({ where: { id: owner.id }, data: { settings: storePlainAccountSettingsDbValue({ accountId: owner.id, content: disabledSettings }) } });
    const disabled = { t: 'plain', v: NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, topics: {},
      id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID, kind: 'expo_push', enabled: false }] }) };
    const enabled = { t: 'plain', v: NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, topics: {},
      id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID, kind: 'expo_push', enabled: true }] }) };
    const empty = { t: 'plain', v: { v: 1, channels: [] } };
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    const url = '/v1/account/entity-rows/notification-channels';
    const headers = { 'x-test-user-id': owner.id,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
    const request = { method: 'POST' as const, url, headers };
    try {
      expect((await app.inject({ ...request, payload: { expectedRevision: 'absent', sourceSettingsVersion: 3, content: disabled,
        settingsMutation: { expectedSettingsVersion: 3, content: enabledSettings } } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
      expect((await app.inject({ ...request, payload: { expectedRevision: 'absent', sourceSettingsVersion: 3, content: disabled } })).json())
        .toMatchObject({ status: 'updated', revision: 0 });
      expect((await app.inject({ ...request, payload: { expectedRevision: 0, content: enabled,
        settingsMutation: { expectedSettingsVersion: 2, content: enabledSettings } } })).json()).toEqual({ status: 'settings-conflict', revision: 3 });
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content: disabled });
      expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json()).toEqual({ content: disabledSettings, version: 3 });
      expect(await db.accountSettingsSnapshot.count({ where: { accountId: owner.id } })).toBe(0);
      expect((await app.inject({ ...request, payload: { expectedRevision: 0, content: enabled,
        settingsMutation: { expectedSettingsVersion: 3, content: enabledSettings } } })).json()).toMatchObject({ status: 'updated', revision: 1, settingsVersion: 4 });
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 1, content: enabled });
      expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json()).toEqual({ content: enabledSettings, version: 4 });
      expect((await app.inject({ ...request, payload: { expectedRevision: 0, content: disabled,
        settingsMutation: { expectedSettingsVersion: 4, content: disabledSettings } } })).json()).toEqual({ status: 'conflict', revision: 1 });
      expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json()).toEqual({ content: enabledSettings, version: 4 });
      expect((await app.inject({ ...request, payload: { expectedRevision: 1, content: empty } })).json()).toMatchObject({ status: 'updated', revision: 2 });
      expect((await app.inject({ ...request, payload: { expectedRevision: 2, content: empty,
        settingsMutation: { expectedSettingsVersion: 4, content: disabledSettings } } })).json()).toMatchObject({ status: 'updated', revision: 3, settingsVersion: 5 });
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 3, content: empty });
      expect((await app.inject({ ...request, payload: { expectedRevision: 3, content: null } })).json()).toMatchObject({ status: 'updated', revision: 4 });
      expect((await app.inject({ method: 'POST', url: '/v2/account/settings', headers,
        payload: { expectedVersion: 5, content: enabledSettings } })).json()).toMatchObject({ success: true, version: 6 });
      expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'deleted', revision: 4 });
    } finally { await app.close(); }
  });
});
