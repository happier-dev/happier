import * as React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AgentConfigOptionsProbeObservationSchema, AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, createProviderModelProjectionFixture,
    installProviderSettingsRpcBoundary, installBundledProviderDeclarationsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

// Socket/HTTP and native platform leaves only. Picker, inventory Actions, native
// preflight readers and Provider projection owners run without internal mocks.
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { buildNewSessionAgentPickerOptionInteractions } = await import('./buildNewSessionAgentPickerOptionInteractions');
const { useNewSessionAgentPickerControls } = await import('./useNewSessionAgentPickerControls');
const { useNewSessionAgentPickerEngineSelectionState } = await import('./useNewSessionAgentPickerEngineSelectionState');
const { useProviderModelProjection } = await import('@/providers/hooks/useProviderModelProjection');
await loadSyncSingletonForTests();
const machineId = '828e5af1-7b26-4ab6-b3ba-f0e4f8bdac1b';
let serverId = '';

function backendEntry(backendId: string, agentId: string, catalogAgentId: 'antigravity' | null): ResolvedBackendCatalogEntry {
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId }),
        backendTarget: { kind: 'backend', backendId }, backendTargetKey: `backend:${backendId}`,
        kind: 'pluginBackend', backendId, agentId, catalogAgentId, builtInAgentId: null,
        iconAgentId: catalogAgentId, title: 'Probe Agent', subtitle: null, cliAuthBackgroundCheckSafe: false,
    };
}
const installed = backendEntry('acme.review.agent', 'acme.review.agent', null);
const carrier = backendEntry('antigravity-localharness', 'antigravity', 'antigravity');
const selection = { modelId: 'default', modelSelection: null, sessionModeId: 'default', configOverrides: {} };
const ignore = () => {};
function detail(entry: ResolvedBackendCatalogEntry, providerProjection?: ReturnType<typeof useProviderModelProjection>) {
    const interaction = buildNewSessionAgentPickerOptionInteractions({ entry, disabled: false,
        selectedMachineId: machineId, capabilityServerId: serverId, selectedPath: '/repo',
        providerProjection, getEngineSelectionForTargetKey: () => selection,
        selectBackendTarget: ignore, selectEngineSelection: ignore });
    return interaction.renderDetailContent?.({ onRequestClose: ignore });
}
function ControlsDetail() {
    const params = { selectedBackendEntry: carrier, selectedBackendTargetKey: carrier.backendTargetKey,
        modelMode: 'default' as const, modelSelectionIsExplicit: true, acpSessionModeId: null,
        sessionConfigOptionOverrides: null, setBackendTarget: ignore, setModelMode: ignore,
        setAcpSessionModeId: ignore, setSessionConfigOptionOverrides: ignore };
    const engineSelectionState = useNewSessionAgentPickerEngineSelectionState(params);
    const controls = useNewSessionAgentPickerControls({ ...params, engineSelectionState,
        useProfiles: false, projectionCurrent: true, selectedProfileId: null, profileMap: new Map(),
        resolvedBackendEntries: [carrier], getCompatibleProfileBackendEntries: () => [],
        isBackendEntrySelectable: () => true, selectedMachineId: machineId,
        capabilityServerId: serverId, selectedPath: '/repo', selectedConnectedServices: null });
    const option = controls.agentPickerOptions?.find(candidate => candidate.id === carrier.backendTargetKey);
    if (!option?.renderDetailContent) throw new Error('Carrier Agent detail missing');
    return option.renderDetailContent({ onRequestClose: ignore });
}
function ProjectionDetail({ open }: { open: boolean }) {
    const projection = useProviderModelProjection({ enabled: true, machineId, serverId,
        agentTargetKey: installed.backendTargetKey });
    return <>{projection.status === 'success' ? <span>Projection settled</span> : null}
        {open ? detail(installed, projection) : null}</>;
}
function nativeRequests() {
    return rpc.state.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE);
}

beforeEach(async () => {
    rpc.state.machines.push(createMachineFixture({ id: machineId, activeAt: Date.now() }));
    installBundledProviderDeclarationsRpcBoundary(rpc);
    rpc.intercept(RPC_METHODS.CAPABILITIES_INVOKE, request => {
        const payload = request.payload as { id: string; method: string };
        const agentId = payload.id.replace(/^cli\./, '');
        const result = payload.method === 'probeConfigOptions'
            ? AgentConfigOptionsProbeObservationSchema.parse({ agentId, configOptions: [{
                id: 'effort', name: 'Native probe effort', type: 'select', currentValue: 'high',
                options: [{ value: 'high', name: 'Native high' }, { value: 'low', name: 'Native low' }],
            }] })
            : AgentModelsProbeObservationSchema.parse({ agentId, source: 'dynamic', supportsFreeform: false,
                availableModels: [{ id: 'native-review', name: 'Native probe model' }] });
        return { ok: true, result };
    });
    serverId = (await account.restore({ waivedActions: ['providers.models.refresh', 'agents.models.list', 'agents.config_options.list'] })).serverId;
});
afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it('probes an installed Agent under its operational identity and renders the native result', async () => {
    const screen = await renderScreen(<>{detail(installed)}</>);
    await waitForHomeGovernance(() => {
        expect(nativeRequests(), screen.getTextContent()).toEqual(expect.arrayContaining([
            expect.objectContaining({ machineId, serverId, payload: expect.objectContaining({ id: 'cli.acme.review.agent', method: 'probeConfigOptions' }) }),
        ]));
        expect(screen.getTextContent()).toContain('Native probe effort');
        expect(screen.getTextContent()).toContain('Native probe model');
    });
});

it('probes the plugin Agent rather than its backend carrier through mounted picker controls', async () => {
    const screen = await renderScreen(<ControlsDetail />);
    await waitForHomeGovernance(() => {
        expect(nativeRequests(), screen.getTextContent()).toEqual(expect.arrayContaining([
            expect.objectContaining({ payload: expect.objectContaining({ id: 'cli.antigravity', method: 'probeModels' }) }),
            expect.objectContaining({ payload: expect.objectContaining({ id: 'cli.antigravity', method: 'probeConfigOptions' }) }),
        ]));
        expect(screen.getTextContent()).toContain('Native probe model');
    });
    expect(nativeRequests()).not.toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({ id: 'cli.antigravity-localharness' }),
    }));
});

it('opening detail reuses the screen projection without a second physical Provider request', async () => {
    rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        createProviderModelProjectionFixture({ agentTargetKey: installed.backendTargetKey, groups: [] }));
    const screen = await renderScreen(<ProjectionDetail open={false} />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Projection settled'));
    const projectionRequests = () => rpc.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION);
    expect(projectionRequests()).toHaveLength(1);
    await screen.update(<ProjectionDetail open />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Native probe model'));
    expect(projectionRequests()).toHaveLength(1);
});
