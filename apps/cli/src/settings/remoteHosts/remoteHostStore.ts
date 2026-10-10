import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadRemoteHostCatalogProjectionV1 } from '@happier-dev/protocol/remoteHosts/remoteHostCatalogV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRowReadResponseV1Schema, RemoteHostCatalogRowMutationV1Schema,
  RemoteHostCatalogRowMutationResponseV1Schema, RemoteHostRecordV1Schema, readRetainedRemoteHostCatalogV1,
  sealRemoteHostCatalogContentV1, loadRemoteHostCatalogV1, type RemoteHostCatalogRowMutationV1, type RemoteHostCatalogSnapshotV1,
  type LegacyRemoteHostRecordV1, type RemoteHostRecordV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import type { RemoteHostActionInputByIdV1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import { SavedSecretCatalogReferenceCensusV1Schema, type SharedSavedSecretCreateInputV1,
  type SavedSecretCatalogReferenceCensusV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { formatSharedSavedSecretRefV1, parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { decryptSecretValueWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettingsHistorySavedSecretRecoveryV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import { createInvocationSavedSecretOperationContextV1, readSavedSecretCatalogForOperation,
  prepareSavedSecretResourceCreateForOperation, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createSavedSecretMaterializerFromSnapshotV1, readSavedSecretRevisionsFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';

type SaveInput = RemoteHostActionInputByIdV1['remote_hosts.save'];
type Address = RemoteHostActionInputByIdV1['remote_hosts.delete'];
type Source = Readonly<{ version: number; raw: Readonly<Record<string, unknown>> }>;
type MutationResult = Readonly<{ status: 'updated'; hostId: string; revision: number }>
  | Readonly<{ status: 'conflict'; revision: number }>
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'outcome_unknown' }>;

export function createCliRemoteHostStore(input: Readonly<{ credentials: StoredCredentials; signal?: AbortSignal }>) {
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  return createCapturedStore({ ...input, serverHttpBaseUrl: resolveServerHttpBaseUrl(), assertCurrent: () => {
    input.signal?.throwIfAborted();
    if (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    }
  } });
}

export function createCliRemoteHostStoreForOperation(input: Readonly<{
  operationContext: SavedSecretOperationContextV1; signal?: AbortSignal;
}>) {
  const operationContext = input.operationContext;
  const scopeKey = operationContext.readSnapshot()?.scopeKey;
  return createCapturedStore({ credentials: operationContext.credentials, serverHttpBaseUrl: operationContext.serverHttpBaseUrl,
    operationContext, signal: input.signal, assertCurrent: () => {
      input.signal?.throwIfAborted();
      if (!scopeKey || operationContext.readSnapshot()?.scopeKey !== scopeKey) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    }, verifyCurrent: async () => {
      if (!await operationContext.isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    } });
}

function createCapturedStore(input: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1; assertCurrent(): void; verifyCurrent?(): Promise<void>;
}>) {
  const base = input.serverHttpBaseUrl.replace(/\/+$/, '');
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}`,
    'Content-Type': 'application/json' };
  const assertCurrent = input.assertCurrent;
  let admittedStorage: Awaited<ReturnType<typeof resolveCliAccountStorageContext>> | undefined;
  const verifyCurrent = async () => { assertCurrent(); await input.verifyCurrent?.(); assertCurrent(); };
  const isCurrent = async () => { try { await verifyCurrent(); return true; } catch { return false; } };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    await verifyCurrent();
    const options = { headers, signal: input.signal, validateStatus: () => true };
    const response = body === undefined ? await axios.get(`${base}${path}`, options)
      : await axios.post(`${base}${path}`, body, options).catch(() => {
        throw Object.assign(new Error('outcome_unknown'), { code: 'outcome_unknown' });
      });
    if (body === undefined) await verifyCurrent();
    if ((response.status < 200 || response.status >= 300) && response.status !== 409) {
      throw Object.assign(new Error('remote_host_transport_unavailable'), { code: response.status === 404 ? 'unsupported' : 'remote_host_transport_unavailable' });
    }
    return response.data;
  };
  const readStorageContext = async () => {
    await verifyCurrent();
    const context = await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base,
      authorizationHeaders: headers, signal: input.signal, shouldContinue: () => { assertCurrent(); return true; } });
    await verifyCurrent();
    admittedStorage = context;
    return context;
  };
  const readRow = async () => RemoteHostCatalogRowReadResponseV1Schema.parse(await request(REMOTE_HOST_ROWS_ROUTE_V1));
  const mutateCatalog = async (packet: Readonly<{ mutation: RemoteHostCatalogRowMutationV1;
    savedSecretResources?: readonly SharedSavedSecretCreateInputV1[]; referenceCensus?: SavedSecretCatalogReferenceCensusV1 }>) => {
    const mutation = RemoteHostCatalogRowMutationV1Schema.parse(packet.mutation);
    return RemoteHostCatalogRowMutationResponseV1Schema.parse(await request(REMOTE_HOST_ROWS_ROUTE_V1, {
      mutation, ...(packet.savedSecretResources?.length ? { savedSecretResources: packet.savedSecretResources } : {}),
      ...(packet.referenceCensus ? { referenceCensus: SavedSecretCatalogReferenceCensusV1Schema.parse(packet.referenceCensus) } : {}),
    }));
  };
  const readSource = async (): Promise<Source> => {
    const context = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => context.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    await verifyCurrent();
    return source;
  };
  let operationContext: Promise<SavedSecretOperationContextV1> | undefined;
  const referenceContext = () => operationContext ??= (async () => {
    if (input.operationContext) return input.operationContext;
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('remote_host_reference_unavailable');
    return runWithServerHttpBaseUrl(base, () => createInvocationSavedSecretOperationContextV1({
      credentials: input.credentials, snapshot, serverHttpBaseUrl: base, isCurrent,
    }));
  })();
  const readReferences = async (refs: readonly string[], proofs?: readonly { resourceId: string; revision: number }[]) => {
    const context = await referenceContext();
    const expectedScopeKey = context.readSnapshot()?.scopeKey;
    if (!expectedScopeKey) throw new Error('remote_host_reference_unavailable');
    const expected = new Map(proofs?.map(proof => [proof.resourceId, proof.revision]));
    const snapshot = await runWithServerHttpBaseUrl(base, () => readSavedSecretCatalogForOperation({
      expectedScopeKey, operationContext: context, signal: input.signal, references: refs.map(ref => {
        const parsed = parseSavedSecretRefV1(ref);
        const revision = parsed.kind === 'shared_resource' ? expected.get(parsed.resourceId) : undefined;
        return { ref, ...(revision === undefined ? {} : { revision }) };
      }),
    }));
    await verifyCurrent();
    return { context, snapshot };
  };
  const refsFor = (hosts: readonly RemoteHostRecordV1[]) => [...new Set(hosts.flatMap(host =>
    [host.ssh.passwordSecretRef, host.ssh.identityPrivateKeySecretRef].filter((ref): ref is string => typeof ref === 'string')))];
  const prepareSource = async (_source: Source, hosts: readonly LegacyRemoteHostRecordV1[]) => {
    assertCurrent();
    const admitted = admittedStorage;
    if (!admitted) throw new Error('remote_host_account_unavailable');
    const accountId = readAccountIdFromToken(input.credentials.token);
    if (!accountId) throw new Error('remote_host_account_unavailable');
    const keys = admitted.mode === 'plain' ? [] : deriveSettingsSecretsReadKeysForCredentials(input.credentials);
    try {
      const resources: SharedSavedSecretCreateInputV1[] = [];
      const record = { v: 1 as const, hosts: hosts.map(host => {
        const { passwordEnc, identityPrivateKeyEnc, ...ssh } = host.ssh;
        const credential = (slot: 'password' | 'identityPrivateKey', material: typeof passwordEnc) => {
          if (material == null) return null;
          const value = decryptSecretValueWithKeysV1(material, keys);
          if (value === null) throw new Error('remote_host_secret_unavailable');
          const resourceId = deriveSavedSecretImportResourceIdV1({ accountId, source: { kind: 'remote-host-ssh-credential', hostId: host.id, slot } });
          resources.push(prepareSavedSecretResourceCreateForOperation({ credentials: input.credentials, accountId,
            accountMode: admitted.mode, resourceId, displayName: `${host.name}: ${slot === 'password' ? 'SSH password' : 'SSH private key'}`.slice(0, 100),
            kind: slot === 'password' ? 'password' : 'other', value }));
          return formatSharedSavedSecretRefV1(resourceId);
        };
        return RemoteHostRecordV1Schema.parse({ ...host, ssh: { ...ssh,
          passwordSecretRef: credential('password', passwordEnc), identityPrivateKeySecretRef: credential('identityPrivateKey', identityPrivateKeyEnc),
        } });
      }) };
      return { record, resources, referencedSavedSecretRevisions: resources.map(resource => ({ resourceId: resource.resourceId, revision: 1 })), dispose() {} };
    } finally { keys.forEach(key => key.fill(0)); }
  };
  const verifySource = async (source: Source, hosts: readonly RemoteHostRecordV1[]): Promise<boolean> => {
    if (!Object.prototype.hasOwnProperty.call(source.raw, 'remoteHostsV1')) return true;
    const retained = readRetainedRemoteHostCatalogV1(source.raw.remoteHostsV1 ?? []);
    if (retained.status !== 'ready') return false;
    const refs = refsFor(hosts);
    const { context, snapshot } = await readReferences(refs);
    const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent: () => context.readSnapshot() === snapshot });
    const keys = snapshot.settingsSecretsReadKeys;
    for (const legacy of retained.hosts) {
      const current = hosts.find(host => host.id === legacy.id);
      if (!current) return false;
      for (const slot of ['password', 'identityPrivateKey'] as const) {
        const old = legacy.ssh[slot === 'password' ? 'passwordEnc' : 'identityPrivateKeyEnc'];
        if (old == null) continue;
        const ref = current.ssh[slot === 'password' ? 'passwordSecretRef' : 'identityPrivateKeySecretRef'];
        if (!ref) return false;
        const destination = materializer.resolve(ref);
        const sourceValue = decryptSecretValueWithKeysV1(old, keys);
        if (destination.status !== 'ready' || sourceValue === null || destination.value !== sourceValue) return false;
      }
    }
    return true;
  };
  const cleanupSource = async (source: Source, revision: number): Promise<boolean> => {
    const row = await readRow();
    if ((row.status !== 'present' && row.status !== 'deleted') || row.revision !== revision) return false;
    const currentSource = await readSource();
    if (currentSource.version !== source.version || !isDeepStrictEqual(currentSource.raw, source.raw)) return false;
    if (Object.prototype.hasOwnProperty.call(source.raw, 'remoteHostsV1')) {
      const { remoteHostsV1: _retired, ...raw } = source.raw;
      const storage = await readStorageContext();
      const result = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials, expectedVersion: source.version,
        raw, envelopeKind: storage.mode === 'plain' ? 'plain' : 'encrypted', signal: input.signal, deps: {
          resolveAccountEncryptionMode: async () => storage.mode,
          updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
        } });
      if (!result.success) return false;
    }
    const freshSource = await readSource();
    let savedSecretRecovery: AccountSettingsHistorySavedSecretRecoveryV1 | undefined;
    const accountId = readAccountIdFromToken(input.credentials.token);
    if (accountId) {
      try {
        const context = await referenceContext();
        const expectedScopeKey = context.readSnapshot()?.scopeKey;
        if (!expectedScopeKey) throw new Error('remote_host_reference_unavailable');
        const snapshot = await runWithServerHttpBaseUrl(base, () => readSavedSecretCatalogForOperation({
          expectedScopeKey, operationContext: context, signal: input.signal, refreshCatalog: true,
        }));
        await verifyCurrent();
        const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent: () => context.readSnapshot() === snapshot });
        savedSecretRecovery = { accountId, source: freshSource,
          resources: snapshot.savedSecretResources ?? [], resolveResourceValue: resourceId => {
            const value = materializer.resolve(formatSharedSavedSecretRefV1(resourceId));
            return value.status === 'ready' ? value.value : null;
          } };
      } catch { await verifyCurrent(); }
    }
    const history = await normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: input.credentials, serverBaseUrl: base,
      isCurrent, signal: input.signal, savedSecretRecovery,
      destinationAuthority: { activeTransferredRoots: ['remoteHostsV1'], activePrivateCatalogRevisions: { remoteHosts: revision } } });
    return history.status === 'complete';
  };
  const readCatalog = async (): Promise<RemoteHostCatalogSnapshotV1> => {
    const storage = await readStorageContext();
    return loadRemoteHostCatalogProjectionV1({ ...storage, signal: input.signal, assertCurrent,
      readRow, readSource, prepareSource, mutateCatalog, verifySource, cleanupSource });
  };
  const readCatalogForOperation = async (): Promise<RemoteHostCatalogSnapshotV1> => {
    const admitted = await readStorageContext();
    const destination = await loadRemoteHostCatalogV1({ ...admitted, signal: input.signal, readRow });
    return destination.status === 'ready' && destination.revision === 'absent' ? readCatalog() : destination;
  };
  const mutateHosts = async (value: SaveInput | Address, remove: boolean): Promise<MutationResult> => {
    const hostId = 'host' in value ? value.host.id : value.hostId;
    try {
      // A current destination mutation does not wait on retained-source/history maintenance.
      const catalog = await readCatalogForOperation();
      if (catalog.status !== 'ready') return { status: 'unavailable', reason: catalog.status === 'unavailable' ? catalog.reason : 'remote_host_catalog_incomplete' };
      if (catalog.revision !== value.expectedRevision) return { status: 'conflict', revision: catalog.revision === 'absent' ? -1 : catalog.revision };
      const host = 'host' in value ? RemoteHostRecordV1Schema.parse(value.host) : null;
      const previous = catalog.hosts.find(existing => existing.id === hostId);
      const hosts = remove ? catalog.hosts.filter(existing => existing.id !== hostId)
        : host ? previous ? catalog.hosts.map(existing => existing.id === hostId ? host : existing) : [...catalog.hosts, host]
          : [...catalog.hosts];
      if (remove && hosts.length === catalog.hosts.length) return { status: 'unavailable', reason: 'remote_host_not_found' };
      const savedSecretResources = 'host' in value ? value.savedSecretResources : undefined;
      const resources = new Set(savedSecretResources?.map(resource => resource.resourceId));
      const refs = refsFor(hosts).filter(ref => { const parsed = parseSavedSecretRefV1(ref); return parsed.kind !== 'shared_resource' || !resources.has(parsed.resourceId); });
      const proofs = 'host' in value ? value.referencedSavedSecretRevisions : undefined;
      let referencedSavedSecretRevisions: { resourceId: string; revision: number }[] = [];
      if (refs.length) {
        const { context, snapshot } = await readReferences(refs, proofs);
        const revisions = readSavedSecretRevisionsFromSnapshotV1(snapshot, refs, { isCurrent: () => context.readSnapshot() === snapshot });
        if (revisions.status !== 'ready') return { status: 'unavailable', reason: 'remote_host_reference_unavailable' };
        referencedSavedSecretRevisions = [...new Map([...revisions.resourcesByRef.values()].map(proof => [proof.resourceId, proof] as const)).values()];
      }
      referencedSavedSecretRevisions.push(...(savedSecretResources ?? []).map(resource => ({ resourceId: resource.resourceId, revision: 1 })));
      const storage = await readStorageContext();
      const source = catalog.revision === 'absent' ? await readSource() : null;
      const referenceCensus = savedSecretResources?.length ? SavedSecretCatalogReferenceCensusV1Schema.parse({
        scope: 'catalogs', accountMode: storage.mode, catalogs: {},
        remoteHosts: { revision: catalog.revision, resourceRefs: refsFor(catalog.hosts) },
      }) : undefined;
      if (referenceCensus && 'host' in value && value.referenceCensus && !isDeepStrictEqual(value.referenceCensus, referenceCensus))
        return { status: 'unavailable', reason: 'references-conflict' };
      const result = await mutateCatalog({ mutation: RemoteHostCatalogRowMutationV1Schema.parse({ expectedRevision: catalog.revision,
        content: sealRemoteHostCatalogContentV1({ ...storage, record: { v: 1, hosts }, randomBytes: length => new Uint8Array(randomBytes(length)) }),
        referencedSavedSecretRevisions, ...(source ? { sourceSettingsVersion: source.version } : {}),
      }), ...(savedSecretResources?.length ? { savedSecretResources, referenceCensus } : {}) });
      return result.status === 'updated' ? { status: 'updated', hostId, revision: result.revision }
        : result.status === 'conflict' ? result : { status: 'unavailable', reason: result.status };
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'outcome_unknown' ? { status: 'outcome_unknown' }
        : { status: 'unavailable', reason: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'remote_host_operation_failed' };
    }
  };
  return { assertCurrent, readRow, readStorageContext, readCatalog, readCatalogForOperation,
    saveHost: (value: SaveInput) => mutateHosts(value, false), removeHost: (value: Address) => mutateHosts(value, true) };
}

export type CliRemoteHostStore = ReturnType<typeof createCliRemoteHostStore>;
