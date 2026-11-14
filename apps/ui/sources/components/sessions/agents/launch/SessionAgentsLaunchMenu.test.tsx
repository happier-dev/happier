import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { WorkflowStartPicker } from '@/components/workflows/run/WorkflowStartPicker';
import { SelectionList } from '@/components/ui/selectionList';
import type { DropdownMenuProps } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { WorkflowDefinitionListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

import { SessionAgentsLaunchMenu } from './SessionAgentsLaunchMenu';
import type { SessionAgentLauncher } from './useSessionAgentLauncher';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: routerPush, navigate: routerPush },
}).module);

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: DropdownMenuProps) => React.createElement('DropdownMenu', props,
        props.open ? props.header : null,
        props.open && props.renderContent ? props.renderContent({ maxHeight: 500, maxWidth: 400, placement: 'bottom', presentation: 'anchored', requestClose: () => props.onOpenChange(false) }) : null,
        props.open ? typeof props.footer === 'function'
            ? props.footer({ anchor: { kind: 'rect', rect: { left: 0, top: 0, height: 0 } } })
            : props.footer : null),
}));

vi.mock('@/components/ui/buttons/IconButton', () => ({
    IconButton: (props: Record<string, unknown>) => React.createElement('IconButton', props),
}));

vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/ui/icons/Icon')>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).installTextModuleMock()());

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).installUnistylesMock()());

// The workflow library reads through the Action front door (a transport boundary); FIN's library
// owner, its definition client and parser stay real.
const executeMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => executeMock,
    createFrontDoorUiActionExecutor: () => executeMock,
}));
let accountScope: Awaited<ReturnType<typeof activateStorageAccountScope>>;
beforeEach(async () => {
    accountScope = await activateStorageAccountScope({ serverId: 'server-a', accountId: 'account-a' });
});
afterEach(() => {
    standardCleanup();
    act(() => accountScope.dispose());
});

function launcher(): SessionAgentLauncher {
    return {
        unavailableReason: null,
        intents: ['review', 'plan', 'delegate'],
        agentIds: [],
        openConversation: vi.fn(),
        openRun: vi.fn(),
        openDetails: vi.fn(),
        openStartDraft: vi.fn(),
        providerLaunch: null,
        startBuiltinWorkflow: vi.fn(),
        startPluginWorkflow: vi.fn(),
        startWorkflow: vi.fn(),
    };
}

function readMenu(tree: renderer.ReactTestRenderer) {
    return tree.root.findByType('DropdownMenu' as never) as unknown as {
        props: {
            items: ReadonlyArray<{ id: string; category?: string; submenu?: { items: ReadonlyArray<{ id: string; category?: string }> } }>;
            onSelect: (id: string) => void;
            onOpenChange: (open: boolean) => void;
            open: boolean;
        };
    };
}

describe('SessionAgentsLaunchMenu — Keep going until done…', () => {
    it('opens the Goal control through its one entry when the session can hold a goal', () => {
        const onKeepGoing = vi.fn();
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={launcher()} onKeepGoing={onKeepGoing} />);
        });
        const menu = readMenu(tree!);
        const ids = menu.props.items.map((item) => item.id);
        // Lab `convo-W1`: the last of "Ask an agent to", after the asks and before Run a workflow.
        expect(ids.indexOf('keep-going')).toBeGreaterThan(ids.indexOf('delegate'));
        expect(ids.indexOf('keep-going')).toBe(ids.indexOf('run-workflow') - 1);
        expect(menu.props.items.find((item) => item.id === 'keep-going')?.category)
            .toBe(menu.props.items.find((item) => item.id === 'delegate')?.category);

        act(() => menu.props.onSelect('keep-going'));
        expect(onKeepGoing).toHaveBeenCalledTimes(1);

        act(() => tree?.unmount());
    });

    it('offers no Keep going item where the Goal control cannot open', () => {
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={launcher()} onKeepGoing={null} />);
        });
        expect(readMenu(tree!).props.items.map((item) => item.id)).not.toContain('keep-going');
        act(() => tree?.unmount());
    });
});

describe('SessionAgentsLaunchMenu — when agents cannot start here', () => {
    it('says why once, above the choices, as a note rather than a disabled choice', () => {
        const reason = 'This session has stopped. Resume it to start agents here.';
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(
                <SessionAgentsLaunchMenu
                    launcher={{ ...launcher(), unavailableReason: 'sessionInactive' } as SessionAgentLauncher}
                    unavailableText={reason}
                />,
            );
        });
        const menu = tree!.root.findByType('DropdownMenu' as never) as unknown as {
            props: { items: ReadonlyArray<{ id: string; disabled?: boolean }>; header?: React.ReactNode };
        };
        // A sentence is not an option: it is never a (one-line, disabled) row among the choices.
        expect(menu.props.items.map((item) => item.id)).not.toContain('unavailable');
        let header: renderer.ReactTestRenderer | undefined;
        act(() => { header = renderer.create(<>{menu.props.header}</>); });
        const note = header!.root.findByProps({ testID: 'session-agents-launch:unavailable' });
        expect(note.props.children).toBe(reason);
        // The whole sentence is readable: the note wraps instead of ending in an ellipsis.
        expect(note.props.numberOfLines).toBeUndefined();
        act(() => { header?.unmount(); tree?.unmount(); });
    });
});

describe('SessionAgentsLaunchMenu — Second opinion and Run a workflow ›', () => {
    afterEach(async () => {
        const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
        resetWorkflowLibraryReadsForTests();
        executeMock.mockReset();
        routerPush.mockReset();
    });

    function definition(definitionId: string) {
        return {
            kind: 'workflow-definition.v1',
            definitionId,
            revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: `Workflow ${definitionId}` },
            stepCount: 1,
            triggers: [],
            nextRunAt: null,
            contentStatus: 'available',
        } satisfies WorkflowDefinitionListResultV1['definitions'][number];
    }

    it('offers Second opinion with the asks, and opens a review start with the second_opinion role', () => {
        const start = launcher();
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={start} />);
        });
        const items = readMenu(tree!).props.items;
        const secondOpinion = items.find((item) => item.id === 'second-opinion');
        expect(secondOpinion?.category).toBe(items.find((item) => item.id === 'delegate')?.category);

        act(() => readMenu(tree!).props.onSelect('second-opinion'));
        expect(start.openRun).toHaveBeenCalledWith('review', expect.objectContaining({ roleId: 'second_opinion' }));
        act(() => tree?.unmount());
    });

    it('offers no Second opinion where no Agent here can review', () => {
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={{ ...launcher(), intents: ['plan'] } as SessionAgentLauncher} />);
        });
        expect(readMenu(tree!).props.items.map((item) => item.id)).not.toContain('second-opinion');
        act(() => tree?.unmount());
    });

    async function openWorkflowPicker(tree: renderer.ReactTestRenderer) {
        await act(async () => { readMenu(tree).props.onOpenChange(true); });
        await act(async () => { readMenu(tree).props.onSelect('run-workflow'); });
        await act(async () => { await Promise.resolve(); });
    }

    it('demands the shared chooser only after Workflow is chosen and Back returns without starting', async () => {
        executeMock.mockResolvedValue({ ok: true, result: { definitions: [definition('wf-1')] } });
        const start = launcher();
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => { tree = renderer.create(<SessionAgentsLaunchMenu launcher={start} />); });
        expect(executeMock).not.toHaveBeenCalled();
        await act(async () => { readMenu(tree!).props.onOpenChange(true); });
        expect(executeMock).not.toHaveBeenCalled();
        expect(tree!.root.findAllByType(WorkflowStartPicker)).toHaveLength(0);
        await act(async () => { readMenu(tree!).props.onSelect('run-workflow'); });
        expect(readMenu(tree!).props.open).toBe(true);
        expect(tree!.root.findAllByType(WorkflowStartPicker)).toHaveLength(1);
        expect(executeMock.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list')).toHaveLength(1);
        await act(async () => { tree!.root.findByProps({ testID: 'session-agents-launch:workflow-back' }).props.onPress(); });
        expect(tree!.root.findAllByType(WorkflowStartPicker)).toHaveLength(0);
        expect(readMenu(tree!).props.items.map(item => item.id)).toContain('conversation');
        expect(start.startWorkflow).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();
        act(() => tree?.unmount());
    });

    it('passes the chosen saved revision to contextual Start without visiting the library', async () => {
        const saved = { ...definition('wf-1'), revision: { headerVersion: 3, bodyVersion: 7 } };
        executeMock.mockResolvedValue({ ok: true, result: { definitions: [saved] } });
        const start = launcher();
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => { tree = renderer.create(<SessionAgentsLaunchMenu launcher={start} />); });
        await openWorkflowPicker(tree!);
        await act(async () => { await tree!.root.findByType(SelectionList).props.onSelect('wf-1', { id: 'wf-1', label: 'Workflow wf-1' }); });
        expect(executeMock.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.get')).toHaveLength(0);
        // The Start tab is named after the chosen workflow, never a generic "Workflow".
        expect(start.startWorkflow).toHaveBeenCalledWith({ source: { kind: 'saved', definitionId: 'wf-1', revision: saved.revision }, name: 'Workflow wf-1' });
        expect(readMenu(tree!).props.open).toBe(false);
        expect(routerPush).not.toHaveBeenCalled();
        expect(executeMock.mock.calls.filter(([actionId]) => actionId === 'workflow.run.start')).toHaveLength(0);
        act(() => tree?.unmount());
    });

    it('passes built-in choices to that same reference-only contextual start', async () => {
        executeMock.mockResolvedValue({ ok: true, result: { definitions: [] } });
        const start = launcher();
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => { tree = renderer.create(<SessionAgentsLaunchMenu launcher={start} />); });
        await openWorkflowPicker(tree!);
        await act(async () => { await tree!.root.findByType(SelectionList).props.onSelect('builtin:plan-with-a-panel', { id: 'builtin:plan-with-a-panel', label: 'Plan with a panel' }); });
        expect(start.startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'catalog', workflow: 'builtin:plan-with-a-panel' }, name: expect.any(String) }));
        expect(routerPush).not.toHaveBeenCalled();
        act(() => tree?.unmount());
    });

    it('keeps All workflows as explicit library navigation', async () => {
        const start = launcher();
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => { tree = renderer.create(<SessionAgentsLaunchMenu launcher={start} />); });
        await openWorkflowPicker(tree!);
        await act(async () => { tree!.root.findByProps({ testID: 'session-agents-launch:workflow-all' }).props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith('/workflows');
        expect(start.startWorkflow).not.toHaveBeenCalled();
        act(() => tree?.unmount());
    });
});
