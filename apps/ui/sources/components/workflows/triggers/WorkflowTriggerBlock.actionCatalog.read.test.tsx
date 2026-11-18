import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { serializeActionSpec } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { resolveWorkflowActionTitle } from '@/sync/domains/workflows/workflowActionPresentation';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The portal is a platform boundary; the field, menu and its empty result stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
// Substitute Metro loading only; discovery executes through the real Action front door.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});

const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { WorkflowTriggerBlock } = await import('./WorkflowTriggerBlock');
const { TriggerPopover } = await import('./TriggerPopover');
const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
const { Item } = await import('@/components/ui/lists/Item');
const { WorkflowActionBlockEditor } = await import('../editor/WorkflowActionBlockEditor');
const { createWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowEditorDraft');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');

afterAll(async () => { await network.dispose(); });

describe('Action trigger catalog read presentation', () => {
    let serverId: string;
    let serverUrl: string;
    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        network.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
        const home = await network.addHome(`https://trigger-action-catalog-${crypto.randomUUID()}.test`, 'account-a');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        // An addressed, unfocused Home has no hydrated Account settings snapshot:
        // its actual discovery admission must read this Home's HTTP baseline.
        const target = await network.addHome(`https://trigger-catalog-target-${crypto.randomUUID()}.test`, 'target-account');
        serverId = target.id;
        serverUrl = target.serverUrl;
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(async () => {
        await standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    it('authors an all-Session changed-files habit through the shared lifecycle filter controls', async () => {
        const changes: import('./sessionTriggerForm').TriggerWhenValue[] = [];
        let restoreFilter = () => {};
        function Habit() {
            const [when, setWhen] = React.useState<import('./sessionTriggerForm').TriggerWhenValue>({ kind: 'turnEnds',
                subject: { kind: 'session', serverId, sessionId: 'source-session' } });
            restoreFilter = () => setWhen({ kind: 'turnEnds', filter: { v: 1, all: [
                { field: '/launchProfileId', op: 'eq', value: 'review-profile' },
            ] } });
            return <WorkflowTriggerBlock testID="habit" title="Habit" when={when} enabled incomplete={false}
                startOptions={[]} onSelectStart={() => {}} onChangeWhen={next => { changes.push(next); setWhen(next); }}
                onRemove={() => {}} machineId={null} serverId={serverId} />;
        }
        const screen = await renderScreen(<Habit />);
        const source = screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === 'habit-session');
        const any = source?.props.items.find((item: { id: string }) => item.id === 'any-session');
        expect(any).toBeDefined();
        await act(async () => source!.props.onSelect(any.id));
        expect(changes.at(-1)).not.toHaveProperty('subject');
        await screen.pressByTestIdAsync('automation-event-filter-add-clause');
        const picker = screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === 'habit-session');
        expect(picker?.props.selectedId).toBe('any-session');
        const fieldPicker = screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('automation-event-filter-clause-') && node.props.testID.endsWith('-field-picker'))[0];
        await act(async () => fieldPicker!.props.onPress());
        const field = screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.endsWith('-field-option-/changedFiles'))[0];
        await act(async () => field!.props.onPress());
        const value = screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('automation-event-filter-clause-') && node.props.testID.endsWith('-value'))[0];
        await act(async () => value!.props.onChangeText('true'));
        expect(changes.at(-1)).toMatchObject({ kind: 'turnEnds', filter: { v: 1, all: [
            { field: '/changedFiles', op: 'eq', value: true },
        ] } });
        await act(async () => value!.props.onChangeText(''));
        expect(changes.at(-1)).toMatchObject({ filterInvalid: true });
        expect(changes.at(-1)).not.toHaveProperty('filter');
        // Restoring a Sentence snapshot replaces the draft rather than leaving stale filter controls.
        await act(async () => restoreFilter());
        const restored = screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('automation-event-filter-clause-') && node.props.testID.endsWith('-value'))[0];
        expect(restored?.props.value).toBe('"review-profile"');
    });

    it.each([
        { surface: 'trigger', state: 'failed' }, { surface: 'trigger', state: 'ready' },
        { surface: 'step', state: 'failed' }, { surface: 'step', state: 'ready' },
        { surface: 'then', state: 'failed' }, { surface: 'then', state: 'ready' },
    ] as const)('distinguishes a pending $surface read from a settled $state catalog', async ({ surface, state }) => {
        const reply = createDeferred<Response>();
        let requested = false;
        network.setHttpResponder(async input => {
            const url = new URL(String(input));
            const path = url.pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.origin !== serverUrl || path !== '/v2/account/settings') return null;
            requested = true;
            return reply.promise;
        });
        const screen = await renderScreen(surface === 'trigger' ? <WorkflowTriggerBlock testID="action-trigger" title="Action trigger"
            when={{ kind: 'action', phase: 'before', actionIds: [], mode: 'notify' }} enabled incomplete={false}
            startOptions={[]} onSelectStart={vi.fn()} onChangeWhen={vi.fn()} onRemove={vi.fn()}
            machineId={null} serverId={serverId} /> : surface === 'then' ? <TriggerPopover
                testID="then-action" anchorRef={React.createRef()} onRequestClose={vi.fn()}
                whenKinds={['turnEnds']} sessionId={null} workflowOptions={[]}
                initial={{ when: { kind: 'turnEnds' }, then: { kind: 'doAction', actionId: null, input: {} }, enabled: true }}
                machineId={null} serverId={serverId} onSubmit={vi.fn()} /> : <WorkflowActionBlockEditor
                block={{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: {} }}
                draft={createWorkflowEditorDraft({ draftId: 'catalog-step', blocks: [] })}
                ordinal={1} total={1} actions={[]} onSelect={vi.fn()} onChangeBlock={vi.fn()}
                composerScope={{ kind: 'machine', machineId: null, serverId }} testIDPrefix="catalog-step" />);
        try {
            await vi.waitFor(() => expect(requested).toBe(true));
            if (surface !== 'step') {
                if (surface === 'trigger') await screen.pressByTestIdAsync('action-trigger-action.trigger');
                else await act(async () => {
                    screen.findAllByType(Item).find(item => item.props.title === 'workflows.triggers.then.action')!.props.onPress();
                });
                await vi.waitFor(() => expect(screen.getTextContent()).toContain('workflows.triggers.card.actionsLoading'));
            } else {
                expect.soft(screen.getTextContent()).toContain('common.loading');
                // The card's note says the catalog state once; its source line does not repeat it.
                expect.soft(screen.getTextContent().split('common.loading').length - 1).toBe(1);
                expect.soft(screen.getTextContent()).not.toContain('workflows.page.blocks.actionNotInCatalog');
                expect.soft(screen.getTextContent()).not.toContain('workflows.page.blocks.noFields');
            }
            expect(screen.getTextContent()).not.toContain('workflows.triggers.card.noActions');
            // Disable offered Actions through the real Account settings boundary,
            // keeping the discovery read itself admitted.
            const discoveryRead = getActionSpec('action.spec.search');
            const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: Object.fromEntries(
                listActionSpecs().filter(spec => spec.id !== discoveryRead.id && serializeActionSpec(spec, { includeOutputSchema: false })
                    .automation?.[surface === 'trigger' ? 'before' : 'workflowStep'])
                    .map(spec => [spec.id, { enabled: false }]),
            ) });
            await act(async () => reply.resolve(state === 'failed'
                ? Response.json({ error: 'catalog_settings_unavailable' }, { status: 503 })
                : Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 })));
            const emptyLabel = surface === 'step' ? 'workflows.page.blocks.actionNotInCatalog' : 'workflows.triggers.card.noActions';
            const settledLabel = state === 'failed' ? 'common.requestFailed'
                : surface === 'then' ? resolveWorkflowActionTitle(discoveryRead.id, discoveryRead) : emptyLabel;
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(settledLabel));
            if (surface === 'step') expect(screen.getTextContent().split(settledLabel).length - 1).toBe(1);
            expect(screen.getTextContent()).not.toContain('workflows.triggers.card.actionsLoading');
            if (state === 'ready') expect(screen.getTextContent()).not.toContain('common.requestFailed');
            if (state === 'failed') {
                expect(screen.getTextContent()).not.toContain(emptyLabel);
                expect(screen.getTextContent()).not.toContain('workflows.page.blocks.noFields');
            }
        } finally {
            reply.resolve(Response.json({ content: { t: 'plain', v: {} }, version: 2 }));
            await screen.unmount();
        }
    });
});
