import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { loadConnectedMetadataCatalogV1, type ConnectedMetadataCatalogV1, type ConnectedMetadataSourceTransferV1 } from '@happier-dev/protocol/connect/connectedMetadataCatalogV1';
import {
  ConnectedPresentationRowReadResponseV1Schema, ConnectedAcknowledgementsRowReadResponseV1Schema,
  ConnectedPresentationRowMutationV1Schema, ConnectedAcknowledgementsRowMutationV1Schema,
  ConnectedMetadataRowMutationResponseV1Schema, sealConnectedPresentationContentV1, sealConnectedAcknowledgementsContentV1,
  applyConnectedPresentationMutationV1, applyConnectedSubscriptionPriceMutationV1, applyConnectedAcknowledgementMutationV1, removeConnectedMetadataSubjectV1,
  removeLegacyConnectedMetadataSubjectV1,
  CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
  connectedEntitySubjectKeyV1, type ConnectedPresentationRecordV1, type ConnectedAcknowledgementsRecordV1,
  type QualifiedConnectedEntityRef, type QualifiedAcknowledgementSubject, type LegacyConnectedMetadataInventoryV1,
} from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { StoredCredentials } from '@/persistence';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

const presentationPath = CONNECTED_PRESENTATION_ROWS_ROUTE_V1;
const acknowledgementsPath = CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1;

type WriteInput<Record> = Readonly<{ record: Record; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>;
type MetadataStoreInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal;
  serverHttpBaseUrl?: string; operationContext?: SavedSecretOperationContextV1;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null }>;
type PreparedCleanup = Readonly<{ subjectKey: string; originalRaw: Readonly<Record<string, unknown>>;
  raw: Readonly<Record<string, unknown>>; expectedVersion: number; mode: 'plain' | 'e2ee'; incomplete: boolean; failure?: string }>;

/** Captured Account transport; finite requester custody never borrows daemon publication. */
export function createCliConnectedMetadataStore(input: MetadataStoreInput) {
  const operationContext = input.operationContext;
  const credentials = operationContext?.credentials ?? input.credentials;
  const base = (operationContext?.serverHttpBaseUrl ?? input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const readSnapshot = () => operationContext ? operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  const isCurrent = async () => !input.signal?.aborted && (!input.isCredentialCurrent || await input.isCredentialCurrent()) && (operationContext
    ? await operationContext.isCurrent() && operationContext.readSnapshot()?.scopeKey === scopeKey
    : getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    if (credentials.token !== input.credentials.token || !await isCurrent()) {
      throw Object.assign(new Error('Captured connected metadata Account retired'), { code: 'scope-retired' });
    }
  };
  const headersFor = (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
    const authorization = input.authorizeRequest ? input.authorizeRequest(request) : { Authorization: `Bearer ${credentials.token}` };
    if (!authorization) throw Object.assign(new Error('Captured Action authorization unavailable'), { code: 'unauthorized' });
    return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorization, 'Content-Type': 'application/json' };
  };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    await assertCurrent();
    const options = { headers: headersFor({ method: body === undefined ? 'GET' : 'POST', path,
      ...(body === undefined ? {} : { body }) }), ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true };
    const response = body === undefined ? await axios.get<unknown>(`${base}${path}`, options)
      : await axios.post<unknown>(`${base}${path}`, body, options).catch((error: unknown) => {
        throw Object.assign(new Error('Connected metadata mutation transport failed'), { code: classifyHomeDomainHttpMutationFailureV1({
          error, issued: true, aborted: input.signal?.aborted === true,
        }), cause: error });
      });
    // A durable mutation receipt remains true after retirement; private reads do not.
    if (body === undefined) await assertCurrent();
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      throw Object.assign(new Error('Connected metadata transport unavailable'), { code:
        body !== undefined && response.status >= 500 ? 'outcome_unknown'
          : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
          : [404, 405, 501].includes(response.status) ? 'unsupported' : 'unreachable' });
    }
    return response.data;
  };
  const readStorageContext = async () => {
    await assertCurrent();
    const context = await resolveCliAccountStorageContext({ credentials, serverBaseUrl: base, signal: input.signal,
      authorizationHeaders: headersFor({ method: 'GET', path: '/v1/account/encryption/currentness' }),
      shouldContinue: () => readSnapshot()?.scopeKey === scopeKey });
    await assertCurrent();
    return context;
  };
  const publishObservedSource = async (raw: Readonly<Record<string, unknown>>, version: number) => {
    if (!await isCurrent()) return;
    const incumbent = readSnapshot();
    if (!incumbent) return;
    const snapshot = { ...incumbent, source: 'network' as const, rawSettings: raw, settings: accountSettingsParse(raw),
      settingsVersion: version, loadedAtMs: Date.now() };
    if (operationContext) await operationContext.replaceAccountSettings(snapshot);
    else commitActiveAccountSettingsSnapshot(snapshot);
  };
  const readSourceSnapshot = async () => {
    const context = await readStorageContext();
    const source = await readAccountSettingsV2Raw({ credentials, signal: input.signal, deps: {
      resolveAccountEncryptionMode: async () => context.mode,
      fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
    } });
    await assertCurrent();
    await publishObservedSource(source.raw, source.version);
    return source;
  };
  const replaceSource = async (value: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>, expectedMode?: 'plain' | 'e2ee') => {
    const current = await readStorageContext();
    if (expectedMode !== undefined && current.mode !== expectedMode) {
      throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
    }
    const response = await replaceAccountSettingsV2RawForOwnerCutover({ credentials, signal: input.signal,
      raw: value.raw, expectedVersion: value.expectedVersion, envelopeKind: current.mode === 'plain' ? 'plain' : 'encrypted', deps: {
        resolveAccountEncryptionMode: async () => current.mode,
        updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
      } });
    if (response.success) await publishObservedSource(value.raw, response.version);
    return response.success ? { status: 'applied' as const, settingsVersion: response.version }
      : response.error === 'version-mismatch' ? { status: 'conflict' as const, currentSettingsVersion: response.currentVersion }
        : { status: 'rejected' as const };
  };
  const readInventory = async (): Promise<LegacyConnectedMetadataInventoryV1> => {
    const profile = AccountProfileSchema.parse(await request('/v1/account/profile'));
    const agents = [...readAgentCatalogSnapshot().agentDefinitionsById.entries()].flatMap(([legacyAgentId, agent]) => {
      const target = AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity: agent.identity });
      // Contribution templates without a configured definition are not legacy executable targets.
      return target.success ? [{ legacyAgentId, agentTargetKey: buildBackendTargetKeyV2(target.data) }] : [];
    });
    return {
      entities: [...profile.connectedAccountsV4.map(({ ref }) => ({ kind: 'account' as const, account: ref })),
        ...profile.connectedAccountGroupsV4.map(({ ref }) => ({ kind: 'group' as const, ...ref }))], agents,
      disclosureSubjects: [...profile.connectedAccountsV4.map(({ ref }) => ({ kind: 'account' as const, account: ref })),
        ...profile.connectedAccountGroupsV4.flatMap(group => group.members.map(member => ({ kind: 'group-member' as const,
          group: group.ref, accountId: member.connectedAccountId })))],
    };
  };
  const writePresentation = async (value: WriteInput<ConnectedPresentationRecordV1>) => {
    const context = await readStorageContext();
    const mutation = ConnectedPresentationRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
      content: sealConnectedPresentationContentV1({ ...context, record: value.record }),
      ...(value.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: value.sourceSettingsVersion }) });
    const result = ConnectedMetadataRowMutationResponseV1Schema.safeParse(await request(presentationPath, mutation));
    if (!result.success) throw Object.assign(new Error('Connected metadata mutation outcome is unknown'), { code: 'outcome_unknown' });
    return result.data;
  };
  const writeAcknowledgements = async (value: WriteInput<ConnectedAcknowledgementsRecordV1>) => {
    const context = await readStorageContext();
    const mutation = ConnectedAcknowledgementsRowMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
      content: sealConnectedAcknowledgementsContentV1({ ...context, record: value.record }),
      ...(value.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: value.sourceSettingsVersion }) });
    const result = ConnectedMetadataRowMutationResponseV1Schema.safeParse(await request(acknowledgementsPath, mutation));
    if (!result.success) throw Object.assign(new Error('Connected metadata mutation outcome is unknown'), { code: 'outcome_unknown' });
    return result.data;
  };
  const readCatalog = async (onReady?: (catalog: ConnectedMetadataCatalogV1) => void, transferSource = true) => {
    const context = await readStorageContext();
    const assertMode = async () => {
      const current = await readStorageContext();
      if (current.mode !== context.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
      return current;
    };
    const transfer: ConnectedMetadataSourceTransferV1 = {
        readSourceSnapshot, readInventory,
        initializePresentation: async value => { await assertMode(); return writePresentation(value); },
        initializeAcknowledgements: async value => { await assertMode(); return writeAcknowledgements(value); },
        replaceSource: async value => {
          await assertMode();
          const response = await replaceSource(value, context.mode);
          await assertCurrent();
          return response;
        },
        normalizeHistory: value => normalizeCliAccountSettingsHistoryAfterTransfer({ credentials, serverBaseUrl: base,
          signal: input.signal, isCurrent, destinationAuthority: value,
          ...(input.authorizeRequest ? { authorizeRequest: input.authorizeRequest } : {}) }),
        // Headless CLI has no device-local disclosure receipt. The canonical loader retains that source.
    };
    const catalog = await loadConnectedMetadataCatalogV1({ ...context, signal: input.signal,
      readPresentationRow: async () => ConnectedPresentationRowReadResponseV1Schema.parse(await request(presentationPath)),
      readAcknowledgementsRow: async () => ConnectedAcknowledgementsRowReadResponseV1Schema.parse(await request(acknowledgementsPath)),
      ...(onReady ? { onReadyBeforeCleanup: async (ready: ConnectedMetadataCatalogV1) => { await assertMode(); onReady(ready); } } : {}),
      ...(transferSource ? { transfer } : {}) });
    await assertMode();
    return catalog;
  };
  const requirePresentation = (catalog: ConnectedMetadataCatalogV1) => {
    const value = catalog.presentation;
    if (value.status !== 'ready') throw Object.assign(new Error('Connected presentation catalog unavailable'), {
      code: value.status === 'unavailable' ? value.reason : 'connected_metadata_catalog_incomplete' });
    return { record: { v: 1 as const, entries: [...value.entries] }, revision: value.revision };
  };
  const requireAcknowledgements = (catalog: ConnectedMetadataCatalogV1) => {
    const value = catalog.acknowledgements;
    if (value.status !== 'ready') throw Object.assign(new Error('Connected acknowledgements catalog unavailable'), {
      code: value.status === 'unavailable' ? value.reason : 'connected_metadata_catalog_incomplete' });
    return { record: { v: 1 as const, entries: [...value.entries] }, revision: value.revision };
  };
  const publishAfterMutation = async () => {
    if (operationContext) return;
    try {
      const { refreshActiveConnectedMetadataCatalogAfterChange } = await import('./hydrateConnectedMetadataCatalog');
      await refreshActiveConnectedMetadataCatalogAfterChange({ credentials, scopeKey, lifetimeToken, serverHttpBaseUrl: base,
        ...(input.authorizeRequest ? { authorizeRequest: input.authorizeRequest } : {}),
        ...(input.isCredentialCurrent ? { isCredentialCurrent: input.isCredentialCurrent } : {}) });
    }
    catch { /* A failed projection cannot undo an acknowledged effect or authorize replay. */ }
  };
  const requireUpdated = (result: Awaited<ReturnType<typeof writePresentation>>) => {
    if (result.status !== 'updated') throw Object.assign(new Error('Connected metadata mutation not acknowledged'), { code: result.status });
  };
  return {
    assertCurrent, readCatalog: (onReady?: (catalog: ConnectedMetadataCatalogV1) => void) => readCatalog(onReady),
    readAdmittedCatalog: () => readCatalog(undefined, false), readInventory,
    prepareCleanup: async (subject: QualifiedConnectedEntityRef): Promise<PreparedCleanup> => {
      // Establish row authority before the credential/group identity can disappear.
      const catalog = await readCatalog();
      const inventory = await readInventory();
      const source = await readSourceSnapshot();
      const context = await readStorageContext();
      const prepared = removeLegacyConnectedMetadataSubjectV1({ raw: source.raw, inventory, subject });
      return { subjectKey: connectedEntitySubjectKeyV1(subject), originalRaw: source.raw, raw: prepared.raw,
        expectedVersion: source.version, mode: context.mode, incomplete: prepared.diagnostics.length > 0,
        ...(catalog.cleanup?.status === 'cleanup-pending' ? { failure: catalog.cleanup.reason } : {}) };
    },
    setLabel: async (value: Readonly<{ subject: QualifiedConnectedEntityRef; label: string | null }>) => {
      const inventory = await readInventory();
      if (inventory.entities.filter(subject => connectedEntitySubjectKeyV1(subject) === connectedEntitySubjectKeyV1(value.subject)).length !== 1) {
        throw Object.assign(new Error('Connected metadata subject unavailable'), { code: 'connected_metadata_subject_unavailable' });
      }
      const catalog = requirePresentation(await readCatalog());
      const record = applyConnectedPresentationMutationV1(catalog.record, value);
      if (isDeepStrictEqual(record, catalog.record)) return;
      requireUpdated(await writePresentation({ record, expectedRevision: catalog.revision }));
      await publishAfterMutation();
    },
    setSubscriptionPrice: async (value: Readonly<{ account: import('@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence').QualifiedConnectedAccountRef;
      price: Omit<import('@happier-dev/protocol/connect/accountSubscription').ProviderAccountSubscriptionMonthlyPriceV1, 'enteredAtMs'> | null }>) => {
      const profile = AccountProfileSchema.parse(await request('/v1/account/profile'));
      const subject = { kind: 'account' as const, account: value.account };
      if (profile.connectedAccountsV4.filter(candidate => connectedEntitySubjectKeyV1({ kind: 'account', account: candidate.ref }) === connectedEntitySubjectKeyV1(subject)).length !== 1) {
        throw Object.assign(new Error('Connected metadata subject unavailable'), { code: 'connected_metadata_subject_unavailable' });
      }
      const admitted = await readCatalog(undefined, false);
      const catalog = requirePresentation(admitted.presentation.status === 'unavailable' && admitted.presentation.reason === 'authority-not-confirmed'
        ? await readCatalog() : admitted);
      const record = applyConnectedSubscriptionPriceMutationV1(catalog.record, { account: value.account,
        price: value.price ? { ...value.price, enteredAtMs: Date.now() } : null });
      if (isDeepStrictEqual(record, catalog.record)) return;
      requireUpdated(await writePresentation({ record, expectedRevision: catalog.revision }));
      await publishAfterMutation();
    },
    setAcknowledgement: async (value: Readonly<{ subject: QualifiedAcknowledgementSubject; acknowledged: boolean | null }>) => {
      if (value.subject.kind === 'adoption') {
        const inventory = await readInventory();
        const subject = value.subject;
        if (!inventory.agents.some(agent => agent.agentTargetKey === subject.agentTargetKey)
          || inventory.entities.filter(entity => entity.kind === 'group' && entity.service.pluginId === subject.service.pluginId
            && entity.service.localId === subject.service.localId && entity.groupId === subject.groupId).length !== 1) {
          throw Object.assign(new Error('Connected acknowledgement subject unavailable'), { code: 'connected_metadata_subject_unavailable' });
        }
      }
      const catalog = requireAcknowledgements(await readCatalog());
      const record = applyConnectedAcknowledgementMutationV1(catalog.record, value);
      if (isDeepStrictEqual(record, catalog.record)) return;
      requireUpdated(await writeAcknowledgements({ record, expectedRevision: catalog.revision }));
      await publishAfterMutation();
    },
    cleanup: async (subject: QualifiedConnectedEntityRef, prepared?: PreparedCleanup) => {
      // Post-delete reads cannot qualify vanished legacy subjects or advance the
      // source version captured before the definite primary effect.
      const catalog = await readCatalog(undefined, false);
      let failure: unknown;
      try {
        const presentation = requirePresentation(catalog);
        const next = removeConnectedMetadataSubjectV1({ presentation: presentation.record, acknowledgements: { v: 1, entries: [] }, subject });
        if (!isDeepStrictEqual(next.presentation, presentation.record)) {
          requireUpdated(await writePresentation({ record: next.presentation, expectedRevision: presentation.revision }));
        }
      } catch (error) { failure = error; }
      try {
        const acknowledgements = requireAcknowledgements(catalog);
        const next = removeConnectedMetadataSubjectV1({ presentation: { v: 1, entries: [] }, acknowledgements: acknowledgements.record, subject });
        if (!isDeepStrictEqual(next.acknowledgements, acknowledgements.record)) {
          requireUpdated(await writeAcknowledgements({ record: next.acknowledgements, expectedRevision: acknowledgements.revision }));
        }
      } catch (error) { failure ??= error; }
      try {
        if (!prepared || prepared.subjectKey !== connectedEntitySubjectKeyV1(subject)) {
          throw Object.assign(new Error('Historical metadata cleanup was not qualified before deletion'), { code: 'connected_metadata_cleanup_not_prepared' });
        }
        if (!isDeepStrictEqual(prepared.raw, prepared.originalRaw)) {
          const receipt = await replaceSource({ raw: prepared.raw, expectedVersion: prepared.expectedVersion }, prepared.mode);
          if (receipt.status !== 'applied') throw Object.assign(new Error('Historical metadata cleanup not acknowledged'), { code: receipt.status });
        }
        if (prepared.incomplete) throw Object.assign(new Error('Opaque historical metadata remains'), { code: 'connected_metadata_source_incomplete' });
      } catch (error) { failure ??= error; }
      if (prepared?.failure) failure ??= Object.assign(new Error('Connected metadata maintenance remains incomplete'), { code: prepared.failure });
      await publishAfterMutation();
      if (failure) throw failure;
    },
  };
}
