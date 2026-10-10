import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema,
  ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation } from './catalogStore';
import { refreshActiveProviderConnectionsCatalog } from './hydrate';
import { createCliProviderActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliProviderActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { CustomProviderTemplateV1Schema } from '@happier-dev/protocol/providers/connections/customTemplateV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createCliAccountProviderActionExecuteV1 } from '@/providers/connections/accountActions';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it('refuses a model list from a credential retired after declaration admission without refreshing projections', async () => {
  const credentials = { token: 'provider-retiring-reader', encryption: null };
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 4,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  let current = true;
  let retireAfterAdmission = false;
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://retiring-provider-home.invalid', isCurrent: async () => {
      const admitted = current;
      if (retireAfterAdmission) queueMicrotask(() => { current = false; });
      return admitted;
    } });
  const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_reader', source: { kind: 'custom', template: { v: 1, name: 'Reader',
      endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://reader.invalid/v1', capabilities: {
        streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' } } }, role: 'named', displayName: 'Reader',
      displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 }] });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      status: 'present', revision: 7, content: { t: 'plain', v: catalog } } };
    throw new Error(`Pure model read must not refresh Account projections: ${path}`);
  });
  const execute = createCliAccountProviderActionExecuteV1({ credentials, operationContext,
    serverHttpBaseUrl: 'https://retiring-provider-home.invalid', readDefinitions: async () => {
      retireAfterAdmission = true;
      return [];
    } });
  await expect(execute(parseProviderActionRequestV1('providers.models.list', { connectionId: 'pc_reader' }),
    { surface: 'cli' })).rejects.toMatchObject({ code: 'scope-retired' });
});

it.each(['updated', 'uninitialized', 'conflict', 'outcome_unknown'] as const)('authors a Provider through its captured Account without a machine: %s', async outcome => {
  const credentials = { token: 'provider-account-authoring', encryption: null };
  const retained = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_retained', source: { kind: 'contribution', contributionKey: 'legacy.provider/source' },
      role: 'named', displayName: 'Retained', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 }] });
  let settingsRaw: Record<string, unknown> = outcome === 'uninitialized' ? { unrelatedPreference: 'keep',
    providerSettingsV1: { ...retained, defaultsByAgentTargetKey: {} } } : {};
  let settingsVersion = 4;
  const snapshot = { source: 'network' as const, settings: accountSettingsParse(settingsRaw), rawSettings: settingsRaw,
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://provider-authoring-home.invalid', isCurrent: async () => true });
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'unrelated-ambient-account' });
  let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
  let present = outcome !== 'uninitialized';
  let revision = 7;
  const submitted: unknown[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const endpoint = new URL(String(url));
    expect(endpoint.origin).toBe('https://provider-authoring-home.invalid');
    if (endpoint.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (endpoint.pathname === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      ...(present ? { status: 'present', revision, content: { t: 'plain', v: catalog } } : { status: 'absent' }) } };
    if (endpoint.pathname === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: settingsRaw } } };
    if (endpoint.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(endpoint.pathname);
    if (history) return history;
    throw new Error(`Unexpected Account Provider read: ${endpoint.pathname}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (new URL(String(url)).pathname === '/v2/account/settings') {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(mutation.expectedVersion).toBe(settingsVersion);
      if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must keep Plain preferences');
      settingsRaw = mutation.content.v;
      settingsVersion++;
      return { status: 200, data: { success: true, version: settingsVersion } };
    }
    expect(String(url)).toBe('https://provider-authoring-home.invalid/v1/account/entity-rows/provider-connections');
    const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
    submitted.push(mutation);
    expect(mutation.expectedRevision).toBe(present ? revision : 'absent');
    if (outcome === 'conflict') return { status: 409, data: { status: 'conflict', revision: revision + 1 } };
    if (mutation.content?.t !== 'plain') throw new Error('Plain Account must keep a Plain catalog');
    catalog = mutation.content.v;
    present = true;
    revision += 1;
    if (outcome === 'outcome_unknown') throw new Error('Lost acknowledgement after durable commit');
    return { status: 200, data: { status: 'updated', revision, cursor: revision } };
  });
  const executor = createActionExecutor({ providerActionExecute: createCliProviderActionExecuteV1({ credentials,
    operationContext, serverId: 'provider-home', serverHttpBaseUrl: 'https://provider-authoring-home.invalid',
    callMachineAction: async () => { throw new Error('Account Provider authoring must not call a machine'); } }) });
  const context = { surface: 'cli' as const, serverId: 'provider-home', authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
  const execute = (actionId: Parameters<typeof executor.execute>[0], input: unknown) => executor.execute(actionId, input,
    { ...context, presentUserConfirmation: { actionId } });
  const template = CustomProviderTemplateV1Schema.parse({ v: 1, name: 'Account Provider',
    endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://provider.invalid/v1',
      capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
    catalog: { source: 'manual', manualModelPolicy: 'allowed' } });
  const result = await execute('providers.connections.create_custom', { action: 'createCustom',
    connectionId: 'pc_account', template, savedSecretId: null, enable: false });
  expect(submitted, JSON.stringify(result)).toHaveLength(outcome === 'uninitialized' ? 2 : 1);
  expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('unrelated-ambient-account');
  if (outcome !== 'updated' && outcome !== 'uninitialized') {
    expect(result).toMatchObject({ ok: false, errorCode: `provider_catalog_${outcome}` });
    expect(catalog.connections).toHaveLength(outcome === 'conflict' ? 0 : 1);
    return;
  }
  expect(result).toMatchObject({ ok: true, result: { status: 'success', action: 'createCustom', connection: { connectionId: 'pc_account' } } });
  expect(await execute('providers.connections.update', { action: 'update', connectionId: 'pc_account',
    expectedRevision: 0, displayName: 'Renamed Account Provider', displayNameMode: 'custom' })).toMatchObject({ ok: true });
  expect(await execute('providers.models.manual.add', { action: 'manualAdd', connectionId: 'pc_account',
    expectedConnectionRevision: 1, models: [{ id: 'manual-model' }] })).toMatchObject({ ok: true });
  expect(catalog.manualModelsByConnectionId.pc_account).toMatchObject([{ id: 'manual-model' }]);
  expect(await execute('providers.connections.describe', { connectionId: 'pc_account' })).toMatchObject({
    ok: true, result: { status: 'success', connections: [{ connectionId: 'pc_account', displayName: 'Renamed Account Provider' }] } });
  expect(await execute('providers.connections.delete', { action: 'delete', connectionId: 'pc_account' })).toMatchObject({ ok: true });
  expect(catalog.connections).toEqual(outcome === 'uninitialized' ? retained.connections : []);
  if (outcome === 'uninitialized') expect(settingsRaw).toEqual({ unrelatedPreference: 'keep', providerDefaultModelSelectionsByAgentTargetKeyV1: {} });
  expect(catalog.manualModelsByConnectionId).toEqual({});
});

it.each(['empty', 'retained', 'personal'] as const)('uses personal-reference demand before activating a %s Provider source in its initiating Home', async sourceKind => {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'provider-captured-source-owner' })).toString('base64url')}.signature`, encryption: null };
  const sourceCatalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: sourceKind === 'empty' ? [] : [{ v: 1, id: 'pc_source', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'named', displayName: 'Retained source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
    ...(sourceKind === 'personal' ? { secretBindingsByConnectionId: { pc_source: { account: { apiKey: 'locked-unrelated' } } } } : {}) });
  let raw: Record<string, unknown> = { unrelatedPreference: { keep: true }, secrets: [{ id: 'locked-unrelated', name: 'Locked',
    kind: 'token', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'unopenable' } }, createdAt: 1, updatedAt: 1 }],
    ...(sourceKind !== 'empty' ? { providerSettingsV1: { ...sourceCatalog, defaultsByAgentTargetKey: {} } } : {}) };
  let settingsVersion = 4;
  const snapshot = { source: 'network' as const, settings: accountSettingsParse(raw), rawSettings: raw,
    settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://provider-source-home.invalid', isCurrent: async () => true });
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'unrelated-ambient-account' });
  let catalog: typeof sourceCatalog | undefined;
  let resourceReads = 0;
  let unrelatedProfileReads = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const endpoint = new URL(String(url));
    expect(endpoint.origin).toBe('https://provider-source-home.invalid');
    const path = endpoint.pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: catalog
      ? { status: 'present', revision: 1, content: { t: 'plain', v: catalog } } : { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: raw } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/account/entity-rows/profiles') { unrelatedProfileReads += 1; return { status: 503, data: { error: 'locked_unrelated_source' } }; }
    if (path === '/v1/saved-secrets') { resourceReads += 1; return { status: 403, data: { error: 'forbidden' } }; }
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected captured Provider HTTP boundary: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const endpoint = new URL(String(url));
    expect(endpoint.origin).toBe('https://provider-source-home.invalid');
    if (endpoint.pathname === '/v1/account/entity-rows/provider-connections') {
      const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
      expect(mutation.expectedRevision).toBe('absent');
      expect(mutation.savedSecretRevisions).toEqual([]);
      if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must write a Plain catalog');
      catalog = mutation.content.v;
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    }
    if (endpoint.pathname === '/v2/account/settings') {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(mutation.expectedVersion).toBe(settingsVersion);
      if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must retain Plain Settings');
      raw = mutation.content.v;
      settingsVersion += 1;
      return { status: 200, data: { success: true, version: settingsVersion } };
    }
    throw new Error(`Unexpected captured Provider write: ${endpoint.pathname}`);
  });
  const read = createCliProviderConnectionsStoreForOperation({ operationContext }).readCatalog();
  if (sourceKind === 'personal') {
    expect(await read).toMatchObject({ status: 'unavailable' });
    expect(catalog).toBeUndefined();
    expect(raw.providerSettingsV1).toEqual(snapshot.rawSettings.providerSettingsV1);
  } else {
    expect(await read).toMatchObject({ status: 'ready', revision: 1, catalog: { connections: sourceCatalog.connections } });
    expect(raw).not.toHaveProperty('providerSettingsV1');
  }
  expect(raw.secrets).toEqual(snapshot.rawSettings.secrets);
  expect(raw.unrelatedPreference).toEqual({ keep: true });
  expect(resourceReads).toBe(0);
  expect(unrelatedProfileReads).toBe(sourceKind === 'personal' ? 1 : 0);
  expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('unrelated-ambient-account');
});

it('opens keyless Plain Provider rows and refuses a late row from a retired Account lifetime', async () => {
  const credentials = { token: 'provider-catalog-owner', encryption: null };
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey };
  setActiveAccountSettingsSnapshot(snapshot);
  let release: (() => void) | undefined;
  const rowWait = new Promise<void>(resolve => { release = resolve; });
  let rowEntered: (() => void) | undefined;
  const rowStarted = new Promise<void>(resolve => { rowEntered = resolve; });
  let block = false;
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      if (block) { rowEntered?.(); await rowWait; }
      return { status: 200, data: { status: 'present', revision: 7, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
    if (historyResponse) return historyResponse;
    throw new Error(`Unexpected Provider HTTP boundary: ${path}`);
  });
  const store = createCliProviderConnectionsStore({ credentials });
  expect(await store.readCatalog()).toMatchObject({ status: 'ready', revision: 7, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
  block = true;
  const pending = store.readCatalog();
  await rowStarted;
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'replacement', settingsVersion: 1 });
  release?.();
  await expect(pending).rejects.toMatchObject({ code: 'scope-retired' });
  expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement');
});

it('reads retained row authority in its issued invocation Home without activating an absent catalog', async () => {
  const credentials = { token: 'provider-invocation-owner', encryption: null };
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  let current = true;
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://captured-provider-home.invalid', isCurrent: async () => current });
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'unrelated-daemon-account' });
  let row: { status: 'absent' } | { status: 'deleted'; revision: number } = { status: 'absent' };
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    expect(String(url)).toBe('https://captured-provider-home.invalid/v1/account/entity-rows/provider-connections');
    return { status: 200, data: row };
  });
  const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected Provider mutation'));
  const store = createCliProviderConnectionsStoreForOperation({ operationContext });
  expect(await store.readRow()).toEqual({ status: 'absent' });
  row = { status: 'deleted', revision: 11 };
  expect(await store.readRow()).toEqual(row);
  expect(post).not.toHaveBeenCalled();
  expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toBeUndefined();
  current = false;
  await expect(store.readRow()).rejects.toMatchObject({ code: 'scope-retired' });
});

it('reopens an in-flight catalog read after a source visibility mutation before publishing its winner', async () => {
  const credentials = { token: 'provider-pending-read-owner', encryption: null };
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
  const initial = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'default', displayName: 'A', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }] });
  let catalog = initial;
  let rowReads = 0;
  let release: (() => void) | undefined;
  const oldRowWait = new Promise<void>(resolve => { release = resolve; });
  let entered: (() => void) | undefined;
  const oldRowStarted = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      const captured = catalog;
      if (++rowReads === 1) { entered?.(); await oldRowWait; }
      return { status: 200, data: { status: 'present', revision: captured === initial ? 7 : 8, content: { t: 'plain', v: captured } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected Provider pending-read HTTP boundary: ${path}`);
  });
  let committed: (() => void) | undefined;
  const mutationCommitted = new Promise<void>(resolve => { committed = resolve; });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/provider-connections');
    const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
    if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must write Plain catalog');
    catalog = mutation.content.v;
    committed?.();
    return { status: 200, data: { status: 'updated', revision: 8, cursor: 8 } };
  });
  const pendingRead = refreshActiveProviderConnectionsCatalog({ credentials });
  await oldRowStarted;
  const execute = createCliProviderActionExecuteV1({ credentials, serverId: 'provider-home',
    serverHttpBaseUrl: 'https://pending-provider-home.invalid',
    callMachineAction: async () => { throw new Error('Visibility must not consult a daemon'); } });
  const action = execute({ actionId: 'providers.models.source_visibility.set', input: {
    action: 'setConnectionVisibility', connectionId: 'pc_a', shown: false,
  } }, { surface: 'cli', serverId: 'provider-home' });
  await mutationCommitted;
  release?.();
  expect(await action).toEqual({ ok: true, result: { status: 'updated' } });
  await pendingRead;
  expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({
    status: 'ready', revision: 8, catalog: { modelPickerVisibilityByConnectionId: { pc_a: false } },
  });
});
