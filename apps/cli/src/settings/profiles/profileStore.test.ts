import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ProfileRecordV1Schema, ProfileRowMutationV1Schema, ProfileProviderConversionMutationV1Schema, PROFILE_RECORDS_ROUTE_V1,
  openProfileRecordContentV1, sealProfileRecordContentV1, type ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { createLegacyProfileCloneRecordV1 } from '@happier-dev/protocol/profiles/read';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliProfileStore, createCliProfileStoreForOperation } from './profileStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
  LaunchProfileArtifactV1Schema, buildLaunchProfileArtifactHeaderV1, FeaturesResponseSchema,
  SavedSecretResourceMaterialsResponseV1Schema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['plain', 'e2ee'] as const)('admits a captured lossless legacy clone and forwards its source CAS on the %s writer', async mode => {
  const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
  const credentials = { token: 'captured-legacy-clone', encryption: mode === 'e2ee' ? material : null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const source = ProfileRecordV1Schema.parse({ v: 1, id: 'machine-login', enabled: false, promptStack: [],
    secretBindings: { MASKED: null }, definition: { kind: 'legacy', profile: { id: 'machine-login', name: 'Machine login',
      authMode: 'machineLogin', requiresMachineLoginTargetKey: 'agent:claude', environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'kept' }],
      createdAt: 1, updatedAt: 2 } } });
  const record = createLegacyProfileCloneRecordV1({ source, id: 'machine-login-copy', name: 'Copy', createdAt: 10, updatedAt: 10 });
  if (!record) throw new Error('Expected a supported legacy clone');
  const content = sealProfileRecordContentV1({ mode, material: mode === 'e2ee' ? material : null, record: source,
    randomBytes: length => new Uint8Array(length).fill(8) });
  const contentKeyFingerprint = mode === 'e2ee' ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null;
  // Only HTTP is replaced; captured source opening, semantic admission and mode-aware sealing remain real.
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/currentness') || path.endsWith('/account/encryption')) return { status: 200, data: {
      mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint, updatedAt: 1 } };
    if (path.endsWith('/entity-rows/profiles')) return { status: 200, data: { status: 'listed', rows: [{ id: source.id, revision: 4, content }],
      nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 5, transferControl: { status: 'absent' } } };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 5 } };
    if (path.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: null } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    throw new Error(`Unexpected clone read: ${path}`);
  });
  const submitted: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (_input, body) => {
    const mutation = ProfileRowMutationV1Schema.parse(body);
    submitted.push(mutation);
    expect(mutation).toMatchObject({ operation: 'clone-legacy', expectedRevision: 'absent', legacyCloneSource: { id: source.id, revision: 4 } });
    expect(openProfileRecordContentV1({ mode, material: mode === 'e2ee' ? material : null,
      expectedId: record.id, content: mutation.content })).toMatchObject({ status: 'opened', record });
    return { status: 200, data: { status: 'updated', revision: 0, cursor: 0, referenceGuardRevision: 6 } };
  });
  const store = createCliProfileStore({ credentials });
  await expect(store.writeRecord({ record, operation: 'clone-legacy', expectedRevision: 'absent', legacyCloneSource: { id: source.id, revision: 3 } }))
    .rejects.toBeInstanceOf(Error);
  expect(submitted).toEqual([]);
  await expect(store.writeRecord({ record, operation: 'clone-legacy', expectedRevision: 'absent', legacyCloneSource: { id: source.id, revision: 4 } }))
    .resolves.toMatchObject({ status: 'updated', revision: 0 });
  expect(submitted).toHaveLength(1);
});

it('loads a retained legacy Artifact through the single issued Account catalog capture even when absent from the grant list', async () => {
  const credentials = { token: 'bob-legacy-artifact', encryption: null };
  const raw = { profiles: [{ artifactId: 'retained-artifact' }] };
  const definition = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', secretBindings: {},
    profile: { v: 2, id: 'retained-profile', name: 'Retained', createdAt: 1, updatedAt: 2 } });
  const header = buildLaunchProfileArtifactHeaderV1(definition);
  const row = { id: 'retained-artifact', ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 2, bodyVersion: 4, seq: 4, createdAt: 1, updatedAt: 2 };
  const context = await runWithServerHttpBaseUrl('https://bob-home.test', async () => createInvocationSavedSecretOperationContextV1({
    credentials, serverHttpBaseUrl: 'https://bob-home.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  }));
  const artifactReads: string[] = [];
  // Only HTTP is replaced: Account custody, full paging, source selection and
  // the incumbent Plain Artifact opening/definition projection remain real.
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://bob-home.test');
    if (url.pathname.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.pathname.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.pathname.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 'absent' } };
    if (url.pathname.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
    if (url.pathname.endsWith('/entity-rows/profiles')) return { status: 200, data: { status: 'listed', rows: [],
      complete: true, nextCursor: null, diagnostics: [], referenceGuardRevision: 'absent', transferControl: { status: 'absent' } } };
    if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: raw } } };
    if (url.pathname === '/v1/artifacts') return { status: 200, data: [] };
    if (url.pathname === '/v1/artifacts/retained-artifact') { artifactReads.push(url.pathname); return { status: 200, data: row }; }
    throw new Error(`Unexpected issued Artifact boundary: ${url.pathname}`);
  });
  const projection = await createCliProfileStoreForOperation({ operationContext: context }).readCatalog();
  expect(projection.catalog).toMatchObject({ status: 'ready', source: 'legacy' });
  expect(projection.artifactsById.get('retained-artifact')).toMatchObject({ artifactId: 'retained-artifact',
    body: JSON.stringify(definition), revision: { headerVersion: 2, bodyVersion: 4 } });
  expect(artifactReads).toEqual(['/v1/artifacts/retained-artifact']);
});

it('refuses a newer predecessor source baseline than the issued Settings capture and recovers after genuine Settings refresh', async () => {
  const credentials = { token: 'bob-source-version', encryption: null };
  const raw = { profiles: [{ id: 'legacy', name: 'Current source', createdAt: 1, updatedAt: 2 }] };
  const context = await runWithServerHttpBaseUrl('https://bob-home.test', async () => createInvocationSavedSecretOperationContextV1({
    credentials, serverHttpBaseUrl: 'https://bob-home.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  }));
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 'absent' } };
    if (path.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path.endsWith('/entity-rows/profiles')) return { status: 200, data: { status: 'listed', rows: [], complete: true,
      nextCursor: null, diagnostics: [], referenceGuardRevision: 'absent', transferControl: { status: 'absent' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 2, content: { t: 'plain', v: raw } } };
    throw new Error(`Unexpected source-version boundary: ${path}`);
  });
  const store = createCliProfileStoreForOperation({ operationContext: context });
  await expect(store.readProfileCatalog()).resolves.toEqual({ status: 'unavailable', reason: 'reference-conflict' });
  const snapshot = context.readSnapshot();
  if (!snapshot) throw new Error('Missing issued Account capture');
  expect(await context.replaceAccountSettings({ ...snapshot, settingsVersion: 2 })).toBe(true);
  await expect(store.readProfileCatalog()).resolves.toMatchObject({ status: 'ready', source: 'legacy' });
});

it.each(['ready', 'access_removed', 'stale_selection'] as const)('captures private and inherited Artifact binding proofs without caller proofs, refusing %s references before mutation', async state => {
  const credentials = { token: 'bob-retained-binding-proof', encryption: null };
  const aliceCredentials = { token: 'alice-ambient-proof', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 9,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(aliceCredentials) });
  const aliceSnapshot = getActiveAccountSettingsSnapshot();
  const context = await runWithServerHttpBaseUrl('https://bob-proof-home.test', async () => createInvocationSavedSecretOperationContextV1({
    credentials, serverHttpBaseUrl: 'https://bob-proof-home.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  }));
  const resourceId = 'retained-credential';
  const ref = `happier:shared-secret:v1:${resourceId}`;
  const inheritedResourceId = 'inherited-credential';
  const inheritedRef = `happier:shared-secret:v1:${inheritedResourceId}`;
  const materialStatus = state === 'access_removed' ? 'access_removed' : 'ready';
  const resources = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId,
    encryptionMode: 'plain', recipientEnvelope: null,
    entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Retained credential', kind: 'apiKey',
      ownerAccountId: 'owner-account', revision: 7, materialStatus: 'ready',
      capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
      content: { v: 1, name: 'Retained credential', kind: 'apiKey', value: 'boundary-fixture' } }),
  }, { resourceId: inheritedResourceId, encryptionMode: 'plain', recipientEnvelope: null,
    entry: { ref: inheritedRef, source: 'shared_resource', relationship: 'recipient', name: 'Inherited credential', kind: 'apiKey',
      ownerAccountId: 'owner-account', revision: 11, materialStatus,
      capabilities: { use: materialStatus === 'ready', rename: false, rotate: false, manageAccess: false, delete: false } },
    storedContent: materialStatus === 'ready' ? sealSavedSecretResourceStoredContentV1({ resourceId: inheritedResourceId, mode: 'plain',
      content: { v: 1, name: 'Inherited credential', kind: 'apiKey', value: 'inherited-boundary-fixture' } }) : null,
  }] });
  const artifactId = 'retained-artifact-proof';
  const definition = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
    secretBindings: { TOKEN: inheritedRef, INHERITED: inheritedRef, OPTIONAL_TOKEN: 'happier:shared-secret:v1:missing-masked' },
    profile: { v: 2, id: 'retained-profile', name: 'Retained', createdAt: 1, updatedAt: 1 } });
  const artifact = { id: artifactId, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent(buildLaunchProfileArtifactHeaderV1(definition)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 2, bodyVersion: 4, seq: 4, createdAt: 1, updatedAt: 2 };
  // HTTP is the only replacement. Issued custody, resource admission/opening,
  // value-free revision projection and Profile sealing remain canonical.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('https://bob-proof-home.test');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
    return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} })),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.spyOn(axios, 'get').mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://bob-proof-home.test');
    expect(options?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.pathname === `/v1/artifacts/${artifactId}`) return { status: 200, data: artifact };
    if (url.pathname === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: resources };
    throw new Error(`Unexpected captured binding proof request: ${url.pathname}`);
  });
  const committed: unknown[] = [];
  const dispatched: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://bob-proof-home.test');
    expect(url.pathname).toBe(PROFILE_RECORDS_ROUTE_V1);
    const mutation = ProfileRowMutationV1Schema.parse(body);
    dispatched.push(mutation);
    if (JSON.stringify(mutation.savedSecretRevisions) !== JSON.stringify([
      { resourceId, expectedRevision: 7 }, { resourceId: inheritedResourceId, expectedRevision: 11 },
    ])) {
      return { status: 409, data: { status: 'invalid-reference', reason: 'saved-secret-revision-required' } };
    }
    committed.push(mutation);
    return { status: 200, data: { status: 'updated', revision: 5, cursor: 5, referenceGuardRevision: 5 } };
  });
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'retained-profile', enabled: true, promptStack: [],
    secretBindings: { TOKEN: ref, OPTIONAL_TOKEN: null },
    definition: { kind: 'artifact', artifactId } });
  const write = createCliProfileStoreForOperation({ operationContext: context }).writeRecord({ record, operation: 'update', expectedRevision: 4,
    ...(state === 'stale_selection' ? { savedSecretRevisions: [{ resourceId, expectedRevision: 6 }] } : {}) });
  if (state === 'ready') {
    await expect(write).resolves.toMatchObject({ status: 'updated', revision: 5 });
    expect(committed).toMatchObject([{ referencedSavedSecretIds: [ref, inheritedRef],
      savedSecretRevisions: [{ resourceId, expectedRevision: 7 }, { resourceId: inheritedResourceId, expectedRevision: 11 }],
      artifactRevision: { artifactId, headerVersion: 2, bodyVersion: 4 },
      content: { t: 'plain', v: { secretBindings: { TOKEN: ref, OPTIONAL_TOKEN: null } } } }]);
  } else {
    await expect(write).rejects.toBeInstanceOf(Error);
    expect(committed).toEqual([]);
    expect(dispatched).toEqual([]);
  }
  expect(getActiveAccountSettingsSnapshot()).toBe(aliceSnapshot);
});

it.each(['plain', 'e2ee'] as const)('preserves inherited inline bytes on %s edits but refuses them for new creation before dispatch', async mode => {
  const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
  const credentials = { token: 'retained-profile-edit', encryption: mode === 'e2ee' ? material : null };
  const id = `  legacy/branch\\資料/😀-${'x'.repeat(300)}  `;
  const record = { v: 1, id, enabled: false, promptStack: [], secretBindings: {}, definition: { kind: 'inline', profile: {
    v: 2, id, name: `  ${'n'.repeat(96)}  `, description: 'Retained source definition',
    extraEnvironmentVariables: Array.from({ length: 257 }, (_, index) => ({ name: `CONFIG_${index}`, value: `value-${index}`, isSecret: false })),
    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 2,
  } } } satisfies ProfileRecordV1;
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const contentKeyFingerprint = mode === 'e2ee' ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null;
  // Only HTTP is replaced. Persisted-mode admission, operation admission,
  // sealing and authenticated destination opening remain the real owners.
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
    mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint, updatedAt: 1,
  } });
  const persisted: ProfileRecordV1[] = [];
  const submitted: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    submitted.push(body);
    expect(new URL(String(input)).pathname).toBe(PROFILE_RECORDS_ROUTE_V1);
    const mutation = ProfileRowMutationV1Schema.parse(body);
    expect(mutation).toMatchObject({ id, operation: 'update', expectedRevision: 4, content: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
    const opened = openProfileRecordContentV1({ mode, material: mode === 'e2ee' ? material : null,
      expectedId: id, content: mutation.content });
    if (opened.status !== 'opened') throw new Error(`Could not open actual Profile mutation: ${opened.reason}`);
    persisted.push(opened.record);
    return { status: 200, data: { status: 'updated', revision: 5, cursor: 5, referenceGuardRevision: 5 } };
  });
  const store = createCliProfileStore({ credentials });
  await expect(store.writeRecord({ record, expectedRevision: 4, operation: 'update' })).resolves.toMatchObject({ status: 'updated', revision: 5 });
  expect(persisted).toEqual([record]);
  const createId = 'new-profile';
  const createRecord = { ...record, id: createId, definition: { kind: 'inline' as const,
    profile: { ...record.definition.profile, id: createId } } };
  await expect(store.writeRecord({ record: createRecord, expectedRevision: 'absent', operation: 'create' })).rejects.toBeInstanceOf(Error);
  expect(persisted).toEqual([record]);
  // An invalid new definition must not rely on the server to refuse its write.
  expect(submitted).toEqual([expect.objectContaining({ id, operation: 'update' })]);
});

it('writes destination rows and removes only owned preferences in the same exact Settings CAS', async () => {
  const credentials = { token: 'profile-store-test', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const raw = { favoriteProfiles: ['focused', 'other'], profileEnabledById: { focused: true, other: false },
    untouchedFutureOwner: { opaque: ['keep'] } };
  const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId: 'credential',
    encryptionMode: 'plain', recipientEnvelope: null,
    entry: { ref: 'happier:shared-secret:v1:credential', source: 'shared_resource', relationship: 'owner',
      name: 'Credential', kind: 'token', revision: 2, materialStatus: 'ready',
      capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'credential', mode: 'plain',
      content: { v: 1, name: 'Credential', kind: 'token', value: 'http-boundary-fixture' } }),
  }] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
    return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} })),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  // Exact Home HTTP is the boundary; raw opening, preference cleanup and record sealing stay real.
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: raw }, version: 7 } };
    if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: materials };
    throw new Error(`Unexpected Profile store request: ${path}`);
  });
  const mutations: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    expect(new URL(String(input)).pathname).toBe(PROFILE_RECORDS_ROUTE_V1);
    const mutation = ProfileRowMutationV1Schema.parse(body);
    mutations.push(mutation);
    return { status: 200, data: { status: 'updated', revision: 5, cursor: 5, referenceGuardRevision: 5 } };
  });
  const store = createCliProfileStore({ credentials });
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'focused', enabled: true, promptStack: [],
    secretBindings: { TOKEN: 'happier:shared-secret:v1:credential', OPTIONAL_TOKEN: null },
    definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } } });
  await store.writeRecord({ record, expectedRevision: 4, operation: 'update',
    savedSecretRevisions: [{ resourceId: 'credential', expectedRevision: 2 }] });
  await store.deleteRecord({ id: 'focused', expectedRevision: 5, previousDefinition: record.definition });
  expect(mutations).toMatchObject([
    { id: 'focused', operation: 'update', expectedRevision: 4, content: { t: 'plain', v: record },
      referencedSavedSecretIds: ['happier:shared-secret:v1:credential'],
      savedSecretRevisions: [{ resourceId: 'credential', expectedRevision: 2 }] },
    { id: 'focused', operation: 'remove', expectedRevision: 5, content: null,
      settingsCleanup: { expectedSettingsVersion: 7, nextSettings: { t: 'plain', v: {
        favoriteProfiles: ['other'], profileEnabledById: { other: false }, untouchedFutureOwner: raw.untouchedFutureOwner,
      } } } },
  ]);
});

it('dispatches the strict Profile, Provider catalog and Settings composite to its one transaction route', async () => {
  const credentials = { token: 'composite-test', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/profiles/provider-conversion');
    expect(ProfileProviderConversionMutationV1Schema.parse(body)).toMatchObject({ expectedSettingsVersion: 7, profileCensus: [],
      providerMutation: { expectedRevision: 'absent', sourceSettingsVersion: 7, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } });
    return { status: 200, data: { status: 'updated', settingsVersion: 8, providerRevision: 0, rows: [], referenceGuardRevision: 'absent' } };
  });
  const store = createCliProfileStore({ credentials });
  const mutation = ProfileProviderConversionMutationV1Schema.parse({ operation: 'provider-conversion', expectedAccountMode: 'plain',
    expectedSettingsVersion: 7, expectedProfileTransferRevision: 'absent', expectedReferenceGuardRevision: 'absent',
    profileCensus: [], mutations: [], nextSettings: { t: 'plain', v: {} }, providerMutation: { expectedRevision: 'absent',
      sourceSettingsVersion: 7, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 }, referencedSavedSecretIds: [], savedSecretRevisions: [] } });
  await expect(store.providerConversion(mutation)).resolves.toMatchObject({ status: 'updated', settingsVersion: 8, providerRevision: 0 });
});

it('preserves a committed row receipt when the caller Account retires during dispatch', async () => {
  const credentials = { token: 'profile-receipt-test', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
  vi.spyOn(axios, 'post').mockImplementation(async () => {
    resetActiveAccountSettingsSnapshotForTests();
    return { status: 200, data: { status: 'updated', revision: 5, cursor: 5, referenceGuardRevision: 5 } };
  });
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'focused', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } } });
  await expect(createCliProfileStore({ credentials }).writeRecord({ record, expectedRevision: 4, operation: 'update' }))
    .resolves.toMatchObject({ status: 'updated', revision: 5 });
});

it('classifies a lost mutation response as outcome unknown without replaying the write', async () => {
  const credentials = { token: 'profile-unknown-test', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
  const effects: string[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (_input, body) => {
    effects.push(ProfileRowMutationV1Schema.parse(body).id);
    throw new Error('Connection closed after server commit');
  });
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'focused', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } } });
  await expect(createCliProfileStore({ credentials }).writeRecord({ record, expectedRevision: 4, operation: 'update' }))
    .rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(effects).toEqual(['focused']);
});

it('rechecks the row census when another client activates and cleans up during the source read', async () => {
  const credentials = { token: 'profile-activation-race', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  let activated = false;
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'focused', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'inline', profile: { v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1 } } });
  const transfer = () => activated ? { status: 'present', revision: 2, content: { t: 'plain', v: {
    v: 1, phase: 'active', sourceSettingsVersion: 7, migratedLogicalRevision: 1, inventory: [],
  } } } : { status: 'absent' };
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: activated ? 1 : 'absent' } };
    if (path.endsWith('/transfer')) return { status: 200, data: transfer() };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed',
      rows: activated ? [{ id: record.id, revision: 1, content: { t: 'plain', v: record } }] : [],
      complete: true, nextCursor: null, diagnostics: [], referenceGuardRevision: activated ? 1 : 'absent', transferControl: transfer() } };
    if (path === '/v2/account/settings') {
      activated = true;
      return { status: 200, data: { version: 8, content: { t: 'plain', v: {} } } };
    }
    throw new Error(`Unexpected activation race boundary: ${path}`);
  });
  await expect(createCliProfileStore({ credentials }).readProfileCatalog()).resolves.toEqual({
    status: 'unavailable', reason: 'reference-conflict',
  });
});

it('reads Artifact grants from the same captured Home as its Profile rows', async () => {
  const credentials = { token: 'profile-artifact-home', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const control = { status: 'present', revision: 1, content: { t: 'plain', v: {
    v: 1, phase: 'active', sourceSettingsVersion: 7, migratedLogicalRevision: 1, inventory: [],
  } } };
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://captured-home.test');
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.pathname.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 'absent' } };
    if (url.pathname.endsWith('/transfer')) return { status: 200, data: control };
    if (url.pathname === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed',
      rows: [], complete: true, nextCursor: null, diagnostics: [], referenceGuardRevision: 'absent', transferControl: control } };
    if (url.pathname === '/v1/artifacts') return { status: 200, data: [] };
    throw new Error(`Unexpected Artifact Home boundary: ${url.pathname}`);
  });
  const store = runWithServerHttpBaseUrl('https://captured-home.test', () => createCliProfileStore({ credentials }));
  await expect(runWithServerHttpBaseUrl('https://other-home.test', () => store.readCatalog()))
    .resolves.toMatchObject({ catalog: { status: 'ready', source: 'destination' }, artifactsById: new Map() });
});
