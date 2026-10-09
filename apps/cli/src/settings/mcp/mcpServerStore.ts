import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1, readRetainedMcpServerCatalogSourceV1, type McpServerCatalogMutationV1,
  type McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema,
  McpServerCatalogRowMutationV1Schema, McpServerCatalogRowMutationResponseV1Schema, sealMcpServerCatalogContentV1,
  listMcpServerCatalogSavedSecretRefsV1, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import { createInvocationSavedSecretOperationContextV1, importLegacySavedSecretsForOperation,
  captureSavedSecretReferencesForOperation, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

export function createCliMcpServerStore(input: Readonly<{ credentials: StoredCredentials; serverId?: string;
  signal?: AbortSignal; hasPendingCleanup?: () => boolean }>) {
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
      // Resolve the incumbent publication owner before issuing any effects.
      const { refreshActiveMcpServerCatalogAfterChange } = await import('./hydrateMcpServerCatalog');
      return async () => { await refreshActiveMcpServerCatalogAfterChange({ credentials: input.credentials, scopeKey, lifetimeToken }); };
    },
    publishSource: async snapshot => { assertCurrent(); commitActiveAccountSettingsSnapshot(snapshot); } });
}

export function createCliMcpServerStoreForOperation(input: Readonly<{
  operationContext: SavedSecretOperationContextV1; serverId?: string; signal?: AbortSignal; hasPendingCleanup?: () => boolean;
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
    verifyCurrent: async () => { if (!await context.isCurrent()) throw Object.assign(new Error('Captured MCP Account retired'), { code: 'scope-retired' }); },
    publishSource: async snapshot => { await context.replaceAccountSettings(snapshot); } });
}

function createCapturedStore(input: Readonly<{
  credentials: StoredCredentials; serverId: string; base: string; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
  hasPendingCleanup?: () => boolean;
  assertCurrent(): void; verifyCurrent?(): Promise<void>; readSnapshot(): ActiveAccountSettingsSnapshot | null;
  prepareMutationPublication?(): Promise<() => Promise<void>>;
  publishSource(snapshot: ActiveAccountSettingsSnapshot): Promise<void>;
}>) {
  const base = input.base.replace(/\/+$/, '');
  const accountId = readAccountIdFromToken(input.credentials.token);
  const scope = accountId ? { serverId: input.serverId, accountId } : null;
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` };
  const verifyCurrent = async () => { input.assertCurrent(); await input.verifyCurrent?.(); input.assertCurrent(); };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    await verifyCurrent();
    const options = { headers, signal: input.signal, validateStatus: () => true };
    const response = body === undefined ? await axios.get(`${base}${path}`, options)
      : await axios.post(`${base}${path}`, body, options).catch((cause: unknown) => {
        throw Object.assign(new Error('MCP mutation transport failed'), { code: classifyHomeDomainHttpMutationFailureV1({
          error: cause, issued: true, aborted: input.signal?.aborted === true,
        }), cause });
      });
    // Acknowledged effects remain truthful after retirement; private reads do not.
    if (body === undefined) await verifyCurrent();
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      throw Object.assign(new Error('MCP Account transport unavailable'), { code: response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable' });
    }
    return response.data as unknown;
  };
  const readStorageContext = async () => {
    await verifyCurrent();
    const context = await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base,
      signal: input.signal, authorizationHeaders: headers, shouldContinue: () => { input.assertCurrent(); return true; } });
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
  const writeCatalog = async (value: Readonly<{ catalog: McpServerCatalogV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>) => {
    const referencedSavedSecretIds = [...new Set(listMcpServerCatalogSavedSecretRefsV1(value.catalog).map(ref => ref.secretId))];
    let savedSecretRevisions: { resourceId: string; expectedRevision: number }[] = [];
    if (referencedSavedSecretIds.length) {
      const context = await operationContext();
      const scopeKey = context.readSnapshot()?.scopeKey;
      if (!scopeKey) throw Object.assign(new Error('MCP references are unavailable'), { code: 'invalid-reference' });
      const proof = await runWithServerHttpBaseUrl(base, () => captureSavedSecretReferencesForOperation({ expectedScopeKey: scopeKey,
        operationContext: context, signal: input.signal, references: referencedSavedSecretIds }));
      savedSecretRevisions = proof.savedSecretRevisions;
    }
    const context = await readStorageContext();
    const mutation = McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
      content: sealMcpServerCatalogContentV1({ ...context, catalog: value.catalog }), sourceSettingsVersion: value.sourceSettingsVersion,
      referencedSavedSecretIds, savedSecretRevisions });
    const result = McpServerCatalogRowMutationResponseV1Schema.safeParse(await request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, mutation));
    if (!result.success) throw Object.assign(new Error('MCP mutation outcome is unknown'), { code: 'outcome_unknown' });
    return result.data;
  };
  let admittedCatalog: McpServerCatalogSnapshotV1 | undefined;
  const readCatalog = async (onReady?: (catalog: McpServerCatalogSnapshotV1) => void) => {
    const context = await readStorageContext();
    let absent = false;
    const catalog = await loadMcpServerCatalogV1({ ...context, signal: input.signal,
      readRow: async () => { const row = await readRow(); absent = row.status === 'absent'; return row; },
      hasPendingCleanup: input.hasPendingCleanup,
      onReadyBeforeCleanup: async catalog => {
        const admitted = await readStorageContext();
        await verifyCurrent();
        if (admitted.mode !== context.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
        admittedCatalog = catalog;
        onReady?.(catalog);
      },
      transfer: {
        readSourceSnapshot: async () => {
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
        },
        initializeCatalog: writeCatalog,
        replaceSource: async value => {
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
        },
        normalizeHistory: value => normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: input.credentials,
          serverBaseUrl: base, signal: input.signal, destinationAuthority: value,
          isCurrent: async () => { try { await verifyCurrent(); return true; } catch { return false; } } }),
      } });
    const admitted = await readStorageContext();
    await verifyCurrent();
    const result = admitted.mode === context.mode ? catalog : { status: 'unavailable' as const, reason: 'account-mode-mismatch' as const };
    // Maintenance may attach cleanup metadata, but cannot invalidate the
    // immutable first-ready capture merely by returning a different object.
    if (result.status !== 'ready' || admittedCatalog === undefined) admittedCatalog = result;
    return result;
  };
  /** Return the admitted row while the same captured loader retains optional maintenance to terminal. */
  const readCatalogForOperation = async (): Promise<McpServerCatalogSnapshotV1> => {
    let resolveAdmission!: (catalog: McpServerCatalogSnapshotV1) => void;
    const admission = new Promise<McpServerCatalogSnapshotV1>(resolve => { resolveAdmission = resolve; });
    const work = readCatalog(resolveAdmission);
    // The full work handle remains observed even after first-ready wins.
    void work.catch(() => undefined);
    return Promise.race([work, admission]);
  };
  return { assertCurrent: input.assertCurrent, readRow, readStorageContext, readSourceSnapshot, readCatalog, readCatalogForOperation, writeCatalog,
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
      return commitMcpServerCatalogMutationV1({ catalog: snapshot.catalog, revision: snapshot.revision, change, scope,
        writeCatalog: async value => {
          const publishMutation = await input.prepareMutationPublication?.();
          const result = await writeCatalog(value);
          if (result.status === 'updated' && publishMutation) {
            // Projection failure cannot turn an acknowledged effect into a replayable failure.
            try { await publishMutation(); } catch { /* The captured refresh owner retains recovery. */ }
          }
          return result;
        } });
    } };
}
export type CliMcpServerStore = ReturnType<typeof createCliMcpServerStore>;
