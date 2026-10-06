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

const execute = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('@/sync/runtime/orchestration/connectionManager', async (original) => ({
    ...await original<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => appliedSnapshot(), isAppliedActiveServerRuntimeAvailable: () => true,
}));
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
afterEach(async () => {
    standardCleanup();
    execute.mockReset();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
});

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
    it('preserves unavailable reasons through trigger options and refuses picking that source', async () => {
        const previous = storage.getState();
        const runtime = await import('@/sync/domains/server/serverRuntime');
        appliedSnapshot = runtime.getActiveServerSnapshot;
        const server = await runtime.upsertAndActivateServer({ serverUrl: 'http://unavailable-trigger.test', name: 'Trigger picker' });
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
        appliedSnapshot = runtime.getActiveServerSnapshot;
        const server = await runtime.upsertAndActivateServer({ serverUrl: 'http://unavailable-add.test', name: 'Add picker' });
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
