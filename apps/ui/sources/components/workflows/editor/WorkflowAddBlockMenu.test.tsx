import * as React from 'react';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
// Collect the real picker before the interaction timeout starts on a cold host.
import { WorkflowAddBlockMenu } from './WorkflowAddBlockMenu';
import { storage } from '@/sync/domains/state/storageStore';
import { SelectionList } from '@/components/ui/selectionList';
import { SelectionListSearchHeader } from '@/components/ui/selectionList/SelectionListSearchHeader';
import { t } from '@/text';
import { TriggerPopover } from '../triggers/TriggerPopover';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useTriggerThenOptions } from '../triggers/useTriggerThenOptions';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const execute = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>()),
    createFrontDoorActionExecute: () => execute,
}));
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(() => {
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
});
afterEach(async () => {
    standardCleanup();
    execute.mockReset();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Ranking consumes visible copy, so raw-key translation mocks hide description matches.
vi.unmock('@/text');
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
        ['Notify', 'add-action:notifications.notify_me', { kind: 'action', actionId: 'notifications.notify_me' }],
        ['If', 'add-if', { kind: 'if' }],
    ] as const)('ranks the %s title above description matches and inserts it on Enter', async (query, optionId, request) => {
        const onAdd = vi.fn();
        const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} />);
        await screen.pressByTestIdAsync('add');
        const input = screen.findAll((node) => (node.type as unknown) === 'TextInput' && typeof node.props.onChangeText === 'function')[0]!;
        await act(async () => { input.props.onChangeText(query); await new Promise(resolve => setTimeout(resolve, 10)); });
        const { Item } = await import('@/components/ui/lists/Item');
        const rows = screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('selection-list:add-root:option:'));
        expect(rows[0]?.props.testID).toBe(`selection-list:add-root:option:${optionId}`);
        expect(rows[0]?.props.focused).toBe(true);
        await act(async () => { screen.findByType(SelectionListSearchHeader).props.onKeyPress({ nativeEvent: { key: 'Enter' }, preventDefault() {} }); });
        expect(onAdd).toHaveBeenCalledWith(request);
    });
    it('keeps the Add viewport steady when opening a workflow submenu', async () => {
        const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={vi.fn()} />);
        await screen.pressByTestIdAsync('add');
        const viewportHeight = () => StyleSheet.flatten(screen.findByTestId('selection-list')!.props.style)?.height;
        expect(viewportHeight()).toBe(480);
        await screen.pressByTestIdAsync('selection-list:add-root:option:add-workflow');
        expect(viewportHeight()).toBe(480);
    });
    it('shows a workflow submenu purpose mark while preserving its insertion action', async () => {
        const onAdd = vi.fn();
        const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} />);
        await screen.pressByTestIdAsync('add');
        await screen.pressByTestIdAsync('selection-list:add-root:option:add-workflow');
        const review = screen.findByTestId('selection-list:add-workflow:option:add-workflow:builtin:review-and-converge')!;
        expect(review.findAll((node) => (node.type as unknown) === 'Icon').map((node) => node.props.name)).toContain('shield-check');
        await screen.pressByTestIdAsync('selection-list:add-workflow:option:add-workflow:builtin:review-and-converge');
        expect(onAdd).toHaveBeenCalledWith({ kind: 'workflow', workflowRef: 'builtin:review-and-converge' });
        expect(screen.findAllByType(SelectionList)).toHaveLength(0);
    });
    it('finds Actions directly from the top-level search and visibly focuses its first match', async () => {
        const onAdd = vi.fn();
        const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} />);
        await screen.pressByTestIdAsync('add');
        const input = screen.findAll((node) => (node.type as unknown) === 'TextInput' && typeof node.props.onChangeText === 'function')[0]!;
        await act(async () => { input.props.onChangeText('Notify me'); await new Promise(resolve => setTimeout(resolve, 10)); });
        const { Item } = await import('@/components/ui/lists/Item');
        const row = screen.findAllByType(Item).find(node => node.props.testID === 'selection-list:add-root:option:add-action:notifications.notify_me');
        expect(row).toBeDefined();
        expect(row?.props.focused).toBe(true);
        await screen.pressByTestIdAsync('selection-list:add-root:option:add-action:notifications.notify_me');
        expect(onAdd).toHaveBeenCalledWith({ kind: 'action', actionId: 'notifications.notify_me' });
    });
    it('finds a built-in workflow by name from the top-level search and inserts it (DESIGN-9 N45)', async () => {
        const onAdd = vi.fn();
        const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} />);
        await screen.pressByTestIdAsync('add');
        const input = screen.findAll((node) => (node.type as unknown) === 'TextInput' && typeof node.props.onChangeText === 'function')[0]!;
        await act(async () => { input.props.onChangeText('Review & converge'); await new Promise(resolve => setTimeout(resolve, 10)); });
        const { Item } = await import('@/components/ui/lists/Item');
        const rows = screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('selection-list:add-root:option:'));
        expect(rows[0]?.props.testID).toBe('selection-list:add-root:option:add-workflow:builtin:review-and-converge');
        await screen.pressByTestIdAsync('selection-list:add-root:option:add-workflow:builtin:review-and-converge');
        expect(onAdd).toHaveBeenCalledWith({ kind: 'workflow', workflowRef: 'builtin:review-and-converge' });
        expect(screen.findAllByType(SelectionList)).toHaveLength(0);
    });
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
        const previous = storage.getState();
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const server = await runtime.upsertAndActivateServer({ serverUrl: 'http://unavailable-trigger.test', name: 'Trigger picker' });
        publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' } });
        execute.mockResolvedValue({ ok: true, result: { definitions: [
            { kind: 'workflow-definition.v1', definitionId: 'missing-title', metadata: null, revision: null,
                contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null, triggers: [], nextRunAt: null },
        ] } });
        try {
            const hook = await renderHook(() => useTriggerThenOptions());
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
        } finally { await act(async () => { storage.setState(previous); }); }
    });
    it('shows unavailable workflow sources with their reason and refuses inserting them', async () => {
        const previous = storage.getState();
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const server = await runtime.upsertAndActivateServer({ serverUrl: 'http://unavailable-add.test', name: 'Add picker' });
        publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' } });
        execute.mockResolvedValue({ ok: true, result: { definitions: [
            { kind: 'workflow-definition.v1', definitionId: 'missing-title', metadata: null, revision: null,
                contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null, triggers: [], nextRunAt: null },
            { kind: 'workflow-definition.v1', definitionId: 'readable', metadata: { title: 'Readable recipe' }, revision: { headerVersion: 1, bodyVersion: 1 },
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null },
        ] } });
        try {
            const { WorkflowAddBlockMenu } = await import('./WorkflowAddBlockMenu');
            const onAdd = vi.fn();
            const screen = await renderScreen(<WorkflowAddBlockMenu scopeLabel="Workflow" testID="add" onAdd={onAdd} />);
            await screen.pressByTestIdAsync('add');
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
        } finally { await act(async () => { storage.setState(previous); }); }
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
