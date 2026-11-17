import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, Children, isValidElement, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import type { WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections,
    DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The daemon RPC behind the real network boundary is the only substitute; Sync, the
// projection loader, its section reader and the catalog hook stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { PLUGIN_UI_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { useWorkflowActionCatalog } = await import('./useWorkflowActionCatalog');
const { useWorkflowTriggerEventOptions } = await import('../triggers/useWorkflowTriggerEventOptions');
const { useWorkflowEventAutomate } = await import('../events/WorkflowEventDetail');
const { WorkflowTriggerSection } = await import('../triggers/WorkflowTriggerSection');
const { WorkflowTriggerBlock } = await import('../triggers/WorkflowTriggerBlock');
const { TriggerPluginEventRows } = await import('../triggers/TriggerPluginEventRows');
const { PluginEventAutomationEditor } = await import('../../automations/editor/PluginEventAutomationEditor');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT } = await import('../triggers/workflowTriggerDraft');
import type { WorkflowTriggerIncomplete } from '../triggers/workflowTriggerStarts';

afterAll(async () => { await network.dispose(); });

const projection = {
    v: 2 as const, generation: 3,
    installedPackagesById: { 'acme.deploy': { id: 'acme.deploy', displayName: 'Deploy', version: '1.0.0', enabled: true,
        source: { kind: 'path' as const, locator: '/plugins/acme.deploy' } } },
    actionsById: { 'acme.deploy/ship': { id: 'ship', pluginId: 'acme.deploy', occurrenceId: 'occurrence-a', title: 'Ship it',
        scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
    agentsById: { 'acme.deploy/agent': { id: 'acme.deploy/agent', identity: { pluginId: 'acme.deploy', localId: 'agent' }, title: 'Agent' } },
    familiesById: {},
};

function releaseEventProjection(nativePresence = false) {
    const pluginId = 'acme.deploy';
    const declared = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1, projection, projectionDigest: 'c'.repeat(64), automationEligibleEvents: [{
            event: { id: `${pluginId}/released`, identity: { pluginId, localId: 'released' }, occurrenceId: 'occurrence-a',
                sourceCustody: { kind: 'development', registeredRootId: 'catalog-root' }, title: 'A release ships', description: null,
                ...(nativePresence ? { payloadSchema: { type: 'object', properties: { machineId: { type: 'string' } } } } : {}),
                automation: { v: 1, eligible: true, subjectKinds: ['environment'], source: { sourceContractVersion: 1,
                    ...(nativePresence ? { nativeActivity: { kind: 'machinePresence', transition: 'offline' } } : {}),
                    supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: { type: 'object' },
                    setupActionRef: { pluginId, localId: 'setup' } } } },
            setupAction: { id: `${pluginId}/setup`, identity: { pluginId, localId: 'setup' }, occurrenceId: 'occurrence-a',
                title: 'Set up releases', description: null, inputSchema: { type: 'object' }, inputHints: null },
        }],
    });
    const first = declared.automationEligibleEvents?.[0];
    if (!nativePresence || first === undefined) return buildDeferredDaemonProjectionSections(declared);
    const { nativeActivity: _nativeActivity, ...source } = first.event.automation.source;
    return buildDeferredDaemonProjectionSections({ ...declared, automationEligibleEvents: [
        ...(declared.automationEligibleEvents ?? []), { ...first, event: { ...first.event, id: `${pluginId}/alternate`,
            identity: { ...first.event.identity, localId: 'alternate' }, automation: { ...first.event.automation, source } } },
    ] });
}

describe('useWorkflowActionCatalog', () => {
    let serverId: string;
    const sectionsRead = new Set<string>();
    let deferred: ReturnType<typeof buildDeferredDaemonProjectionSections>;

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        sectionsRead.clear();
        deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection, projectionDigest: 'b'.repeat(64) }));
        const sectionByIndexDigest = new Map(Object.entries(deferred.manifest.sections).map(([section, digest]) => [digest, section]));
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
        const home = await network.addHome('https://workflow-action-catalog.example.test', 'account-a');
        serverId = home.id;
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const read = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            if (!read) return { ok: true, result: deferred.manifest };
            for (const digest of [read.digest, ...read.includeDigests ?? []]) {
                const section = sectionByIndexDigest.get(digest);
                if (section) sectionsRead.add(section);
            }
            return { ok: true, result: deferred.read(read.digest, read.offset, read.includeDigests) };
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(async () => {
        standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    it('offers the Machine\'s plugin Actions while hydrating only the plugin UI sections, not the whole catalogue', async () => {
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().specs.some(spec => spec.plugin?.id === 'acme.deploy')).toBe(true));
            expect([...sectionsRead].sort()).toEqual([...demandedDaemonProjectionSections(deferred.manifest, PLUGIN_UI_SECTIONS)].sort());
            expect(sectionsRead.has('agentsById')).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('reads resource When choices once on demand, including settled Actions and Event setup declarations', async () => {
        deferred = releaseEventProjection();
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 2);
        const { buildResourceWorkflowTriggerStartOptions } = await import('../triggers/workflowTriggerStarts');
        const hook = await renderHook((enabled: boolean) => {
            const catalog = useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }, 'automation', { enabled });
            const events = useWorkflowTriggerEventOptions({ machineId: 'machine-1', serverId, enabled });
            return { catalog, events, choices: buildResourceWorkflowTriggerStartOptions({
                subject: { kind: 'environment', serverId, environmentId: 'production' },
                actions: catalog.specs, events: events.events, machineId: 'machine-1' }) };
        }, { initialProps: false });
        try {
            expect(hook.getCurrent().catalog.phase).toBe('idle');
            expect(hook.getCurrent().choices).toEqual([]);
            expect(sectionsRead.size).toBe(0);
            await hook.rerender(true);
            await vi.waitFor(() => {
                expect(hook.getCurrent().catalog.phase).toBe('ready');
                expect(hook.getCurrent().events.status).toBe('ready');
            });
            expect(hook.getCurrent().choices).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'action:before:deployments.deploy', setupRequired: false }),
                expect.objectContaining({ id: 'action:after:deployments.deploy', setupRequired: false }),
                expect.objectContaining({ id: 'event:acme.deploy/released', setupRequired: true }),
            ]));
            const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId, sections: PLUGIN_UI_SECTIONS })
                ?.workflowActionCatalog.current?.readers).toBe(1);
            await hook.rerender(false);
            expect(hook.getCurrent().choices).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('opens a cold offline Machine fact as native intent without demanding its catalog', async () => {
        const fact = { key: 'presence', kind: 'machine', machineId: 'offline-machine', event: 'offline',
            sourceRevision: 999_999, occurredAt: 10, coverage: 'live' } as const;
        const hook = await renderHook(() => useWorkflowEventAutomate({ fact, title: 'Machine went offline',
            subtitle: null, glyph: 'desktop', needsYou: false, lines: [], open: null, runsStarted: [] }, true));
        try {
            expect(hook.getCurrent().open).not.toBeNull();
            await act(async () => hook.getCurrent().open?.());
            const builder = hook.getCurrent().builder;
            if (!isValidElement<{ intent: WorkflowSentenceEditorIntent }>(builder)) throw new Error('Expected the sentence builder');
            expect(builder.props.intent).toMatchObject({ nativeEvent: fact });
            expect(builder.props.intent.eventSeed).toBeUndefined();
            expect(builder.props.intent.trigger).toBeUndefined();
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toEqual([]);
            expect(network.requests.some(request => request.targetId === 'offline-machine')).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('resolves native intent through the selected Runs-on catalog and clears it when the start is replaced', async () => {
        deferred = releaseEventProjection(true);
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 2);
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the authoring Account');
        const nativeEvent = { key: 'presence', kind: 'machine', machineId: 'offline-machine', event: 'offline',
            sourceRevision: 999_999, occurredAt: 10, coverage: 'live' } as const;
        function findBlock(node: ReactNode): ReactElement<ComponentProps<typeof WorkflowTriggerBlock>> | null {
            for (const child of Children.toArray(node)) {
                if (!isValidElement<{ children?: ReactNode }>(child)) continue;
                if (child.type === WorkflowTriggerBlock && isValidElement<ComponentProps<typeof WorkflowTriggerBlock>>(child)) return child;
                const nested = findBlock(child.props.children);
                if (nested) return nested;
            }
            return null;
        }
        const hook = await renderHook((machineId: string | null) => {
            const [incomplete, updateIncomplete] = useState<WorkflowTriggerIncomplete>({ pending: [{ clientId: 'native',
                when: { kind: 'pluginEvent', value: null }, nativeEvent }], edits: {} });
            const element = WorkflowTriggerSection({ accountLifetime: lifetime, testIDPrefix: 'native', set: null,
                draft: EMPTY_WORKFLOW_TRIGGER_DRAFT, onChangeDraft: () => {}, status: 'ready', onRetry: () => {},
                stepsUnsaved: false, whereTarget: machineId === null ? null : { machineId, directory: '/repo' },
                whereSummary: null, inputs: [], incomplete: { state: incomplete, onChange: updateIncomplete } });
            return { incomplete, block: findBlock(element) };
        }, { initialProps: null });
        try {
            expect(hook.getCurrent().block?.props.when).toEqual({ kind: 'pluginEvent', value: null });
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toEqual([]);
            await hook.rerender('editor-controller');
            await vi.waitFor(() => expect(hook.getCurrent().block?.props.initialEventSeed).toMatchObject({
                eventRef: { pluginId: 'acme.deploy', localId: 'released' }, setupInput: { v: 1, serverId, machineId: 'offline-machine' },
            }));
            expect(hook.getCurrent().block?.props.when).toMatchObject({ kind: 'pluginEvent', eventRef: { pluginId: 'acme.deploy', localId: 'released' } });
            expect(network.requests.some(request => request.targetId === 'offline-machine')).toBe(false);
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                && request.payload !== null && typeof request.payload === 'object' && !('sectionRead' in request.payload))).toHaveLength(1);
            await act(async () => hook.getCurrent().block?.props.onSelectStart?.('event:acme.deploy/alternate'));
            expect(hook.getCurrent().incomplete.pending[0]?.nativeEvent).toBeUndefined();
            expect(hook.getCurrent().incomplete.pending[0]?.eventSeed).toBeUndefined();
            expect(hook.getCurrent().block?.props.when).toMatchObject({ eventRef: { pluginId: 'acme.deploy', localId: 'alternate' } });
        } finally { await hook.unmount(); }
    });

    it.each([undefined, 'explicit-watcher'])('authors an ordinary seed on its selected controller while preserving explicit monitoring %s', async monitoringMachineId => {
        deferred = releaseEventProjection(true);
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 2);
        const eventRef = { pluginId: 'acme.deploy', localId: 'released' };
        const initialEventSeed = { eventRef, ...(monitoringMachineId === undefined ? {} : { monitoringMachineId }),
            setupInput: { v: 1, serverId, machineId: 'offline-machine' } };
        const hook = await renderHook(() => {
            const rows = TriggerPluginEventRows({ testID: 'native-setup', when: { kind: 'pluginEvent', value: null, eventRef },
                machineId: 'editor-controller', serverId, initialEventSeed, editing: true, onChange: () => {} });
            const editor = Children.toArray(rows.props.children).find((child): child is ReactElement<ComponentProps<typeof PluginEventAutomationEditor>> =>
                isValidElement<ComponentProps<typeof PluginEventAutomationEditor>>(child) && child.type === PluginEventAutomationEditor);
            if (!editor) throw new Error('Expected the ordinary Event editor');
            return PluginEventAutomationEditor(editor.props);
        });
        try {
            await vi.waitFor(() => {
                const content = hook.getCurrent();
                if (!isValidElement<{ model: { eligibleEvents: readonly unknown[] } }>(content)) throw new Error('Expected the Event composer');
                expect(content.props.model.eligibleEvents).toEqual(expect.arrayContaining([expect.objectContaining({
                    event: expect.objectContaining({ identity: eventRef }),
                })]));
            });
            expect(network.requests.some(request => request.targetId === (monitoringMachineId ?? 'editor-controller'))).toBe(true);
            expect(network.requests.some(request => request.targetId === 'offline-machine')).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('offers only Actions admitted by the Account discovery read', async () => {
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'machines.command.run': { enabled: false } } });
        network.setHttpResponder(async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (pathname === '/v2/account/settings') return Response.json({
                content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2,
            });
            return null;
        });
        storage.getState().applySettingsLocal({ actionsSettingsV1 });
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
            expect(hook.getCurrent().specs.some(spec => spec.id === 'machines.command.run')).toBe(false);
            expect(hook.getCurrent().specs.some(spec => spec.id === 'notifications.notify_me')).toBe(true);
        } finally { await hook.unmount(); }
    });

    it('keeps an undemanded Event picker idle and honors the canonical Event read admission', async () => {
        deferred = releaseEventProjection();
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'workflow.events.list': { enabled: false } } });
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({ actionsSettingsV1 }), 2);
        const hook = await renderHook((enabled: boolean) => useWorkflowTriggerEventOptions({ machineId: 'machine-1', serverId, enabled }),
            { initialProps: false });
        try {
            expect(hook.getCurrent()).toEqual({ status: 'idle', events: [] });
            expect(sectionsRead.size).toBe(0);
            await hook.rerender(true);
            await vi.waitFor(() => expect(['ready', 'unavailable']).toContain(hook.getCurrent().status));
            expect(hook.getCurrent()).toEqual({ status: 'unavailable', events: [] });
        } finally { await hook.unmount(); }
    });

    it('shares the admitted Event catalog and one Machine projection across demanded menus', async () => {
        deferred = releaseEventProjection();
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 2);
        const hook = await renderHook(() => [
            useWorkflowTriggerEventOptions({ machineId: 'machine-1', serverId, enabled: true }),
            useWorkflowTriggerEventOptions({ machineId: 'machine-1', serverId, enabled: true }),
        ]);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().every(catalog => catalog.status === 'ready')).toBe(true));
            for (const catalog of hook.getCurrent()) expect(catalog.events).toMatchObject([{
                eventRef: { pluginId: 'acme.deploy', localId: 'released' }, title: 'A release ships', pluginName: 'Deploy',
                automation: { subjectKinds: ['environment'] },
            }]);
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                && request.payload !== null && typeof request.payload === 'object' && !('sectionRead' in request.payload))).toHaveLength(1);
        } finally { await hook.unmount(); }
    });

    it('offers native Account choices before a Machine is selected without reading a daemon', async () => {
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: null, serverId }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
            expect(hook.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(true);
            expect(hook.getCurrent().specs.some(spec => spec.id === 'notifications.notify_me')).toBe(true);
            expect(sectionsRead.size).toBe(0);
            expect(hook.getCurrent().specs.some(spec => spec.plugin !== undefined)).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('withdraws a pending Account read when that Account retires and admits its successor', async () => {
        let releaseOld: ((response: Response) => void) | undefined;
        const retiredRead = new Promise<Response>(resolve => { releaseOld = resolve; });
        let oldPending = false;
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { wait: { enabled: false } } });
        network.setHttpResponder(async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (pathname !== '/v2/account/settings') return null;
            if (!oldPending) { oldPending = true; return retiredRead; }
            return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 });
        });
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: null, serverId }));
        try {
            await vi.waitFor(() => expect(oldPending).toBe(true));
            await act(async () => {
                await network.setAccount('https://workflow-action-catalog.example.test', 'account-b');
                // Connection restore precedes settings hydration. Publish the successor's
                // real scoped settings, then wait for its choices rather than an old ready frame.
                storage.getState().applySettingsForScope({ serverId, accountId: 'account-b' }, settingsParse({ actionsSettingsV1 }), 2);
            });
            await vi.waitFor(() => {
                expect(hook.getCurrent().phase).toBe('ready');
                expect(hook.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(false);
            });
            await act(async () => { releaseOld?.(Response.json({ content: { t: 'plain', v: {} }, version: 1 })); });
            expect(hook.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(false);
        } finally {
            releaseOld?.(Response.json({ content: { t: 'plain', v: {} }, version: 1 }));
            await hook.unmount();
        }
    });

    it('shares one discovery admission across Workflow and hook pickers for the same demanded target', async () => {
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const hook = await renderHook(() => [
            useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }),
            useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }, 'before'),
            useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }, 'after'),
        ]);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().every(catalog => catalog.phase === 'ready')).toBe(true));
            const entry = readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId, sections: PLUGIN_UI_SECTIONS });
            expect(entry?.workflowActionCatalog.current?.readers).toBe(3);
            const [steps, before, after] = hook.getCurrent();
            expect(steps.specs.some(spec => spec.id === 'wait')).toBe(true);
            expect(steps.specs.some(spec => spec.id === 'workspace.tabs.open')).toBe(false);
            for (const hooks of [before, after]) {
                expect(hooks.specs.some(spec => spec.id === 'wait')).toBe(false);
                expect(hooks.specs.some(spec => spec.id === 'workspace.tabs.open')).toBe(true);
                expect(hooks.specs.some(spec => spec.id === 'transcript.unfollow')).toBe(true);
            }
            const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { wait: { enabled: false } } });
            await act(async () => {
                storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({ actionsSettingsV1 }), 2);
            });
        } finally { await hook.unmount(); }
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId, sections: PLUGIN_UI_SECTIONS })?.workflowActionCatalog.current ?? null).toBeNull();
        const reopened = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }));
        try {
            await vi.waitFor(() => expect(reopened.getCurrent().phase).toBe('ready'));
            expect(reopened.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(false);
        } finally { await reopened.unmount(); }
    });

    it('reads agent-only Workflow choices through the addressed UI discovery Action', async () => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const result = await execute('action.spec.search', { purpose: 'workflow_step', query: 'wait', limit: 100 }, {
            surface: 'ui', serverId, expectedAccountId: 'account-a',
        });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        const { ActionSpecSearchResultSchema } = await import('@happier-dev/protocol/actions/specs/catalog');
        expect(ActionSpecSearchResultSchema.parse(result.result).actionSpecs.some(spec => spec.id === 'wait')).toBe(true);
        const complete = await execute('action.spec.search', { purpose: 'workflow_step', limit: null }, {
            surface: 'ui', serverId, expectedAccountId: 'account-a',
        });
        expect(complete).toMatchObject({ ok: true });
        if (!complete.ok) return;
        expect(ActionSpecSearchResultSchema.parse(complete.result).actionSpecs.map(spec => spec.id)).toContain('wait');
    });
});
