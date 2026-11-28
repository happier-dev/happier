import { publishSessionDraftPickerFixture, useSessionDraftPickerPresentation } from '@/dev/testkit/harness/sessionDraftPickerPresentation';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRowReadResponseV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInput/agentInputTestHelpers';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { applyConnectedAccountCatalogSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { createProviderModelProjectionFixture, createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

installDisconnectedServerSocketBoundary();

installAgentInputCommonModuleMocks({ text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
} });
const { storage } = await import('@/sync/domains/state/storage');

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn<(_request: unknown) => Promise<unknown>>(async (_request) => ({
    ok: true, result: { availableModels: [{ id: 'probed-model', name: 'Probed model' }], supportsFreeform: false },
})) }));

// Machine capability, Provider projection and continuation-inspection transports.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (params: { method: string; payload: { agentTargetKey?: string; selections?: readonly unknown[] } }) => {
        if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1,
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { codex: {
                id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, isBuiltIn: true, title: 'Codex',
                connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }],
            } } }),
        };
        if (params.method === RPC_METHODS.CAPABILITIES_INVOKE) return invoke(params.payload);
        if (params.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) return createProviderModelProjectionFixture({
            agentTargetKey: params.payload.agentTargetKey, groups: [],
        });
        if (!params.payload.selections) throw new Error(`Unexpected machine RPC: ${params.method}`);
        return { v: 1, inspections: params.payload.selections.map(() => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true })) };
    },
}));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: () => {} }));
vi.mock('expo-image', () => ({ Image: 'Image' }));

const [{ useInSessionAgentPickerControls }, { getResolvedBackendCatalogEntries }, { settingsDefaults }] = await Promise.all([
    import('./useInSessionAgentPickerControls'),
    import('@/agents/backendCatalog/getResolvedBackendCatalogEntries'),
    import('@/sync/domains/settings/settings'),
]);
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const account = createProviderSettingsAccountHarness();
let probeServerId: string;

beforeEach(async () => {
    probeServerId = (await account.restore()).serverId;
});
afterEach(async () => { await standardCleanup(); await account.reset(); });

describe('continuation target account discovery', () => {
    it('does not issue New Session authentication probes while inherited purpose authority is unread', async () => {
        invoke.mockClear();
        resetDynamicModelProbeCacheForTests();
        const { useNewSessionScreenPreflightState } = await import('../new/hooks/screenModel/useNewSessionScreenPreflightState');
        const hook = await renderHook((ready: boolean) => useNewSessionScreenPreflightState({
            backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            selectedMachineId: 'unread-purpose-probe-machine',
            capabilityServerId: probeServerId, cwd: '/repo', connectedAccountDefaultsReady: ready,
        }), { initialProps: false });
        try {
            await act(async () => { await Promise.resolve(); });
            expect(invoke.mock.calls).toEqual([]);
            expect(hook.getCurrent().modelOptionsProbeState).toMatchObject({ phase: 'idle' });
            expect(hook.getCurrent().modelOptionsProbeState.onRefresh).toBeUndefined();
            await hook.rerender(true);
            await vi.waitFor(() => expect(invoke.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({ method: 'probeModels' })));
        } finally { await hook.unmount(); }
    });

    it.each(['work', 'missing-profile', 'unavailable', 'retained-default', 'explicit'])('probes the destination-only qualified target account (%s)', async (profileId) => {
        invoke.mockClear();
        resetDynamicModelProbeCacheForTests();
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const bridge = await loadSyncSingletonForTests();
        const previous = storage.getState();
        const http = createHomeHubArtifactHttpBoundary('continuation-defaults');
        const sessionId = 'c123456789012345678901234';
        const session = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
            metadata: { machineId: 'machine-1', path: '/repo', host: 'tester.local', flavor: 'claude' } });
        const value = {
                v: 1 as const, bindings: [{
                    purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
                    target: { kind: 'account' as const, account: {
                        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                        accountId: profileId === 'explicit' ? 'work' : profileId,
                    } },
                }],
        };
        const usesRetainedDefault = profileId === 'retained-default';
        let purposeRow: ConnectedAccountCatalogRowReadResponseV1 = usesRetainedDefault ? { status: 'absent' }
            : { status: 'present', revision: 3, content: { t: 'plain', v: { key: 'purposes', value } } };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://continuation-defaults.test', accountId: 'continuation-defaults',
            request: createSessionReadBatchFetchBoundary(async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === `/v2/sessions/${sessionId}`) return Response.json({ session });
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') {
                    if (profileId === 'unavailable') return Response.json({ error: 'unavailable' }, { status: 503 });
                    if (init?.method === 'POST') {
                        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                        if (mutation.expectedRevision !== 'absent' || mutation.content === null) throw Error('Expected purposes initialization');
                        purposeRow = { status: 'present', revision: 3, content: mutation.content };
                        return Response.json({ status: 'updated', revision: 3, cursor: 3 });
                    }
                    return Response.json(purposeRow);
                }
                if (usesRetainedDefault && path === '/v2/account/settings') {
                    return Response.json({ version: 7, content: { t: 'plain', v: {
                        connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { codex: {
                            v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId } },
                        } } },
                    } } });
                }
                return http.request(input, init);
            }) });
        const accountScope = { serverId: connection.home.id, accountId: 'continuation-defaults' };
        storage.setState({ profileScope: accountScope, profile: AccountProfileSchema.parse({ id: accountScope.accountId }) });
        if (!usesRetainedDefault) applyConnectedAccountCatalogSnapshot(accountScope, 'purposes', profileId === 'unavailable'
            ? { status: 'unavailable', reason: 'account-mode-mismatch' }
            : { status: 'ready', revision: 3, record: { key: 'purposes', value } }, true);
        publishSessionDraftPickerFixture(accountScope, sessionId);
        const hook = await renderHook(() => {
            const controls = useInSessionAgentPickerControls({
            sessionId, accountScope,
            currentAgentId: 'claude', currentAgentLabel: 'Claude', projectionCurrent: true,
            entries: getResolvedBackendCatalogEntries({
                enabledAgentIds: ['claude', 'codex'],
                // The real Codex manifest declares this qualified launch purpose;
                // a bare bundled presentation fallback has no daemon declarations.
                mergedProviderProjectionById: { codex: {
                    agentId: 'codex', qualifiedId: 'happier.agent.codex/codex',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }],
                } },
            }),
            featureDecision: { state: 'enabled' },
            source: { currentBackendTargetKey: 'agent:happier.agent.claude/claude', storageKind: 'persisted', canEditSession: true, machinePresence: 'online', hasConversationToCarry: true },
            machine: { machineId: 'machine-1', serverId: connection.home.id, connectionGeneration: 1, daemonGeneration: 1 },
            detail: { capabilityServerId: connection.home.id, machineId: 'machine-1', cwd: '/repo' },
        });
            useSessionDraftPickerPresentation(controls, accountScope, sessionId);
            return controls;
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
        await act(async () => { hook.getCurrent().onAgentPickerVisibilityChange(true); });
        await act(async () => { await Promise.resolve(); });
        const readOption = () => hook.getCurrent().composeAgentPickerOptions([]).find((row) => row.id.includes('codex'));
        if (usesRetainedDefault) await vi.waitFor(() => expect(purposeRow.status).toBe('present'));
        if (profileId === 'unavailable') {
            expect(readOption()?.disabled).toBe(true);
            expect(invoke.mock.calls).toEqual([]);
            return;
        }
        await vi.waitFor(() => expect(readOption()).toMatchObject({ disabled: false }));
        const expectedProfileId = profileId === 'explicit' ? 'personal' : profileId;
        if (profileId === 'explicit') {
            await act(async () => { await readOption()?.onSelectImmediate?.(); });
            expect(hook.getCurrent().armedContinuation?.selection.agentId).toBe('codex');
            await act(async () => {
                hook.getCurrent().setArmedBinding('happier.agent.codex/openai-codex', {
                    source: 'connected', selection: 'profile', profileId: expectedProfileId,
                });
            });
        }
        const detail = readOption()?.renderDetailContent?.({ onRequestClose: vi.fn() });
        if (!React.isValidElement(detail)) throw new Error('Expected target Agent detail content');
        screen = await renderScreen(detail);
        await act(async () => { await Promise.resolve(); });
        const request = invoke.mock.calls.map((args) => args[0] as { id?: string; method?: string; params?: unknown })
            .find((candidate) => candidate.id === 'cli.codex' && candidate.method === 'probeModels');
        expect(request).toBeDefined();
        expect(request?.params).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: expectedProfileId },
        } } });
        } finally {
            await screen?.unmount(); await hook.unmount(); storage.setState(previous, true);
            await connection.dispose(); bridge.dispose();
        }
    });

    it('does not reuse a prior personal-account catalog or start a native probe for an exact Team binding', async () => {
        invoke.mockClear();
        resetDynamicModelProbeCacheForTests();
        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();
        const { resolveNewSessionCapabilityProbeContext } = await import('../new/modules/newSessionCapabilityProbeContext');
        const { NewSessionEngineOptionDetail } = await import('../new/components/NewSessionEngineOptionDetail');
        const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const serviceKey = 'happier.agent.codex/openai-codex';
        invoke.mockImplementation(async (request) => {
            const probe = request as { method: string; params?: { connectedServices?: unknown } };
            const bindings = ConnectedServiceBindingsV2Schema.safeParse(probe.params?.connectedServices);
            if (bindings.success && bindings.data.bindingsByServiceId[serviceKey]?.source === 'team_resource') {
                return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Sessionless Team probe unavailable' } };
            }
            return { ok: true, result: probe.method === 'probeModels'
                ? AgentModelsProbeObservationSchema.parse({ source: 'dynamic', availableModels: [{ id: 'personal-model', name: 'Personal account model' }], supportsFreeform: false })
                : { configOptions: [] } };
        });
        const detail = (connectedServices: ReturnType<typeof ConnectedServiceBindingsV2Schema.parse>) => React.createElement(NewSessionEngineOptionDetail, {
            backendTarget: target, selectedMachineId: 'machine-1', capabilityServerId: probeServerId,
            selectedModelId: 'default',
            capabilityProbeContext: resolveNewSessionCapabilityProbeContext({ backendTarget: target, settings: settingsDefaults, connectedServices }),
        });
        const personal = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        const screen = await renderScreen(detail(personal));
        await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('Personal account model'));

        const team = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'team_resource', resourceId: 'team-resource', deliveryMode: 'brokered' },
        } });
        await act(async () => { screen.tree.update(detail(team)); await Promise.resolve(); });
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Personal account model');
        // The Team catalog owns a team_resource binding's models; no native operation probe runs for it.
        expect(invoke.mock.calls.map(([request]) => request)).not.toContainEqual(expect.objectContaining({
            method: 'probeModels', params: expect.objectContaining({ connectedServices: team }),
        }));
        await screen.unmount();
    });

    it('removes Native catalog rows without a native probe when New Session selects an exact Team binding', async () => {
        resetDynamicModelProbeCacheForTests();
        invoke.mockClear();
        const { useNewSessionScreenPreflightState } = await import('../new/hooks/screenModel/useNewSessionScreenPreflightState');
        const serviceKey = 'happier.agent.claude/claude-subscription';
        invoke.mockImplementation(async (request) => {
            const probe = request as { method: string; params?: { connectedServices?: unknown } };
            const bindings = ConnectedServiceBindingsV2Schema.safeParse(probe.params?.connectedServices);
            if (bindings.success && bindings.data.bindingsByServiceId[serviceKey]?.source === 'team_resource') {
                return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Sessionless Team probe unavailable' } };
            }
            return { ok: true, result: probe.method === 'probeModels'
                ? { availableModels: [{ id: 'native-only-model', name: 'Native account model' }], supportsFreeform: false }
                : probe.method === 'probeConfigOptions' ? { configOptions: [] } : { availableModes: [] } };
        });
        const native = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'native' },
        } });
        const team = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'team_resource', resourceId: 'team-model-account', deliveryMode: 'brokered' },
        } });
        let current: ReturnType<typeof useNewSessionScreenPreflightState> | undefined;
        function Harness({ bindings }: { bindings: typeof team }) {
            current = useNewSessionScreenPreflightState({
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                selectedMachineId: 'team-observation-machine',
                capabilityServerId: probeServerId, cwd: '/repo', connectedServicesBindingsPayload: bindings,
            });
            return null;
        }
        const screen = await renderScreen(<Harness bindings={native} />);
        await vi.waitFor(() => expect(current?.preflightModels?.availableModels.map((model) => model.id)).toContain('native-only-model'));

        await act(async () => { screen.tree.update(<Harness bindings={team} />); });

        await vi.waitFor(() => {
            expect(current?.modelOptions.map((model) => model.value)).not.toContain('native-only-model');
            expect(current?.modelOptionsProbeState).toMatchObject({ phase: 'idle', failed: false });
        });
        expect(invoke.mock.calls.map(([request]) => request)).not.toContainEqual(expect.objectContaining({
            method: 'probeModels', params: expect.objectContaining({ connectedServices: team }),
        }));
        await screen.unmount();
    });
});
