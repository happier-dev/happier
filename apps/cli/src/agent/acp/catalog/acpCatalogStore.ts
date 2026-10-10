import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema,
  AcpCatalogRowMutationV1Schema, AcpCatalogRowMutationResponseV1Schema, readFreshAcpCatalogSourceV1,
  openAcpCatalogContentV1, sealAcpCatalogContentV1, listAcpCatalogSavedSecretRefsV1,
  type AcpCatalogRecordV1, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { prepareAcpCatalogTransferV2, readAcpCatalogTransferSourceV2 } from '@happier-dev/protocol/acp/catalog/transferAcpCatalogV2';
import { KIRO_ACP_STDERR_RULES } from '@happier-dev/plugins-kiro/agent/acp/transport';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAccountSettingsSnapshot, commitActiveAcpCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAccountSettingsV2Raw, sealAccountSettingsV2RawContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { captureSavedSecretReferencesForOperation, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import type { AcpCatalogCleanupV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { AcpCatalogUnavailableError, requireReadyAcpCatalog } from './configured/resolveBackend';

/** The existing Account custody supplies admission; the row is the sole ACP persistence owner. */
export function createCliAcpCatalogStore(input: Readonly<{
  credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
}>) {
  const operation = input.operationContext;
  const base = (operation?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const scopeKey = runWithServerHttpBaseUrl(base, () => resolveAccountSettingsScopeKey(input.credentials));
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  let capturedSource: (Awaited<ReturnType<typeof readAccountSettingsV2Raw>> & Readonly<{ mode: 'plain' | 'e2ee' }>) | undefined;
  const snapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (snapshot()?.scopeKey !== scopeKey || operation?.credentials.token !== undefined && operation.credentials.token !== input.credentials.token
      || !operation && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw Object.assign(new Error('Captured ACP Account retired'), { code: 'scope-retired' });
    }
  };
  const admitCurrent = async () => {
    assertCurrent();
    if (operation && !await operation.isCurrent()) throw Object.assign(new Error('Captured ACP Account retired'), { code: 'scope-retired' });
    assertCurrent();
  };
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}`,
    'Content-Type': 'application/json' };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    await admitCurrent();
    const options = { headers, signal: input.signal, validateStatus: () => true };
    const response = body === undefined ? await axios.get(`${base}${path}`, options)
      : await axios.post(`${base}${path}`, body, options).catch((error: unknown) => {
        throw Object.assign(new Error('ACP mutation transport failed'), { code: classifyHomeDomainHttpMutationFailureV1({
          error, issued: true, aborted: input.signal?.aborted === true,
        }), cause: error });
      });
    // A receipt remains truthful after retirement; reads never disclose a retired answer.
    if (body === undefined) await admitCurrent();
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      throw Object.assign(new Error('ACP Account transport unavailable'), { code: response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable' });
    }
    return response.data as unknown;
  };
  const readStorageContext = async () => {
    await admitCurrent();
    const context = await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base,
      signal: input.signal, authorizationHeaders: headers, shouldContinue: () => { assertCurrent(); return true; } });
    await admitCurrent();
    return context;
  };
  /** No activation, source read or write: complete censuses consume this exact absent/tombstone distinction. */
  const readRow = async () => AcpCatalogRowReadResponseV1Schema.parse(await request(ACP_CATALOG_ROWS_ROUTE_V1));
  const readSourceSnapshot = async () => {
    const storage = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => storage.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    await admitCurrent();
    const incumbent = snapshot();
    if (!incumbent) throw new AcpCatalogUnavailableError('scope-retired');
    const next = { ...incumbent, source: 'network' as const, rawSettings: source.raw,
      settings: accountSettingsParse(source.raw), settingsVersion: source.version, loadedAtMs: Date.now() };
    if (operation) {
      if (!await operation.replaceAccountSettings(next)) throw new AcpCatalogUnavailableError('scope-retired');
    } else commitActiveAccountSettingsSnapshot(next);
    if (snapshot()?.settingsVersion !== source.version) throw new AcpCatalogUnavailableError('source-stale');
    capturedSource = { ...source, mode: storage.mode };
    return source;
  };
  const readCatalog = async (): Promise<AcpCatalogSnapshotV1> => {
    const storage = await readStorageContext();
    const row = await readRow();
    let catalog: AcpCatalogSnapshotV1;
    if (row.status === 'present') {
      const opened = openAcpCatalogContentV1({ ...storage, content: row.content });
      catalog = opened.status === 'opened' ? { status: 'ready', record: opened.record, revision: row.revision } : opened;
    } else if (row.status === 'deleted') catalog = { status: 'ready', revision: row.revision, record: { v: 1, definitions: [] } };
    else if (row.status === 'absent') {
      const source = await readSourceSnapshot();
      const fresh = readFreshAcpCatalogSourceV1(source.raw);
      if (fresh.status === 'ready') catalog = { status: 'ready', record: fresh.record, revision: 'absent', source: 'fresh',
        sourceSettingsVersion: source.version };
      else {
        const transferred = prepareAcpCatalogTransferV2({ rawSettings: source.raw, sourceSettingsVersion: source.version,
          kiroStderrRules: KIRO_ACP_STDERR_RULES });
        catalog = transferred.status === 'ready' ? { status: 'ready', record: transferred.record, revision: 'absent', source: 'predecessor',
          sourceSettingsVersion: source.version } : transferred.status === 'not-required' ? fresh : transferred;
      }
    } else catalog = { status: 'unavailable', reason: row.status };
    const admitted = await readStorageContext();
    return admitted.mode === storage.mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' };
  };
  const writeRecord = async (value: Readonly<{
    record: AcpCatalogRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number; source?: 'fresh' | 'predecessor';
  }>) => {
    const record = AcpCatalogRecordV1Schema.parse(value.record);
    const refs = [...new Set(listAcpCatalogSavedSecretRefsV1(record).map(reference => reference.secretId))];
    const proofs = await captureSavedSecretReferencesForOperation({ expectedScopeKey: scopeKey, references: refs,
      operationContext: operation, signal: input.signal });
    await admitCurrent();
    const storage = await readStorageContext();
    let settingsCleanup;
    if (value.expectedRevision === 'absent') {
      if (!capturedSource || capturedSource.version !== value.sourceSettingsVersion) throw new AcpCatalogUnavailableError('source-stale');
      if (Object.hasOwn(capturedSource.raw, 'acpCatalogSettingsV1')) {
        const nextSettings = { ...capturedSource.raw };
        delete nextSettings.acpCatalogSettingsV1;
        settingsCleanup = { expectedSettingsVersion: capturedSource.version,
          nextSettings: sealAccountSettingsV2RawContent({ credentials: input.credentials, raw: nextSettings,
            envelopeKind: storage.mode === 'plain' ? 'plain' : 'encrypted', randomBytes: n => new Uint8Array(randomBytes(n)) }) };
      }
    }
    const mutation = AcpCatalogRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
      content: sealAcpCatalogContentV1({ ...storage, record }), ...proofs,
      ...(settingsCleanup ? { settingsCleanup } : {}),
      ...(value.expectedRevision === 'absent' ? { sourceSettingsVersion: value.sourceSettingsVersion, source: value.source } : {}) });
    const result = AcpCatalogRowMutationResponseV1Schema.safeParse(await request(ACP_CATALOG_ROWS_ROUTE_V1, mutation));
    if (!result.success) throw Object.assign(new Error('ACP mutation outcome is unknown'), { code: 'outcome_unknown' });
    if (result.data.status === 'updated') {
      // The central history owner reopens current destination rows before removing
      // retained history. Maintenance cannot undo an acknowledged catalog write.
      let cleanup: AcpCatalogCleanupV1 = { status: 'cleanup-pending', reason: 'history-incomplete' };
      try {
        const history = await normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: input.credentials,
          serverBaseUrl: base, signal: input.signal,
          isCurrent: async () => { try { await admitCurrent(); return true; } catch { return false; } },
          destinationAuthority: { activeTransferredRoots: [] } });
        if (history.status === 'complete') cleanup = { status: 'complete' };
      } catch { /* The durable receipt remains successful; cleanup is explicitly pending. */ }
      return { ...result.data, cleanup };
    }
    return result.data;
  };
  const publish = async (catalog: AcpCatalogSnapshotV1) => {
    if (operation) return await operation.commitAcpCatalog({ catalog });
    return commitActiveAcpCatalog({ scopeKey, lifetimeToken, catalog });
  };
  return { assertCurrent, admitCurrent, readStorageContext, readRow, readSourceSnapshot, readCatalog, writeRecord, publish,
    updateCatalog: async (mutate: (current: unknown) => unknown, expectation?: Readonly<{
      expectedRevision?: number | 'absent'; sourceSettingsVersion?: number;
    }>) => {
      let sourceSettingsExpectation = expectation?.sourceSettingsVersion;
      let observed = await readCatalog();
      if (observed.status === 'unavailable' && observed.reason === 'saved-secret-unavailable' && capturedSource) {
        const original = readAcpCatalogTransferSourceV2({ rawSettings: capturedSource.raw,
          sourceSettingsVersion: capturedSource.version });
        // Passive reads stay read-only. An explicit edit first promotes this
        // complete source's personal bindings through the existing S2 owner.
        if (original.status === 'ready' && original.references.length > 0) {
          if (expectation?.expectedRevision !== undefined && expectation.expectedRevision !== 'absent') {
            return { status: 'conflict' as const, revision: -1 };
          }
          if ((expectation?.expectedRevision === 'absent' || sourceSettingsExpectation !== undefined)
            && sourceSettingsExpectation !== capturedSource.version) {
            return { status: 'settings-conflict' as const, revision: capturedSource.version };
          }
          const { importLegacySavedSecretsForOperation } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
          const imported = await runWithServerHttpBaseUrl(base, () => importLegacySavedSecretsForOperation({
            expectedScopeKey: scopeKey, signal: input.signal, operationContext: operation,
            ...(expectation?.expectedRevision === 'absent' ? { sourceExpectation: {
              mode: capturedSource.mode, raw: capturedSource.raw, version: capturedSource.version,
            } } : {}),
          }));
          await admitCurrent();
          if (imported.status !== 'complete') {
            if (imported.reason === 'conflict' && expectation?.expectedRevision === 'absent') {
              // A diagnostic read reports the conflicting source; it grants no
              // authority to promote it or apply the originally captured draft.
              const conflicting = await readCatalog();
              if (conflicting.status === 'ready' && typeof conflicting.revision === 'number') {
                return { status: 'conflict' as const, revision: conflicting.revision };
              }
              return { status: 'settings-conflict' as const, revision: capturedSource.version };
            }
            throw new AcpCatalogUnavailableError('saved-secret-unavailable');
          }
          // This operation's acknowledged promotion advances its admitted
          // source expectation; a later foreign source change still conflicts.
          if (sourceSettingsExpectation !== undefined) {
            if (imported.sourceSettingsVersion === undefined) throw new AcpCatalogUnavailableError('source-stale');
            sourceSettingsExpectation = imported.sourceSettingsVersion;
          }
          // Only the acknowledged original source may supply the next baseline.
          // A concurrently admitted row wins this fresh read without overwrite.
          observed = await readCatalog();
        }
      }
      let catalog = requireReadyAcpCatalog(observed);
      if (expectation?.expectedRevision !== undefined) {
        if (catalog.revision !== expectation.expectedRevision) {
          return { status: 'conflict' as const, revision: catalog.revision === 'absent' ? -1 : catalog.revision };
        }
        if (catalog.revision === 'absent' && catalog.sourceSettingsVersion !== sourceSettingsExpectation) {
          return { status: 'settings-conflict' as const, revision: catalog.sourceSettingsVersion };
        }
        if (catalog.revision !== 'absent' && expectation.sourceSettingsVersion !== undefined) {
          throw new AcpCatalogUnavailableError('invalid-stored-content');
        }
      }
      const current = { v: 2 as const, backends: catalog.record.definitions };
      const next = mutate(current);
      if (next === current) return { status: 'unchanged' as const };
      if (!next || typeof next !== 'object' || Array.isArray(next) || Reflect.get(next, 'v') !== 2) throw new AcpCatalogUnavailableError('invalid-stored-content');
      const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: Reflect.get(next, 'backends') });
      if (catalog.revision === 'absent' && catalog.source === 'predecessor') {
        const transfer = await writeRecord({ record: catalog.record, expectedRevision: 'absent', source: 'predecessor',
          sourceSettingsVersion: catalog.sourceSettingsVersion });
        if (transfer.status !== 'updated') return transfer;
        // Acknowledged transfer is not permission to mutate a replacement Account.
        try { await admitCurrent(); }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'scope-retired') {
            throw new AcpCatalogUnavailableError('scope-retired', transfer.revision);
          }
          throw error;
        }
        catalog = { status: 'ready', record: catalog.record, revision: transfer.revision };
        await publish(catalog);
      }
      const result = await writeRecord({ record, expectedRevision: catalog.revision,
        ...(catalog.revision === 'absent' ? { sourceSettingsVersion: catalog.sourceSettingsVersion, source: catalog.source } : {}) });
      if (result.status === 'updated') {
        try {
          await admitCurrent();
          await publish({ status: 'ready', record, revision: result.revision });
        } catch { /* A retired projection cannot undo a durable mutation receipt. */ }
      }
      return result;
    },
  };
}
export type CliAcpCatalogStore = ReturnType<typeof createCliAcpCatalogStore>;
