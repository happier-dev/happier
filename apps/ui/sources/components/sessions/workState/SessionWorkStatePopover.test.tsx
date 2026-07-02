import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { SessionWorkStatePopover } from './SessionWorkStatePopover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirm = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const mock = createModalModuleMock();
    return {
        ...mock.module,
        Modal: {
            ...mock.module.Modal,
            alert,
            confirm,
        },
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (key === 'session.workState.goal.budgetProgress' && params?.used && params?.budget) {
                return `${params.used} / ${params.budget}`;
            }
            return `${key}:${params?.title ?? ''}`;
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props, null),
}));

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('ScrollView', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(collectText).join(' ');
    const record = value as { children?: unknown };
    return collectText(record.children);
}

const SessionWorkStatePopoverAny = SessionWorkStatePopover as unknown as React.ComponentType<any>;

describe('SessionWorkStatePopover', () => {
    beforeEach(() => {
        alert.mockReset();
        confirm.mockReset();
    });

    it('keeps an existing goal in read mode until the user edits it', async () => {
        const anchorRef = { current: null } as React.RefObject<unknown>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopoverAny
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
        expect(tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        expect(confirm).not.toHaveBeenCalled();
        expect(alert).not.toHaveBeenCalled();

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });

        expect(tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-save-button' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toThrow();

        act(() => tree?.unmount());
    });

    it('marks the primary pending work-state item as selected in the grouped snapshot list', async () => {
        const anchorRef = { current: null } as React.RefObject<unknown>;

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
        const anchorRef = { current: null } as React.RefObject<unknown>;

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
                onRequestClose={vi.fn()}
            />);
        });

        const text = collectText(tree?.toJSON());
        expect(text).toContain('☑ Read plan');
        expect(text).toContain('☐ Run focused tests');
        expect(text).toContain('☐ Draft implementation');

        act(() => tree?.unmount());
    });

    it('creates a native goal when editable controls are opened without an existing goal', async () => {
        const anchorRef = { current: null } as React.RefObject<unknown>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopoverAny
                open
                anchorRef={anchorRef}
                snapshot={null}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        act(() => {
            tree?.root.findByProps({ testID: 'session-goal-objective-input' }).props.onChangeText('Ship goal editing');
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        expect(onSetGoal).toHaveBeenCalledWith({
            objective: 'Ship goal editing',
            resumeInactiveWithInitialGoal: false,
        });

        act(() => tree?.unmount());
    });

    it('keeps popover content flexible for narrow viewports', async () => {
        const anchorRef = { current: null } as React.RefObject<unknown>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopoverAny
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
});
