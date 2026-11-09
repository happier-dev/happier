import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeferred, renderScreen, standardCleanup, flushHookEffects, findTestInstanceByTypeWithProps, pressTestInstanceAsync } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture, createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const transport = vi.hoisted(() => ({ call: vi.fn<(request: { method: string; payload: unknown }) => Promise<unknown>>() }));
// The real inventory Action, discovery/cache, projection and picker run below this machine RPC boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (request: { method: string; payload: unknown }) => transport.call(request),
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const account = createProviderSettingsAccountHarness();
const { useExactModelChoice } = await import('./useExactModelChoice');
const { ModalProvider, Modal } = await import('@/modal');
const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readAccountAgentProviderRequirements } = await import('@/providers/catalog/accountProviderDeclarations');
const { SlimProfileRoutingFields } = await import('@/components/profiles/edit/SlimProfileRoutingFields');
const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
const { resolveProfileBackendTargetKeyForEntry } = await import('@/components/profiles/edit/profileBackendEntryStorage');
const { Item } = await import('@/components/ui/lists/Item');
const { t } = await import('@/text');
await loadSyncSingletonForTests();

let serverId = '';
let enabled = false;
let open: ReturnType<typeof useExactModelChoice>['open'];
let choice: ReturnType<typeof useExactModelChoice>;
const agentTargetKey = 'agent:happier.agent.codex/codex';
const nativeRef = { agentTargetKey, providerConnectionId: null, modelId: 'machine-native-model' } as const;
const nativeOptionId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, null, nativeRef.modelId])}`;
function Host() {
  choice = useExactModelChoice({ agentTargetKey, agentId: 'codex', machineId: 'machine-a', serverId,
    selected: null, title: 'Model', fallbackLabel: 'Choose', enabled });
  open = choice.open;
  return null;
}

beforeEach(async () => {
  enabled = false;
  transport.call.mockReset();
  transport.call.mockImplementation(async ({ method }) => {
    if (method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) return createProviderModelProjectionFixture({ agentTargetKey, groups: [] });
    if (method === RPC_METHODS.CAPABILITIES_INVOKE) return { ok: true, result: {
      availableModels: [{ id: nativeRef.modelId, name: 'Machine native model' }], supportsFreeform: false,
      source: 'dynamic', observedAt: Date.now(),
    } };
    return { errorCode: 'method_not_found', error: 'Method not found' };
  });
  // The picker's own Machine row: model discovery admits an own worker before its raw RPC path (fddb78c8af).
  serverId = (await account.restore({ waivedActions: ['providers.models.refresh'], machines: [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })],
    settings: { experiments: true, featureToggles: { providers: true } } })).serverId;
});
afterEach(async () => { await act(async () => { Modal.hideAll(); }); await standardCleanup(); await account.reset(); });

describe('exact model choice uses machine catalogs and preserves failures', () => {
  it.each(['native', 'provider'] as const)('loads Profile model catalogs only when opened and selects the exact %s choice', async (source) => {
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] });
    const entry = entries.find(candidate => candidate.builtInAgentId === 'codex');
    if (!entry) throw new Error('Expected the resolved Codex catalog entry');
    const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
    const ref = { agentTargetKey: targetKey, providerConnectionId: 'pc_profile', modelId: 'profile-provider-model' };
    const group = createProviderModelProjectionGroupFixture({ connectionId: ref.providerConnectionId,
      rows: [{ ref, descriptor: { id: ref.modelId, name: 'Profile Provider model' },
        sources: { probe: true, manual: false, static: false }, confidence: 'probe',
        compatibility: { result: { status: 'verified', selectedProtocol: 'openai-responses',
          evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-22' } },
          compatibilityFingerprint: 'compatibility:v1:profile-model', confirmed: true },
        endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible' }],
    });
    const original = transport.call.getMockImplementation();
    if (!original) throw new Error('Expected Machine transport');
    transport.call.mockImplementation(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
      ? Promise.resolve(createProviderModelProjectionFixture({ agentTargetKey: targetKey, groups: [group] })) : original(request));
    const onPreferredModelChange = vi.fn();
    const screen = await renderScreen(<ModalProvider><SlimProfileRoutingFields
      entries={entries} machineId="machine-a" serverId={serverId} preferredAgentTargetKey={targetKey}
      defaultPermissionModeByTargetKey={{}} defaultPersistenceModeByTargetKey={{}}
      onPermissionDefaultsChange={vi.fn()} onPersistenceDefaultsChange={vi.fn()}
      onPreferredAgentChange={vi.fn()} onPreferredModelChange={onPreferredModelChange}
    /></ModalProvider>);
    await flushHookEffects();
    const modelReads = () => transport.call.mock.calls.map(([request]) => request.method).filter(method => (
      method === RPC_METHODS.CAPABILITIES_INVOKE || method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
    ));
    expect(modelReads()).toEqual([]);
    await pressTestInstanceAsync(findTestInstanceByTypeWithProps(screen, Item, { title: t('profiles.preferredModel.title') }));
    const providerOptionId = `model-picker-overlay-option:${JSON.stringify([targetKey, ref.providerConnectionId, ref.modelId])}`;
    const profileNativeRef = { ...nativeRef, agentTargetKey: targetKey };
    const profileNativeOptionId = `model-picker-overlay-option:${JSON.stringify([targetKey, null, nativeRef.modelId])}`;
    await waitForHomeGovernance(() => {
      expect(screen.findByTestId(profileNativeOptionId)).not.toBeNull();
      expect(screen.findByTestId(providerOptionId)).not.toBeNull();
    });
    expect(modelReads()).toContain(RPC_METHODS.CAPABILITIES_INVOKE);
    expect(modelReads()).toContain(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION);
    await screen.pressByTestIdAsync(source === 'native' ? profileNativeOptionId : providerOptionId);
    expect(onPreferredModelChange).toHaveBeenCalledWith({ v: 1, updatedAt: expect.any(Number), ref: source === 'native' ? profileNativeRef : group.rows[0]!.ref });
  });

  it.each(['deferred', 'missed'] as const)('keeps verified source rows selectable across a %s or failed shared Machine declaration answer', async (outcome) => {
    enabled = true;
    const ref = { agentTargetKey, providerConnectionId: 'pc_gateway', modelId: 'gateway-model' };
    const group = createProviderModelProjectionGroupFixture({ connectionId: ref.providerConnectionId,
      rows: [{ ref, descriptor: { id: ref.modelId, name: 'Gateway model' },
        sources: { probe: true, manual: false, static: false }, confidence: 'probe',
        compatibility: { result: { status: 'verified', selectedProtocol: 'openai-responses',
          evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-22' } },
          compatibilityFingerprint: 'compatibility:v1:gateway-model', confirmed: true },
        endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible' }],
    });
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
      codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        providerRequirements: readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' }) },
    } });
    const original = transport.call.getMockImplementation();
    if (!original) throw new Error('Expected Machine transport');
    let answer = createDeferred<unknown>();
    transport.call.mockImplementation(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      ? answer.promise : request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
        ? Promise.resolve(createProviderModelProjectionFixture({ agentTargetKey, groups: [group] })) : original(request));
    const read = () => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', serverId, machineId: 'machine-a',
      accountLifetime: captureActiveServerAccountScopeLifetime() });
    let pending = read();
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    const selected = vi.fn();
    const optionId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, ref.providerConnectionId, ref.modelId])}`;
    await act(async () => { open(selected); });
    await waitForHomeGovernance(() => {
      expect(screen.findByTestId(optionId)).not.toBeNull();
      expect(screen.findByTestId(optionId)?.props.disabled).not.toBe(true);
    });
    expect(selected).not.toHaveBeenCalled();
    if (outcome === 'missed') {
      await act(async () => { answer.reject(new Error('Transport unavailable')); await pending; });
      answer = createDeferred<unknown>();
      pending = read();
      await screen.pressByTestIdAsync('model-picker-overlay-refresh');
    }
    await act(async () => { answer.resolve({ protocolVersion: 1, projection }); await pending; });
    await waitForHomeGovernance(() => {
      expect(screen.findByTestId(optionId)).not.toBeNull();
      expect(screen.findByTestId(optionId)?.props.disabled).not.toBe(true);
    });
    await screen.pressByTestIdAsync(optionId);
    expect(selected).toHaveBeenCalledWith(group.rows[0]!.ref);

    await act(async () => { open(selected); });
    answer = createDeferred<unknown>();
    pending = read();
    await act(async () => { answer.reject(new Error('Transport unavailable')); await pending; });
    selected.mockClear();
    expect(screen.findByTestId(optionId)?.props.disabled).not.toBe(true);
    await screen.pressByTestIdAsync(optionId);
    expect(selected).toHaveBeenCalledWith(group.rows[0]!.ref);
  });

  it('loads the machine native catalog only on demand and commits its exact native choice', async () => {
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    const retainedOpen = open;
    expect(transport.call.mock.calls.some(([request]) => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toBe(false);
    enabled = true;
    await act(async () => { screen.update(<ModalProvider><Host /></ModalProvider>); });
    const selected = vi.fn();
    await act(async () => { open(selected); });
    await flushHookEffects();
    expect(screen.findByTestId(nativeOptionId)).not.toBeNull();
    await screen.pressByTestIdAsync(nativeOptionId);
    expect(selected).toHaveBeenCalledWith(nativeRef);
    // Route popovers can retain their opener while discovery settles elsewhere.
    await act(async () => { retainedOpen(vi.fn()); });
    expect(screen.findByTestId(nativeOptionId)).not.toBeNull();
  });

  it('keeps a typed projection failure and retry visible in the opened picker', async () => {
    enabled = true;
    transport.call.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
      ? { status: 'error', error: createProviderErrorV1('provider_endpoint_unavailable') }
      : { errorCode: 'method_not_found', error: 'Method not found' });
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    await waitForHomeGovernance(() => expect(choice.error?.code).toBe('provider_endpoint_unavailable'));
    await act(async () => { open(vi.fn()); });
    expect(screen.findByTestId('provider-error:provider_endpoint_unavailable')).not.toBeNull();
    expect(screen.findByTestId('model-picker-overlay-refresh')).not.toBeNull();
    transport.call.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
      ? createProviderModelProjectionFixture({ agentTargetKey, groups: [] })
      : { errorCode: 'method_not_found', error: 'Method not found' });
    await screen.pressByTestIdAsync('model-picker-overlay-refresh');
    await flushHookEffects();
    expect(screen.findByTestId('provider-error:provider_endpoint_unavailable')).toBeNull();
  });
});
