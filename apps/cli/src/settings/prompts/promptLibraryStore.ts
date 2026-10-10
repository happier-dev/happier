import axios from 'axios';
import { loadPromptLibraryCatalogV1, readPromptLibraryCatalogRecordV1, type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { applyRoleOverrideMutationV1, type RoleOverrideMutationV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema, PromptLibraryRowMutationV1Schema,
  PromptLibraryRowMutationResponseV1Schema, sealPromptLibraryContentV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { parseSettingsFromContent, readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { retainLegacyRoleArtifactsV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { normalizeAccountSettingsHistoryClientV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { randomBytes } from 'node:crypto';

/** Captures the incumbent Home/Account/key lifetime, without a parallel Settings publication. */
export function createCliPromptLibraryStore(input: Readonly<{ credentials: StoredCredentials; signal?: AbortSignal }>) {
  const base = resolveServerHttpBaseUrl().replace(/\/+$/, '');
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}`,
    'Content-Type': 'application/json' };
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw Object.assign(new Error('Captured Prompt library Account retired'), { code: 'scope-retired' });
    }
  };
  const publishObservedSource = (raw: Readonly<Record<string, unknown>>, version: number): void => {
    const incumbent = getActiveAccountSettingsSnapshot();
    // A network read or durable cleanup receipt advances the existing Settings
    // owner, never a retired Account lifetime or an already newer winner.
    if (incumbent?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) return;
    commitActiveAccountSettingsSnapshot({ ...incumbent, source: 'network', rawSettings: raw,
      settings: accountSettingsParse(raw), settingsVersion: version, loadedAtMs: Date.now() });
  };
  const requestResponse = async (path: string, body?: unknown): Promise<Readonly<{ status: number; data: unknown }>> => {
    assertCurrent();
    const options = { headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true };
    const response = body === undefined ? await axios.get(`${base}${path}`, options) : await axios.post(`${base}${path}`, body, options).catch((error: unknown) => {
      throw Object.assign(new Error('Prompt library mutation transport failed'), { code: classifyHomeDomainHttpMutationFailureV1({
        error, issued: true, aborted: input.signal?.aborted === true,
      }), cause: error });
    });
    if (body === undefined) assertCurrent();
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      throw Object.assign(new Error('Prompt library Account transport unavailable'), { code:
        response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
          : response.status === 404 ? 'unsupported' : 'unreachable' });
    }
    return { status: response.status, data: response.data as unknown };
  };
  const request = async (path: string, body?: unknown): Promise<unknown> => (await requestResponse(path, body)).data;
  const readStorageContext = async () => {
    assertCurrent();
    return await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base,
      signal: input.signal, shouldContinue: () => { assertCurrent(); return true; }, authorizationHeaders: headers });
  };
  const readPromptLibraryCatalog = async (onReady?: (catalog: PromptLibraryCatalogSnapshotV1) => void) => {
    const context = await readStorageContext();
    const catalog = await loadPromptLibraryCatalogV1({ ...context, signal: input.signal,
      readRows: async () => PromptLibraryRowsListResponseV1Schema.parse(await request(PROMPT_LIBRARY_ROWS_ROUTE_V1)),
      ...(onReady ? { onReadyBeforeCleanup: async (catalog: PromptLibraryCatalogSnapshotV1) => {
        const admitted = await readStorageContext();
        assertCurrent();
        if (admitted.mode !== context.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
        onReady(catalog);
      } } : {}),
      transfer: {
        readSourceSnapshot,
        initializeRecord: writeRecord,
        replaceSource: async value => {
          const current = await readStorageContext();
          if (current.mode !== context.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
          const response = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials,
            signal: input.signal, raw: value.raw, expectedVersion: value.expectedVersion,
            envelopeKind: context.mode === 'plain' ? 'plain' : 'encrypted', deps: {
              resolveAccountEncryptionMode: async () => current.mode,
              updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
            } });
          if (response.success) publishObservedSource(value.raw, response.version);
          assertCurrent();
          return response.success ? { status: 'applied', settingsVersion: response.version }
            : response.error === 'version-mismatch' ? { status: 'conflict', currentSettingsVersion: response.currentVersion }
              : { status: 'rejected' };
        },
        retainLegacyRoleArtifacts: raw => runWithServerHttpBaseUrl(base, async () => {
          assertCurrent();
          const accountId = readAccountIdFromToken(input.credentials.token);
          if (!accountId) throw new Error('Account identity unavailable');
          const artifacts = createCredentialedAccountArtifactStore(input.credentials);
          const receipts = await retainLegacyRoleArtifactsV1({ rawSettings: raw, accountId, signal: input.signal, artifactStore: {
            ...artifacts,
            read: async (...args) => { assertCurrent(); const result = await artifacts.read(...args); assertCurrent(); return result; },
            create: async value => { assertCurrent(); return await artifacts.create(value); },
          } });
          assertCurrent();
          return receipts;
        }),
        normalizeHistory: value => normalizeAccountSettingsHistoryClientV1({ destinationAuthority: value, ports: {
          request: (path, value) => requestResponse(path, value.body),
          readCurrentness: () => fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: base,
            authorizationHeaders: headers, signal: input.signal }),
          isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
          resolveTransferMaterial: async mode => {
            const current = await readStorageContext();
            if (current.mode !== mode) throw new Error('Account history mode changed');
            return current.material;
          },
          openSnapshot: async content => (await parseSettingsFromContent({ content, credentials: input.credentials,
            emptyEnvelopeKind: content.t === 'plain' ? 'plain' : 'encrypted' })).raw,
          resealSnapshot: (raw, recorded) => {
            if (recorded.t === 'plain') return { t: 'plain', v: raw };
            const encryption = input.credentials.encryption;
            if (!encryption) throw new Error('Account history encryption material unavailable');
            const material = encryption.type === 'legacy' ? { type: 'legacy' as const, secret: encryption.secret }
              : { type: 'dataKey' as const, machineKey: encryption.machineKey };
            return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
              payload: raw, randomBytes: length => new Uint8Array(randomBytes(length)) }) };
          },
          unavailable: (_status, message) => { throw new Error(message); },
        } }),
      } });
    const admitted = await readStorageContext();
    assertCurrent();
    return admitted.mode === context.mode ? catalog : { status: 'unavailable' as const, reason: 'account-mode-mismatch' as const };
  };
  const readSourceSnapshot = async () => {
    const context = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => context.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    assertCurrent();
    publishObservedSource(source.raw, source.version);
    return { ...source, ...context };
  };
  const writeRecord = async (value: Readonly<{ record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>) => {
      const context = await readStorageContext();
      if (value.expectedRevision === 'absent' && value.sourceSettingsVersion === undefined) throw new Error('source-currentness-unavailable');
      const mutation = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
        content: sealPromptLibraryContentV1({ ...context, record: value.record }),
        ...(value.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: value.sourceSettingsVersion }) });
      const response = PromptLibraryRowMutationResponseV1Schema.safeParse(await request(
        `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${encodeURIComponent(value.record.key)}`, mutation));
      if (!response.success) throw Object.assign(new Error('Prompt library mutation outcome is unknown'), { code: 'outcome_unknown' });
      return response.data;
  };
  return {
    assertCurrent, readStorageContext, readPromptLibraryCatalog, readSourceSnapshot, writeRecord,
    mutateRoleOverride: async (mutation: RoleOverrideMutationV1): Promise<void> => {
      // Resolve the publication owner before issuing effects, so withdrawal after the receipt is synchronous.
      const { refreshActivePromptLibraryCatalogAfterChange } = await import('./hydratePromptLibraryCatalog');
      const catalog = await readPromptLibraryCatalog();
      const absent = (catalog.status === 'ready' || catalog.status === 'partial')
        && !catalog.rows.some(row => row.record.key === 'role-overrides')
        && !catalog.tombstones.some(row => row.key === 'role-overrides')
        && !catalog.diagnostics.some(row => row.key === 'role-overrides');
      const source = absent ? await readSourceSnapshot() : null;
      const read = readPromptLibraryCatalogRecordV1({ catalog, key: 'role-overrides',
        ...(source ? { rawSettings: source.raw } : {}) });
      if (read.status !== 'ready' || read.record.key !== 'role-overrides') {
        throw Object.assign(new Error('Role override catalog is unavailable'), { code: read.status === 'unavailable' ? read.reason : 'invalid-stored-content' });
      }
      const result = await writeRecord({ record: { key: 'role-overrides', value: { v: 1,
        ...applyRoleOverrideMutationV1({ overrides: read.record.value.overrides }, mutation) } }, expectedRevision: read.revision,
        ...(source ? { sourceSettingsVersion: source.version } : {}) });
      if (result.status !== 'updated') throw Object.assign(new Error('Role override mutation was not acknowledged'), { code: result.status, result });
      // Publication has its incumbent lifetime owner; its refusal never turns an
      // already acknowledged effect into a replayable failure.
      try {
        await refreshActivePromptLibraryCatalogAfterChange({ credentials: input.credentials, scopeKey, lifetimeToken });
      } catch { /* A failed projection cannot undo an acknowledged effect or authorize replay. */ }
    },
  };
}
export type CliPromptLibraryStore = ReturnType<typeof createCliPromptLibraryStore>;
