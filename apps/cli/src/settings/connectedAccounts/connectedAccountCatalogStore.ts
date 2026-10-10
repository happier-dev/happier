import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { loadConnectedAccountCatalogV1, type ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
  ConnectedAccountCatalogRowMutationV1Schema, ConnectedAccountCatalogRowMutationResponseV1Schema,
  sealConnectedAccountCatalogContentV1, readRetainedConnectedAccountCatalogRecordV1, listConnectedConfigurationCatalogSavedSecretRefsV1,
  type ConnectedAccountCatalogKeyV1, type ConnectedAccountCatalogRecordV1,
  type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  commitActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';

type CatalogWrite = Readonly<{ record: ConnectedAccountCatalogRecordV1; expectedRevision: number | 'absent';
  sourceSettingsVersion?: number; settingsMutation?: ConnectedAccountCatalogRowMutationV1['settingsMutation'] }>;

/** Captured Home transport only. Protocol owns opening, absence admission and retained-source cutover. */
export function createCliConnectedAccountCatalogStore(input: Readonly<{
  credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>) {
  const context = input.operationContext;
  const base = (context?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const scopeKey = context?.readSnapshot()?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (readSnapshot()?.scopeKey !== scopeKey || !context && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw Object.assign(new Error('Captured Connected Account retired'), { code: 'scope-retired' });
    }
  };
  const verifyCurrent = async () => {
    assertCurrent();
    if (context && !await context.isCurrent()) throw Object.assign(new Error('Captured Connected Account retired'), { code: 'scope-retired' });
    assertCurrent();
  };
  const compatibilityHeaders = buildCurrentAccountStoredContentCompatibilityHttpHeaders();
  const headersFor = (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
    const authorization = input.authorizeRequest ? input.authorizeRequest(request) : { Authorization: `Bearer ${input.credentials.token}` };
    if (!authorization) throw Object.assign(new Error('Action authorization unavailable'), { code: 'unauthorized' });
    return { ...compatibilityHeaders, ...authorization, 'Content-Type': 'application/json' };
  };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    await verifyCurrent();
    assertCurrent();
    const method = body === undefined ? 'GET' : 'POST';
    const options = { headers: headersFor({ method, path, ...(body === undefined ? {} : { body }) }),
      ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true };
    const response = body === undefined ? await axios.get<unknown>(`${base}${path}`, options)
      : await axios.post<unknown>(`${base}${path}`, body, options).catch((cause: unknown) => {
        throw Object.assign(new Error('Connected Account mutation outcome is unknown'), { code: 'outcome_unknown', cause });
      });
    // A durable effect-only receipt survives retirement; private reads do not.
    if (body === undefined) { await verifyCurrent(); assertCurrent(); }
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      throw Object.assign(new Error('Connected Account transport unavailable'), { code:
        response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
          : response.status === 404 ? 'unsupported' : 'unreachable' });
    }
    return response.data;
  };
  const readStorageContext = async () => {
    await verifyCurrent();
    assertCurrent();
    const storage = await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base,
      signal: input.signal, shouldContinue: () => { assertCurrent(); return true; },
      authorizationHeaders: headersFor({ method: 'GET', path: '/v1/account/encryption/currentness' }) });
    await verifyCurrent();
    assertCurrent();
    return storage;
  };
  const readRow = async (key: ConnectedAccountCatalogKeyV1) => {
    const response = await request(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/${key}`);
    assertCurrent();
    return ConnectedAccountCatalogRowReadResponseV1Schema.parse(response);
  };
  const publishSource = async (raw: Readonly<Record<string, unknown>>, version: number,
    catalog?: Extract<ConnectedAccountCatalogSnapshotV1, { status: 'ready' }>) => {
    await verifyCurrent();
    assertCurrent();
    const snapshot = readSnapshot();
    if (!snapshot) return;
    const next = { ...snapshot, source: 'network' as const, settings: accountSettingsParse(raw), rawSettings: raw,
      settingsVersion: version, loadedAtMs: Date.now(), ...(catalog ? catalog.record.key === 'configurations'
        ? { connectedConfigurationCatalog: catalog } : { connectedPurposeCatalog: catalog } : {}) };
    if (context) await context.replaceAccountSettings(next);
    else commitActiveAccountSettingsSnapshot(next);
  };
  const readSourceSnapshot = async () => {
    const storage = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => storage.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    await publishSource(source.raw, source.version);
    assertCurrent();
    return { ...source, ...storage };
  };
  const writeRecord = async (value: CatalogWrite) => {
    const storage = await readStorageContext();
    const references = value.record.key === 'configurations'
      ? [...new Set(listConnectedConfigurationCatalogSavedSecretRefsV1(value.record.value).map(reference => reference.secretId))] : [];
    const captured = references.length === 0 ? { referencedSavedSecretIds: [], savedSecretRevisions: [] }
      : await runWithServerHttpBaseUrl(base, async () => {
        const { captureSavedSecretReferencesForOperation } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
        return captureSavedSecretReferencesForOperation({ expectedScopeKey: scopeKey, references,
          signal: input.signal, ...(context ? { operationContext: context } : {}) });
      });
    await verifyCurrent();
    assertCurrent();
    const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
      content: sealConnectedAccountCatalogContentV1({ ...storage, record: value.record }),
      ...captured, ...(value.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: value.sourceSettingsVersion }),
      ...(value.settingsMutation ? { settingsMutation: value.settingsMutation } : {}) });
    return ConnectedAccountCatalogRowMutationResponseV1Schema.parse(await request(
      `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/${value.record.key}`, mutation));
  };
  const readAdmittedCatalog = async (key: ConnectedAccountCatalogKeyV1) => {
    const storage = await readStorageContext();
    const catalog = await loadConnectedAccountCatalogV1({ key, ...storage, signal: input.signal, readRow: () => readRow(key) });
    const current = await readStorageContext();
    await verifyCurrent();
    return current.mode === storage.mode ? catalog : { status: 'unavailable' as const, reason: 'account-mode-mismatch' as const };
  };
  const readCatalog = async (key: ConnectedAccountCatalogKeyV1,
    onReadyBeforeCleanup?: (catalog: Extract<ConnectedAccountCatalogSnapshotV1, { status: 'ready' }>) => Promise<void>) => {
    const storage = await readStorageContext();
    const catalog = await loadConnectedAccountCatalogV1({ key, ...storage, signal: input.signal, readRow: () => readRow(key),
      onReadyBeforeCleanup: async ready => {
        const admitted = await readStorageContext();
        if (admitted.mode !== storage.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
        await onReadyBeforeCleanup?.(ready);
      }, transfer: {
        readSourceSnapshot: async phase => {
          let source = await readSourceSnapshot();
          const retained = phase.purpose === 'initialization' && key === 'configurations'
            ? readRetainedConnectedAccountCatalogRecordV1(source.raw, key) : null;
          // Only this complete source's actual personal references require S2.
          // Partial admission remains Protocol-owned; unrelated personal secrets
          // cannot turn an empty/non-secret configuration read into a full import.
          if (retained?.status === 'ready' && retained.record.key === 'configurations'
            && listConnectedConfigurationCatalogSavedSecretRefsV1(retained.record.value)
              .some(reference => parseSavedSecretRefV1(reference.secretId).kind === 'personal')) {
            const { importLegacySavedSecretsForOperation } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
            const imported = await runWithServerHttpBaseUrl(base, () => importLegacySavedSecretsForOperation({ expectedScopeKey: scopeKey,
              signal: input.signal, ...(context ? { operationContext: context } : {}) }));
            await verifyCurrent();
            if (imported.status !== 'complete') throw new Error('Connected Account personal source transfer unavailable');
            source = await readSourceSnapshot();
          }
          if (key !== 'purposes' || phase.purpose !== 'initialization') return source;
          const contributions = readCurrentContributionRegistry();
          return { ...source, purposeDefaultAgents: Array.from(contributions.agentDefinitionsById.keys(), agentId => {
            const declarations = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId, contributions });
            return { agentId, identity: declarations?.authorizedPurposes[0]?.purpose.consumer ?? null,
              connectedAccounts: declarations?.authorizedPurposes.flatMap(scope => scope.serviceRefs[0]
                ? [{ purpose: scope.purpose.purpose, service: scope.serviceRefs[0] }] : []) ?? [] };
          }) };
        }, initializeRecord: writeRecord,
        replaceSource: async value => {
          const current = await readStorageContext();
          if (current.mode !== storage.mode) return { status: 'rejected' };
          const result = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials, ...value,
            signal: input.signal, envelopeKind: current.mode === 'plain' ? 'plain' : 'encrypted', deps: {
              resolveAccountEncryptionMode: async () => current.mode,
              updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
            } });
          if (result.success) { await publishSource(value.raw, result.version); return { status: 'applied', settingsVersion: result.version }; }
          return result.error === 'version-mismatch' ? { status: 'conflict', currentSettingsVersion: result.currentVersion } : { status: 'rejected' };
        }, normalizeHistory: value => normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: input.credentials,
          serverBaseUrl: base, signal: input.signal, isCurrent: async () => { try { await verifyCurrent(); return true; } catch { return false; } },
          ...(input.authorizeRequest ? { authorizeRequest: input.authorizeRequest } : {}),
          destinationAuthority: value }),
      } });
    await verifyCurrent();
    assertCurrent();
    return catalog;
  };
  const sealSettingsMutation = (source: Awaited<ReturnType<typeof readSourceSnapshot>>, raw: Readonly<Record<string, unknown>>) => ({
    expectedSettingsVersion: source.version,
    content: source.mode === 'plain' ? { t: 'plain' as const, v: raw } : { t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: source.material, payload: raw,
        randomBytes: length => new Uint8Array(randomBytes(length)) }) },
  });
  return { serverHttpBaseUrl: base, assertCurrent, readSnapshot, readStorageContext, readRow, readCatalog, readAdmittedCatalog, readSourceSnapshot, writeRecord,
    sealSettingsMutation, publishSource };
}
