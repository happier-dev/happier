import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, FeaturesResponseSchema,
  ProviderContributionV1Schema, ProviderSettingsV1Schema, encryptSecretStringV1 } from '@happier-dev/protocol';
import * as policyOwner from '@happier-dev/protocol/account/settings/accountSettings';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { PinnedHttpStreamTransport } from '@/network/pinnedHttp';
import { resolveProviderContributionRegistryView } from './registry/contributions';
import { resolveProviderConnectionForMachine } from './registry/resolve';
import { createProviderInlineSuggestionQuery } from './inlineSuggestions';

const connectionId = 'pc_inline';
const machineId = 'machine-a';
const baseUrl = 'https://suggestions.example/v1';
const publicAddress = '93.184.216.34';
const privateAddress = '10.0.0.7';
const secretKey = new Uint8Array(32).fill(7);

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function request(path = 'src/main.ts') {
  return DaemonLspQueryRequestSchema.parse({ rootPath: '/workspace', path, languageId: 'typescript',
    kind: 'ai.inlineSuggest', version: 3, position: { line: 0, character: 6 },
    inlineSuggestion: { connectionId, modelId: 'fim', prefix: 'const ', suffix: '\n' } });
}

function response(text = 'answer') {
  let consumed = false;
  return { status: 200, headers: {}, contentLength: null, cancel() {}, read: async () => {
    if (consumed) return null;
    consumed = true;
    return Buffer.from(JSON.stringify({ done: true, done_reason: 'stop', response: text }));
  } };
}

function fixture() {
  const definition = ProviderContributionV1Schema.parse({ v: 1, id: 'suggestions', name: 'Suggestions', kind: 'cloud',
    endpointTemplates: [{ id: 'main', protocol: 'ollama-native', baseUrl, capabilities: {
      streaming: 'unsupported', toolRoundTrips: 'unsupported', statefulResponses: 'unsupported', reasoningControls: 'unsupported',
    } }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['ollama-native'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
    catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'fim', name: 'FIM', contextWindowTokens: 8192,
      inlineCompletion: { operationId: 'fim', tokenAccounting: 'utf8-bytes', outputTokens: 64, promptOverheadTokens: 3 } }] },
    inlineCompletion: [{ id: 'fim', mode: 'native-fim', endpointTemplateId: 'main', path: '/api/generate', wireFormat: 'ollama-generate' }],
  });
  const registry = resolveProviderContributionRegistryView({ providersByContributionKey: new Map([['acme.suggestions/suggestions', {
    provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.suggestions',
    identity: { pluginId: 'acme.suggestions', localId: 'suggestions' }, definition,
  }]]) }, 1);
  const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{ v: 1, id: connectionId, source: { kind: 'contribution', contributionKey: 'acme.suggestions/suggestions' },
      role: 'default', displayName: 'Suggestions', displayNameMode: 'automatic', deployment: { kind: 'external' },
      revision: 0, createdAt: 1, updatedAt: 1 }],
    secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: 'inline-secret' } } },
  });
  // Use the real resolver to derive the grant's exact security identity.
  const resolved = resolveProviderConnectionForMachine({ connectionId, machineId, providerSettings: initial, registry,
    dnsEvidenceByEndpointUrl: new Map([[baseUrl, [publicAddress]]]) });
  if (resolved.status !== 'resolved') throw new Error('Fixture endpoint must resolve');
  const providers = ProviderSettingsV1Schema.parse({ ...initial, accountGrants: [{ v: 1, connectionId,
    connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 }] });
  const settings = AccountSettingsSchema.parse({ filesEditorAiSuggestionsV1: { enabled: true, connectionId, modelId: 'fim' },
    secrets: [SavedSecretSchema.parse({ id: 'inline-secret', name: 'Inline fixture', encryptedValue: { _isSecretValue: true,
      encryptedValue: encryptSecretStringV1('fixture-only', secretKey, length => new Uint8Array(length).fill(3)) } })] });
  let revision = 1;
  const publish = (nextProviders = providers, nextSettings = settings) => {
    const snapshot: ActiveAccountSettingsSnapshot = { source: 'network', settings: nextSettings, settingsVersion: revision,
      loadedAtMs: revision, scopeKey: 'inline-account', settingsSecretsReadKeys: [secretKey],
      providerConnectionsCatalog: { status: 'ready', revision: revision++, catalog: splitProviderSettingsV1(nextProviders).catalog } };
    setActiveAccountSettingsSnapshot(snapshot);
  };
  publish();
  const openHttp = vi.fn<PinnedHttpStreamTransport>(async () => response());
  const resolveAddresses = vi.fn(async (_hostname: string): Promise<readonly string[]> => [publicAddress]);
  let providersEnabled = true;
  const query = createProviderInlineSuggestionQuery({ resolveRegistry: async () => registry, resolveAddresses, openHttp,
    getServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { providers: { enabled: providersEnabled } }, capabilities: {},
    }) }) });
  return { query, providers, settings, registry, publish, openHttp, resolveAddresses,
    setProvidersEnabled: (enabled: boolean) => { providersEnabled = enabled; } };
}

describe('inline suggestion admission', () => {
  it('resolves policy once per request and applies a real policy change at the next admission', async () => {
    const f = fixture();
    // Observation only: the actual policy function runs on every invocation.
    const policy = vi.spyOn(policyOwner, 'resolveFilesEditorAiSuggestionPolicy');
    expect(await f.query(request(), machineId)).toMatchObject({ status: 'ok', text: 'answer' });
    expect(policy).toHaveBeenCalledTimes(1);
    f.publish(f.providers, { ...f.settings, filesEditorAiSuggestionsV1: { ...f.settings.filesEditorAiSuggestionsV1, enabled: false } });
    expect(await f.query(request(), machineId)).toEqual({ status: 'error', errorCode: 'ai_disabled' });
    expect(policy).toHaveBeenCalledTimes(2);
    expect(f.openHttp).toHaveBeenCalledTimes(1);
  });

  it('uses the admitted public DNS answer for the dial even when later DNS would be private', async () => {
    const f = fixture();
    f.resolveAddresses.mockResolvedValueOnce([publicAddress]).mockResolvedValue([privateAddress]);
    const dialed: string[][] = [];
    f.openHttp.mockImplementation(async input => { dialed.push([...input.validatedAddresses]); return response(); });
    expect(await f.query(request(), machineId)).toMatchObject({ status: 'ok', text: 'answer' });
    expect(dialed).toEqual([[publicAddress]]);
    expect(f.resolveAddresses).toHaveBeenCalledTimes(1);
    // A new request gets the private answer and cannot borrow the public grant.
    expect(await f.query(request(), machineId)).toEqual({ status: 'error', errorCode: 'model_unavailable' });
    expect(dialed).toEqual([[publicAddress]]);
  });

  it('keeps a held answer usable across irrelevant connection changes and admits the next request afresh', async () => {
    const f = fixture();
    const reading = deferred<void>();
    const body = deferred<Uint8Array | null>();
    let first = true;
    f.openHttp.mockImplementation(async () => ({ ...response(), read: async () => {
      if (!first) return null;
      first = false; reading.resolve(); return body.promise;
    } }));
    const pending = f.query(request(), machineId);
    await reading.promise;
    const renamed = { ...f.providers, connections: f.providers.connections.map(row => ({ ...row,
      displayName: 'Renamed', displayNameMode: 'custom' as const, revision: row.revision + 1 })) };
    f.publish(renamed);
    body.resolve(Buffer.from(JSON.stringify({ done: true, done_reason: 'stop', response: 'held answer' })));
    expect(await pending).toMatchObject({ status: 'ok', text: 'held answer' });
    f.publish({ ...renamed, accountGrants: [] });
    expect(await f.query(request(), machineId)).toEqual({ status: 'error', errorCode: 'model_unavailable' });
    expect(f.openHttp).toHaveBeenCalledTimes(1);
  });

  it('permits the owner to dial a private endpoint with its exact Machine grant', async () => {
    const f = fixture();
    const resolved = resolveProviderConnectionForMachine({ connectionId, machineId, providerSettings: f.providers, registry: f.registry,
      dnsEvidenceByEndpointUrl: new Map([[baseUrl, [privateAddress]]]) });
    if (resolved.status !== 'resolved') throw new Error('Private fixture endpoint must resolve');
    f.publish(ProviderSettingsV1Schema.parse({ ...f.providers, machineGrants: [{ v: 1, connectionId, machineId,
      connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
      endpointSetFingerprint: resolved.record.endpointSetFingerprint, confirmedAt: 1 }] }));
    f.resolveAddresses.mockResolvedValue([privateAddress]);
    expect(await f.query(request(), machineId)).toMatchObject({ status: 'ok', text: 'answer' });
    expect(f.openHttp.mock.calls.map(([input]) => input.validatedAddresses)).toEqual([[privateAddress]]);
  });

  it.each(['disabled', 'excluded', 'language', 'unauthorized', 'feature'] as const)('discloses no context or credential when %s', async denial => {
    const f = fixture();
    if (denial === 'disabled') f.publish(f.providers, { ...f.settings,
      filesEditorAiSuggestionsV1: { ...f.settings.filesEditorAiSuggestionsV1, enabled: false } });
    if (denial === 'language') f.publish(f.providers, { ...f.settings,
      filesEditorAiSuggestionsV1: { ...f.settings.filesEditorAiSuggestionsV1, disabledLanguageIds: ['typescript'] } });
    if (denial === 'unauthorized') f.publish({ ...f.providers, accountGrants: [] });
    if (denial === 'feature') f.setProvidersEnabled(false);
    expect(await f.query(request(denial === 'excluded' ? '.env.local' : undefined), machineId))
      .toMatchObject({ status: 'error', errorCode: denial === 'disabled' ? 'ai_disabled' : denial === 'excluded'
        ? 'ai_excluded' : denial === 'language' ? 'ai_language_disabled' : 'model_unavailable' });
    expect(f.openHttp).not.toHaveBeenCalled();
  });

  it('admits credentials for every new request and refuses a withdrawn secret', async () => {
    const f = fixture();
    f.openHttp.mockImplementationOnce(async () => {
      f.publish(f.providers, { ...f.settings, secrets: [] });
      return response();
    });
    expect(await f.query(request(), machineId)).toMatchObject({ status: 'ok' });
    expect(f.openHttp.mock.calls[0]?.[0].headers.authorization?.startsWith('Bearer ')).toBe(true);
    const refused = await f.query(request(), machineId);
    expect(refused).toMatchObject({ status: 'error', errorCode: 'provider_error',
      error: createProviderErrorV1('provider_secret_missing', { connectionId, machineId, savedSecretReason: 'reference_missing' }) });
    expect(DaemonLspQueryResponseSchema.parse(refused)).toEqual(refused);
    expect(f.openHttp).toHaveBeenCalledTimes(1);
  });

  it('refuses changed source selection before admission without disclosure', async () => {
    const f = fixture();
    f.publish(f.providers, { ...f.settings, filesEditorAiSuggestionsV1: { ...f.settings.filesEditorAiSuggestionsV1, modelId: 'other' } });
    expect(await f.query(request(), machineId)).toEqual({ status: 'error', errorCode: 'stale_query' });
    expect(f.openHttp).not.toHaveBeenCalled();
  });

  it('cancels an admitted held response and cancels its transport', async () => {
    const f = fixture();
    const reading = deferred<void>();
    const cancel = vi.fn();
    f.openHttp.mockImplementation(async input => ({ ...response(), cancel, read: () => {
      reading.resolve(); return new Promise<Uint8Array | null>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('HTTP read aborted')), { once: true });
      });
    } }));
    const controller = new AbortController();
    const pending = f.query(request(), machineId, controller.signal);
    await reading.promise;
    controller.abort();
    expect(await pending).toEqual({ status: 'error', errorCode: 'cancelled' });
    expect(f.openHttp.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
});
