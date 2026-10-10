import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { WorkflowDefinitionListResultV1 } from '@happier-dev/protocol';

import { SessionAgentsLaunchMenu } from './SessionAgentsLaunchMenu';
import type { SessionAgentLauncher } from './useSessionAgentLauncher';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('@/components/appShell/workspace/destinationRoute', () => ({
    useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
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
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>()),
    captureActiveServerAccountScopeLifetime: () => ({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
    }),
}));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/storage')>()),
    useActiveServerAccountScope: () => ({ serverId: 'server-a', accountId: 'account-a' }),
}));

function launcher(): SessionAgentLauncher {
    return {
        unavailableReason: null,
        intents: ['review', 'plan', 'delegate'],
        agentIds: [],
        openConversation: vi.fn(),
        openRun: vi.fn(),
        openDetails: vi.fn(),
        providerLaunch: null,
        startBuiltinWorkflow: vi.fn(),
    } as unknown as SessionAgentLauncher;
}

function readMenu(tree: renderer.ReactTestRenderer) {
    return tree.root.findByType('DropdownMenu' as never) as unknown as {
        props: {
            items: ReadonlyArray<{ id: string; category?: string; submenu?: { items: ReadonlyArray<{ id: string; category?: string }> } }>;
            onSelect: (id: string) => void;
            onOpenChange: (open: boolean) => void;
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

    function workflowItems(tree: renderer.ReactTestRenderer) {
        return readMenu(tree).props.items.find((item) => item.id === 'run-workflow')?.submenu?.items ?? [];
    }

    async function open(tree: renderer.ReactTestRenderer) {
        await act(async () => {
            readMenu(tree).props.onOpenChange(true);
        });
        await act(async () => { await Promise.resolve(); });
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

    it('asks the workflow library only once the menu opens, and lists Built-in beside Your library', async () => {
        executeMock.mockResolvedValue({ ok: true, result: { definitions: [definition('wf-1')] } });
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={launcher()} />);
        });
        expect(executeMock).not.toHaveBeenCalled();

        await open(tree!);

        expect(executeMock.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list')).toHaveLength(1);
        const items = workflowItems(tree!);
        const builtIn = items.filter((item) => item.id.startsWith('builtin:'));
        // Session launches now carry their origin, including the scoped built-ins.
        expect(builtIn.map((item) => item.id)).toEqual(expect.arrayContaining([
            'builtin:builtin:keep-going', 'builtin:builtin:review-and-converge',
            'builtin:builtin:plan-with-a-panel', 'builtin:builtin:open-a-pull-request',
        ]));
        const saved = items.find((item) => item.id === 'workflow:wf-1');
        expect(saved).toBeTruthy();
        expect(saved?.category).not.toBe(builtIn[0]?.category);
        act(() => tree?.unmount());
    });

    it('starts a built-in through the launcher and opens a saved workflow at its run entry', async () => {
        executeMock.mockResolvedValue({ ok: true, result: { definitions: [definition('wf-1')] } });
        const start = launcher();
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={start} />);
        });
        await open(tree!);

        act(() => readMenu(tree!).props.onSelect('builtin:builtin:plan-with-a-panel'));
        expect(start.startBuiltinWorkflow).toHaveBeenCalledWith('builtin:plan-with-a-panel');
        // Selection closes the menu. Reopen before choosing its saved-workflow
        // row so the real demand-scoped library can publish that choice again.
        await open(tree!);
        act(() => readMenu(tree!).props.onSelect('workflow:wf-1'));
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/workflows/[id]', params: { id: 'wf-1', intent: 'run' } });
        act(() => tree?.unmount());
    });

    it('pages through the whole library while open, so a workflow on a later page can be found and run', async () => {
        executeMock
            .mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-1')], nextCursor: 'page-2' } })
            .mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-2')] } });
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={launcher()} />);
        });
        await open(tree!);
        await act(async () => { await Promise.resolve(); });

        const listCalls = executeMock.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list');
        expect(listCalls).toHaveLength(2);
        expect(listCalls[1]?.[1]).toEqual(expect.objectContaining({ cursor: 'page-2' }));
        const ids = workflowItems(tree!).map((item) => item.id);
        expect(ids).toEqual(expect.arrayContaining(['workflow:wf-1', 'workflow:wf-2']));
        expect(ids).not.toContain('workflow-library-status');

        act(() => readMenu(tree!).props.onSelect('workflow:wf-2'));
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/workflows/[id]', params: { id: 'wf-2', intent: 'run' } });
        act(() => tree?.unmount());
    });

    it('offers the Workflows destination when a later page cannot be read', async () => {
        executeMock
            .mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-1')], nextCursor: 'page-2' } })
            .mockRejectedValueOnce(new Error('offline'));
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={launcher()} />);
        });
        await open(tree!);
        await act(async () => { await Promise.resolve(); });

        expect(workflowItems(tree!).at(-1)?.id).toBe('workflow-all');
        act(() => readMenu(tree!).props.onSelect('workflow-all'));
        expect(routerPush).toHaveBeenCalledWith('/workflows');
        act(() => tree?.unmount());
    });

    it('shows what a read settled after the menu closed mid-read and opened again', async () => {
        const { createDeferred } = await import('@/dev/testkit');
        const firstPage = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(firstPage.promise)
            .mockResolvedValue({ ok: true, result: { definitions: [definition('wf-1')] } });
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(<SessionAgentsLaunchMenu launcher={launcher()} />);
        });
        await open(tree!);
        expect(workflowItems(tree!).map((item) => item.id)).toContain('workflow-library-status');

        // Closed before the first page arrived; the read settles with its owner.
        await act(async () => {
            readMenu(tree!).props.onOpenChange(false);
        });
        await act(async () => {
            firstPage.resolve({ ok: true, result: { definitions: [definition('wf-1')] } });
            await firstPage.promise;
        });
        await open(tree!);

        const ids = workflowItems(tree!).map((item) => item.id);
        expect(ids).toContain('workflow:wf-1');
        expect(ids).not.toContain('workflow-library-status');
        act(() => tree?.unmount());
    });
});
