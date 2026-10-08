import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
// Collect the real picker before the interaction timeout starts on a cold host.
import { WorkflowAddBlockMenu } from './WorkflowAddBlockMenu';
import { storage } from '@/sync/domains/state/storageStore';
import { SelectionList } from '@/components/ui/selectionList';
import { t } from '@/text';
import { TriggerPopover } from '../triggers/TriggerPopover';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useTriggerThenOptions } from '../triggers/useTriggerThenOptions';
import type { WorkflowDefinitionListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

afterEach(async () => {
    standardCleanup();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
});

const unavailableDefinition = {
    kind: 'workflow-definition.v1', definitionId: 'missing-title', metadata: null, revision: null,
    contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null, triggers: [], nextRunAt: null,
} satisfies WorkflowDefinitionListResultV1['definitions'][number];

async function serveDefinitions(serverUrl: string, definitions: WorkflowDefinitionListResultV1['definitions']) {
    const previous = storage.getState();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    const singleton = await loadSyncSingletonForTests();
    await runtime.upsertAndActivateServer({ serverUrl, scope: 'tab' });
    const boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'account-a', fixtureResponse: async (actionId) => {
        if (actionId !== 'workflow.definition.list') throw new Error(`Unexpected Action ${actionId}`);
        return { ok: true, result: { definitions } satisfies WorkflowDefinitionListResultV1 };
    } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
    expect(storage.getState().profileScope).toEqual({ serverId: boundary.serverId, accountId: 'account-a' });
    boundary.prime();
    return async () => {
        await boundary.dispose();
        singleton.dispose();
        await act(async () => { storage.setState(previous); });
    };
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// Recycler geometry depends on the browser's scroll host. Render its rows
// through the canonical boundary harness while preserving SelectionList logic.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItems: true }).module;
});
// The portal cannot position against a real window in the host renderer. Keep
// the real SelectionList, catalog, query filtering and option activation below it.
vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: (props: { open: boolean; children: (render: { maxHeight: number }) => React.ReactNode }) =>
        props.open ? props.children({ maxHeight: 480 }) : null,
}));
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

describe('workflow Add Action picker', () => {
    it.each([
        ['webhook', 'webhooks.call'],
        ['command', 'machines.command.run'],
    ] as const)('inserts the %s preset through the existing Action leaf', async (preset, actionId) => {
        const onAdd = vi.fn();
        const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} />);
        await screen.pressByTestIdAsync('add');
        await screen.pressByTestIdAsync(`selection-list:add-root:option:add-${preset}`);
        expect(onAdd).toHaveBeenCalledWith({ kind: 'action', actionId });
        expect(screen.findAllByType(SelectionList)).toHaveLength(0);
    });
    it('preserves unavailable reasons through trigger options and refuses picking that source', async () => {
        const dispose = await serveDefinitions('http://unavailable-trigger.test', [unavailableDefinition]);
        try {
            const hook = await renderHook(() => useTriggerThenOptions());
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(hook.getCurrent().workflowOptions.some(option => option.ref === 'missing-title')).toBe(true);
            });
            const options = hook.getCurrent().workflowOptions;
            const screen = await renderScreen(<TriggerPopover testID="trigger" anchorRef={React.createRef()}
                onRequestClose={() => {}} whenKinds={['turnEnds']} sessionId="session-1" onSubmit={vi.fn()}
                initial={{ when: { kind: 'turnEnds' }, then: { kind: 'runWorkflow', ref: null, inputs: {} }, enabled: true }}
                workflowOptions={options} />);
            const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'trigger-workflow')!;
            expect(picker.props.items.find((item: { id: string }) => item.id === 'missing-title')).toMatchObject({
                disabled: true, subtitle: t('workflows.contentReasons.invalidHeader'),
            });
            await act(async () => { picker.props.onSelect('missing-title'); });
            expect(screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'trigger-workflow')!.props.selectedId).toBeNull();
        } finally { await dispose(); }
    });
    it('shows unavailable workflow sources with their reason and refuses inserting them', async () => {
        const dispose = await serveDefinitions('http://unavailable-add.test', [unavailableDefinition,
            { kind: 'workflow-definition.v1', definitionId: 'readable', metadata: { title: 'Readable recipe' }, revision: { headerVersion: 1, bodyVersion: 1 },
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null },
        ]);
        try {
            const { WorkflowAddBlockMenu } = await import('./WorkflowAddBlockMenu');
            const onAdd = vi.fn();
            const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} />);
            await screen.pressByTestIdAsync('add');
            await vi.waitFor(async () => {
                await act(async () => {});
                const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
                const kinds = root.sections.find(section => section.kind === 'static' && section.id === 'kinds');
                if (kinds?.kind !== 'static') throw new Error('missing_step_kinds');
                const step = kinds.options.find(option => option.id === 'add-workflow')?.openStep;
                expect(step?.sections.some(section => section.kind === 'static' && section.id === 'library')).toBe(true);
            });
            const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
            const kinds = root.sections.find(section => section.kind === 'static' && section.id === 'kinds');
            if (kinds?.kind !== 'static') throw new Error('missing_step_kinds');
            const workflowStep = kinds.options.find(option => option.id === 'add-workflow')!.openStep!;
            const section = workflowStep.sections.find(section => section.kind === 'static' && section.id === 'library');
            if (section?.kind !== 'static') throw new Error('missing_workflow_options');
            const unavailable = section.options.find(option => option.id === 'add-workflow:missing-title')!;
            expect(unavailable).toMatchObject({ disabled: true, subtitle: t('workflows.contentReasons.invalidHeader') });
            await act(async () => { unavailable.onSelect?.(); });
            expect(onAdd).not.toHaveBeenCalled();
            await act(async () => { section.options.find(option => option.id === 'add-workflow:readable')!.onSelect?.(); });
            expect(onAdd).toHaveBeenCalledWith({ kind: 'workflow', workflowRef: 'readable' });
        } finally { await dispose(); }
    });
    it('searches the real nested picker and inserts the selected eligible Action', async () => {
        const onAdd = vi.fn();
        const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} onUseExample={vi.fn()} />);
        await screen.pressByTestIdAsync('add');
        expect(screen.findByTestId('selection-list:add-root:option:add-example') === null).toBe(true);
        await screen.pressByTestIdAsync('selection-list:add-root:option:add-action');
        const { listWorkflowStepActionSpecs } = await import('../presentation/workflowActionCatalog');
        const description = listWorkflowStepActionSpecs().find(spec => spec.id === 'notifications.notify_me')!.description;
        expect(screen.getTextContent()).toContain(description);
        // The root's Action explanation may remain once; it is not every row's subtitle.
        expect(screen.getTextContent().split(t('workflows.page.blocks.noAgentTurn')).length).toBeLessThanOrEqual(2);
        const inputs = screen.findAll((node) => (node.type as unknown) === 'TextInput' && typeof node.props.onChangeText === 'function');
        expect(inputs).toHaveLength(1);
        await act(async () => { inputs[0]!.props.onChangeText('Notify me'); });
        const options = screen.findAll((node) => typeof node.type === 'string'
            && typeof node.props.testID === 'string' && node.props.testID.startsWith('selection-list:add-action:option:'));
        expect(options.map((node) => node.props.testID)).toEqual(['selection-list:add-action:option:add-action:notifications.notify_me']);
        await screen.pressByTestIdAsync('selection-list:add-action:option:add-action:notifications.notify_me');
        expect(onAdd).toHaveBeenCalledWith({ kind: 'action', actionId: 'notifications.notify_me' });
    });
});
