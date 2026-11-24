import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture, createProviderSettingsAccountHarness,
    createProviderSettingsHarness, installBundledProviderDeclarationsRpcBoundary,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

// Substitute only Home HTTP, daemon Socket transport and platform navigation.
// Projection publication, the Action/approval owners and modal content remain real.
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);
await loadSyncSingletonForTests();
const { useExactModelChoice, ExactModelChoicePicker } = await import('./useExactModelChoice');
const { ModalProvider } = await import('@/modal');

const agentTargetKey = 'agent:happier.agent.codex/codex';
const machineId = '6a37defb-c9fd-46bd-8b59-5a341cf630a9';
const ref = { agentTargetKey, providerConnectionId: 'pc_x', modelId: 'v4-flash' } as const;
const optionTestId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, ref.providerConnectionId, ref.modelId])}`;
const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [{
    v: 1, id: ref.providerConnectionId, source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
    role: 'named', displayName: 'DeepSeek', displayNameMode: 'custom', revision: 3, createdAt: 1, updatedAt: 1,
}] });
const projection = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey,
    groups: [createProviderModelProjectionGroupFixture({ connectionId: ref.providerConnectionId, connectionRevision: 3,
        providerName: 'DeepSeek', connectionName: 'DeepSeek', rows: [{
            ref, descriptor: { id: ref.modelId, name: 'V4 Flash' }, confidence: 'account_unverified', loadState: 'unknown', visibility: 'visible',
            sources: { manual: true, static: false, probe: false }, endpointHealth: 'not_checked', catalog: { stale: false },
            compatibility: { compatibilityFingerprint: 'compatibility:v1:x', confirmed: false,
                result: { status: 'experimental', selectedProtocol: 'openai-responses', reasons: ['compatibility_evidence_missing'],
                    confirmationScope: { kind: 'model', modelId: ref.modelId } } },
        }] })], currentSelectionRecovery: null });

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it.each([
    { surface: 'dialog', native: false }, { surface: 'inline', native: false },
    { surface: 'dialog', native: true }, { surface: 'inline', native: true },
] as const)('selects the connected-account model and its exact binding in the $surface picker (native: $native)', async ({ surface, native }) => {
    rpc.state.machines.push(createMachineFixture({ id: machineId, activeAt: Date.now() }));
    installBundledProviderDeclarationsRpcBoundary(rpc);
    const { serverId } = await account.restore({ waivedActions: ['providers.models.refresh'] });
    const providerModel = { source: 'connected_account' as const, agentTargetKey, modelId: 'muse-spark-1.3-contributor',
        endpointTemplateId: 'cliproxyapi-openai-responses',
        purpose: { consumer: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, purpose: 'meta-upstream' } };
    const selected = native ? { agentTargetKey, providerConnectionId: null, modelId: 'gpt-5' } : providerModel;
    const service = native ? { pluginId: 'happier.agent.codex', localId: 'openai-codex' }
        : { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    const binding = { purpose: native
        ? { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'model-inference' } : providerModel.purpose,
        target: { kind: 'account' as const, account: {
        service, accountId: 'chosen-account',
    } } };
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
        [`${service.pluginId}/${service.localId}`]: { source: 'connected' as const, selection: 'profile' as const, profileId: 'chosen-account' },
    } };
    rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, ({ payload }) => {
        const request = payload as { connectedServices?: unknown };
        return createProviderModelProjectionFixture({ agentTargetKey, groups: (native
            ? JSON.stringify(request.connectedServices) === JSON.stringify(connectedServices) : request.connectedServices)
            ? [createProviderModelProjectionGroupFixture({ connectionId: 'connected-source:muse', providerName: 'CLIProxyAPI',
                connectionName: 'My Muse', connectedAccountTarget: binding.target,
                rows: [{ ref: selected, descriptor: { id: selected.modelId, name: 'Muse Spark' }, gatewaySlots: [binding],
                    confidence: 'verified_static', loadState: 'unknown', visibility: 'visible',
                    sources: { manual: false, static: true, probe: false }, endpointHealth: 'available', catalog: { stale: false },
                    compatibility: { compatibilityFingerprint: 'compatibility:v1:muse', confirmed: true,
                        result: { status: 'verified', selectedProtocol: 'openai-responses',
                            evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-09' } } } }],
            })] : [] });
    });
    const onSelect = vi.fn();
    let open!: () => void;
    const params = { agentTargetKey, agentId: null, machineId, serverId, selected: null,
        title: 'Model', fallbackLabel: 'Choose', includeProviderConnectedAccounts: true as const,
        ...(native ? { connectedServices, providerProtocols: [] } : {}) };
    function Host() {
        const choice = useExactModelChoice(params);
        open = () => choice.open(onSelect);
        return surface === 'inline' ? <ExactModelChoicePicker {...params} onSelect={onSelect} /> : null;
    }
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    if (surface === 'dialog') await act(async () => { open(); });
    const optionId = `model-picker-overlay-option:${sessionModelSelectionKey(selected)}`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(optionId)).not.toBeNull());
    await screen.pressByTestIdAsync(optionId);
    expect(onSelect).toHaveBeenCalledWith(selected, binding);
    expect(navigation.spies.push).not.toHaveBeenCalled();
});

it('updates the open exact-model dialog from a delayed projection and confirms its experimental selection', async () => {
    rpc.state.machines.push(createMachineFixture({ id: machineId, activeAt: Date.now() }));
    installBundledProviderDeclarationsRpcBoundary(rpc);
    const { serverId } = await account.restore({ catalog, waivedActions: ['providers.models.refresh'] });
    await account.home.requireUiApproval(serverId, 'providers.models.experimental.confirm');
    let releaseProjection!: () => void;
    const projectionReady = new Promise<void>(resolve => { releaseProjection = resolve; });
    rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async () => {
        await projectionReady;
        return projection;
    });
    const onSelect = vi.fn();
    let open!: () => void;
    function Host() {
        const choice = useExactModelChoice({ agentTargetKey, agentId: null, machineId, serverId,
            selected: null, title: 'Model', fallbackLabel: 'Choose' });
        open = () => choice.open(onSelect);
        return null;
    }
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    await waitForHomeGovernance(() => expect(rpc.state.requests.some(request =>
        request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toBe(true));
    await act(async () => { open(); });
    expect(screen.findByTestId(optionTestId)).toBeNull();
    await act(async () => { releaseProjection(); });
    // Control: the same mounted entry consumes a valid real producer response.
    await waitForHomeGovernance(() => expect(screen.findByTestId(optionTestId)).not.toBeNull());
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => { screen.pressByTestId(optionTestId); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
    expect(screen.findByTestId('actions.confirmation-review.decision-approve')?.props.disabled).not.toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(account.catalogMutations).toHaveLength(0);
    // Own UI Ask is answered by the Action's native confirmation, not a retained Artifact.
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() => expect(onSelect).toHaveBeenCalledWith(ref));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(account.catalogMutations).toHaveLength(1);
    expect(account.catalogMutations[0]).toMatchObject({ content: { t: 'plain', v: {
        experimentalBindingConfirmations: [{ connectionId: ref.providerConnectionId, agentTargetKey,
            modelId: ref.modelId, compatibilityFingerprint: 'compatibility:v1:x' }],
    } } });
    expect(navigation.spies.push).not.toHaveBeenCalled();
});
