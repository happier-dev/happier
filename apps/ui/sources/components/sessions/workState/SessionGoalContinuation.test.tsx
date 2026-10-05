import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import { SessionWorkStateContent } from './SessionWorkStateContent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const confirm = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
// The Action front door is the relay to the daemon that owns `session.trigger.*`: the boundary.
const execute = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => execute,
}));

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { alert, confirm },
}).module);

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).installTextModuleMock({
    translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
})());

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props, null),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement('Popover', props, props.open ? (
        typeof props.children === 'function' ? props.children({ maxHeight: 360 }) : props.children
    ) : null),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FloatingOverlay', props, props.children),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
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

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).installReactNativeWebMock({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
})());

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).installUnistylesMock()());

const SESSION_ID = 'session-goal-1';
const MACHINE_ID = 'machine-1';

function goalSnapshot(goal: Readonly<{ tokenBudget?: number }> = {}): SessionWorkStateSnapshot {
    return {
        v: 1,
        backendId: 'opencode',
        updatedAt: 10,
        primaryItemId: 'goal:1',
        items: [{
            id: 'goal:1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Every retry state has customer copy',
            updatedAt: 10,
            ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
        }],
    } as SessionWorkStateSnapshot;
}

function keepGoingSet(inputs: Record<string, unknown>) {
    return {
        automationId: 'automation-keep-going',
        revision: 3,
        enabled: true,
        health: 'available',
        target: { kind: 'workflow', ref: 'builtin:keep-going' },
        context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs },
        triggers: [{
            id: 'trigger-keep-going',
            revision: 1,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
            kind: 'sessionLifecycle',
            sourceSessionId: SESSION_ID,
            events: ['parentTurnCompleted'],
            policy: { kind: 'everyMatch' },
            remainingOccurrences: null,
            status: { state: 'waiting', runId: null },
            triggerDefinitionEnvelope: null,
        }],
    };
}

function installTriggerHost(initialSets: readonly unknown[]) {
    let sets = [...initialSets];
    execute.mockImplementation(async (actionId: string, input: Record<string, unknown>) => {
        if (actionId === 'session.trigger.list') return { ok: true, result: { sessionId: SESSION_ID, sets, pullRequestLinks: [] } };
        if (actionId === 'session.trigger.add') {
            const set = keepGoingSet(input.inputs as Record<string, unknown>);
            sets = [set];
            return { ok: true, result: { set, triggerId: 'trigger-keep-going' } };
        }
        if (actionId === 'session.trigger.remove') {
            const removed = sets[0] as ReturnType<typeof keepGoingSet>;
            sets = [];
            return { ok: true, result: { set: { ...removed, triggers: [] } } };
        }
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    });
}

function callsOf(actionId: string): unknown[][] {
    return execute.mock.calls.filter((call) => call[0] === actionId);
}

async function renderGoalControl(params: Readonly<{
    nativeGoalOwner: boolean;
    snapshot?: SessionWorkStateSnapshot;
    onSetGoal?: ReturnType<typeof vi.fn>;
    onClearGoal?: ReturnType<typeof vi.fn>;
}>): Promise<renderer.ReactTestRenderer> {
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
        tree = renderer.create(<SessionWorkStateContent
            open
            snapshot={params.snapshot ?? goalSnapshot()}
            editableGoal
            showEmptyGoalControls
            requestClose={vi.fn()}
            onSetGoal={params.onSetGoal ?? vi.fn(async () => ({ ok: true }))}
            onClearGoal={params.onClearGoal ?? vi.fn(async () => ({ ok: true }))}
            continuation={{
                sessionId: SESSION_ID,
                machineId: MACHINE_ID,
                nativeGoalOwner: params.nativeGoalOwner,
                agentLabel: 'OpenCode',
            }}
        />);
    });
    await act(async () => { await Promise.resolve(); });
    return tree!;
}

/** The node carrying `testID` that owns the given prop (host or composite), so assertions read real props. */
function findByTestId(tree: renderer.ReactTestRenderer, testID: string, prop = 'value') {
    const nodes = tree.root.findAll((node) => node.props.testID === testID);
    const match = nodes.find((node) => prop in node.props) ?? nodes[0];
    if (!match) throw new Error(`No node with testID ${testID}`);
    return match;
}

function hasTestId(tree: renderer.ReactTestRenderer, testID: string): boolean {
    return tree.root.findAll((node) => node.props.testID === testID).length > 0;
}

describe('the Goal control: one continuation owner (FIN 04 §5.5, 07 S16c)', () => {
    beforeEach(() => {
        execute.mockReset();
        confirm.mockReset();
        alert.mockReset();
    });

    it('attaches Keep going as a When-a-turn-ends session trigger with the prefilled limits', async () => {
        installTriggerHost([]);
        const tree = await renderGoalControl({ nativeGoalOwner: false, snapshot: goalSnapshot({ tokenBudget: 50_000 }) });

        const keepGoing = findByTestId(tree, 'session-goal-keep-going-switch');
        expect(keepGoing.props.value).toBe(false);
        expect(findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.value).toBe('4');
        expect(findByTestId(tree, 'session-goal-keep-going-strikes', 'onChangeText').props.value).toBe('3');
        expect(findByTestId(tree, 'session-goal-keep-going-second-opinion').props.value).toBe(false);
        // The agent's usage reporting has no named owner yet (LEAD-1): the fallback line is the truthful one.
        expect(hasTestId(tree, 'session-goal-keep-going-budget')).toBe(true);

        await act(async () => { await keepGoing.props.onValueChange(true); });

        expect(callsOf('session.trigger.add')).toEqual([[
            'session.trigger.add',
            {
                sessionId: SESSION_ID,
                target: { kind: 'workflow', ref: 'builtin:keep-going' },
                inputs: { maxRounds: 4, strikes: 3, secondOpinion: false },
                trigger: {
                    kind: 'sessionLifecycle',
                    enabled: true,
                    sourceSessionId: SESSION_ID,
                    events: ['parentTurnCompleted'],
                    policy: { kind: 'everyMatch' },
                },
            },
            expect.objectContaining({ externalActionTarget: { kind: 'machine', machineId: MACHINE_ID } }),
        ]]);
        expect(findByTestId(tree, 'session-goal-keep-going-switch').props.value).toBe(true);

        act(() => tree.unmount());
    });

    it('lets an agent with native goals keep going on its own and writes no trigger', async () => {
        installTriggerHost([]);
        const onSetGoal = vi.fn(async () => ({ ok: true }));
        const tree = await renderGoalControl({ nativeGoalOwner: true, onSetGoal });

        expect(hasTestId(tree, 'session-goal-keep-going-rounds')).toBe(false);
        expect(hasTestId(tree, 'session-goal-keep-going-strikes')).toBe(false);
        expect(hasTestId(tree, 'session-goal-keep-going-second-opinion')).toBe(false);
        const native = findByTestId(tree, 'session-goal-keep-going-switch');
        expect(native.props.value).toBe(true);

        await act(async () => { await native.props.onValueChange(false); });

        expect(callsOf('session.trigger.add')).toEqual([]);
        expect(callsOf('session.trigger.remove')).toEqual([]);
        expect(onSetGoal).toHaveBeenCalledWith({ status: 'paused' });

        act(() => tree.unmount());
    });

    it('reads an attached Keep going and removes it when the goal is cleared', async () => {
        installTriggerHost([keepGoingSet({ maxRounds: 6, strikes: 2, secondOpinion: true })]);
        confirm.mockResolvedValue(true);
        const onClearGoal = vi.fn(async () => ({ ok: true }));
        const tree = await renderGoalControl({ nativeGoalOwner: false, onClearGoal });

        expect(findByTestId(tree, 'session-goal-keep-going-switch').props.value).toBe(true);
        expect(findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.value).toBe('6');
        expect(findByTestId(tree, 'session-goal-keep-going-strikes', 'onChangeText').props.value).toBe('2');
        expect(findByTestId(tree, 'session-goal-keep-going-second-opinion').props.value).toBe(true);

        act(() => { findByTestId(tree, 'session-goal-actions-overflow', 'onPress').props.onPress(); });
        await act(async () => { await findByTestId(tree, 'session-goal-clear-button', 'onPress').props.onPress(); });
        await act(async () => { await Promise.resolve(); });

        expect(onClearGoal).toHaveBeenCalledTimes(1);
        expect(callsOf('session.trigger.remove')).toEqual([[
            'session.trigger.remove',
            { sessionId: SESSION_ID, triggerId: 'trigger-keep-going' },
            expect.objectContaining({ externalActionTarget: { kind: 'machine', machineId: MACHINE_ID } }),
        ]]);

        act(() => tree.unmount());
    });

    it('shows the typed failure instead of either owner when Keep going is still attached under native goals', async () => {
        installTriggerHost([keepGoingSet({ maxRounds: 4, strikes: 3, secondOpinion: false })]);
        const tree = await renderGoalControl({ nativeGoalOwner: true });

        expect(hasTestId(tree, 'session-goal-continuation-failure')).toBe(true);
        expect(hasTestId(tree, 'session-goal-keep-going-switch')).toBe(false);

        act(() => tree.unmount());
    });
});
