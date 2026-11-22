import axios from '@/api/client/credentialAxios';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { registryUpstreamEqualV1, type RegistryUpstreamV1 } from '@happier-dev/protocol/registries/registryUpstreamV1';
import type { RegistryProvenanceV1 } from '@happier-dev/protocol/registries/registryItemsV1';
import { classifyHomeDomainHttpMutationFailureV1, readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1, readRetainedMcpServerCatalogSourceV1, type McpServerCatalogMutationV1,
  type McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readPluginMcpServerMetadata } from '@/mcp/runtime/pluginMcpServerItems';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema,
  McpServerCatalogRowMutationV1Schema, McpServerCatalogRowMutationResponseV1Schema, sealMcpServerCatalogContentV1,
  listMcpServerCatalogSavedSecretRefsV1, remapMcpServerCatalogSavedSecretReferencesV1, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';

import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAccountSettingsSnapshot, commitActiveMcpServerCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { importLegacySavedSecretsForOperation } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { captureSavedSecretReferencesForOperation, SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";

export type McpServerStoreAuthorizationRequest = Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>;
export type McpServerStoreAuthorization = (request: McpServerStoreAuthorizationRequest) =>
  Readonly<Record<string, string>> | null | Promise<Readonly<Record<string, string>> | null>;

type RegistryObservation = Readonly<{ key: string; upstream: RegistryUpstreamV1; provenance?: RegistryProvenanceV1 }>;

export function createCliMcpServerStore(input: Readonly<{ credentials: StoredCredentials; serverId?: string;
  signal?: AbortSignal; hasPendingCleanup?: () => boolean; resolveAuthorizationHeaders?: McpServerStoreAuthorization }>) {
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw Object.assign(new Error('Captured MCP Account retired'), { code: 'scope-retired' });
    }
  };
  return createCapturedStore({ ...input, serverId: input.serverId ?? configuration.activeServerId,
    base: resolveServerHttpBaseUrl(), assertCurrent,
    readSnapshot: getActiveAccountSettingsSnapshot,
    prepareMutationPublication: async () => {
      if (input.resolveAuthorizationHeaders) return async () => {
        const catalog = await createCliMcpServerStore(input).readCatalogForOperation();
        assertCurrent();
        commitActiveMcpServerCatalog({ scopeKey, lifetimeToken, catalog });
      };
      // Resolve the incumbent publication owner before issuing any effects.
      const { refreshActiveMcpServerCatalogAfterChange } = await import('./hydrateMcpServerCatalog');
      return async () => { await refreshActiveMcpServerCatalogAfterChange({ credentials: input.credentials, scopeKey, lifetimeToken }); };
    },
    publishSource: async snapshot => { assertCurrent(); commitActiveAccountSettingsSnapshot(snapshot); } });
}

export function createCliMcpServerStoreForOperation(input: Readonly<{
  operationContext: SavedSecretOperationContextV1; serverId?: string; signal?: AbortSignal; hasPendingCleanup?: () => boolean;
  assertEffectCurrent?: () => Promise<void>;
  resolveAuthorizationHeaders?: McpServerStoreAuthorization;
}>) {
  const context = input.operationContext;
  const scopeKey = context.readSnapshot()?.scopeKey;
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (!scopeKey || context.readSnapshot()?.scopeKey !== scopeKey) {
      throw Object.assign(new Error('Captured MCP Account retired'), { code: 'scope-retired' });
    }
  };
  return createCapturedStore({ credentials: context.credentials, serverId: input.serverId ?? configuration.activeServerId,
    base: context.serverHttpBaseUrl,
    signal: input.signal, hasPendingCleanup: input.hasPendingCleanup, operationContext: context, assertCurrent, readSnapshot: context.readSnapshot,
    resolveAuthorizationHeaders: input.resolveAuthorizationHeaders,
    verifyCurrent: async () => {
      if (!await context.isCurrent()) throw Object.assign(new Error('Captured MCP Account retired'), { code: 'scope-retired' });
      await input.assertEffectCurrent?.();
    },
    publishCatalog: async catalog => { if (!await context.commitMcpCatalog(catalog)) throw Object.assign(new Error('Captured MCP Account retired'), { code: 'scope-retired' }); },
    prepareMutationPublication: async () => async () => { await createCliMcpServerStoreForOperation(input).readCatalogForOperation(); },
    publishSource: async snapshot => { await context.replaceAccountSettings(snapshot); } });
}

function createCapturedStore(input: Readonly<{
  credentials: StoredCredentials; serverId: string; base: string; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
  hasPendingCleanup?: () => boolean;
  resolveAuthorizationHeaders?: McpServerStoreAuthorization;
  assertCurrent(): void; verifyCurrent?(): Promise<void>; readSnapshot(): ActiveAccountSettingsSnapshot | null;
  prepareMutationPublication?(): Promise<() => Promise<void>>;
  publishCatalog?(catalog: McpServerCatalogSnapshotV1): Promise<void>;
  publishSource(snapshot: ActiveAccountSettingsSnapshot): Promise<void>;
}>) {
  const base = input.base.replace(/\/+$/, '');
  const accountId = readAccountIdFromToken(input.credentials.token);
  const scope = accountId ? { serverId: input.serverId, accountId } : null;
  const headers = async (request: McpServerStoreAuthorizationRequest) => {
    const authorization = input.resolveAuthorizationHeaders
      ? await input.resolveAuthorizationHeaders(request) : { Authorization: `Bearer ${input.credentials.token}` };
    if (!authorization) throw Object.assign(new Error('MCP Account authorization is unavailable'), { code: 'unauthorized' });
    return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorization };
  };
  const verifyCurrent = async () => { input.assertCurrent(); await input.verifyCurrent?.(); input.assertCurrent(); };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    await verifyCurrent();
    const options = { headers: await headers({ method: body === undefined ? 'GET' : 'POST', path,
      ...(body === undefined ? {} : { body }) }), signal: input.signal, validateStatus: () => true };
    const response = body === undefined ? await axios.get(`${base}${path}`, options)
      : await axios.post(`${base}${path}`, body, options).catch((cause: unknown) => {
        throw Object.assign(new Error('MCP mutation transport failed'), { code: classifyHomeDomainHttpMutationFailureV1({
          error: cause, issued: true, aborted: input.signal?.aborted === true,
        }), cause });
      });
    // Acknowledged effects remain truthful after retirement; private reads do not.
    if (body === undefined) await verifyCurrent();
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      const rollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
      throw Object.assign(new Error('MCP Account transport unavailable'), { code: rollback?.code ?? (
        body !== undefined && response.status >= 500 ? 'outcome_unknown'
        : response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable') });
    }
    return response.data as unknown;
  };
  const readStorageContext = async (usage: 'identity' | 'fresh-authority' = 'fresh-authority') => {
    await verifyCurrent();
    const context = await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base, usage,
      signal: input.signal, authorizationHeaders: await headers({ method: 'GET', path: '/v1/account/encryption/currentness' }),
      shouldContinue: () => { input.assertCurrent(); return true; } });
    await verifyCurrent();
    return context;
  };
  const readRow = async () => McpServerCatalogRowReadResponseV1Schema.parse(await request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1));
  const publishObservedSource = async (raw: Readonly<Record<string, unknown>>, version: number) => {
    await verifyCurrent();
    const previous = input.readSnapshot();
    if (previous) await input.publishSource({ ...previous, source: 'network', rawSettings: raw,
      settings: accountSettingsParse(raw), settingsVersion: version, loadedAtMs: Date.now() });
  };
  const readSourceSnapshot = async () => {
    const context = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => context.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    await publishObservedSource(source.raw, source.version);
    return source;
  };
  const operationContext = async () => {
    if (input.operationContext) return input.operationContext;
    await verifyCurrent();
    const snapshot = input.readSnapshot();
    if (!snapshot) throw Object.assign(new Error('MCP Account is unavailable'), { code: 'scope-retired' });
    return createInvocationSavedSecretOperationContextV1({ credentials: input.credentials, serverHttpBaseUrl: base,
      snapshot, isCurrent: async () => { try { await verifyCurrent(); return true; } catch { return false; } } });
  };
  const writeCatalog = async (value: Readonly<{ catalog: McpServerCatalogV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>,
    previousCatalog?: McpServerCatalogV1) => {
    let catalog = value.catalog;
    let referencedSavedSecretIds = [...new Set(listMcpServerCatalogSavedSecretRefsV1(catalog).map(ref => ref.secretId))];
    let savedSecretRevisions: { resourceId: string; expectedRevision: number }[] = [];
    if (referencedSavedSecretIds.length) {
      const context = await operationContext();
      const scopeKey = context.readSnapshot()?.scopeKey;
      if (!scopeKey) throw Object.assign(new Error('MCP references are unavailable'), { code: 'invalid-reference' });
      let previousReferences: Set<string> | undefined;
      const canResolveResourceId = previousCatalog && ((id: string) =>
        !(previousReferences ??= new Set(listMcpServerCatalogSavedSecretRefsV1(previousCatalog).map(ref => ref.secretId))).has(id));
      const proof = await runWithServerHttpBaseUrl(base, () => captureSavedSecretReferencesForOperation({ expectedScopeKey: scopeKey,
        operationContext: context, signal: input.signal, references: referencedSavedSecretIds, canResolveResourceId })).catch(cause => {
        if (cause instanceof SavedSecretOperationAdmissionError) {
          throw Object.assign(new Error('MCP Saved Secret reference refused'), { code: cause.reason });
        }
        throw cause;
      });
      referencedSavedSecretIds = proof.referencedSavedSecretIds;
      savedSecretRevisions = proof.savedSecretRevisions;
      if (proof.referenceRemapping) catalog = remapMcpServerCatalogSavedSecretReferencesV1(catalog, proof.referenceRemapping);
    }
    const context = await readStorageContext();
    const mutation = McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
      content: sealMcpServerCatalogContentV1({ ...context, catalog }), sourceSettingsVersion: value.sourceSettingsVersion,
      referencedSavedSecretIds, savedSecretRevisions });
    const result = McpServerCatalogRowMutationResponseV1Schema.safeParse(await request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, mutation));
    if (!result.success) throw Object.assign(new Error('MCP mutation outcome is unknown'), { code: 'outcome_unknown' });
    return result.data;
  };
  const writeAndPublishCatalog = async (value: Parameters<typeof writeCatalog>[0], previousCatalog?: McpServerCatalogV1) => {
    const publishMutation = await input.prepareMutationPublication?.();
    const result = await writeCatalog(value, previousCatalog);
    if (result.status === 'updated' && publishMutation) {
      // Projection failure cannot turn an acknowledged effect into a replayable failure.
      try { await publishMutation(); } catch { /* The captured refresh owner retains recovery. */ }
    }
    return result;
  };
  let admittedCatalog: McpServerCatalogSnapshotV1 | undefined;
  const readCatalog = async (onReady?: (catalog: McpServerCatalogSnapshotV1) => void,
    options?: Readonly<{ maintainSource?: false }>) => {
    const context = await readStorageContext('identity');
    let absent = false;
    const catalog = await loadMcpServerCatalogV1({ ...context, signal: input.signal, ...options,
      readRow: async () => { const row = await readRow(); absent = row.status === 'absent'; return row; },
      hasPendingCleanup: input.hasPendingCleanup,
      onReadyBeforeCleanup: async catalog => {
        const admitted = await readStorageContext('identity');
        await verifyCurrent();
        if (admitted.mode !== context.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
        admittedCatalog = catalog;
        await input.publishCatalog?.(catalog);
        onReady?.(catalog);
      },
      transfer: {
        readSourceSnapshot: () => (async () => {
          // The SavedSecret owner rewrites personal references before the domain
          // captures its first activation CAS. Raw census never calls this path.
          const source = await readSourceSnapshot();
          if (!absent) return source;
          const retained = readRetainedMcpServerCatalogSourceV1(source.raw);
          if (retained.status !== 'opened' || !listMcpServerCatalogSavedSecretRefsV1(retained.catalog)
            .some(reference => parseSavedSecretRefV1(reference.secretId).kind === 'personal')) return source;
          const captured = await operationContext();
          const scopeKey = captured.readSnapshot()?.scopeKey;
          if (scopeKey) {
            await runWithServerHttpBaseUrl(base, () => importLegacySavedSecretsForOperation({ expectedScopeKey: scopeKey,
              operationContext: captured, signal: input.signal }));
          }
          return readSourceSnapshot();
        })(),
        initializeCatalog: value => (() => writeCatalog(value))(),
        replaceSource: value => (async () => {
          const current = await readStorageContext();
          if (current.mode !== context.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
          const response = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials, signal: input.signal,
            raw: value.raw, expectedVersion: value.expectedVersion, envelopeKind: current.mode === 'plain' ? 'plain' : 'encrypted', deps: {
              resolveAccountEncryptionMode: async () => current.mode,
              updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
            } });
          if (response.success) await publishObservedSource(value.raw, response.version);
          return response.success ? { status: 'applied' as const, settingsVersion: response.version }
            : response.error === 'version-mismatch' ? { status: 'conflict' as const, currentSettingsVersion: response.currentVersion }
              : { status: 'rejected' as const };
        })(),
        normalizeHistory: value => normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: input.credentials,
          serverBaseUrl: base, signal: input.signal, destinationAuthority: value,
          isCurrent: async () => { try { await verifyCurrent(); return true; } catch { return false; } } }),
      } });
    const admitted = await readStorageContext('identity');
    await verifyCurrent();
    const result = admitted.mode === context.mode ? catalog : { status: 'unavailable' as const, reason: 'account-mode-mismatch' as const };
    // Maintenance may attach cleanup metadata, but cannot invalidate the
    // immutable first-ready capture merely by returning a different object.
    if (result.status !== 'ready' || admittedCatalog === undefined) admittedCatalog = result;
    await input.publishCatalog?.(result);
    return result;
  };
  /** Finite operations use the same admission owner without starting optional retained maintenance. */
  const readCatalogForOperation = async (): Promise<McpServerCatalogSnapshotV1> => {
    return readCatalog(undefined, { maintainSource: false });
  };
  const requireMutableCatalog = (snapshot: McpServerCatalogSnapshotV1) => {
    if (snapshot.status !== 'ready') throw new McpServerCatalogUnavailableError(
      snapshot.status === 'unavailable' ? snapshot.reason : snapshot.status);
    if (snapshot.authority !== 'active' || snapshot.revision === 'absent') throw new McpServerCatalogUnavailableError('authority-not-confirmed');
    return { ...snapshot, revision: snapshot.revision };
  };
  const recordRegistryUpstream = async (changes: readonly RegistryObservation[]) => {
    if (changes.length === 0) return;
    const snapshot = requireMutableCatalog(await readCatalogForOperation());
    const byKey = new Map(changes.map(change => [change.key, change]));
    const shouldRecord = (entry: McpServerCatalogV1['servers'][number] | undefined, change: RegistryObservation) =>
      entry?.origin?.kind === 'registry'
      && (!change.provenance || isDeepStrictEqual(entry.origin.provenance, change.provenance))
      && !registryUpstreamEqualV1(entry.origin.upstream, change.upstream);
    const attempted: RegistryObservation[] = [];
    const now = Date.now();
    const servers = snapshot.catalog.servers.map(entry => {
      const change = byKey.get(entry.id);
      if (!change || entry.origin?.kind !== 'registry' || !shouldRecord(entry, change)) return entry;
      attempted.push(change);
      return { ...entry, updatedAt: Math.max(now, entry.updatedAt + 1), origin: { ...entry.origin, upstream: change.upstream,
        // Distinct transitions retain distinct event replay identities within one clock tick.
        upstreamObservedAt: Math.max(now, (entry.origin.upstreamObservedAt ?? -1) + 1) } };
    });
    if (attempted.length === 0) return;
    const receipt = await writeAndPublishCatalog({ catalog: { ...snapshot.catalog, servers }, expectedRevision: snapshot.revision });
    if (receipt.status === 'updated') return;
    if (receipt.status === 'conflict') {
      const current = requireMutableCatalog(await readCatalogForOperation());
      const entries = new Map(current.catalog.servers.map(entry => [entry.id, entry]));
      // Absorb a peer's equal observation, but never replay over its configuration or provenance edits.
      if (attempted.every(change => !shouldRecord(entries.get(change.key), change))) return;
    }
    throw Object.assign(new Error('MCP registry update observation was not recorded'), {
      code: `mcp_registry_update_${receipt.status}`, receipt,
    });
  };
  return { assertCurrent: input.assertCurrent, readRow, readStorageContext, readSourceSnapshot, readCatalog, readCatalogForOperation, writeCatalog,
    recordRegistryUpstream,
    mutate: async (change: McpServerCatalogMutationV1, expectedRevision?: number | 'absent', capturedCatalog?: McpServerCatalogSnapshotV1) => {
      await verifyCurrent();
      const incumbent = input.readSnapshot()?.mcpServerCatalog;
      if (capturedCatalog && capturedCatalog !== incumbent && capturedCatalog !== admittedCatalog) {
        throw Object.assign(new Error('MCP catalog admission is unavailable'), { code: 'mcp_catalog_unavailable', reason: 'catalog-unobserved' });
      }
      const snapshot = capturedCatalog ?? (incumbent?.status === 'ready' ? incumbent : incumbent === undefined ? admittedCatalog : undefined)
        ?? await readCatalogForOperation();
      await verifyCurrent();
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active' || snapshot.revision === 'absent') throw Object.assign(new Error('MCP catalog is unavailable'), {
        code: 'mcp_catalog_unavailable', reason: snapshot.status === 'unavailable' ? snapshot.reason : snapshot.status });
      if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) return { status: 'conflict' as const,
        revision: snapshot.revision };
      const pluginItemIds = change.kind === 'plugin-defaults'
        || change.kind === 'rules-change' && change.serverIds.some(id => id.startsWith('plugin:'))
        || (change.kind === 'tools-change' || change.kind === 'tools-snapshot') && change.serverId.startsWith('plugin:')
        ? (await readPluginMcpServerMetadata()).map(item => item.id) : [];
      await verifyCurrent();
      const commit = (current: Extract<McpServerCatalogSnapshotV1, { status: 'ready' }> & { revision: number }) =>
        commitMcpServerCatalogMutationV1({ catalog: current.catalog, revision: current.revision, change, scope,
        ctx: { nowMs: Date.now(), newId: randomUUID, pluginItemIds },
        writeCatalog: value => writeAndPublishCatalog(value, current.catalog) });
      let current = { ...snapshot, revision: snapshot.revision };
      let result = await commit(current);
      if (change.kind !== 'tools-snapshot') return result;
      const testedConfiguration = readSnapshotConfiguration(snapshot.catalog, change.serverId);
      while (result.status === 'conflict') {
        // Only this conflict's committed advancement permits rebasing; a newer
        // later read cannot authorize replay after a non-advancing refusal.
        if (result.revision <= current.revision) return result;
        const observed = await readCatalogForOperation();
        if (observed.status !== 'ready' || observed.authority !== 'active' || typeof observed.revision !== 'number'
          || observed.revision <= current.revision
          || !isDeepStrictEqual(testedConfiguration, readSnapshotConfiguration(observed.catalog, change.serverId))) return result;
        // A peer's observation advances the shared row without changing what
        // this probe tested. Reapply only this observation at the same CAS owner.
        current = { ...observed, revision: observed.revision };
        result = await commit(current);
      }
      return result;
    } };
}

function readSnapshotConfiguration(catalog: McpServerCatalogV1, serverId: string) {
  if (serverId.startsWith('plugin:')) {
    const { toolsSnapshot: _snapshot, ...settings } = catalog.pluginServers?.[serverId] ?? {};
    return settings;
  }
  const server = catalog.servers.find(entry => entry.id === serverId);
  if (!server) return undefined;
  const { toolsSnapshot: _snapshot, updatedAt: _updatedAt, ...configuration } = server;
  return configuration;
}
export type CliMcpServerStore = ReturnType<typeof createCliMcpServerStore>;
