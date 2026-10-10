import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema, ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol';

import { renderHook, renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInput/agentInputTestHelpers';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { applyConnectedAccountCatalogSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { storage } from '@/sync/domains/state/storage';

installDisconnectedServerSocketBoundary();

installAgentInputCommonModuleMocks({ text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
} });

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn<(_request: unknown) => Promise<unknown>>(async (_request) => ({
    ok: true, result: { availableModels: [{ id: 'probed-model', name: 'Probed model' }], supportsFreeform: false },
})) }));

// Only machine capability and continuation-inspection transports are replaced.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (params: { method: string; payload: { selections?: readonly unknown[] } }) => params.method === 'capabilities.invoke'
        ? invoke(params.payload)
        : { v: 1, inspections: params.payload.selections!.map(() => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true })) },
}));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: () => {} }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml' }));

const [{ useInSessionAgentPickerControls }, { getResolvedBackendCatalogEntries }, { settingsDefaults }] = await Promise.all([
    import('./useInSessionAgentPickerControls'),
    import('@/agents/backendCatalog/getResolvedBackendCatalogEntries'),
    import('@/sync/domains/settings/settings'),
]);
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');

describe('continuation target account discovery', () => {
    it('does not issue New Session authentication probes while inherited purpose authority is unread', async () => {
        invoke.mockClear();
        resetDynamicModelProbeCacheForTests();
        const { useNewSessionScreenPreflightState } = await import('../new/hooks/screenModel/useNewSessionScreenPreflightState');
        const hook = await renderHook((ready: boolean) => useNewSessionScreenPreflightState({
            backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            settings: settingsDefaults, selectedMachineId: 'unread-purpose-probe-machine',
            capabilityServerId: 'unread-purpose-probe-server', cwd: '/repo', connectedAccountDefaultsReady: ready,
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

    it.each(['work', 'missing-profile', 'unavailable'])('probes the destination-only qualified target purpose account (%s)', async (profileId) => {
        invoke.mockClear();
        resetDynamicModelProbeCacheForTests();
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const bridge = await loadSyncSingletonForTests();
        const previous = storage.getState();
        const http = createHomeHubArtifactHttpBoundary('continuation-defaults');
        const value = {
                v: 1 as const, bindings: [{
                    purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
                    target: { kind: 'account' as const, account: {
                        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: profileId,
                    } },
                }],
        };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://continuation-defaults.test', accountId: 'continuation-defaults',
            request: (input, init) => new URL(String(input)).pathname === '/v1/account/entity-rows/connected-accounts/purposes'
                ? Promise.resolve(profileId === 'unavailable' ? Response.json({ error: 'unavailable' }, { status: 503 })
                    : Response.json({ status: 'present', revision: 3, content: { t: 'plain', v: { key: 'purposes', value } } }))
                : http.request(input, init) });
        const accountScope = { serverId: connection.home.id, accountId: 'continuation-defaults' };
        storage.setState({ profileScope: accountScope, profile: AccountProfileSchema.parse({ id: accountScope.accountId }) });
        applyConnectedAccountCatalogSnapshot(accountScope, 'purposes', profileId === 'unavailable'
            ? { status: 'unavailable', reason: 'account-mode-mismatch' }
            : { status: 'ready', revision: 3, record: { key: 'purposes', value } }, true);
        const settings = settingsDefaults;
        const hook = await renderHook(() => useInSessionAgentPickerControls({
            sessionId: 'qualified-account-discovery', accountScope,
            currentAgentId: 'claude', currentAgentLabel: 'Claude', projectionCurrent: true,
            entries: getResolvedBackendCatalogEntries({
                enabledAgentIds: ['claude', 'codex'],
                acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
                mergedProviderProjectionById: {
                    codex: {
                        agentId: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                        connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, required: false }],
                    },
                },
            }),
            featureDecision: { state: 'enabled' },
            source: { currentBackendTargetKey: 'agent:happier.agent.claude/claude', storageKind: 'persisted', canEditSession: true, machinePresence: 'online', hasConversationToCarry: true },
            machine: { machineId: 'machine-1', serverId: connection.home.id, connectionGeneration: 1, daemonGeneration: 1 },
            detail: { settings, capabilityServerId: connection.home.id, machineId: 'machine-1', cwd: '/repo' },
        }));
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
        await act(async () => { hook.getCurrent().onAgentPickerVisibilityChange(true); });
        await act(async () => { await Promise.resolve(); });
        const option = hook.getCurrent().composeAgentPickerOptions([]).find((row) => row.id.includes('codex'));
        if (profileId === 'unavailable') {
            expect(option?.disabled).toBe(true);
            expect(invoke.mock.calls).toEqual([]);
            return;
        }
        expect(option?.disabled).not.toBe(true);
        const detail = option?.renderDetailContent?.({ onRequestClose: () => {} });
        if (!React.isValidElement(detail)) throw new Error('Expected target Agent detail content');
        screen = await renderScreen(detail);
        await act(async () => { await Promise.resolve(); });
        const request = invoke.mock.calls.map((args) => args[0] as { id?: string; method?: string; params?: unknown })
            .find((candidate) => candidate.id === 'cli.codex' && candidate.method === 'probeModels');
        expect(request).toBeDefined();
        expect(request?.params).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId },
        } } });
        } finally {
            await screen?.unmount(); await hook.unmount(); storage.setState(previous, true);
            await connection.dispose(); bridge.dispose();
        }
    });

    it('keeps exact Team probe errors separate from a prior personal-account catalog', async () => {
        resetDynamicModelProbeCacheForTests();
        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();
        const { resolveNewSessionCapabilityProbeContext } = await import('../new/modules/newSessionCapabilityProbeContext');
        const { NewSessionEngineOptionDetail } = await import('../new/components/NewSessionEngineOptionDetail');
        const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const serviceKey = 'happier.agent.codex/openai-codex';
        invoke.mockImplementation(async (request) => {
            const probe = request as { method: string; params: { connectedServices?: unknown } };
            const bindings = ConnectedServiceBindingsV2Schema.parse(probe.params.connectedServices);
            if (bindings.bindingsByServiceId[serviceKey]?.source === 'team_resource') {
                return { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Sessionless Team probe unavailable' } };
            }
            return { ok: true, result: probe.method === 'probeModels'
                ? { availableModels: [{ id: 'personal-model', name: 'Personal account model' }], supportsFreeform: false }
                : { configOptions: [] } };
        });
        const detail = (connectedServices: ReturnType<typeof ConnectedServiceBindingsV2Schema.parse>) => React.createElement(NewSessionEngineOptionDetail, {
            backendTarget: target, selectedMachineId: 'machine-1', capabilityServerId: 'server-1',
            selectedModelId: 'default',
            capabilityProbeContext: resolveNewSessionCapabilityProbeContext({ backendTarget: target, settings: settingsDefaults, connectedServices }),
        });
        const personal = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        const screen = await renderScreen(detail(personal));
        await act(async () => { await Promise.resolve(); });
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Personal account model');

        const team = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'team_resource', resourceId: 'team-resource', deliveryMode: 'brokered' },
        } });
        await act(async () => { screen.tree.update(detail(team)); await Promise.resolve(); });
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Personal account model');
        expect(JSON.stringify(screen.tree.toJSON())).toContain('agentInput.model.unavailable');
        expect(invoke.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
            method: 'probeModels', params: expect.objectContaining({ connectedServices: team }),
        }));
        await screen.unmount();
    });

    it('removes Native catalog rows when New Session requests an exact Team model observation', async () => {
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
                settings: settingsDefaults, selectedMachineId: 'team-observation-machine',
                capabilityServerId: 'team-observation-server', cwd: '/repo', connectedServicesBindingsPayload: bindings,
            });
            return null;
        }
        const screen = await renderScreen(<Harness bindings={native} />);
        await vi.waitFor(() => expect(current?.preflightModels?.availableModels.map((model) => model.id)).toContain('native-only-model'));

        await act(async () => { screen.tree.update(<Harness bindings={team} />); });

        await vi.waitFor(() => {
            expect(current?.modelOptions.map((model) => model.value)).not.toContain('native-only-model');
            expect(current?.modelOptionsProbeState.failed).toBe(true);
        });
        expect(invoke.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
            method: 'probeModels', params: expect.objectContaining({ connectedServices: team }),
        }));
        await screen.unmount();
    });
});
