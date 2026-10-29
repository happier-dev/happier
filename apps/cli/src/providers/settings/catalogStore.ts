import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { loadProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/providerConnectionsCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema,
  ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema,
  sealProviderConnectionsContentV1, listProviderConnectionsCatalogSavedSecretRefsV1, readRetainedProviderConnectionsCatalogV1,
  type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { logger } from '@/ui/logger';
import { runWithRequesterSessionCurrentnessCheckpoint, runWithoutRequesterSessionCurrentnessCheckpoint } from "@/daemon/sessionEncryption/requesterCurrentness";
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

type CatalogReadPhase = 'admission_currentness' | 'account_currentness' | 'storage_currentness' | 'row' | 'source' | 'history';

/** File-only catalog observations never serialize Account content or transport errors. */
export async function observeProviderCatalogPhase<T>(input: Readonly<{ catalogReadId: string; phase: CatalogReadPhase }>, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const record = (status: 'started' | 'completed' | 'failed') => logger.infoFile('[PROVIDER] Catalog phase', {
    ...input, status, durationMs: Math.round(performance.now() - startedAt),
  });
  record('started');
  try { const result = await work(); record('completed'); return result; }
  catch (error) { record('failed'); throw error; }
}

/** The daemon Account's existing lifetime owns both Home transport and admission. */
export function createCliProviderConnectionsStore(input: Readonly<{
  credentials: StoredCredentials; signal?: AbortSignal; isCredentialCurrent?(): boolean | Promise<boolean>;
}>) {
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const isCredentialCurrent = input.isCredentialCurrent;
  return createCapturedStore({ ...input, scopeKey, serverHttpBaseUrl: resolveServerHttpBaseUrl(), assertCurrent: () => {
    input.signal?.throwIfAborted();
    if (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) retired();
  }, verifyCurrent: isCredentialCurrent ? async () => {
    if (!await isCredentialCurrent()) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
  } : undefined });
}

/** An issued invocation owner never borrows the daemon's ambient Account. */
export function createCliProviderConnectionsStoreForOperation(input: Readonly<{ operationContext: SavedSecretOperationContextV1; signal?: AbortSignal }>) {
  const context = input.operationContext;
  const scopeKey = context.readSnapshot()?.scopeKey;
  if (!scopeKey) retired();
  return createCapturedStore({ ...input, credentials: context.credentials, scopeKey, serverHttpBaseUrl: context.serverHttpBaseUrl,
    assertCurrent: () => {
      input.signal?.throwIfAborted();
      if (context.readSnapshot()?.scopeKey !== scopeKey) retired();
    }, verifyCurrent: async () => { if (!await context.isCurrent()) retired(); } });
}

function retired(): never { throw Object.assign(new Error('Captured Provider Account retired'), { code: 'scope-retired' }); }

function createCapturedStore(input: Readonly<{
  credentials: StoredCredentials; scopeKey: string; serverHttpBaseUrl: string; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1; assertCurrent(): void; verifyCurrent?(): Promise<void>;
}>) {
  const base = input.serverHttpBaseUrl.replace(/\/+$/, '');
  const catalogReadId = randomUUID();
  const observePhase = <T>(phase: CatalogReadPhase, work: () => Promise<T>) => observeProviderCatalogPhase({ catalogReadId, phase }, work);
  const verifyCurrent = async () => {
    input.assertCurrent();
    if (input.verifyCurrent) await observePhase('account_currentness', input.verifyCurrent);
    input.assertCurrent();
  };
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}`,
    'Content-Type': 'application/json' };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    await verifyCurrent();
    const options = { headers, validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}) };
    const response = body === undefined ? await axios.get(`${base}${path}`, options)
      : await axios.post(`${base}${path}`, body, options).catch(() => {
        // A dispatched effect can already have committed. Never replay it blindly.
        throw Object.assign(new Error('Provider mutation outcome is unknown'), { code: 'outcome_unknown' });
      });
    if (body === undefined) await verifyCurrent();
    const failure: unknown = response.data;
    if (response.status === 503 && failure && typeof failure === 'object'
      && 'error' in failure && failure.error === 'database_transaction_conflict_exhausted') {
      // Only the transaction owner's confirmed rollback permits retry recovery.
      throw createProviderErrorV1('provider_catalog_unavailable');
    }
    if (response.status < 200 || response.status >= 300 && response.status !== 409) throw Object.assign(
      new Error('Provider Account transport unavailable'), { code: response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable' });
    return response.data as unknown;
  };
  const readRow = () => observePhase('row', async () => ProviderConnectionsRowReadResponseV1Schema.parse(await request(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)));
  const readStorageContext = async (usage: 'identity' | 'fresh-authority' = 'fresh-authority') => {
    await verifyCurrent();
    const context = await observePhase('storage_currentness', () => resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base, usage,
      authorizationHeaders: headers, signal: input.signal, shouldContinue: () => { input.assertCurrent(); return true; } }));
    await verifyCurrent();
    return context;
  };
  const readSourceSnapshot = () => observePhase('source', async () => {
    const context = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => context.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    await verifyCurrent();
    return { ...source, ...context };
  });
  const mutateCatalog = async (value: Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>) => runWithoutRequesterSessionCurrentnessCheckpoint(async () => {
    const context = await readStorageContext();
    const { captureSavedSecretReferencesForOperation } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
    const capture = await runWithServerHttpBaseUrl(base, () => captureSavedSecretReferencesForOperation({ expectedScopeKey: input.scopeKey,
      references: listProviderConnectionsCatalogSavedSecretRefsV1(value.catalog).map(ref => ref.secretId),
      operationContext: input.operationContext, signal: input.signal }));
    await verifyCurrent();
    const admitted = await readStorageContext();
    if (admitted.mode !== context.mode) throw Object.assign(new Error('Provider Account mode changed'), { code: 'account-mode-mismatch' });
    const result = ProviderConnectionsRowMutationResponseV1Schema.safeParse(await request(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
      ProviderConnectionsRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
        ...(value.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: value.sourceSettingsVersion }),
        content: sealProviderConnectionsContentV1({ ...admitted, catalog: value.catalog }), ...capture })));
    if (!result.success) throw Object.assign(new Error('Provider mutation acknowledgement is invalid'), { code: 'outcome_unknown' });
    return result.data;
  });
  const replaceSource = async (value: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>) => {
    const context = await readStorageContext();
    let response: ReturnType<typeof AccountSettingsV2UpdateResponseSchema.parse>;
    try { response = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials, ...value,
      envelopeKind: context.mode === 'plain' ? 'plain' : 'encrypted', signal: input.signal, deps: {
        resolveAccountEncryptionMode: async () => context.mode,
        updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
      } }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'outcome_unknown') return { status: 'outcomeUnknown' as const, lastKnownSettingsVersion: value.expectedVersion };
      throw error;
    }
    if (!response.success) return response.error === 'version-mismatch' ? { status: 'conflict' as const, currentSettingsVersion: response.currentVersion }
      : { status: 'rejected' as const };
    const observed = await readSourceSnapshot();
    const previous = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    if (!previous || observed.version !== response.version || !isDeepStrictEqual(observed.raw, value.raw)) return { status: 'rejected' as const };
    const next = { ...previous, source: 'network' as const, settings: accountSettingsParse(observed.raw), rawSettings: observed.raw,
      settingsVersion: observed.version };
    if (input.operationContext) {
      if (!await input.operationContext.replaceAccountSettings(next)) return { status: 'rejected' as const };
    } else commitActiveAccountSettingsSnapshot(next);
    return { status: 'applied' as const, settingsVersion: response.version };
  };
  /** Mutations require existing row authority and never initialize or clean a retained source. */
  const readCatalogForMutation = async () => runWithRequesterSessionCurrentnessCheckpoint(async () => {
    const context = await readStorageContext('identity');
    const catalog = await loadProviderConnectionsCatalogV1({ ...context, signal: input.signal, readRow });
    const admitted = await readStorageContext();
    await verifyCurrent();
    return admitted.mode === context.mode ? catalog : { status: 'unavailable' as const, reason: 'account-mode-mismatch' };
  });
  const readCatalog = async (options?: Pick<Parameters<typeof loadProviderConnectionsCatalogV1>[0], 'onReadyBeforeCleanup' | 'hasPendingCleanup'>
    & Readonly<{ sourceCleanupPending?: boolean }>) => runWithRequesterSessionCurrentnessCheckpoint(async () => {
    const context = await readStorageContext('identity');
    let initializeSource = false;
    const catalog = await loadProviderConnectionsCatalogV1({ ...context, signal: input.signal, readRow: async () => {
      const row = await readRow();
      initializeSource = row.status === 'absent';
      return row;
    }, ...options, onReadyBeforeCleanup: options?.onReadyBeforeCleanup ? async ready => {
      const admitted = await readStorageContext();
      if (admitted.mode !== context.mode) throw Object.assign(new Error('Provider Account mode changed'), { code: 'account-mode-mismatch' });
      await verifyCurrent();
      await options.onReadyBeforeCleanup?.(ready);
    } : undefined, transfer: {
      needsSourceCleanup: () => {
        const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
        return options?.sourceCleanupPending === true || snapshot?.rawSettings === undefined
          || Object.hasOwn(snapshot.rawSettings, 'providerSettingsV1')
          || snapshot.providerConnectionsCatalog?.status === 'ready'
            && snapshot.providerConnectionsCatalog.cleanup?.status === 'cleanup-pending';
      },
      readSourceSnapshot: async () => {
        let source = await readSourceSnapshot();
        // Only actual personal bindings in this inactive source require S2 promotion.
        if (initializeSource) {
          initializeSource = false;
          const hasPersonalReferences = (catalog: ProviderConnectionsCatalogV1) =>
            listProviderConnectionsCatalogSavedSecretRefsV1(catalog)
              .some(reference => parseSavedSecretRefV1(reference.secretId).kind === 'personal');
          const retained = readRetainedProviderConnectionsCatalogV1(source.raw);
          if (retained.status === 'ready' && hasPersonalReferences(retained.catalog)) {
            const { importLegacySavedSecretsForOperation } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
            await runWithoutRequesterSessionCurrentnessCheckpoint(() => runWithServerHttpBaseUrl(base, () => importLegacySavedSecretsForOperation({ expectedScopeKey: input.scopeKey,
              refreshCatalog: true, operationContext: input.operationContext, signal: input.signal })));
            source = await readSourceSnapshot();
            const normalized = readRetainedProviderConnectionsCatalogV1(source.raw);
            if (normalized.status === 'ready' && hasPersonalReferences(normalized.catalog)) {
              throw Object.assign(new Error('Provider SavedSecret import is pending'), { code: 'saved-secret-import-pending' });
            }
          }
        }
        return source;
      }, initializeCatalog: mutateCatalog, replaceSource: value => runWithoutRequesterSessionCurrentnessCheckpoint(() => replaceSource(value)),
      normalizeHistory: value => observePhase('history', () => normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: input.credentials, serverBaseUrl: base,
        signal: input.signal, isCurrent: async () => { try { await verifyCurrent(); return true; } catch { return false; } },
        destinationAuthority: { activeTransferredRoots: value.activeTransferredRoots } })),
    } });
    const admitted = await readStorageContext();
    await verifyCurrent();
    return admitted.mode === context.mode ? catalog : { status: 'unavailable' as const, reason: 'account-mode-mismatch' };
  }, { readOnly: true });
  return { assertCurrent: input.assertCurrent, verifyCurrent, readRow, readStorageContext, readSourceSnapshot, readCatalog,
    readCatalogForMutation, mutateCatalog };
}
