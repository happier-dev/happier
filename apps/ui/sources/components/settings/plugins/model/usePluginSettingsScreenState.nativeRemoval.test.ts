import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { PluginDevelopmentStatusV1Schema } from '@happier-dev/protocol/capabilities';
import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { IModal } from '@/modal';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn<(request: Readonly<{ machineId: string; serverId?: string | null; method: string; payload: unknown }>) => Promise<unknown>>(),
    confirm: vi.fn<IModal['confirm']>(),
    alert: vi.fn<IModal['alert']>(),
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// This is the machine network boundary; capability parsing, selection, caches and the hook stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: boundary.rpc,
}));
installApprovalCommonModuleMocks({
    // Keep translation parameters visible so the test can see which reason reached the user.
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    modal: async () =>
        (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: {
            confirm: boundary.confirm, alert: boundary.alert,
        } }).module,
});
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let scenario = 0;
afterEach(async () => { standardCleanup(); await connection?.dispose(); connection = null; vi.restoreAllMocks(); });

async function renderRemovalOwner(
    method: 'disable' | 'uninstall',
    changes: readonly unknown[],
    options: Readonly<{ initiallyEnabled?: boolean; readbackEnabled?: boolean; development?: boolean;
        developmentRoot?: string; actionFailure?: boolean;
        beforeActionResponse?: (signal: AbortSignal | null | undefined) => Promise<void>;
        actionError?: string; bundled?: boolean }> = {},
) {
    boundary.rpc.mockReset();
    boundary.confirm.mockReset().mockResolvedValue(true);
    boundary.alert.mockReset();
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockImplementation(boundary.confirm);
    vi.mocked(Modal.alert).mockImplementation(boundary.alert);
    // Each scenario supplies a different daemon census. Give it its own Home so the real
    // capability cache cannot answer with the preceding scenario's still-fresh snapshot.
    const serverIdentityId = `srv_plugin_removal_${++scenario}`;
    const selectedTarget = { serverIdentityId, machineId: 'controller-1' };
    const developmentActionsSettings = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
        // These cases isolate retained-resource consent from the ordinary
        // uninstall Action prompt, which is covered by the policy suites.
        'plugins.uninstall': ['ui'],
        'plugins.install': ['ui'],
        'plugins.dev.submit': ['ui'], 'plugins.dev.unregister': ['ui'], 'plugins.dev.test': ['ui'], 'plugins.pack': ['ui'],
    } });
    let serverContent: unknown = { t: 'plain', v: {
        machineAdministrationTargetsLocalV1: { 'plugins.home': selectedTarget },
        actionsSettingsV1: developmentActionsSettings,
    } };
    let serverVersion = 1;
    const pluginId = 'example.compute';
    const sourceRootPath = options.developmentRoot ?? '/plugins/example.compute';
    const installed = {
        pluginId, title: 'Example compute', description: null, version: '1.0.0', enabled: options.initiallyEnabled ?? true,
        source: { kind: options.bundled ? 'bundled' : 'localPath', locator: sourceRootPath, trustPolicy: 'trusted' },
        ...(options.bundled ? { accountEnabled: false, machineEnabled: true, enabled: false } : {}),
        install: { mode: 'managed', manifestVersion: '2' },
        compatibility: { status: 'compatible', diagnostics: [] }, diagnostics: [],
    };
    const requests: Array<Readonly<{ machineId: string; serverId?: string | null; payload: CapabilitiesInvokeRequest }>> = [];
    const actionRequests: Array<Readonly<{ actionId: string; envelope: ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse> }>> = [];
    const developmentStatus = PluginDevelopmentStatusV1Schema.parse({
        roots: [{ kind: 'explicit', rootPath: sourceRootPath, trusted: true, persisted: true }],
        plugins: [{ pluginId, sourceRootPath, phase: 'active' }],
    });
    let machineCensus = {
        ...createPlainMachineRowFixture({ id: 'controller-1', accountId: 'account-owner' }),
        installationId: 'installation-1', runnerContentKeyBinding: null,
    };
    boundary.rpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return {
            protocolVersion: 1, results: { 'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [{
                ...installed, enabled: requests.length + actionRequests.length > 0 ? options.readbackEnabled ?? installed.enabled : installed.enabled,
            }], ...(options.development ? { developmentActions: { create: true }, developmentStatus } : {}) } } },
        };
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
            protocolVersion: 1,
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, toolsById: {},
                commandsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
        };
        if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) {
            const payload = request.payload as CapabilitiesInvokeRequest;
            requests.push({ machineId: request.machineId, serverId: request.serverId, payload });
            const change = changes[requests.length - 1];
            return { ok: true, result: { action: method, pluginId,
                ...(change === undefined ? { entry: { ...installed, enabled: false }, change: null } : { change }) } };
        }
        throw new Error(`Unexpected RPC: ${request.method}`);
    });
    connection = await restoreServerAccountForTest({
        serverUrl: `https://plugin-removal-${scenario}.test`, serverIdentityId, accountId: 'account-owner',
        credentials: { token: createAccountTokenForTests('account-owner', { currentAccount: true }) },
        request: async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/health') return Response.json({});
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId } },
            }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: serverVersion }));
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const write = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    expect(write.expectedVersion).toBe(serverVersion);
                    serverContent = write.content;
                    return Response.json({ success: true, version: ++serverVersion });
                }
                return Response.json({ content: serverContent, version: serverVersion });
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/machines') return Response.json([machineCensus]);
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => id === machineCensus.id ? machineCensus : null);
            if (path.startsWith('/v1/actions/')) {
                const actionId = path.slice('/v1/actions/'.length);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                actionRequests.push({ actionId, envelope });
                await options.beforeActionResponse?.(init?.signal);
                const lifecycleChange = actionId === `plugins.${method}` ? changes[actionRequests.filter(request => request.actionId === actionId).length - 1] : undefined;
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                    execution: options.actionError ? { ok: false, errorCode: options.actionError, error: options.actionError } : { ok: true, result: { ok: options.actionFailure !== true, kind: actionId.replaceAll('.', '_'),
                        ...(actionId === `plugins.${method}` ? { action: method, pluginId, change: lifecycleChange ?? committed } : {}),
                        ...(options.actionFailure ? { diagnostics: [{ code: 'plugin_author_test_failed', message: 'Plugin tests failed' }] } : {}),
                        ...(actionId === 'plugins.dev.submit' || actionId === 'plugins.dev.unregister' ? { status: developmentStatus } : {}) } },
                }));
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = { serverId: connection.home.id, accountId: 'account-owner' };
    storage.getState().activateProfileScope(scope);
    await storage.getState().activateSettingsScope(scope);
    storage.getState().applySettings({ ...storage.getState().settings,
        machineAdministrationTargetsLocalV1: { 'plugins.home': selectedTarget },
        actionsSettingsV1: developmentActionsSettings,
    }, serverVersion);
    const machine = createMachineFixture({ id: 'controller-1', installationId: 'installation-1', activeAt: Date.now() });
    storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId });
    storage.setState({ isDataReady: true,
        machineListStatusByServerId: { [connection.home.id]: 'idle' },
    });
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    clearDaemonMergedProjectionCacheForTests();
    const { usePluginSettingsScreenState } = await import('./usePluginSettingsScreenState');
    const hook = await renderHook(() => usePluginSettingsScreenState());
    await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(true));
    if (options.development) await vi.waitFor(() => expect(hook.getCurrent().developmentPlugins.map(plugin => plugin.sourceRootPath)).toEqual([sourceRootPath]));
    const publishMachine = (changes: Partial<typeof machine>) => {
        const next = { ...machine, seq: machine.seq + 1, updatedAt: Date.now(), ...changes };
        machineCensus = { ...machineCensus, seq: next.seq, updatedAt: next.updatedAt,
            installationId: next.installationId ?? machineCensus.installationId,
            daemonStateVersion: next.daemonStateVersion,
        };
        storage.getState().applyMachines([next], true, { sourceServerId: scope.serverId });
    };
    return { hook, requests, actionRequests, storage, scope, machine, publishMachine };
}

describe('development Settings through the real UI Action wiring', () => {
    it('does not admit a new install from a retained callback while the projection refreshes', async () => {
        const { hook, actionRequests } = await renderRemovalOwner('disable', []);
        const runCatalogAction = hook.getCurrent().runCatalogAction;
        const originalRpc = boundary.rpc.getMockImplementation()!;
        let releaseProjection!: () => void;
        const projection = new Promise<void>(resolve => { releaseProjection = resolve; });
        boundary.rpc.mockImplementation(async request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) await projection;
            return originalRpc(request);
        });
        try {
            await act(async () => { hook.getCurrent().refreshPluginTruth(); });
            await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(false));
            await act(async () => { runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
            expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false);
            expect(actionRequests).toEqual([]);
        } finally { releaseProjection(); }
    });

    it('presents a failed install preparation instead of silently re-enabling the action', async () => {
        const { hook, actionRequests } = await renderRemovalOwner('disable', [], { actionError: 'approval_context_unavailable' });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.alert).toHaveBeenCalledWith('common.error', 'approval_context_unavailable');
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
    });

    it.each(['daemon generation', 'installation', 'unmount'] as const)('retires an issued install on real authority retirement (%s)', async retirement => {
        let releaseResponse!: () => void;
        const response = new Promise<void>(resolve => { releaseResponse = resolve; });
        let actionSignal: AbortSignal | null | undefined;
        const { hook, actionRequests, publishMachine } = await renderRemovalOwner('disable', [], {
            beforeActionResponse: async signal => { actionSignal = signal; await response; },
        });
        try {
            await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
            await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
            if (retirement === 'unmount') await hook.unmount();
            else await act(async () => { publishMachine(retirement === 'installation'
                ? { installationId: 'installation-next' } : { daemonStateVersion: 2 }); });
            await vi.waitFor(() => expect(actionSignal?.aborted).toBe(true));
            expect(boundary.alert).not.toHaveBeenCalled();
            expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        } finally { releaseResponse(); }
    });

    it('keeps an issued install pending across a projection refresh on the same daemon', async () => {
        let releaseResponse!: () => void;
        const response = new Promise<void>(resolve => { releaseResponse = resolve; });
        let actionSignal: AbortSignal | null | undefined;
        const { hook, actionRequests } = await renderRemovalOwner('disable', [], {
            beforeActionResponse: async signal => { actionSignal = signal; await response; },
        });
        try {
            await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
            await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
            expect(actionSignal?.aborted).toBe(false);
            const originalRpc = boundary.rpc.getMockImplementation()!;
            let releaseProjection!: () => void;
            const projection = new Promise<void>(resolve => { releaseProjection = resolve; });
            boundary.rpc.mockImplementation(async request => {
                if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) await projection;
                return originalRpc(request);
            });
            try {
                await act(async () => { hook.getCurrent().refreshPluginTruth(); });
                await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(false));
                expect(actionSignal?.aborted).toBe(false);
                expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(true);
            } finally { releaseProjection(); }
        } finally { releaseResponse(); }
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
    });

    it('updates the selected installed channel without reconstructing its distribution in the UI', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', []);
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        expect(actionRequests[0]).toMatchObject({ actionId: 'plugins.install', envelope: {
            target: { kind: 'machine', machineId: 'controller-1' },
            input: { machineId: 'controller-1', source: { kind: 'installed', pluginId: 'example.compute' } },
        } });
        expect(requests).toEqual([]);
    });
    it.each(['/plugins/example.compute', '/plugins/example.compute.mjs'])('submits, tests, packs, and unregisters %s only on the selected machine through Actions', async (sourceRootPath) => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [], {
            development: true, developmentRoot: sourceRootPath,
        });
        await act(async () => { hook.getCurrent().runDevelopmentSourceInstall(sourceRootPath); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(false));
        for (const action of ['test', 'pack', 'unregister'] as const) {
            // A development source is addressed by its root, so a source that never loaded stays actionable.
            await act(async () => { hook.getCurrent().runDevelopmentAction(action, sourceRootPath); });
            await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(false));
        }
        expect(actionRequests.map(({ actionId, envelope }) => ({ actionId, target: envelope.target, input: envelope.input }))).toEqual([
            { actionId: 'plugins.dev.submit', target: { kind: 'machine', machineId: 'controller-1' }, input: { projectRoot: sourceRootPath } },
            { actionId: 'plugins.dev.test', target: { kind: 'machine', machineId: 'controller-1' }, input: { projectRoot: sourceRootPath } },
            { actionId: 'plugins.pack', target: { kind: 'machine', machineId: 'controller-1' }, input: { locator: sourceRootPath } },
            { actionId: 'plugins.dev.unregister', target: { kind: 'machine', machineId: 'controller-1' }, input: { projectRoot: sourceRootPath } },
        ]);
        expect(requests).toEqual([]);
        expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done');
    });

    it('settles a failed development Action without publishing success', async () => {
        const { hook, actionRequests, requests } = await renderRemovalOwner('disable', [], {
            development: true, actionFailure: true,
        });
        await vi.waitFor(() => expect(hook.getCurrent().developmentPlugins).toHaveLength(1));
        // The row acts on the source root reported by this scenario's daemon census.
        const sourceRootPath = hook.getCurrent().developmentPlugins[0]!.sourceRootPath;
        await act(async () => { hook.getCurrent().runDevelopmentAction('test', sourceRootPath); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(false));
        expect(actionRequests.map(request => request.actionId)).toEqual(['plugins.dev.test']);
        expect(requests).toEqual([]);
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        expect(boundary.alert).toHaveBeenCalledWith('common.error', 'Plugin tests failed');
    });
});

const committed = { kind: 'committed', pluginId: 'example.compute', desiredGeneration: null, appliedGeneration: null, pendingSurfaces: [] };

describe('local plugin removal at the actual settings hook and machine RPC boundary', () => {
    it.each(['account', 'machine'] as const)('dispatches bundled %s enablement through its semantic Action', async scope => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [committed], { bundled: true });
        const action = scope === 'account' ? 'enable' : 'disable';
        await act(async () => { hook.getCurrent().runInstalledPluginAction(action, 'example.compute', scope); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests.map(request => ({ actionId: request.actionId, input: request.envelope.input }))).toEqual([
            { actionId: `plugins.${action}`, input: { pluginId: 'example.compute', machineId: 'controller-1', scope } },
        ]);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
    });

    it('dispatches disable through the semantic Action with no default confirmation', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [committed]);
        await act(async () => { hook.getCurrent().runInstalledPluginAction('disable', 'example.compute'); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests.map(request => ({ actionId: request.actionId, target: request.envelope.target, input: request.envelope.input }))).toEqual([
            { actionId: 'plugins.disable', target: { kind: 'machine', machineId: 'controller-1' }, input: { pluginId: 'example.compute', machineId: 'controller-1' } },
        ]);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done');
    });

    it.each(['disable', 'uninstall'] as const)('reviews exact native responsibility and a renewed census before %s can commit', async method => {
        const first = createManagedResourceDependencyFixture();
        const renewed = createManagedResourceDependencyFixture(8);
        const { hook, requests, actionRequests } = await renderRemovalOwner(method, [
            { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [first] },
            { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [renewed] }, committed,
        ]);
        await act(async () => { hook.getCurrent().runCatalogAction({ method, pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests.length, JSON.stringify({ alerts: boundary.alert.mock.calls })).toBeGreaterThan(0));
        await vi.waitFor(() => expect(boundary.confirm).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.confirm, JSON.stringify({ requests, alerts: boundary.alert.mock.calls })).toHaveBeenCalledTimes(2);
        expect(boundary.confirm.mock.calls[0]?.[1]).toContain('native-1');
        const disposition = (resource: typeof first) => ({
            managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
            expectedAllocation: resource.allocation, expectedResource: resource.resource,
            expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery, responsibility: 'manual',
        });
        expect(actionRequests.map(request => ({ actionId: request.actionId, input: request.envelope.input }))).toEqual([
            { actionId: `plugins.${method}`, input: { machineId: 'controller-1', pluginId: 'example.compute' } },
            { actionId: `plugins.${method}`, input: { machineId: 'controller-1', pluginId: 'example.compute', managedResourceDispositions: [disposition(first)] } },
            { actionId: `plugins.${method}`, input: { machineId: 'controller-1', pluginId: 'example.compute', managedResourceDispositions: [disposition(renewed)] } },
        ]);
        expect(actionRequests.every(request => request.envelope.target?.kind === 'machine' && request.envelope.target.machineId === 'controller-1')).toBe(true);
        expect(requests).toEqual([]);
        expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done');
    });

    it.each(['cancel', 'daemon generation', 'installation', 'account'] as const)('does not retry or report success after consent retires (%s)', async retirement => {
        const { hook, requests, actionRequests, storage, scope, publishMachine } = await renderRemovalOwner('disable', [
            { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [createManagedResourceDependencyFixture()] }, committed,
        ]);
        boundary.confirm.mockImplementation(async () => {
            if (retirement === 'daemon generation') publishMachine({ daemonStateVersion: 2 });
            if (retirement === 'installation') publishMachine({ installationId: 'installation-2' });
            if (retirement === 'account') storage.getState().activateProfileScope({ ...scope, accountId: 'account-next' });
            return retirement !== 'cancel';
        });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests.length, JSON.stringify({ alerts: boundary.alert.mock.calls })).toBeGreaterThan(0));
        await vi.waitFor(() => expect(boundary.confirm).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.confirm, JSON.stringify({ requests, alerts: boundary.alert.mock.calls })).toHaveBeenCalledTimes(1);
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
    });

    it.each([
        { kind: 'dataRemovalPartial', pluginId: 'example.compute', completed: ['uninstall'], pending: ['secrets'], causeCode: 'unavailable' },
        { kind: 'failed', code: 'invalid_disposition' },
        { kind: 'outcomeUnknown', pluginId: 'example.compute' },
        { kind: 'managedResourcesReviewRequired', pluginId: 'wrong-plugin', resources: [createManagedResourceDependencyFixture()] },
        { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [createManagedResourceDependencyFixture()], unknownRecovery: true },
        { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [{ ...createManagedResourceDependencyFixture(), intentRevision: 'unreadable' }] },
    ])('does not report disable success for an uncommitted or mismatched daemon result ($kind)', async change => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [change]);
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        expect(hook.getCurrent().routineOperationSettlement?.message).not.toBe('common.done');
    });

    it('tells the author which plugin field a refused change names, and keeps the generic outcome when the daemon gave no reason', async () => {
        const reason = 'Plugin example.compute Settings group "general" field "enabled" declares a default that is not a boolean.';
        const refused = await renderRemovalOwner('disable', [{ kind: 'failed', code: 'PLUGIN_SETTINGS_DEFAULT_INVALID', message: reason }]);
        await act(async () => { refused.hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(refused.hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.alert).toHaveBeenCalledWith('common.error', expect.stringContaining(reason));
        expect(refused.hook.getCurrent().routineOperationSettlement?.message).not.toBe('common.done');
        await refused.hook.unmount();

        const generic = await renderRemovalOwner('disable', [{ kind: 'failed', code: 'plugin_change_failed' }]);
        await act(async () => { generic.hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(generic.hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.alert).toHaveBeenCalledWith('common.error', expect.stringContaining('settingsPlugins.marketplaceChangeDecisionFailed'));
    });

    it('reconciles an actual unknown disable from the original daemon readback and preserves disabled inventory', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [
            { kind: 'outcomeUnknown', pluginId: 'example.compute' },
        ], { readbackEnabled: false });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        expect(boundary.alert).not.toHaveBeenCalled();
        expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done');
        expect(hook.getCurrent().installedPlugins.find(entry => entry.pluginId === 'example.compute')?.enabled).toBe(false);
    });

    it('preserves the daemon confirmed disabled no-op without a native responsibility review', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [undefined], { initiallyEnabled: false });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done');
    });
});
