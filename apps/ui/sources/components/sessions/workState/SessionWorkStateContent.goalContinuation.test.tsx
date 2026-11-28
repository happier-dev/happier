import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import { SessionWorkStateContent } from './SessionWorkStateContent';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationDefinitionListItemSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const confirm = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
// The Action front door is the relay to the daemon that owns `workflow.trigger.*`: the boundary.
const execute = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => execute,
    createFrontDoorUiActionExecutor: () => execute,
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

vi.mock('@/components/ui/popover', async () => ({
    ...await import('@/components/ui/popover/modalAwareFloatingPopoverPortalOptions'),
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
let portableHome: string;
const renderedTrees: renderer.ReactTestRenderer[] = [];
let accountNumber = 0;

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
        scopeSessionId: SESSION_ID,
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
            subject: { kind: 'session', serverId: portableHome, sessionId: SESSION_ID },
            events: ['parentTurnCompleted'],
            policy: { kind: 'everyMatch' },
            remainingOccurrences: null,
            status: { state: 'waiting', runId: null },
            triggerDefinitionEnvelope: 'opened-definition',
        }],
    };
}

function installTriggerHost(initialSets: readonly unknown[]) {
    let sets = [...initialSets];
    execute.mockImplementation(async (actionId: string, input: Record<string, unknown>) => {
        if (actionId === 'workflow.trigger.list') return { ok: true, result: { lifetimeSession: { sessionId: SESSION_ID }, sets, pullRequestLinks: [] } };
        if (actionId === 'workflow.trigger.add') {
            const set = keepGoingSet(input.inputs as Record<string, unknown>);
            sets = [set];
            return { ok: true, result: { set, triggerId: 'trigger-keep-going' } };
        }
        if (actionId === 'workflow.trigger.remove') {
            const removed = sets[0] as ReturnType<typeof keepGoingSet>;
            sets = [];
            return { ok: true, result: { set: { ...removed, revision: removed.revision + 1, triggers: [] } } };
        }
        if (actionId === 'workflow.trigger.update') {
            const request = WorkflowTriggerUpdateRequestV1Schema.parse(input);
            const current = sets[0] as ReturnType<typeof keepGoingSet>;
            if (request.expectedRevision !== current.revision) return { ok: false, errorCode: 'currentness_conflict', error: 'currentness_conflict' };
            const set = { ...current, revision: current.revision + 1,
                context: { ...current.context, inputs: request.patch.inputs ?? current.context.inputs } };
            sets = [set];
            return { ok: true, result: { set } };
        }
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    });
    return { replaceSets: (next: readonly unknown[]) => { sets = [...next]; } };
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
    renderedTrees.push(tree!);
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
    afterEach(() => { act(() => { for (const tree of renderedTrees.splice(0)) tree.unmount(); }); });
    beforeEach(async () => {
        const { getServerProfileById, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const profile = getServerProfileById(getActiveServerSnapshot().serverId);
        if (!profile) throw new Error('Expected the selected Home profile');
        portableHome = profile.serverIdentityId ?? 'goal-home';
        await setServerProfileIdentityForUrl(profile.serverUrl, portableHome);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: getActiveServerSnapshot().serverId, accountId: `goal-reader-${++accountNumber}` },
            automations: {}, workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
        execute.mockReset();
        confirm.mockReset();
        alert.mockReset();
    });

    it('reflects another writer updating and removing Keep going while the Goal stays open', async () => {
        const host = installTriggerHost([keepGoingSet({ maxRounds: 6, strikes: 2, secondOpinion: true })]);
        const tree = await renderGoalControl({ nativeGoalOwner: false });
        await act(async () => { storage.getState().upsertWorkflowTriggerSet({
            set: WorkflowTriggerSetV1Schema.parse({ ...keepGoingSet({ maxRounds: 8, strikes: 2, secondOpinion: false }), revision: 4 }),
            queryKey: `session:${SESSION_ID}`,
        }); });
        expect(findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.value).toBe('8');
        await act(async () => { findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.onChangeText(''); });
        const updated = { ...keepGoingSet({ maxRounds: 8, strikes: 4, secondOpinion: false }), revision: 5 };
        host.replaceSets([updated]);
        await act(async () => { storage.getState().upsertWorkflowTriggerSet({
            set: WorkflowTriggerSetV1Schema.parse(updated), queryKey: `session:${SESSION_ID}`,
        }); });
        expect(findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.value).toBe('');
        expect(findByTestId(tree, 'session-goal-keep-going-strikes', 'onChangeText').props.value).toBe('4');
        await act(async () => { findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.onChangeText('9'); });
        expect(hasTestId(tree, 'session-goal-keep-going-error')).toBe(false);
        expect(storage.getState().workflowTriggerSetsById['automation-keep-going'].context?.inputs).toMatchObject({ maxRounds: 9, strikes: 4 });
        await act(async () => { storage.getState().upsertWorkflowTriggerSet({
            set: WorkflowTriggerSetV1Schema.parse({ ...keepGoingSet({}), revision: 7, triggers: [] }),
            queryKey: `session:${SESSION_ID}`,
        }); });
        expect(findByTestId(tree, 'session-goal-keep-going-switch').props.value).toBe(false);
    });

    it('refreshes on the existing Session trigger change signal and ignores unrelated changes', async () => {
        const host = installTriggerHost([keepGoingSet({ maxRounds: 6, strikes: 2, secondOpinion: true })]);
        const tree = await renderGoalControl({ nativeGoalOwner: false });
        const reads = callsOf('workflow.trigger.list').length;
        const publish = (id: string, sessionId: string) => storage.getState().upsertAutomation(
            createAutomationDefinitionSummary(AutomationDefinitionListItemSchema.parse({
                id, name: 'Keep going', description: null, enabled: true, triggers: [],
                scopeSessionId: sessionId, targetType: 'existingSession', existingSessionId: sessionId,
                templateVersion: 4, lastRunAt: null, createdAt: 1, updatedAt: 2, assignments: [],
            })),
        );
        await act(async () => { publish('unrelated', 'other-session'); });
        expect(callsOf('workflow.trigger.list')).toHaveLength(reads);
        host.replaceSets([]);
        await act(async () => { publish('automation-keep-going', SESSION_ID); });
        expect(callsOf('workflow.trigger.list')).toHaveLength(reads + 1);
        expect(findByTestId(tree, 'session-goal-keep-going-switch').props.value).toBe(false);
    });

    it('keeps clean fields live after a refused detach', async () => {
        const host = installTriggerHost([keepGoingSet({ maxRounds: 6, strikes: 2, secondOpinion: false })]);
        const transport = execute.getMockImplementation()!;
        execute.mockImplementation((actionId, ...args) => actionId === 'workflow.trigger.remove'
            ? Promise.resolve({ ok: false, errorCode: 'currentness_conflict', error: 'currentness_conflict' })
            : transport(actionId, ...args));
        const tree = await renderGoalControl({ nativeGoalOwner: false });
        await act(async () => { findByTestId(tree, 'session-goal-keep-going-switch').props.onValueChange(false); });
        expect(hasTestId(tree, 'session-goal-keep-going-error')).toBe(true);
        const updated = { ...keepGoingSet({ maxRounds: 8, strikes: 4, secondOpinion: true }), revision: 4 };
        host.replaceSets([updated]);
        await act(async () => { storage.getState().upsertWorkflowTriggerSet({
            set: WorkflowTriggerSetV1Schema.parse(updated), queryKey: `session:${SESSION_ID}`,
        }); });
        expect(findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.value).toBe('8');
        expect(findByTestId(tree, 'session-goal-keep-going-strikes', 'onChangeText').props.value).toBe('4');
    });

    it('shows a new canonical attachment after a successful detach', async () => {
        const host = installTriggerHost([keepGoingSet({ maxRounds: 6, strikes: 2, secondOpinion: false })]);
        const tree = await renderGoalControl({ nativeGoalOwner: false });
        await act(async () => { findByTestId(tree, 'session-goal-keep-going-switch').props.onValueChange(false); });
        expect(findByTestId(tree, 'session-goal-keep-going-switch').props.value).toBe(false);
        const updated = { ...keepGoingSet({ maxRounds: 8, strikes: 4, secondOpinion: true }), revision: 5 };
        host.replaceSets([updated]);
        await act(async () => { storage.getState().upsertWorkflowTriggerSet({
            set: WorkflowTriggerSetV1Schema.parse(updated), queryKey: `session:${SESSION_ID}`,
        }); });
        expect(findByTestId(tree, 'session-goal-keep-going-switch').props.value).toBe(true);
        expect(findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.value).toBe('8');
        expect(findByTestId(tree, 'session-goal-keep-going-strikes', 'onChangeText').props.value).toBe('4');
        await act(async () => { findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.onChangeText('9'); });
        expect(storage.getState().workflowTriggerSetsById['automation-keep-going'].context?.inputs)
            .toMatchObject({ maxRounds: 9, strikes: 4, secondOpinion: true });
    });

    it('merges queued dirty fields with the latest canonical clean fields', async () => {
        const host = installTriggerHost([keepGoingSet({ maxRounds: 6, strikes: 2, secondOpinion: false })]);
        const transport = execute.getMockImplementation()!;
        let releaseFirst: (() => void) | undefined;
        let finishSecond: (() => void) | undefined;
        const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
        const secondResponse = new Promise<void>(resolve => { finishSecond = resolve; });
        let writes = 0;
        execute.mockImplementation(async (actionId, ...args) => {
            const result = await transport(actionId, ...args);
            if (actionId === 'workflow.trigger.update') {
                if (++writes === 1) await firstResponse;
                else finishSecond!();
            }
            return result;
        });
        const tree = await renderGoalControl({ nativeGoalOwner: false });
        await act(async () => { findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.onChangeText('7'); });
        await act(async () => { findByTestId(tree, 'session-goal-keep-going-rounds', 'onChangeText').props.onChangeText('8'); });
        const updated = { ...keepGoingSet({ maxRounds: 7, strikes: 4, secondOpinion: false }), revision: 5 };
        host.replaceSets([updated]);
        await act(async () => { storage.getState().upsertWorkflowTriggerSet({
            set: WorkflowTriggerSetV1Schema.parse(updated), queryKey: `session:${SESSION_ID}`,
        }); });
        await act(async () => { releaseFirst!(); await secondResponse; });
        expect(storage.getState().workflowTriggerSetsById['automation-keep-going'].context?.inputs)
            .toMatchObject({ maxRounds: 8, strikes: 4 });
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

        expect(callsOf('workflow.trigger.add')).toEqual([[
            'workflow.trigger.add',
            {
                lifetimeSession: { sessionId: SESSION_ID },
                target: { kind: 'workflow', ref: 'builtin:keep-going' },
                inputs: { maxRounds: 4, strikes: 3, secondOpinion: false },
                trigger: {
                    kind: 'sessionLifecycle',
                    enabled: true,
                    subject: { kind: 'session', serverId: portableHome, sessionId: SESSION_ID },
                    events: ['parentTurnCompleted'],
                    policy: { kind: 'everyMatch' },
                },
            },
            expect.objectContaining({ externalActionTarget: { kind: 'machine', machineId: MACHINE_ID } }),
        ]]);
        expect(findByTestId(tree, 'session-goal-keep-going-switch').props.value).toBe(true);

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

        expect(callsOf('workflow.trigger.add')).toEqual([]);
        expect(callsOf('workflow.trigger.remove')).toEqual([]);
        expect(onSetGoal).toHaveBeenCalledWith({ status: 'paused' }, expect.any(AbortSignal));

    });

    it('reads Keep going and delegates the complete clear to the Goal Action', async () => {
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
        expect(callsOf('workflow.trigger.remove')).toEqual([]);

    });

    it('shows the typed failure instead of either owner when Keep going is still attached under native goals', async () => {
        installTriggerHost([keepGoingSet({ maxRounds: 4, strikes: 3, secondOpinion: false })]);
        const tree = await renderGoalControl({ nativeGoalOwner: true });

        expect(hasTestId(tree, 'session-goal-continuation-failure')).toBe(true);
        expect(hasTestId(tree, 'session-goal-keep-going-switch')).toBe(false);

    });
});
