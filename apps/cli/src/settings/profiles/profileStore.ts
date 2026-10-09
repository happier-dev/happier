import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { loadProfileCatalogV1, type ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { isLegacyProfileSourcePreservingCloneV1, loadAiLaunchProfileArtifacts, removeProfilePreferenceReferencesV1, readEffectiveProfileSecretBindingsV1 } from '@happier-dev/protocol/profiles/read';
import { prepareBuiltinProfileAttachmentV1 } from '@happier-dev/protocol/profiles/profileOperations';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, ProfileRowsListResponseV1Schema, ProfileReferenceGuardReadResponseV1Schema,
  ProfileRowMutationV1Schema, ProfileRowMutationResponseV1Schema, sealProfileRecordContentV1,
  parseProfileRecordForMutationV1,
  PROFILE_PROVIDER_CONVERSION_ROUTE_V1, ProfileProviderConversionMutationV1Schema, ProfileProviderConversionResponseV1Schema,
  type ProfileProviderConversionMutationV1, type ProfileRecordV1, type ProfileRowMutationV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema,
  ProfileTransferMutationV1Schema, ProfileTransferMutationResponseV1Schema,
  type ProfileTransferMutationV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { parseSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { readSavedSecretRevisionsFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';

/** Captured Home/Account transport shared by Profile hydration and typed Actions. */
export function createCliProfileStore(input: Readonly<{ credentials: StoredCredentials; signal?: AbortSignal }>) {
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw Object.assign(new Error('Captured Profile Account retired'), { code: 'scope-retired' });
    }
  };
  return createCapturedCliProfileStore({ ...input, serverHttpBaseUrl: resolveServerHttpBaseUrl(), assertCurrent });
}

/** The issued invocation Account owner supplies custody, never an ambient Account or a caller-created scope pair. */
export function createCliProfileStoreForOperation(input: Readonly<{
  operationContext: SavedSecretOperationContextV1; signal?: AbortSignal;
}>) {
  const context = input.operationContext;
  const scopeKey = context.readSnapshot()?.scopeKey;
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (!scopeKey || context.readSnapshot()?.scopeKey !== scopeKey) {
      throw Object.assign(new Error('Captured Profile Account retired'), { code: 'scope-retired' });
    }
  };
  return createCapturedCliProfileStore({ credentials: context.credentials, serverHttpBaseUrl: context.serverHttpBaseUrl,
    operationContext: context,
    signal: input.signal, assertCurrent, readSettingsVersion: () => context.readSnapshot()?.settingsVersion, verifyCurrent: async () => {
      if (!await context.isCurrent()) throw Object.assign(new Error('Captured Profile Account retired'), { code: 'scope-retired' });
    } });
}

function createCapturedCliProfileStore(input: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  assertCurrent(): void; verifyCurrent?(): Promise<void>; readSettingsVersion?(): number | undefined;
}>) {
  const base = input.serverHttpBaseUrl.replace(/\/+$/, '');
  const assertCurrent = input.assertCurrent;
  const verifyCurrent = async () => {
    assertCurrent();
    await input.verifyCurrent?.();
    assertCurrent();
  };
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}`,
    'Content-Type': 'application/json' };
  const request = async (path: string, body?: unknown) => {
    await verifyCurrent();
    const options = { headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true };
    const response = body === undefined ? await axios.get(`${base}${path}`, options)
      : await axios.post(`${base}${path}`, body, options).catch(() => {
        // A dispatched mutation may already have committed; no automatic replay.
        throw Object.assign(new Error('Profile mutation outcome is unknown'), { code: 'outcome_unknown' });
      });
    // Effect-only mutation receipts remain truthful after caller retirement.
    // Reads still refuse private disclosure from a retired Account.
    if (body === undefined) await verifyCurrent();
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      throw Object.assign(new Error('Profile Account transport unavailable'), { code:
        response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
          : response.status === 404 ? 'unsupported' : 'unreachable' });
    }
    return response.data as unknown;
  };
  const readStorageContext = async () => {
    await verifyCurrent();
    const context = await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base,
      signal: input.signal, shouldContinue: () => {
        assertCurrent();
        return true;
      }, authorizationHeaders: headers });
    await verifyCurrent();
    return context;
  };
  const readPage = async (cursor?: string) => ProfileRowsListResponseV1Schema.parse(await request(
    `${PROFILE_ROWS_ROUTE_V1}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
  const readReferenceGuard = async () => ProfileReferenceGuardReadResponseV1Schema.parse(await request(`${PROFILE_ROWS_ROUTE_V1}/reference-guard`));
  const readTransfer = async () => ProfileTransferRowReadResponseV1Schema.parse(await request(PROFILE_TRANSFER_ROUTE_V1));
  const mutateRecord = async (mutation: ProfileRowMutationV1) => ProfileRowMutationResponseV1Schema.parse(await request(
    PROFILE_RECORDS_ROUTE_V1, ProfileRowMutationV1Schema.parse(mutation)));
  const readProfileCatalogCapture = async () => {
    const context = await readStorageContext();
    const settingsVersion = input.readSettingsVersion?.();
    const captured: { source: Awaited<ReturnType<typeof readSourceSnapshot>> | null } = { source: null };
    const catalog = await loadProfileCatalogV1({ ...context, signal: input.signal, readPage, readReferenceGuard, readTransfer,
      readSource: async () => {
        captured.source = await readSourceSnapshot();
        return captured.source.raw;
      } });
    const admitted = await readStorageContext();
    await verifyCurrent();
    const result: ProfileCatalogSnapshotV1 = admitted.mode !== context.mode
      ? { status: 'unavailable', reason: 'account-mode-mismatch' }
      : captured.source && input.readSettingsVersion && (captured.source.version !== settingsVersion
        || input.readSettingsVersion() !== settingsVersion)
        ? { status: 'unavailable', reason: 'reference-conflict' } : catalog;
    return { catalog: result, source: captured.source };
  };
  const readProfileCatalog = async () => (await readProfileCatalogCapture()).catalog;
  const readSourceSnapshot = async () => {
    const context = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => context.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    await verifyCurrent();
    return { ...source, ...context };
  };
  const sealSettingsCleanup = (source: Awaited<ReturnType<typeof readSourceSnapshot>>, raw: Readonly<Record<string, unknown>>) => ({
    expectedSettingsVersion: source.version,
    nextSettings: source.mode === 'plain' ? { t: 'plain' as const, v: raw } : { t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: source.material, payload: raw,
        randomBytes: (length) => new Uint8Array(randomBytes(length)) }) },
  });
  const readCatalog = async () => {
    const { catalog, source } = await readProfileCatalogCapture();
    if (catalog.status !== 'ready') return { catalog, artifactsById: new Map<string, ArtifactSharingResourceV1>() };
    const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
    const references = [...catalog.records.map(({ record }) => record),
      ...(catalog.source === 'legacy' && Array.isArray(source?.raw.profiles) ? source.raw.profiles : [])];
    const artifactsById = await runWithServerHttpBaseUrl(base, () => loadAiLaunchProfileArtifacts(references,
      createCredentialedAccountArtifactStore(input.credentials), input.signal));
    await verifyCurrent();
    if (source && input.readSettingsVersion && input.readSettingsVersion() !== source.version) {
      return { catalog: { status: 'unavailable' as const, reason: 'reference-conflict' as const },
        artifactsById: new Map<string, ArtifactSharingResourceV1>() };
    }
    return { catalog, artifactsById };
  };
  return {
    assertCurrent,
    readStorageContext,
    readProfileCatalog,
    readSourceSnapshot,
    replaceSource: async (value: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number;
      expectedProfileTransferRevision: number }>) => {
      const context = await readStorageContext();
      const response = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials, ...value,
        envelopeKind: context.mode === 'plain' ? 'plain' : 'encrypted', signal: input.signal, deps: {
          resolveAccountEncryptionMode: async () => context.mode,
          updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
        } });
      return response.success ? { status: 'applied' as const, settingsVersion: response.version }
        : response.error === 'version-mismatch' ? { status: 'conflict' as const, currentSettingsVersion: response.currentVersion }
        : { status: 'rejected' as const };
    },
    mutateTransfer: async (mutation: ProfileTransferMutationV1) => ProfileTransferMutationResponseV1Schema.parse(
      await request(PROFILE_TRANSFER_ROUTE_V1, ProfileTransferMutationV1Schema.parse(mutation))),
    providerConversion: async (mutation: ProfileProviderConversionMutationV1) => ProfileProviderConversionResponseV1Schema.parse(
      await request(PROFILE_PROVIDER_CONVERSION_ROUTE_V1, ProfileProviderConversionMutationV1Schema.parse(mutation))),
    readCatalog,
    writeRecord: async (value: Readonly<{ record: ProfileRecordV1; expectedRevision: number | 'absent'; operation: Exclude<ProfileRowMutationV1['operation'], 'remove'>;
      savedSecretRevisions?: ProfileRowMutationV1['savedSecretRevisions']; legacyCloneSource?: ProfileRowMutationV1['legacyCloneSource'] }>) => {
      let record = parseProfileRecordForMutationV1({ operation: value.operation, record: value.record });
      if (value.operation === 'clone-legacy') {
        const capture = value.legacyCloneSource;
        if (!capture) throw Object.assign(new Error('Legacy clone source is unavailable'), { code: 'invalid-reference' });
        const { catalog, artifactsById } = await readCatalog();
        if (catalog.status !== 'ready' || catalog.source !== 'destination') throw Object.assign(new Error('Profile source catalog is unavailable'), { code: 'invalid-reference' });
        const source = catalog.records.find(row => row.record.id === capture.id);
        if (!source || source.revision !== capture.revision) throw Object.assign(new Error('Legacy clone source changed'), { code: 'reference-conflict' });
        const artifact = source.record.definition.kind === 'artifact' ? artifactsById.get(source.record.definition.artifactId) : undefined;
        if (source.record.definition.kind === 'artifact' ? (!capture.artifactRevision || !artifact?.revision
          || capture.artifactRevision.artifactId !== artifact.artifactId || capture.artifactRevision.headerVersion !== artifact.revision.headerVersion
          || capture.artifactRevision.bodyVersion !== artifact.revision.bodyVersion) : capture.artifactRevision !== undefined)
          throw Object.assign(new Error('Legacy clone Artifact changed'), { code: 'reference-conflict' });
        if (!isLegacyProfileSourcePreservingCloneV1({ source: source.record, record, artifactsById }))
          throw Object.assign(new Error('Legacy clone changed its source definition'), { code: 'invalid-reference' });
      }
      const source = value.operation === 'attach-builtin' ? await readSourceSnapshot() : undefined;
      const context = source ?? await readStorageContext();
      let settingsCleanup: ProfileRowMutationV1['settingsCleanup'];
      if (source) {
        const prepared = prepareBuiltinProfileAttachmentV1(record, source.raw);
        record = prepared.record;
        settingsCleanup = sealSettingsCleanup(source, prepared.nextSettings);
      }
      let artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1> = new Map();
      if (record.definition.kind === 'artifact') {
        const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
        artifactsById = await runWithServerHttpBaseUrl(base, () => {
          const store = createCredentialedAccountArtifactStore(input.credentials);
          return loadAiLaunchProfileArtifacts([record], { read: (id, options) => store.read(id, options) }, input.signal);
        });
        await verifyCurrent();
      }
      const bindings = readEffectiveProfileSecretBindingsV1(record, { artifactsById });
      if (!bindings) throw Object.assign(new Error('Profile Artifact references are unavailable'), { code: 'invalid-reference' });
      const artifactId = record.definition.kind === 'artifact' ? record.definition.artifactId : undefined;
      const artifact = artifactId ? artifactsById.get(artifactId) : undefined;
      if (artifactId && !artifact?.revision) throw Object.assign(new Error('Profile Artifact revision is unavailable'), { code: 'invalid-reference' });
      const referencedSavedSecretIds = [...new Set(Object.values(bindings))];
      const sharedRefs = referencedSavedSecretIds.filter(ref => parseSavedSecretCatalogReferenceV1(ref)?.kind === 'shared_resource');
      let savedSecretRevisions: ProfileRowMutationV1['savedSecretRevisions'] = [];
      if (sharedRefs.length > 0) {
        const { createInvocationSavedSecretOperationContextV1, readSavedSecretCatalogForOperation } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
        const operationContext = input.operationContext ?? await runWithServerHttpBaseUrl(base, async () => {
          const snapshot = getActiveAccountSettingsSnapshot();
          if (!snapshot) throw Object.assign(new Error('Profile SavedSecret Account is unavailable'), { code: 'invalid-reference' });
          return createInvocationSavedSecretOperationContextV1({ credentials: input.credentials, serverHttpBaseUrl: base, snapshot,
            isCurrent: async () => { try { await verifyCurrent(); return true; } catch { return false; } } });
        });
        const expectedScopeKey = operationContext.readSnapshot()?.scopeKey;
        if (!expectedScopeKey) throw Object.assign(new Error('Profile SavedSecret Account is unavailable'), { code: 'invalid-reference' });
        const selected = new Map(value.savedSecretRevisions?.map(proof => [proof.resourceId, proof.expectedRevision]));
        const snapshot = await runWithServerHttpBaseUrl(base, () => readSavedSecretCatalogForOperation({
          expectedScopeKey, operationContext, signal: input.signal,
          references: sharedRefs.map(ref => {
            const reference = parseSavedSecretCatalogReferenceV1(ref);
            const revision = reference ? selected.get(reference.id) : undefined;
            return { ref, ...(revision === undefined ? {} : { revision }) };
          }),
        }));
        const revisions = readSavedSecretRevisionsFromSnapshotV1(snapshot, sharedRefs,
          { isCurrent: () => operationContext.readSnapshot() === snapshot });
        if (revisions.status !== 'ready') throw Object.assign(new Error('Profile SavedSecret revisions are unavailable'), { code: 'invalid-reference' });
        savedSecretRevisions = [...new Map([...revisions.resourcesByRef.values()]
          .map(({ resourceId, revision }) => [resourceId, { resourceId, expectedRevision: revision }] as const)).values()];
        await verifyCurrent();
      }
      return await mutateRecord({ id: record.id, operation: value.operation, expectedRevision: value.expectedRevision,
        content: sealProfileRecordContentV1({ ...context, record }),
        referencedSavedSecretIds, savedSecretRevisions,
        artifactRevision: artifactId && artifact?.revision ? { artifactId,
          headerVersion: artifact.revision.headerVersion, bodyVersion: artifact.revision.bodyVersion } : null,
        ...(value.legacyCloneSource ? { legacyCloneSource: value.legacyCloneSource } : {}),
        ...(settingsCleanup ? { settingsCleanup } : {}) });
    },
    deleteRecord: async (value: Readonly<{ id: string; expectedRevision: number; previousDefinition: ProfileRecordV1['definition'] }>) => {
      const source = await readSourceSnapshot();
      const raw = removeProfilePreferenceReferencesV1(source.raw, value.id, value.previousDefinition);
      return await mutateRecord({ id: value.id, operation: 'remove', expectedRevision: value.expectedRevision, content: null,
        referencedSavedSecretIds: [], settingsCleanup: sealSettingsCleanup(source, raw) });
    },
  };
}

export type CliProfileStore = ReturnType<typeof createCliProfileStore>;
