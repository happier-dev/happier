import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

import { WorkflowInvocationDetail, type WorkflowInvocationDetailProps } from './WorkflowInvocationDetail';
import type { WorkflowInvocationRecoveryPresentation } from './workflowRunDetailPresentation';

/**
 * A detached Workflow invocation's requests are answered through the SAME
 * canonical permission and question cards a Session uses. These cases render
 * the real cards, footer and question view; only the Session transport, the
 * modal and platform boundaries are replaced, and the Session transport must
 * never be reached from an Execution Run origin.
 */
const sessionOps = vi.hoisted(() => ({
    sessionAllow: vi.fn(),
    sessionDeny: vi.fn(),
    sessionAbort: vi.fn(),
    sessionAllowWithPermissionUpdates: vi.fn(),
    sessionAllowWithAnswers: vi.fn(),
}));
const modalSpies = vi.hoisted(() => ({ alert: vi.fn() }));

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
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modalSpies }).module;
});
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ importOriginal });
});
vi.mock('@/sync/ops', () => sessionOps);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const recovery: WorkflowInvocationRecoveryPresentation = {
    canInspectExecution: false,
    canReattach: false,
    canRetrySameConversation: false,
    canRetryFreshAgent: false,
    retryCausalInvocationIds: [],
    unavailableReasons: { reattach: null, retry: null, continueSameConversation: null, continueFreshAgent: null },
    canContinuePrepared: false,
    canRestoreWorkspace: false,
    canStartReviewedNewRun: false,
    canRunWithAnotherAgent: false,
    preparedRecovery: null,
    requiresUncertaintyAcknowledgement: false,
    waitingForStop: false,
    remainingNotStartedSiblingCount: null,
    workspaceUnavailable: false,
    workspace: null,
};

function progressWith(requests: Record<string, unknown>): WorkflowProgressEnvelopeV1 {
    return {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        execution: { kind: 'detached_run', runId: 'exec-1', localInputId: 'input-1' },
        interaction: { requests },
    } as unknown as WorkflowProgressEnvelopeV1;
}

const permissionProgress = progressWith({
    'permission-1': { tool: 'Read', arguments: { file_path: '/repo/file.txt' }, createdAt: 1 },
});

const questionProgress = progressWith({
    'question-1': {
        tool: 'AskUserQuestion',
        kind: 'user_action',
        createdAt: 1,
        arguments: {
            questions: [{
                question: 'Which branch should the fix land on?',
                header: 'Branch',
                options: [{ label: 'main', description: 'Stable' }, { label: 'dev', description: '' }],
                multiSelect: true,
                freeform: { placeholder: 'Another branch' },
            }],
        },
    },
});

async function renderDetail(overrides: Partial<WorkflowInvocationDetailProps>) {
    const props: WorkflowInvocationDetailProps = {
        progress: permissionProgress,
        recovery,
        workspaceSourceLabel: null,
        continuationText: undefined,
        onChangeContinuationText: () => {},
        replacementText: undefined,
        onChangeReplacementText: () => {},
        testIDPrefix: 'workflow-run',
        ...overrides,
    };
    const screen = await renderScreen(<WorkflowInvocationDetail {...props} />, {
        wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>,
    });
    /** A control the case requires; its absence fails the case rather than typing as nullable. */
    const get = (testID: string) => {
        const node = screen.findByTestId(testID);
        if (node === null) throw new Error(`missing ${testID}`);
        return node;
    };
    return { ...screen, get };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function expectNoSessionTransport() {
    for (const op of Object.values(sessionOps)) expect(op).not.toHaveBeenCalled();
}

describe('WorkflowInvocationDetail canonical request cards', () => {
    afterEach(() => {
        standardCleanup();
        for (const op of Object.values(sessionOps)) op.mockReset();
        modalSpies.alert.mockReset();
    });

    it('opens only a detached execution run, never an Action correspondence without a run identity', async () => {
        const onOpenExecutionRun = vi.fn();
        const actionScreen = await renderDetail({
            progress: {
                ...permissionProgress,
                blockKind: 'action',
                execution: {
                    kind: 'action',
                    actionId: 'mcp_servers.list',
                    actionRequestId: 'request-1',
                    input: {},
                    localInputId: 'input-1',
                },
                interaction: { requests: {} },
            },
            recovery: { ...recovery, canInspectExecution: true },
            onOpenExecutionRun,
        });
        expect(actionScreen.findByTestId('workflow-run-open-execution-run')).toBeNull();

        const runScreen = await renderDetail({
            recovery: { ...recovery, canInspectExecution: true },
            onOpenExecutionRun,
        });
        await runScreen.pressByTestIdAsync('workflow-run-open-execution-run');
        expect(onOpenExecutionRun).toHaveBeenCalledWith('exec-1');
    });

    it('answers a tool permission through the canonical card, addressed to the exact Execution Run', async () => {
        const onRespondToRequest = vi.fn(async () => {});
        const screen = await renderDetail({ onRespondToRequest });

        const { SessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
        expect(screen.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source)).toEqual([
            expect.objectContaining({ kind: 'readOnly', sessionId: 'exec-1', actions: null }),
        ]);
        expect(screen.findByTestId('permission-prompt-card')).toBeTruthy();
        // Structured canonical card data exists, so no raw argument dump.
        expect(screen.getTextContent()).not.toContain('"file_path"');

        await act(async () => { screen.get('permission-footer.allow').props.onPress(); });
        expect(onRespondToRequest).toHaveBeenLastCalledWith({ requestId: 'permission-1', approved: true });

        await act(async () => { screen.get('permission-footer.deny').props.onPress(); });
        expect(onRespondToRequest).toHaveBeenLastCalledWith({ requestId: 'permission-1', approved: false });
        expectNoSessionTransport();
    });

    it('shows canonical busy feedback while a decision is in flight and its alert when it fails', async () => {
        const inFlight = deferred();
        const onRespondToRequest = vi.fn(() => inFlight.promise);
        const screen = await renderDetail({ onRespondToRequest });

        await act(async () => { screen.get('permission-footer.allow').props.onPress(); });
        expect(screen.get('permission-footer.allow').props.accessibilityState)
            .toMatchObject({ disabled: true, busy: true });
        expect(screen.get('permission-footer.deny').props.accessibilityState)
            .toMatchObject({ disabled: true });
        // The opposite press cannot race the answer already in flight.
        await act(async () => { screen.get('permission-footer.deny').props.onPress(); });
        expect(onRespondToRequest).toHaveBeenCalledTimes(1);

        await act(async () => { inFlight.reject(new Error('machine unreachable')); });
        const failure = screen.get('permission-footer.action-error');
        expect(failure.props.accessibilityRole).toBe('alert');
        expect(screen.get('permission-footer.allow').props.accessibilityState)
            .toMatchObject({ disabled: false });
        expectNoSessionTransport();
    });

    it('keeps both decisions withdrawn while the host still holds an unsettled answer for the request', async () => {
        const onRespondToRequest = vi.fn(async () => {});
        const screen = await renderDetail({ onRespondToRequest, pendingRequestIds: new Set(['permission-1']) });

        for (const testID of ['permission-footer.allow', 'permission-footer.deny']) {
            expect(screen.get(testID).props.accessibilityState).toMatchObject({ disabled: true, busy: true });
            await act(async () => { screen.get(testID).props.onPress?.(); });
        }
        expect(onRespondToRequest).not.toHaveBeenCalled();
    });

    it('answers a structured question with choices and free-form text through the canonical question card', async () => {
        const onRespondToRequest = vi.fn(async () => {});
        const screen = await renderDetail({ progress: questionProgress, onRespondToRequest });

        expect(screen.findByTestId('user-action-prompt-card')).toBeTruthy();
        // A question is never offered as Allow/Deny.
        expect(screen.findByTestId('permission-footer.allow')).toBeNull();
        // The visible question names the controls that answer it.
        const group = screen.get('ask-user-question.question:0');
        expect(group.props.role).toBe('group');
        expect(group.props.accessibilityLabel).toBe('Branch: Which branch should the fix land on?');
        expect(screen.get('ask-user-question.freeform:0').props.accessibilityLabel)
            .toBe('Branch: Which branch should the fix land on?');

        await act(async () => { screen.get('ask-user-question.option:0:1').props.onPress(); });
        await act(async () => { screen.get('ask-user-question.freeform:0').props.onChangeText('release'); });
        await act(async () => { screen.get('ask-user-question.submit').props.onPress(); });

        expect(onRespondToRequest).toHaveBeenCalledWith({
            requestId: 'question-1',
            answers: { 'Which branch should the fix land on?': ['dev', 'release'] },
        });
        // Answered: the canonical submitted summary replaces the form.
        expect(screen.findByTestId('ask-user-question.submit')).toBeNull();
        expect(screen.getTextContent()).toContain('dev, release');
        expectNoSessionTransport();
    });

    it('reports a failed answer through the canonical question error and keeps the form answerable', async () => {
        const onRespondToRequest = vi.fn(async () => { throw new Error('machine unreachable'); });
        const screen = await renderDetail({ progress: questionProgress, onRespondToRequest });

        await act(async () => { screen.get('ask-user-question.option:0:0').props.onPress(); });
        await act(async () => { screen.get('ask-user-question.submit').props.onPress(); });

        expect(modalSpies.alert).toHaveBeenCalledWith('common.error', 'machine unreachable');
        expect(screen.get('ask-user-question.submit').props.accessibilityState)
            .toMatchObject({ disabled: false });
    });

    it('offers no decision while the exact evidence is unconfirmed, and never borrows Session authority', async () => {
        const permission = await renderDetail({ contentUnavailable: true });
        expect(permission.findByTestId('permission-prompt-card')).toBeTruthy();
        expect(permission.findByTestId('permission-footer.allow')).toBeNull();
        expect(permission.findByTestId('permission-footer.deny')).toBeNull();
        standardCleanup();

        const question = await renderDetail({ progress: questionProgress, contentUnavailable: true });
        expect(question.findByTestId('user-action-prompt-card')).toBeTruthy();
        expect(question.findByTestId('ask-user-question.submit')).toBeNull();
        expect(question.get('ask-user-question.option:0:0').props.accessibilityState)
            .toMatchObject({ disabled: true });
        expectNoSessionTransport();
    });
});
