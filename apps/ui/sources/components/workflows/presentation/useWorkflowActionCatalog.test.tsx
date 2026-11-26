import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { WorkflowEventsListOutputV1Schema, type WorkflowEventsListOutputV1 } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, Children, isValidElement, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import type { WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { WORKFLOW_EFFECT_ACTION_IDS_V1 } from '@happier-dev/protocol/workflows';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { settingsParse } from '@/sync/domains/settings/settings';
import { t } from '@/text';
import { buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections,
    DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItems: true }).module;
});
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 480, maxWidth: 420, placement: 'bottom' }));

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
const { useWorkflowEventIntents } = await import('../events/WorkflowEventDetail');
const { WorkflowTriggerSection } = await import('../triggers/WorkflowTriggerSection');
const { WorkflowTriggerBlock } = await import('../triggers/WorkflowTriggerBlock');
const { TriggerPluginEventRows } = await import('../triggers/TriggerPluginEventRows');
const { PluginEventAutomationEditor } = await import('../../automations/editor/PluginEventAutomationEditor');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT } = await import('../triggers/workflowTriggerDraft');
const { createWorkflowTriggerIncompleteSeed } = await import('../triggers/workflowTriggerStarts');
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

function releaseEventProjection(nativePresence = false, deploymentFailure = false) {
    const { pluginId, localId } = deploymentFailure ? DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed : { pluginId: 'acme.deploy', localId: 'released' };
    const declared = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1, projection, projectionDigest: 'c'.repeat(64), automationEligibleEvents: [{
            event: { id: `${pluginId}/${localId}`, identity: { pluginId, localId }, occurrenceId: 'occurrence-a',
                sourceCustody: { kind: 'development', registeredRootId: 'catalog-root' },
                title: deploymentFailure ? 'Deployment failed (catalog title)' : 'A release ships', description: null,
                ...(nativePresence ? { payloadSchema: { type: 'object', properties: { machineId: { type: 'string' } } } } : {}),
                automation: { v: 1, eligible: true, subjectKinds: ['environment'],
                    ...(deploymentFailure ? { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], completionOutcome: 'failed' } : {}),
                    source: { sourceContractVersion: 1,
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
    let holdProjection: (() => Promise<void>) | undefined;
    let transportUnavailable: boolean;
    let manifestReads: number;

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        sectionsRead.clear();
        holdProjection = undefined;
        transportUnavailable = false;
        manifestReads = 0;
        deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection, projectionDigest: 'b'.repeat(64) }));
        const sectionByIndexDigest = new Map(Object.entries(deferred.manifest.sections).map(([section, digest]) => [digest, section]));
        network.setHttpResponder(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            return null;
        });
        const home = await network.addHome('https://workflow-action-catalog.example.test', 'account-a');
        serverId = home.id;
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const read = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            if (!read) {
                manifestReads += 1;
                if (transportUnavailable) return { ok: false, error: 'Machine transport unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE };
                await holdProjection?.();
                return { ok: true, result: deferred.manifest };
            }
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
            const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
            await waitForHomeGovernance(() => {
                const { phase, specs } = hook.getCurrent();
                expect(phase, `Projection sections: ${[...sectionsRead].join(', ')}`).toBe('ready');
                expect(specs).toEqual(expect.arrayContaining([
                    ...WORKFLOW_EFFECT_ACTION_IDS_V1.map(id => expect.objectContaining({
                        id, automation: expect.objectContaining({ workflowStep: true }),
                    })),
                    expect.objectContaining({
                        title: 'Ship it', plugin: expect.objectContaining({ id: 'acme.deploy' }),
                        automation: expect.objectContaining({ workflowStep: true }),
                    }),
                ]));
            });
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
            const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
            await waitForHomeGovernance(() => {
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
        const hook = await renderHook(() => useWorkflowEventIntents({ fact, title: 'Machine went offline',
            subtitle: null, glyph: 'desktop', agentId: null, rowTitle: null, needsYou: false, lines: [], open: null, runsStarted: [] }, true));
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
        }, { initialProps: null as string | null });
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
            expect(hook.getCurrent()).toMatchObject({ status: 'idle', events: [] });
            expect(sectionsRead.size).toBe(0);
            await hook.rerender(true);
            await vi.waitFor(() => expect(['ready', 'unavailable']).toContain(hook.getCurrent().status));
            expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', events: [] });
            await act(async () => storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 3));
            await act(async () => hook.getCurrent().retry());
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent().events).toEqual(expect.arrayContaining([
                expect.objectContaining({ eventRef: { pluginId: 'acme.deploy', localId: 'released' } }),
            ]));
        } finally { await hook.unmount(); }
    });

    it('offers all 45 Event declarations from the READY247 watcher capture', async () => {
        // Account A's headless workflow.events.list on daemon 39b4ed1b9936.
        // Only Machine and plugin installation identities are anonymized. The
        // declarations keep their original shapes and go through the real parser.
        const capture = new URL('./fixtures/ready247WorkflowEvents.json.gz', import.meta.url);
        const { machineId, events } = JSON.parse(gunzipSync(readFileSync(capture)).toString('utf8')) as WorkflowEventsListOutputV1;

        const describe = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection, projectionDigest: 'd'.repeat(64),
        });
        deferred = buildDeferredDaemonProjectionSections({ ...describe, automationEligibleEvents: events });
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 2);
        const hook = await renderHook(() => useWorkflowTriggerEventOptions({ machineId, serverId, enabled: true }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().status).not.toBe('loading'));
            const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
            const { PLUGIN_EVENT_AUTOMATION_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
            const entry = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId, sections: PLUGIN_EVENT_AUTOMATION_SECTIONS });
            const parsed = WorkflowEventsListOutputV1Schema.safeParse({ machineId, events });
            expect(hook.getCurrent().status, JSON.stringify({
                projection: entry?.kind,
                reason: entry?.kind === 'error' ? entry.reason : undefined,
                hydration: entry?.deferredHydrationRejection,
                invalidPaths: parsed.success ? undefined : parsed.error.issues.map(issue => issue.path),
            })).toBe('ready');
            expect(hook.getCurrent().events).toHaveLength(45);
            expect(hook.getCurrent().events.map(({ eventRef }) => eventRef)).toEqual(events.map(({ event }) => event.identity));
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

    it.each(['declared', 'different event', 'empty'] as const)(
        'keeps the seeded deployment event while its Machine catalog loads and settles (%s)', async (answer) => {
            if (answer === 'declared') deferred = releaseEventProjection(false, true);
            if (answer === 'different event') deferred = releaseEventProjection();
            if (answer === 'empty') deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1, projection, projectionDigest: 'b'.repeat(64), automationEligibleEvents: [],
            }));
            storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 2);
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Expected the fixture Home lifetime');
            const gate = Promise.withResolvers<void>();
            holdProjection = () => gate.promise;
            const incomplete = createWorkflowTriggerIncompleteSeed({ eventSeed: {
                eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed, monitoringMachineId: 'machine-1',
                setupInput: { v: 1, serverId, environmentId: 'production' },
            } })!;
            const screen = await renderScreen(<WorkflowTriggerSection
                accountLifetime={lifetime} presentation="sentence" testIDPrefix="seed" set={null} draft={EMPTY_WORKFLOW_TRIGGER_DRAFT}
                onChangeDraft={vi.fn()} status="ready" onRetry={vi.fn()} stepsUnsaved whereSummary={null}
                whereTarget={{ machineId: 'machine-1', directory: '~' }} inputs={[]}
                incomplete={{ state: incomplete, onChange: vi.fn() }} />);
            const clientId = incomplete.pending[0]!.clientId;
            const title = () => screen.findAll(node => node.props.testID === `seed-sentence-trigger:new:${clientId}-start`
                && typeof node.props.label === 'string')[0]?.props.label;
            const reason = () => screen.findByTestId('seed-triggers-pending-reason')?.props.children;
            try {
                expect.soft(title()).toBe('deployment failed');
                expect(reason()).toBe(t('workflows.triggers.card.pluginTriggersLoading', { machine: 'tester.local' }));
                await act(async () => gate.resolve());
                await vi.waitFor(() => {
                    expect(title()).toBe(answer === 'declared' ? 'deployment failed (catalog title)' : 'deployment failed');
                    expect(reason()).toBe(answer === 'declared' ? undefined : t('automations.form.trigger.sourceUnavailable'));
                });
                expect(network.requests.some(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                    && request.targetId === 'machine-1')).toBe(true);
            } finally {
                gate.resolve();
                await screen.unmount();
            }
        },
    );

    it('recovers unreadable resource starts on retry while another reader retains the refused Account catalog', async () => {
        const { useResourceAutomationsSection } = await import('../triggers/useResourceAutomationsSection');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const physicalAccount = captureActiveServerAccountScopeLifetime();
        if (!physicalAccount) throw new Error('Expected the admitted physical Account');
        const subject = { kind: 'environment' as const, serverId, environmentId: 'production' };
        const httpPaths: string[] = [];
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            httpPaths.push(path);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v3/automations/query') return Response.json({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 });
            return null;
        });
        const scope = { serverId, accountId: physicalAccount.scope.accountId };
        const refused = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'action.spec.search': { enabled: false } } });
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: refused }), 2);
        let presented = true;
        const hook = await renderHook(() => {
            const section = useResourceAutomationsSection({ subject, accountLifetime: physicalAccount });
            const other = useWorkflowActionCatalog({ kind: 'machine', machineId: null, serverId }, 'automation',
                { accountLifetime: physicalAccount });
            return { ...section, other };
        }, { wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active={presented}>{children}</PluginSurfaceFocusEligibilityProvider> });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().link.whenStatus).toBe('unavailable'));
            expect(hook.getCurrent().other.phase).toBe('error');
            expect(hook.getCurrent().link.whenOptions).toEqual([]);
            const retry = hook.getCurrent().link.retryWhen;
            presented = false;
            await hook.rerender();
            expect(hook.getCurrent().link.whenStatus).toBe('idle');
            const reads = httpPaths.length;
            await act(async () => retry());
            expect(httpPaths).toHaveLength(reads);
            expect(network.requests).toEqual([]);
            presented = true;
            await hook.rerender();
            await act(async () => storage.getState().applySettingsForScope(scope, settingsParse({}), 3));
            await act(async () => hook.getCurrent().link.retryWhen());
            await vi.waitFor(() => expect(hook.getCurrent().link.whenStatus).toBe('ready'));
            expect(hook.getCurrent().link.whenOptions).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'action:before:deployments.deploy', subject }),
            ]));
            expect(hook.getCurrent().accountLifetime).toBe(physicalAccount);
            expect(network.requests).toEqual([]);
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

    it('settles Account Action discovery when the addressed Home is missing', async () => {
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: null, serverId: 'unknown-home' }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('unsupported'));
            expect(hook.getCurrent().specs).toEqual([]);
            expect(sectionsRead.size).toBe(0);
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

    it.each(['pending', 'unavailable'] as const)('recovers the open Add Action submenu from %s Machine discovery', async (initial) => {
        const gate = Promise.withResolvers<void>();
        let requested = false;
        transportUnavailable = initial === 'unavailable';
        holdProjection = () => {
            requested = true;
            return gate.promise;
        };
        const { WorkflowAddBlockMenu } = await import('../editor/WorkflowAddBlockMenu');
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const onAdd = vi.fn();
        const screen = await renderScreen(<WorkflowAddBlockMenu testID="add" scopeLabel="Workflow" onAdd={onAdd}
            composerScope={{ kind: 'machine', machineId: 'picker-machine', serverId }} />);
        const command = 'selection-list:add-action:option:add-action:machines.command.run';
        const webhook = 'selection-list:add-action:option:add-action:webhooks.call';
        const retry = 'add-action-retry';
        try {
            await screen.pressByTestIdAsync('add');
            await screen.pressByTestIdAsync('selection-list:add-root:option:add-action');
            expect(screen.findByTestId(command)).toBeNull();
            expect(screen.findByTestId(webhook)).toBeNull();
            let readsBeforeRetry: number | undefined;
            if (initial === 'unavailable') {
                await waitForHomeGovernance(() => expect(screen.findByTestId(retry)).not.toBeNull());
                readsBeforeRetry = manifestReads;
                transportUnavailable = false;
                await screen.pressByTestIdAsync(retry);
            } else {
                await waitForHomeGovernance(() => expect(requested).toBe(true));
                expect(screen.getTextContent()).toContain('common.loading');
                expect(screen.getTextContent()).not.toContain('selectionList.emptyMatch');
            }
            await act(async () => { gate.resolve(); });
            await waitForHomeGovernance(() => {
                expect(screen.findByTestId(command)).not.toBeNull();
                expect(screen.findByTestId(webhook)).not.toBeNull();
                expect(screen.findByTestId(retry)).toBeNull();
            });
            if (readsBeforeRetry !== undefined) expect(manifestReads - readsBeforeRetry).toBe(1);
            await screen.pressByTestIdAsync(webhook);
            expect(onAdd).toHaveBeenCalledExactlyOnceWith({ kind: 'action', actionId: 'webhooks.call' });
        } finally {
            gate.resolve();
        }
    });
});
