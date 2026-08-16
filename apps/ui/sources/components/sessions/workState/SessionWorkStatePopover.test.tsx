import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { SessionWorkStateContent } from './SessionWorkStateContent';
import { SessionWorkStatePopover } from './SessionWorkStatePopover';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const confirm = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { alert, confirm },
}).module);

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).installTextModuleMock({
    translate: (key, params) => {
        if (key === 'session.workState.goal.budgetProgress' && params?.used && params?.budget) {
            return `${params.used} / ${params.budget}`;
        }
        if (key === 'session.workState.goal.tokensSuffix' && params?.count != null) {
            return `${params.count} tokens`;
        }
        return `${key}:${params?.title ?? ''}`;
    },
})());

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement('Popover', props, props.open ? (
        typeof props.children === 'function' ? props.children({ maxHeight: 360 }) : props.children
    ) : null),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FloatingOverlay', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props, null),
}));

vi.mock('react-native-svg', () => {
    const Svg = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children);
    return {
        default: Svg,
        Svg,
        Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
        Path: (props: Record<string, unknown>) => React.createElement('Path', props, null),
    };
});

vi.mock('@/components/sessions/agentInput/components/AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: Record<string, unknown> & {
        content: () => React.ReactNode;
        onRequestClose: () => void | Promise<void>;
    }) => React.createElement(
        'AgentInputContentPopover',
        { testID: props.testID, onRequestClose: props.onRequestClose },
        props.content(),
    ),
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).installReactNativeWebMock({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
})());

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).installUnistylesMock()());

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(collectText).join(' ');
    const record = value as { children?: unknown };
    return collectText(record.children);
}

/**
 * Pause/Resume, Complete, and Clear live in the goal header's `⋯` overflow menu (U-5). The menu
 * items (which keep the `session-goal-*-button` testIDs) mount only once the menu is opened, so
 * behavior assertions targeting those ids must open the menu first.
 */
function openGoalActionsMenu(tree: renderer.ReactTestRenderer | undefined): void {
    act(() => {
        tree?.root.findByProps({ testID: 'session-goal-actions-overflow' }).props.onPress();
    });
}

describe('SessionWorkStatePopover', () => {
    beforeEach(() => {
        alert.mockReset();
        confirm.mockReset();
    });

    it('marks the primary pending work-state item as selected in the grouped snapshot list', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'opencode',
                    updatedAt: 10,
                    primaryItemId: 'todo:pending',
                    items: [
                        { id: 'todo:pending', kind: 'todo', origin: 'vendor', status: 'pending', title: 'Draft implementation', updatedAt: 8 },
                        { id: 'todo:done', kind: 'todo', origin: 'vendor', status: 'complete', title: 'Read plan', updatedAt: 7 },
                    ],
                }}
                editableGoal={false}
                onRequestClose={vi.fn()}
            />);
        });

        const pendingRow = tree?.root.findByProps({ testID: 'session-work-state-item-todo-pending' });
        const doneGroup = tree?.root.findByProps({ testID: 'session-work-state-group-done' });

        expect(pendingRow?.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
        expect(doneGroup).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('renders work-state todos with the same checklist semantics as transcript todos', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'opencode',
                    updatedAt: 10,
                    primaryItemId: 'todo:active',
                    items: [
                        { id: 'todo:done', kind: 'todo', origin: 'vendor', status: 'complete', title: 'Read plan', updatedAt: 7 },
                        { id: 'todo:active', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run focused tests', updatedAt: 9 },
                        { id: 'todo:pending', kind: 'todo', origin: 'vendor', status: 'pending', title: 'Draft implementation', updatedAt: 8 },
                    ],
                }}
                editableGoal={false}
                onRequestClose={vi.fn()}
            />);
        });

        const text = collectText(tree?.toJSON());
        expect(text).toContain('☑ Read plan');
        expect(text).toContain('☐ Run focused tests');
        expect(text).toContain('☐ Draft implementation');

        act(() => tree?.unmount());
    });

    it('keeps dirty goal edits when outside close is cancelled', async () => {
        confirm.mockResolvedValueOnce(false);
        const onRequestClose = vi.fn();
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        const editButton = tree?.root.findByProps({ testID: 'session-goal-edit-button' });
        await act(async () => {
            await editButton?.props.onPress();
        });
        const input = tree?.root.findByProps({ testID: 'session-goal-objective-input' });
        const popover = tree?.root.findByProps({ testID: 'session-work-state-popover-surface' });
        act(() => {
            input?.props.onChangeText('Ship better goals');
        });
        await act(async () => {
            await popover?.props.onRequestClose();
        });

        expect(confirm).toHaveBeenCalled();
        expect(onRequestClose).not.toHaveBeenCalled();

        act(() => tree?.unmount());
    });

    it('keeps an existing goal in read mode until the user edits it', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(() => tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toThrow();
        openGoalActionsMenu(tree);
        expect(tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        const editButton = tree?.root.findByProps({ testID: 'session-goal-edit-button' });
        await act(async () => {
            await editButton?.props.onPress();
        });
        expect(tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-cancel-edit-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-save-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('does not duplicate an editable goal in the grouped work-state list', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                        { id: 'todo:active', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run focused tests', updatedAt: 9 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(() => tree?.root.findByProps({ testID: 'session-work-state-item-goal-codex' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-work-state-item-todo-active' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('hides the empty goal creation form in the status popover before a goal exists', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={null}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(() => tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-save-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toThrow();

        act(() => tree?.unmount());
    });

    it('keeps the AgentInput goal-chip content as the set-first-goal affordance', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStateContent
                snapshot={null}
                editableGoal
                requestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-save-button' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toThrow();

        act(() => tree?.unmount());
    });

    it('renders the set-first-goal form as creation-only: no usage metrics, budget collapsed, cancel available', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStateContent
                snapshot={null}
                editableGoal
                requestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        // The confusing pre-goal usage cards are gone: no time/tokens metadata before a goal exists.
        expect(() => tree?.root.findByProps({ testID: 'session-goal-usage-meta' })).toThrow();
        // Budget is a collapsed optional disclosure, not a competing primary control.
        expect(tree?.root.findByProps({ testID: 'session-goal-budget-disclosure' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-budget-input' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-cancel-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('hides the budget editor on the chip Set-goal form when a restricted provider profile is supplied (QA-CHIP-2)', async () => {
        // No goal item (set-first-goal form). WITHOUT a profile → Codex full surface → budget disclosure.
        let codexTree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            codexTree = renderer.create(<SessionWorkStateContent
                snapshot={null}
                editableGoal
                requestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });
        expect(codexTree?.root.findByProps({ testID: 'session-goal-budget-disclosure' })).toBeTruthy();
        act(() => codexTree?.unmount());

        // WITH the Claude restricted profile → no budget editor on the same set-goal form.
        let claudeTree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            claudeTree = renderer.create(<SessionWorkStateContent
                snapshot={null}
                editableGoal
                goalActionCapabilityProfile={{ canEdit: true, canStop: false, canClear: true, canConfigureBudget: false }}
                requestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });
        expect(() => claudeTree?.root.findByProps({ testID: 'session-goal-budget-disclosure' })).toThrow();
        expect(() => claudeTree?.root.findByProps({ testID: 'session-goal-budget-input' })).toThrow();
        act(() => claudeTree?.unmount());
    });

    it('routes the set-first-goal Cancel through the dirty-close guard when a draft was typed (U-1)', async () => {
        confirm.mockResolvedValueOnce(false);
        const requestClose = vi.fn();
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStateContent
                snapshot={null}
                editableGoal
                requestClose={requestClose}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        act(() => {
            tree?.root.findByProps({ testID: 'session-goal-objective-input' }).props.onChangeText('Draft objective');
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-cancel-button' }).props.onPress();
        });

        // A typed-but-unsaved draft must prompt the discard confirm; declining keeps the surface open.
        expect(confirm).toHaveBeenCalled();
        expect(requestClose).not.toHaveBeenCalled();

        act(() => tree?.unmount());
    });

    it('closes the set-first-goal form directly on Cancel when no draft was typed (U-1)', async () => {
        const requestClose = vi.fn();
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStateContent
                snapshot={null}
                editableGoal
                requestClose={requestClose}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-cancel-button' }).props.onPress();
        });

        // Nothing typed → not dirty → close directly with no discard prompt.
        expect(confirm).not.toHaveBeenCalled();
        expect(requestClose).toHaveBeenCalledTimes(1);

        act(() => tree?.unmount());
    });

    it('never renders the empty set-goal form in the work-state popover, even with only non-goal items (U-17)', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'claude',
                    updatedAt: 10,
                    primaryItemId: 'task:active',
                    items: [
                        { id: 'task:active', kind: 'task', origin: 'vendor', status: 'active', title: 'Run focused tests', updatedAt: 10 },
                        { id: 'todo:pending', kind: 'todo', origin: 'vendor', status: 'pending', title: 'Draft implementation', updatedAt: 9 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        // The set-goal form belongs only to the goal chip. With no goal item the work-state popover
        // must render its task list but NEVER the empty creation form (no input, no set/cancel button).
        expect(() => tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-save-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-cancel-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-work-state-item-task-active' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('renders the muted empty placeholder when there is no goal, no workflow, and no tasks (F3/U-15)', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'claude',
                    updatedAt: 10,
                    primaryItemId: null,
                    items: [],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(tree?.root.findByProps({ testID: 'session-work-state-empty' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-actions-overflow' })).toThrow();

        act(() => tree?.unmount());
    });

    it('keeps the AgentInput goal-chip set-first-goal affordance even when a task is primary', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStateContent
                snapshot={{
                    v: 1,
                    backendId: 'claude',
                    updatedAt: 10,
                    primaryItemId: 'task:active',
                    items: [
                        { id: 'task:active', kind: 'task', origin: 'vendor', status: 'active', title: 'Run focused tests', updatedAt: 10 },
                    ],
                }}
                editableGoal
                requestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-save-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-work-state-item-task-active' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('shows complete goals as complete and hides pause controls', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'complete', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(collectText(tree?.toJSON())).toContain('session.workState.goal.statusComplete:');
        openGoalActionsMenu(tree);
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('shows budget-limited goals precisely and hides pause controls', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        {
                            id: 'goal:codex',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'blocked',
                            statusReason: 'budgetLimited',
                            title: 'Ship goals',
                            updatedAt: 10,
                        },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(collectText(tree?.toJSON())).toContain('session.workState.goal.statusBudgetLimited:');
        openGoalActionsMenu(tree);
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('reactivates complete goals when saving an edit', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'complete', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        act(() => {
            tree?.root.findByProps({ testID: 'session-goal-objective-input' }).props.onChangeText('Ship goals again');
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        expect(onSetGoal).toHaveBeenCalledWith({
            objective: 'Ship goals again',
            status: 'active',
            resumeInactiveWithInitialGoal: false,
        });

        act(() => tree?.unmount());
    });

    it('closes immediately when an edit resolves to the unchanged goal (no confirmation will arrive)', async () => {
        // Re-submitting the same objective is a no-op: the CLI goal source dedupes and never
        // republishes, so waiting for a work-state confirmation would strand the popover in
        // "setting goal…" for the full timeout. Treat "no change needed" as immediate success.
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });
        const onRequestClose = vi.fn();

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'claude',
                    updatedAt: 10,
                    primaryItemId: 'goal:claude',
                    items: [
                        {
                            id: 'goal:claude',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'active',
                            title: 'Ship goals',
                            updatedAt: 10,
                            goalCapabilities: { canEdit: true, canClear: true },
                        },
                    ],
                }}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        // Edit to the SAME objective (trimmed-equal) and save.
        act(() => {
            tree?.root.findByProps({ testID: 'session-goal-objective-input' }).props.onChangeText('Ship goals  ');
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        // The mutation still dispatches (the runtime may re-inject), but the popover must NOT
        // be left pending: it closes immediately rather than awaiting a confirmation that the
        // source's no-churn dedupe will never deliver.
        expect(onSetGoal).toHaveBeenCalled();
        expect(onRequestClose).toHaveBeenCalled();
        expect(tree?.root.findAllByProps({ testID: 'session-goal-pending' })).toHaveLength(0);

        act(() => tree?.unmount());
    });

    it('marks active goals complete from the popover without changing the objective', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        openGoalActionsMenu(tree);
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-complete-button' }).props.onPress();
        });

        expect(onSetGoal).toHaveBeenCalledWith({ status: 'complete' });

        act(() => tree?.unmount());
    });

    it('validates token budget edits before saving', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10, tokenBudget: 1000, tokensUsed: 250 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        act(() => {
            tree?.root.findByProps({ testID: 'session-goal-budget-input' }).props.onChangeText('0');
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        expect(onSetGoal).not.toHaveBeenCalled();
        expect(tree?.root.findByProps({ testID: 'session-goal-budget-error' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('renders goal budget progress with the shared token usage ring', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        {
                            id: 'goal:codex',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'active',
                            title: 'Ship goals',
                            updatedAt: 10,
                            tokenBudget: 1000,
                            tokensUsed: 250,
                        },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        const budgetMeta = collectText(tree?.root.findByProps({ testID: 'session-goal-usage-meta' }).props.children);
        expect(budgetMeta).toContain('250 / 1k');
        expect(budgetMeta).toContain('25%');
        expect(tree?.root.findByProps({ testID: 'session-goal-budget-meter' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('shows the no-budget state when a goal has no token budget', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        {
                            id: 'goal:codex',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'active',
                            title: 'Ship goals',
                            updatedAt: 10,
                            tokensUsed: 250,
                        },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        const noBudgetMeta = collectText(tree?.root.findByProps({ testID: 'session-goal-usage-meta' }).props.children);
        expect(noBudgetMeta).toContain('250 tokens');
        expect(() => tree?.root.findByProps({ testID: 'session-goal-budget-meter' })).toThrow();

        act(() => tree?.unmount());
    });

    it('requires clear confirmation before invoking the goal clear mutation', async () => {
        confirm.mockResolvedValueOnce(false);
        const anchorRef = { current: null } as React.RefObject<any>;
        const onClearGoal = vi.fn().mockResolvedValue({ ok: true });
        const onRequestClose = vi.fn();

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={vi.fn()}
                onClearGoal={onClearGoal}
            />);
        });

        openGoalActionsMenu(tree);
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-clear-button' }).props.onPress();
        });

        // U-2: confirm is asked BEFORE the popover closes; declining keeps the popover open so the
        // user is not stranded with a dismissed surface after backing out of the destructive prompt.
        expect(confirm).toHaveBeenCalled();
        expect(onRequestClose).not.toHaveBeenCalled();
        expect(onClearGoal).not.toHaveBeenCalled();

        act(() => tree?.unmount());
    });

    it('clears the goal after clear confirmation is accepted', async () => {
        confirm.mockResolvedValueOnce(true);
        const anchorRef = { current: null } as React.RefObject<any>;
        const onClearGoal = vi.fn().mockResolvedValue({ ok: true });
        const onRequestClose = vi.fn();

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={vi.fn()}
                onClearGoal={onClearGoal}
            />);
        });

        openGoalActionsMenu(tree);
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-clear-button' }).props.onPress();
        });

        // Accepting the confirm runs the clear mutation and closes the popover; the confirm is still
        // asked before the close (U-2 order).
        expect(onClearGoal).toHaveBeenCalledTimes(1);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(onRequestClose.mock.invocationCallOrder[0]);

        act(() => tree?.unmount());
    });

    it('closes the popover before showing a goal mutation error alert', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onRequestClose = vi.fn();
        const onSetGoal = vi.fn().mockResolvedValue({
            ok: false,
            error: 'session_goal_control_remote_unavailable',
        });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        openGoalActionsMenu(tree);
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' }).props.onPress();
        });

        expect(alert).toHaveBeenCalledWith(
            'session.workState.notReadyTitle:',
            'session.workState.notReadyMessage:',
        );
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(onRequestClose.mock.invocationCallOrder[0]).toBeLessThan(alert.mock.invocationCallOrder[0]);

        act(() => tree?.unmount());
    });

    it('keeps popover content flexible for narrow viewports', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        const popover = tree?.root.findByProps({ testID: 'session-work-state-popover' });
        expect(popover?.props.style).toEqual(expect.objectContaining({
            minWidth: 0,
            maxWidth: '100%',
        }));

        act(() => tree?.unmount());
    });

    it('exposes only edit and clear for a Claude goal carrying { canEdit, canClear } capabilities', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'claude',
                    updatedAt: 10,
                    primaryItemId: 'goal:claude',
                    items: [
                        {
                            id: 'goal:claude',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'active',
                            title: 'Ship goals',
                            updatedAt: 10,
                            goalCapabilities: { canEdit: true, canClear: true },
                        },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        // Claude does not publish canStop → no pause/resume/complete and no token-budget editor.
        openGoalActionsMenu(tree);
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toBeTruthy();

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        expect(() => tree?.root.findByProps({ testID: 'session-goal-budget-disclosure' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-budget-input' })).toThrow();

        act(() => tree?.unmount());
    });

    it('keeps Codex goals (no capabilities) on the full control surface', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        openGoalActionsMenu(tree);
        expect(tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        expect(tree?.root.findByProps({ testID: 'session-goal-budget-disclosure' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('keeps the destructive goal actions behind the ⋯ overflow menu, not inline (F1/U-5)', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        // U-5: Pause/Resume, Complete, and Clear live behind the overflow affordance — they must NOT be
        // rendered inline on the header. Only the ⋯ menu button and the inline Edit affordance are present
        // before the menu opens; the destructive actions mount only after it is opened.
        expect(tree?.root.findByProps({ testID: 'session-goal-actions-overflow' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toThrow();

        openGoalActionsMenu(tree);
        expect(tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-complete-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('holds a pending "setting goal" state until the work-state confirms, then closes', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });
        const onRequestClose = vi.fn();

        const activeSnapshot = {
            v: 1 as const,
            backendId: 'codex',
            updatedAt: 10,
            primaryItemId: 'goal:codex',
            items: [
                { id: 'goal:codex', kind: 'goal' as const, origin: 'vendor' as const, status: 'active' as const, title: 'Ship goals', updatedAt: 10 },
            ],
        };

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={activeSnapshot}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        openGoalActionsMenu(tree);
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-complete-button' }).props.onPress();
        });

        expect(tree?.root.findByProps({ testID: 'session-goal-pending' })).toBeTruthy();
        expect(onRequestClose).not.toHaveBeenCalled();

        // The native work-state now reflects the change → confirmation closes the popover.
        await act(async () => {
            tree?.update(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    ...activeSnapshot,
                    updatedAt: 11,
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'complete', title: 'Ship goals', updatedAt: 11 },
                    ],
                }}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pending' })).toThrow();

        act(() => tree?.unmount());
    });

    it('softens a slow confirmation to a non-error "still waiting" note and keeps the pending row, then auto-resolves', async () => {
        // G-5: the /goal inject is frequently queued behind an in-flight turn, so the confirmation is
        // legitimately delayed. After the window we must NOT tear down the pending state or shout an
        // error — keep waiting under a softened note and resolve the instant confirmation lands.
        vi.useFakeTimers();
        try {
            const anchorRef = { current: null } as React.RefObject<any>;
            const onSetGoal = vi.fn().mockResolvedValue({ ok: true });
            const onRequestClose = vi.fn();

            const activeSnapshot = {
                v: 1 as const,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:codex',
                items: [
                    { id: 'goal:codex', kind: 'goal' as const, origin: 'vendor' as const, status: 'active' as const, title: 'Ship goals', updatedAt: 10 },
                ],
            };

            let tree: renderer.ReactTestRenderer | undefined;
            await act(async () => {
                tree = renderer.create(<SessionWorkStatePopover
                    open
                    anchorRef={anchorRef}
                    snapshot={activeSnapshot}
                    editableGoal
                    onRequestClose={onRequestClose}
                    onSetGoal={onSetGoal}
                    onClearGoal={vi.fn()}
                />);
            });

            openGoalActionsMenu(tree);
            await act(async () => {
                await tree?.root.findByProps({ testID: 'session-goal-complete-button' }).props.onPress();
            });
            expect(tree?.root.findByProps({ testID: 'session-goal-pending' })).toBeTruthy();
            expect(() => tree?.root.findByProps({ testID: 'session-goal-pending-slow' })).toThrow();

            await act(async () => {
                vi.advanceTimersByTime(12_000);
            });

            // Pending row stays; a softened non-error note appears; no error row; popover stays open.
            expect(tree?.root.findByProps({ testID: 'session-goal-pending' })).toBeTruthy();
            expect(tree?.root.findByProps({ testID: 'session-goal-pending-slow' })).toBeTruthy();
            expect(() => tree?.root.findByProps({ testID: 'session-goal-pending-error' })).toThrow();
            expect(onRequestClose).not.toHaveBeenCalled();

            // Confirmation finally lands → both the pending and the softened note clear, popover closes.
            await act(async () => {
                tree?.update(<SessionWorkStatePopover
                    open
                    anchorRef={anchorRef}
                    snapshot={{
                        ...activeSnapshot,
                        updatedAt: 11,
                        items: [
                            { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'complete', title: 'Ship goals', updatedAt: 11 },
                        ],
                    }}
                    editableGoal
                    onRequestClose={onRequestClose}
                    onSetGoal={onSetGoal}
                    onClearGoal={vi.fn()}
                />);
            });

            expect(onRequestClose).toHaveBeenCalledTimes(1);
            expect(() => tree?.root.findByProps({ testID: 'session-goal-pending' })).toThrow();
            expect(() => tree?.root.findByProps({ testID: 'session-goal-pending-slow' })).toThrow();

            act(() => tree?.unmount());
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears an existing token budget when no limit is selected', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10, tokenBudget: 1000, tokensUsed: 250 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-budget-remove-button' }).props.onPress();
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        expect(onSetGoal).toHaveBeenCalledWith({
            objective: 'Ship goals',
            tokenBudget: null,
            resumeInactiveWithInitialGoal: false,
        });

        act(() => tree?.unmount());
    });
});
