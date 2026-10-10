/** @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { buildQualifiedPluginContributionKey, VoiceProviderContributionSchema, type VoiceProviderContribution } from '@happier-dev/protocol';
import { ConnectedAccountCatalogRowMutationV1Schema, ConnectedPurposeCatalogV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { commitExternalVoiceProviderRegistration, resetExternalVoiceProviderRegistrationsForTests } from '@/voice/registry/externalVoiceProviderRegistrations';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { AccountProfileSchema, type AccountProfile } from '@happier-dev/protocol/account/profile';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();
// Genuine unavailable native/platform boundaries only; Dropdown, Account,
// Sync, purpose loading, normalization and mutation owners stay real.
vi.mock('react-native', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('react-native-web');
  return { ...actual, Platform: { ...(actual.Platform as object), OS: 'web',
    select: (values: Record<string, unknown>) => values.web ?? values.default ?? values.native } };
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
  return await createRadixCjsRealModule();
});
await loadSyncSingletonForTests();
const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { fetchAndApplyProfile } = await import('@/sync/engine/account/syncAccount');
const { refreshConnectedAccountCatalog } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const gestureDispatch = await import('@/utils/system/fireAndForget');

const contribution = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'realtime-openai',
});
const declaration = VoiceProviderContributionSchema.parse({
  id: contribution.localId,
  title: 'OpenAI realtime',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: { turn: { cancelResponse: false, bargeIn: false } },
  credentials: {
  slot: {
    id: 'api_key',
    purpose: 'voice.client-auth',
    title: 'OpenAI credential',
  },
  requirement: { kind: 'always' },
  sources: [
    {
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
    {
      kind: 'connectedAccount',
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
    {
      kind: 'connectedAccount',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
  ],
  hostMediated: {
    operations: [{
      id: 'client-auth',
      purpose: 'voice.client-auth',
      credentialSlotId: 'api_key',
      effect: 'read',
      request: {
        origin: 'https://api.openai.com',
        pathTemplate: '/v1/realtime/client_secrets',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'json', value: {} },
        method: 'POST',
        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        redirect: 'error',
        maxBodyBytes: 65_536,
        contentTypes: ['application/json'],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: { maxBytes: 65_536, contentTypes: ['application/json'] },
    }],
  },
  },
  client: {
    artifactId: 'web-runtime',
    exportName: 'activate',
  },
});
const credentials = declaration.credentials!;

function installCurrentDeclaration(currentDeclaration: VoiceProviderContribution) {
  const providerId = buildQualifiedPluginContributionKey({
    pluginId: contribution.pluginId,
    localId: currentDeclaration.id,
  });
  const registry = createVoiceProviderRegistry({
    bundledContributions: [{ pluginId: contribution.pluginId, providerId, declaration: currentDeclaration }],
    bundledPresentations: [{ providerId, settingsSectionId: 'voice-credential-source-test' }],
  });
  const descriptor = registry.get(providerId);
  if (!descriptor) throw new Error('expected current Voice contribution');
  commitExternalVoiceProviderRegistration({
    token: contribution,
    pluginId: contribution.pluginId,
    localId: currentDeclaration.id,
    providerId,
    descriptor,
    adapter: null,
  });
}

function installCodexDescriptor(options: Readonly<{
  requiresAccountConfiguration?: boolean;
  includeOpenAi?: boolean;
}> = {}) {
  installConnectedAccountDescriptorProjection({
    scopeKey: 'voice-credential-source-test',
    status: 'ready',
    descriptors: [{
      id: 'openai-codex',
      serviceId: 'openai-codex',
      pluginId: 'happier.agent.codex',
      provenance: 'first_party',
      sourceKind: 'bundled',
      title: 'Codex',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          pkce: 'required',
          outcomeReconciliation: 'none',
          ...(options.requiresAccountConfiguration ? {
            configuration: {
              scope: 'account' as const,
              changeBehavior: 'reconnect' as const,
              fields: [{
                id: 'organization',
                title: 'Organization',
                schema: { type: 'string' as const, minLength: 1 },
                required: true,
                secret: false,
              }],
            },
          } : {}),
        }],
      },
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    }, ...(options.includeOpenAi ? [{
      id: 'openai',
      serviceId: 'openai',
      pluginId: 'happier.voice.openai',
      provenance: 'first_party' as const,
      sourceKind: 'bundled' as const,
      title: 'OpenAI',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual' as const,
          outcomeReconciliation: 'none' as const,
          fields: [{
            id: 'api-key',
            title: 'API key',
            schema: { type: 'string' as const, minLength: 1 },
            secret: true,
          }],
        }],
      },
      capabilities: [],
      availability: { state: 'available' as const, reason: 'resolved' as const },
      diagnostics: [],
    }] : [])],
    conflicts: [],
    errorReason: null,
  });
}


const PURPOSES_PATH = '/v1/account/entity-rows/connected-accounts/purposes';
const codexTarget = { kind: 'account' as const, account: {
  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'codex-work',
} };
const apiTarget = { kind: 'account' as const, account: {
  service: { pluginId: 'happier.voice.openai', localId: 'openai' }, accountId: 'api-work',
} };
const codexAccount = {
  ref: codexTarget.account, status: 'connected' as const, configurationReady: false,
  authenticationModeId: 'oauth', revisionSemantics: 'revisioned' as const,
  credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationRevision: null, displayName: 'Work Codex', scopes: [],
};
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let mounted: { root: Root; container: HTMLElement } | undefined;
let locks: ReturnType<typeof installWebLockManagerMock> | undefined;
let purposes: ConnectedPurposeCatalogV1;
let revision: number;
let writes: Array<ReturnType<typeof ConnectedAccountCatalogRowMutationV1Schema.parse>>;
let beforePurposeRead: (() => void) | undefined;
let afterAcknowledgement: (() => void) | undefined;
let omitSettingsReceipt: boolean;
// Observation only: the real dispatcher still attaches its genuine error sink.
// Awaiting its actual promise keeps refusal checks from passing before admission.
function observeGesture() { return vi.spyOn(gestureDispatch, 'fireAndForget'); }
let gestureObservation: ReturnType<typeof observeGesture>;
async function selectionReceipt() {
  await vi.waitFor(() => expect(gestureObservation.mock.calls.some(([, options]) =>
    options?.tag?.startsWith('VoiceCredentialSourceField.'))).toBe(true));
  const call = gestureObservation.mock.calls.find(([, options]) =>
    options?.tag?.startsWith('VoiceCredentialSourceField.'));
  if (!call?.[0]) throw new Error('Missing real Voice gesture promise');
  let receipt: unknown;
  await act(async () => { receipt = await call[0]; });
  return receipt;
}

function binding() { return account!.persistedSettings.voiceSettingsV1.credentialBindings[0]; }
function assertAccountSelection(target = codexTarget, consumer = contribution, purpose = credentials.slot.purpose) {
  expect(binding()).toMatchObject({
    contribution: consumer, credentialSlotId: 'api_key', credentialSource: { kind: 'connectedAccount' },
  });
  expect(purposes.bindings).toEqual([{ purpose: { consumer, purpose }, target }]);
  expect(Object.hasOwn(account!.persistedSettings, 'connectedAccountPurposeBindingsV1')).toBe(false);
}
function requireNode(testID: string): HTMLElement {
  const node = [...document.querySelectorAll<HTMLElement>('[data-testid]')]
    .find(candidate => candidate.dataset.testid === testID);
  if (!node) throw new Error(`Missing actual DOM row ${testID}`);
  return node;
}
function pointerPress(node: HTMLElement) {
  const event = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
  node.dispatchEvent(new MouseEvent('mousedown', { ...event, buttons: 1 }));
  node.dispatchEvent(new MouseEvent('mouseup', { ...event, buttons: 0 }));
  node.dispatchEvent(new MouseEvent('click', { ...event, buttons: 0 }));
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
function optionId(target: typeof codexTarget | typeof apiTarget) {
  // SelectableMenuResults publishes DOM-safe testIDs for the qualified row id.
  return JSON.stringify(['account', target.account.service.pluginId, target.account.service.localId, target.account.accountId])
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}
async function open() {
  const row = requireNode('voice-credential-source-api_key');
  const trigger = row.querySelector<HTMLElement>('[tabindex="0"],[role="button"],button');
  if (!trigger) throw new Error('Missing actual source dropdown trigger');
  await act(async () => { pointerPress(trigger); });
  await vi.waitFor(async () => { await flush(); expect(requireNode('dropdown-option-none')).toBeTruthy(); });
}
async function choose(id: string, admitted = true) {
  gestureObservation.mockClear();
  await open();
  await act(async () => { pointerPress(requireNode(`dropdown-option-${id}`)); });
  await flush();
  return admitted ? await selectionReceipt() : undefined;
}
async function renderField(currentDeclaration = declaration, isCurrent?: () => boolean) {
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  const { ModalProvider } = await import('@/modal');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  const element = () => <InjectedAuthProvider credentials={account!.credentials}><ModalProvider>
    <VoiceCredentialSourceField contribution={{ pluginId: contribution.pluginId, localId: currentDeclaration.id }}
      declaration={currentDeclaration} credentials={currentDeclaration.credentials!} isCurrent={isCurrent} />
  </ModalProvider></InjectedAuthProvider>;
  await act(async () => { root.render(element()); });
  return async () => { await act(async () => { root.render(element()); }); };
}
async function publishProfile(accounts: AccountProfile['connectedAccountsV4'] = [codexAccount]) {
  const profile = AccountProfileSchema.parse({ ...profileDefaults, id: 'account-a', timestamp: 1, connectedAccountsV4: accounts });
  await fetchAndApplyProfile({
    credentials: account!.credentials, applyProfile: storage.getState().applyProfile,
    request: async () => Response.json(profile),
  });
}
beforeEach(async () => {
  locks = installWebLockManagerMock();
  resetExternalVoiceProviderRegistrationsForTests();
  installCurrentDeclaration(declaration);
  installCodexDescriptor();
  purposes = { v: 1, bindings: [] };
  revision = 9;
  writes = [];
  beforePurposeRead = undefined;
  afterAcknowledgement = undefined;
  omitSettingsReceipt = false;
  account = await createSecretSettingsTestHarness({ settings: settingsParse({
    schemaVersion: 7, secrets: [], voiceSettingsV1: { credentialBindings: [] },
  }) });
  account.catalogRows.set(PURPOSES_PATH, {
    status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value: purposes } },
  });
  // Extend the existing HTTP fixture for the composite row+Settings transaction;
  // parse the real DTO and exercise its Settings CAS rather than stubbing Sync.
  setRuntimeFetch(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/auth/ping') return Response.json({});
    if (path !== PURPOSES_PATH) return account!.request(url, init);
    if (init?.method !== 'POST') {
      const callback = beforePurposeRead;
      beforePurposeRead = undefined;
      callback?.();
      return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value: purposes } } });
    }
    const input = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
    writes.push(input);
    if (input.expectedRevision !== revision) return Response.json({ status: 'conflict', revision }, { status: 409 });
    if (input.content?.t !== 'plain') throw new Error('Expected Plain purpose row');
    let settingsVersion: number | undefined;
    if (input.settingsMutation) {
      const response = await account!.request(new URL('/v2/account/settings', String(url)), {
        method: 'POST', body: JSON.stringify({ expectedVersion: input.settingsMutation.expectedSettingsVersion, content: input.settingsMutation.content }),
      });
      const receipt = await response.json() as { success: boolean; version?: number; currentVersion?: number };
      if (!receipt.success) return Response.json({ status: 'settings-conflict', revision: receipt.currentVersion });
      settingsVersion = receipt.version;
    }
    if (input.content.v.key !== 'purposes') throw new Error('Wrong catalog identity');
    purposes = ConnectedPurposeCatalogV1Schema.parse(input.content.v.value);
    revision += 1;
    account!.catalogRows.set(PURPOSES_PATH, { status: 'present', revision, content: input.content });
    const callback = afterAcknowledgement;
    afterAcknowledgement = undefined;
    callback?.();
    return Response.json({ status: 'updated', revision, cursor: revision,
      ...(!omitSettingsReceipt && settingsVersion !== undefined ? { settingsVersion } : {}) });
  });
  await refreshConnectedAccountCatalog(account.scope, 'purposes');
  await publishProfile();
  gestureObservation = observeGesture();
});
afterEach(async () => {
  if (mounted) {
    await act(async () => { mounted!.root.unmount(); });
    mounted.container.remove();
    mounted = undefined;
  }
  resetExternalVoiceProviderRegistrationsForTests();
  gestureObservation?.mockRestore();
  await account?.dispose();
  account = undefined;
  locks?.restore();
  locks = undefined;
});

describe('VoiceCredentialSourceField → admitted Account purpose transaction', () => {
  it('selects the exact declared account and presents its service without exposing its id', async () => {
    await renderField();
    await open();
    const row = requireNode(`dropdown-option-${optionId(codexTarget)}`);
    expect(row.textContent).toContain('Work Codex');
    expect(row.textContent).not.toContain('codex-work');
    expect(row.getAttribute('aria-label')).toBe('Codex · Work Codex');
    await act(async () => { pointerPress(row); });
    expect(await selectionReceipt()).toMatchObject({ status: 'applied' });
    await vi.waitFor(() => assertAccountSelection());
    await vi.waitFor(() => expect(requireNode('voice-credential-source-api_key').textContent).toContain('Work Codex'));
  });
  it('keeps an acknowledged but uncertain selection visible without replaying the composite mutation', async () => {
    omitSettingsReceipt = true;
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'outcomeUnknown' });
    await vi.waitFor(() => expect(requireNode('voice-credential-source-api_key').textContent)
      .toContain('settingsProviders.errors.mutationOutcomeUnknownDescription'));
    expect(requireNode('voice-credential-source-api_key').textContent).toContain('Work Codex');
    assertAccountSelection();
    expect(revision).toBe(10);
    expect(writes.map(write => write.expectedRevision)).toEqual([9]);
  });
  it('selects an Account for a speech declaration through the same mutation owner', async () => {
    const speech = VoiceProviderContributionSchema.parse({
      id: 'speech', title: 'OpenAI speech', kind: 'speech', roles: ['dictation_stt'], platforms: ['web'],
      credentials: { slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'OpenAI credential' },
        requirement: { kind: 'always' }, sources: [{
          kind: 'connectedAccount', service: codexTarget.account.service, rawGrants: [{
            realm: 'daemon', phase: 'speech', request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
          }],
        }] },
      settings: { schemaVersion: 1, fields: [{
        id: 'model', title: 'Model', schema: { type: 'string', minLength: 1, maxLength: 64 },
        default: 'whisper-1', presentation: { control: 'text' },
      }] },
    });
    installCurrentDeclaration(speech);
    await renderField(speech);
    await choose(optionId(codexTarget));
    await vi.waitFor(() => assertAccountSelection(codexTarget,
      { pluginId: contribution.pluginId, localId: speech.id }, 'voice.speech.transcribe'));
  });
  it('refuses an account whose mode still needs Account configuration', async () => {
    installCodexDescriptor({ requiresAccountConfiguration: true });
    await renderField();
    await open();
    const row = requireNode(`dropdown-option-${optionId(codexTarget)}`);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { pointerPress(row); });
    await flush();
    expect(purposes.bindings).toEqual([]);
    expect(binding()).toBeUndefined();
    expect(revision).toBe(9);
  });
  it('updates eligibility when the real descriptor projection arrives', async () => {
    installConnectedAccountDescriptorProjection({ scopeKey: 'voice-credential-source-test',
      status: 'loading', descriptors: [], conflicts: [], errorReason: null });
    const rerender = await renderField();
    await open();
    expect(requireNode(`dropdown-option-${optionId(codexTarget)}`).getAttribute('aria-disabled')).toBe('true');
    installCodexDescriptor();
    await rerender();
    expect(requireNode(`dropdown-option-${optionId(codexTarget)}`).getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { pointerPress(requireNode(`dropdown-option-${optionId(codexTarget)}`)); });
    expect(await selectionReceipt()).toMatchObject({ status: 'applied' });
    await vi.waitFor(() => assertAccountSelection());
  });
  it('offers none, SavedSecret and only manifest-declared service accounts', async () => {
    installCodexDescriptor({ includeOpenAi: true });
    await publishProfile([codexAccount, { ...codexAccount, ref: apiTarget.account,
      authenticationModeId: 'api-key', configurationReady: true, displayName: 'Work API key' },
      { ...codexAccount, ref: { service: { pluginId: 'unrelated.plugin', localId: 'other' }, accountId: 'other-account' },
        displayName: 'Unrelated account' }]);
    await renderField();
    await open();
    const options = [...document.querySelectorAll<HTMLElement>('[data-testid^="dropdown-option-"]')]
      .filter(option => !option.dataset.testid?.endsWith(':scroll-frame'));
    expect(options.map(option => option.dataset.testid)).toEqual([
      'dropdown-option-none', 'dropdown-option-savedSecret',
      `dropdown-option-${optionId(codexTarget)}`, `dropdown-option-${optionId(apiTarget)}`,
    ]);
    expect(options.map(option => option.textContent).join()).not.toContain('Unrelated account');
  });
  it('presents an orphaned purpose as unavailable and allows explicit none to repair it', async () => {
    purposes = { v: 1, bindings: [{ purpose: { consumer: contribution, purpose: credentials.slot.purpose }, target: codexTarget }] };
    await refreshConnectedAccountCatalog(account!.scope, 'purposes');
    await renderField();
    expect(requireNode('voice-credential-source-api_key').textContent).toContain('common.unavailable');
    await choose('none');
    await vi.waitFor(() => expect(binding()).toMatchObject({ credentialSource: { kind: 'none' } }));
    expect(purposes.bindings).toEqual([]);
  });
  it('replaces the single purpose between accounts and clears it for none', async () => {
    installCodexDescriptor({ includeOpenAi: true });
    await publishProfile([codexAccount, { ...codexAccount, ref: apiTarget.account,
      authenticationModeId: 'api-key', configurationReady: true, displayName: 'Work API key' }]);
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'applied' });
    await vi.waitFor(() => assertAccountSelection());
    await choose(optionId(apiTarget));
    await vi.waitFor(() => assertAccountSelection(apiTarget));
    await choose('none');
    await vi.waitFor(() => expect(binding()).toMatchObject({ credentialSource: { kind: 'none' } }));
    expect(purposes.bindings).toEqual([]);
    expect(writes.map(write => write.expectedRevision)).toEqual([9, 10, 11]);
  });
  it('does not admit a gesture from a retired provider', async () => {
    await renderField(declaration, () => false);
    await choose(optionId(codexTarget), false);
    await flush();
    expect(binding()).toBeUndefined();
    expect(purposes.bindings).toEqual([]);
    expect(revision).toBe(9);
  });
  it('admits an equivalent rehydrated declaration', async () => {
    installCurrentDeclaration(VoiceProviderContributionSchema.parse(structuredClone(declaration)));
    await renderField();
    await choose(optionId(codexTarget));
    await vi.waitFor(() => assertAccountSelection());
  });
  it('admits reordered raw grants and header-name sets', async () => {
    const expected = VoiceProviderContributionSchema.parse({
      ...declaration, credentials: { ...credentials, sources: credentials.sources.map(source =>
        source.kind === 'connectedAccount' && typeof source.service !== 'string'
          && source.service.localId === 'openai-codex' ? { ...source, rawGrants: [
            { realm: 'web', phase: 'prepare', request: { kind: 'httpHeaders', origin: 'https://api.openai.com', headerNames: ['authorization', 'openai-organization'] } },
            { realm: 'web', phase: 'connection', request: { kind: 'httpHeaders', origin: 'https://api.openai.com', headerNames: ['authorization'] } },
          ] } : source) },
    });
    installCurrentDeclaration(VoiceProviderContributionSchema.parse({
      ...expected, credentials: { ...expected.credentials!, sources: expected.credentials!.sources.map(source =>
        source.kind === 'connectedAccount' && typeof source.service !== 'string'
          && source.service.localId === 'openai-codex' ? { ...source, rawGrants: [...source.rawGrants!].reverse().map(grant =>
            grant.request.kind === 'httpHeaders' ? { ...grant, request: { ...grant.request, headerNames: [...grant.request.headerNames].reverse() } } : grant) } : source) },
    }));
    await renderField(expected);
    await choose(optionId(codexTarget));
    await vi.waitFor(() => assertAccountSelection());
  });
  it.each([
    ['slot', { credentials: { ...credentials, slot: { ...credentials.slot, id: 'replacement_key' },
      hostMediated: { operations: credentials.hostMediated!.operations.map(operation => ({ ...operation, credentialSlotId: 'replacement_key' })) } } }],
    ['purpose', { credentials: { ...credentials, slot: { ...credentials.slot, purpose: 'voice.replacement' } } }],
    ['service', { credentials: { ...credentials, sources: credentials.sources.map(source =>
      source.kind === 'connectedAccount' && typeof source.service !== 'string' && source.service.localId === 'openai-codex'
        ? { ...source, service: { pluginId: 'replacement.plugin', localId: 'replacement' } } : source) } }],
    ['access contract', { credentials: { ...credentials, sources: credentials.sources.map(source =>
      source.kind === 'connectedAccount' && typeof source.service !== 'string' && source.service.localId === 'openai-codex'
        ? { ...source, rawGrants: [{ realm: 'web', phase: 'prepare', request: { kind: 'httpHeaders',
          origin: 'https://replacement.example.com', headerNames: ['authorization'] } }] } : source) } }],
  ])('refuses manifest %s drift after the gesture before admission', async (_kind, patch) => {
    const drifted = VoiceProviderContributionSchema.parse({ ...declaration, ...patch });
    await renderField();
    beforePurposeRead = () => installCurrentDeclaration(drifted);
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'conflict' });
    await vi.waitFor(() => expect(beforePurposeRead).toBeUndefined());
    await flush();
    expect(binding()).toBeUndefined();
    expect(purposes.bindings).toEqual([]);
    expect(revision).toBe(9);
  });
  it.each([
    ['path', { request: { pathTemplate: '/v1/realtime/replacement' } }],
    ['method', { request: { method: 'PATCH' } }],
    ['purpose', { purpose: 'voice.client-auth.revised' }],
    ['bounds', { request: { maxBodyBytes: 32_768 }, response: { maxBytes: 32_768 } }],
  ])('refuses host-mediated %s drift at admission', async (_kind, patch) => {
    const operation = credentials.hostMediated!.operations[0]!;
    const operationPatch = patch as Readonly<{ purpose?: string; request?: Partial<typeof operation.request>; response?: Partial<typeof operation.response> }>;
    installCurrentDeclaration(VoiceProviderContributionSchema.parse({
      ...declaration, credentials: { ...credentials, hostMediated: { operations: [{
        ...operation, ...operationPatch, request: { ...operation.request, ...operationPatch.request },
        response: { ...operation.response, ...operationPatch.response },
      }] } },
    }));
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'conflict' });
    await flush();
    expect(binding()).toBeUndefined();
    expect(purposes.bindings).toEqual([]);
    expect(revision).toBe(9);
  });
  it('keeps the applied receipt when the operation changes after acknowledged commit', async () => {
    const operation = credentials.hostMediated!.operations[0]!;
    const changed = VoiceProviderContributionSchema.parse({
      ...declaration, credentials: { ...credentials, hostMediated: { operations: [{
        ...operation, request: { ...operation.request, pathTemplate: '/v1/realtime/replacement' },
      }] } },
    });
    afterAcknowledgement = () => installCurrentDeclaration(changed);
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'applied' });
    await vi.waitFor(() => assertAccountSelection());
    await vi.waitFor(() => expect(requireNode('voice-credential-source-api_key').textContent).toContain('Work Codex'));
    expect(requireNode('voice-credential-source-api_key').textContent).not.toContain('mutationOutcomeUnknownDescription');
    expect(revision).toBe(10);
  });
});
