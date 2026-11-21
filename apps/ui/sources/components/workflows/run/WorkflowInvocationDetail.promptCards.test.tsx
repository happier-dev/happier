import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import type { WorkflowInvocationDetailProps } from './WorkflowInvocationDetail';
import type { WorkflowInvocationRecoveryPresentation } from './workflowRunDetailPresentation';

/**
 * A detached Workflow invocation's requests are answered through the SAME
 * canonical permission and question cards a Session uses. These cases render
 * the real cards, footer and question view. Action and Session owners remain
 * real through the HTTP, Socket.IO, credential and platform boundaries. The
 * real Modal provider observes failed answers. A reachable
 * Session with the same id surrounds each detached card, so borrowing that authority is visible
 * at the Socket boundary rather than hidden behind an internal operation spy.
 */
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
    return createTextModuleMock({ translate: (key, params) => key === 'usage.board.plans.capacityResets'
        ? `${key}(${String(params?.time)})` : key });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// Only Radix's DOM primitives are replaced; alerts go through the real modal owner.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const sessionRequests = installSessionActionRpcBoundary(() => undefined);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreExecutorModuleLoader);
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { PermissionPromptCard } = await import('@/components/tools/shell/permissions/PermissionPromptCard');
const { WorkflowInvocationDetail } = await import('./WorkflowInvocationDetail');
const { projectWorkflowInvocationRecovery } = await import('./workflowRunDetailPresentation');
const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const { InvestigationOutcomeBanner } = await import('@/components/inbox/detail/InvestigationOutcomeBanner');
const { ModalProvider, useModal } = await import('@/modal');
const originalState = storage.getState();
const originalAppliedSnapshot = getAppliedActiveServerSnapshot();
const originalRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
let serverId = '';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

const recovery: WorkflowInvocationRecoveryPresentation = {
    canInspectExecution: false,
    canReattach: false,
    canRetrySameConversation: false,
    canRetryFreshAgent: false,
    canRetry: false,
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
    let modals: ReturnType<typeof useModal>['state']['modals'] = [];
    function ObserveModals() {
        modals = useModal().state.modals;
        return null;
    }
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
        wrapper: ({ children }) => <ModalProvider><ObserveModals /><AppPaneProvider><AccountNoticeInvestigationBoundary>
            <AppSessionTranscriptSourceProvider sessionId="exec-1" serverId={serverId}>
                {children}
            </AppSessionTranscriptSourceProvider>
        </AccountNoticeInvestigationBoundary></AppPaneProvider></ModalProvider>,
    });
    /** A control the case requires; its absence fails the case rather than typing as nullable. */
    const get = (testID: string) => {
        const node = screen.findByTestId(testID);
        if (node === null) throw new Error(`missing ${testID}`);
        return node;
    };
    return { ...screen, get, readModals: () => modals };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function expectNoSessionTransport() {
    expect(sessionRequests).toEqual([]);
}

describe('WorkflowInvocationDetail canonical request cards', () => {
    it('offers the shared agent action on a failed Run and presents its configured handoff refusal', async () => {
        const screen = await renderDetail({ progress: null, lifecycle: 'failed',
            investigationSubject: { kind: 'workflowRun', serverId, runId: 'failed-run' } });
        try {
            const buttons = screen.findAllByType(AgentActionButton);
            expect(buttons).toHaveLength(1);
            await act(async () => { buttons[0]!.props.onLaunch('review'); });
            await vi.waitFor(() => expect(screen.findAllByType(InvestigationOutcomeBanner)[0]?.props.outcome)
                .toEqual({ kind: 'unavailable', code: 'catalogUnavailable' }));
            expectNoSessionTransport();
        } finally { await screen.unmount(); }
    });
    beforeEach(async () => {
        await homes.reset();
        // The connection fixture restores its credential spy on disposal;
        // reinstall the canonical Home boundary for each new Account lifetime.
        installHomeGovernanceBoundaries(homes);
        serverId = await homes.addHome({ name: 'Prompt cards', serverUrl: 'https://workflow-prompt-cards.test',
            accountId: 'account-a', currentAccount: true });
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://workflow-prompt-cards.test');
        if (!credentials) throw new Error('Prompt-card Home must be signed in');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://workflow-prompt-cards.test',
            accountId: 'account-a', credentials, request: homes.request });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId, accountId: 'account-a' } });
        homes.answer(serverId, '/v1/account/encryption/currentness', {
            body: createPlainAccountEncryptionCurrentnessFixture(),
        });
        const session = installSessionActionFixture({ homes, storage, serverId, session: { id: 'exec-1' } });
        sessionRequests.length = 0;
        // Positive control: the exact Session authority a misrouted card could
        // borrow must reach the Socket boundary through the real card and Action.
        const positive = await renderScreen(<PermissionPromptCard sessionId={session.id} serverId={serverId}
            request={{ id: 'permission-1', kind: 'permission', tool: 'Read', arguments: { file_path: '/repo/file.txt' }, createdAt: 1 }}
            location={null} metadata={session.metadata} canApprovePermissions />, {
            wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={serverId}>
                {children}
            </AppSessionTranscriptSourceProvider>,
        });
        await positive.pressByTestIdAsync('permission-footer.allow');
        expect(sessionRequests).toEqual([expect.objectContaining({
            method: expect.stringContaining('exec-1'),
            params: expect.objectContaining({ id: 'permission-1', approved: true }),
        })]);
        await positive.unmount();
        sessionRequests.length = 0;
    });
    it.each([1_900_000_000_000, null])('shows the failed leaf issue and only a reported usage reset (%s)', async resetAtMs => {
        const runtimeIssueV1 = SessionRuntimeIssueV1Schema.parse({ v: 1, scope: 'primary_session', status: 'failed',
            code: 'usage_limit', source: 'usage_limit', occurredAt: 100, sanitizedPreview: 'Usage limit reached',
            usageLimit: { v: 1, resetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } });
        const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'step',
            invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'leaf',
            reason: { code: 'session_input_failed', message: 'Current turn failed', runtimeIssueV1 } };
        const screen = await renderDetail({ progress, lifecycle: 'failed', recovery: projectWorkflowInvocationRecovery({
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }),
            progress, machineHomeDirectory: null, nowMs: 1_899_999_999_999,
            recoveryAvailability: {
                reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                restoreWorkspace: { kind: 'unavailable', reason: 'workspace_unavailable' },
                retry: { kind: 'available', causalInvocationIds: ['leaf'] },
                continueSameConversation: { kind: 'available' }, continueFreshAgent: { kind: 'available' },
            },
        }), onRetryFreshAgent: vi.fn(), onRetrySameConversation: vi.fn(), onRunAgain: vi.fn(), noChoicesNext: 'run_again' });
        expect(screen.getTextContent()).toContain('session.usageLimitRecovery.banner.title');
        expect(screen.getTextContent()).not.toContain('Current turn failed');
        expect(screen.findByTestId('workflow-run-retry-fresh')).toBeNull();
        expect(screen.findByTestId('workflow-run-retry-same')).toBeNull();
        expect(screen.findByTestId('workflow-run-recovery-run-again')).toBeNull();
        expect(screen.getTextContent()).toContain('workflows.recovery.usageLimitWait');
        expect(screen.findByTestId('workflow-run-runtime-issue-reset') !== null).toBe(resetAtMs !== null);
        if (resetAtMs !== null) expect(screen.getTextContent()).toContain('2030');
    });
    it('shows the stored safe storage cause in the interrupted root technical details', async () => {
        const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'root',
            invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: 'root',
            reason: { code: 'storage_unavailable', message: 'Workflow storage is temporarily unavailable (database_transaction_timeout).',
                failureCause: { phase: 'workflow.storage.invocations.admit', errorClass: 'Error',
                    errorCode: 'database_transaction_timeout', httpStatus: 503 } } };
        const screen = await renderDetail({ progress, lifecycle: 'needs_attention', recovery: projectWorkflowInvocationRecovery({
            run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
            invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'needs_attention' }), progress, machineHomeDirectory: null,
        }) });
        expect(screen.getTextContent()).not.toContain(progress.reason!.message);
        expect(screen.getTextContent()).not.toContain('workflow.storage.invocations.admit');
        await screen.pressByTestIdAsync('workflow-run-invocation-technical.header');
        const text = screen.getTextContent();
        expect(text).toContain('workflow.storage.invocations.admit');
        expect(text).toContain('database_transaction_timeout');
        expect(text).toContain('Error');
        expect(text).toContain('503');
    });
    it('explains the Machine source-runtime repair before offering another launch', async () => {
        const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'step',
            invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'leaf',
            reason: { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', message: 'SOURCE_RUNTIME_RELOAD_REQUIRED' } };
        const onRunAgain = vi.fn();
        const screen = await renderDetail({ progress, lifecycle: 'failed', onRunAgain, noChoicesNext: 'run_again',
            recovery: projectWorkflowInvocationRecovery({ run: createWorkflowRunSummaryFixture({ state: 'failed' }),
                invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }), progress, machineHomeDirectory: null }) });
        expect(screen.getTextContent()).toContain('session.startFailure.cause.SOURCE_RUNTIME_RELOAD_REQUIRED');
        expect(screen.getTextContent()).toContain('workflows.recovery.reloadSourceRuntime');
        // This harness renders translation keys; the raw producer code itself stays folded.
        expect(screen.getTextContent().replace('session.startFailure.cause.SOURCE_RUNTIME_RELOAD_REQUIRED', ''))
            .not.toContain('SOURCE_RUNTIME_RELOAD_REQUIRED');
        expect(screen.findByTestId('workflow-run-recovery-run-again')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-run-invocation-technical.header');
        expect(screen.getTextContent().replace('session.startFailure.cause.SOURCE_RUNTIME_RELOAD_REQUIRED', ''))
            .toContain('SOURCE_RUNTIME_RELOAD_REQUIRED');
        expect(onRunAgain).not.toHaveBeenCalled();
    });
    it.each(['failed', 'outcome_uncertain'] as const)('shows only the unreadable-content notice without a cause or recovery choice for %s (H3)', async lifecycle => {
        const screen = await renderDetail({ progress: null, lifecycle, contentUnavailable: true,
            recovery: { ...recovery, failureCause: null } });
        expect(screen.findByTestId('workflow-run-content-unavailable')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-recovery-card')).toBeNull();
    });

    it.each(['cause', 'choice'] as const)('keeps a known recovery %s visible beside unreadable content (H3)', async known => {
        const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'step',
            invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'leaf',
            reason: { code: 'session_input_failed', message: 'The recorded turn failed' } };
        const onRetry = vi.fn();
        const screen = await renderDetail({ progress: null, lifecycle: 'failed', contentUnavailable: true,
            recovery: known === 'cause' ? projectWorkflowInvocationRecovery({
                run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
                invocation: createWorkflowInvocationIndexFixture({ lifecycle: 'failed' }),
                progress, machineHomeDirectory: null,
            }) : { ...recovery, failureCause: null, canRetry: true }, onRetry });
        expect(screen.findByTestId('workflow-run-content-unavailable')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-recovery-card')).not.toBeNull();
        if (known === 'cause') expect(screen.getTextContent()).toContain('The recorded turn failed');
        else {
            await screen.pressByTestIdAsync('workflow-run-retry');
            expect(onRetry).toHaveBeenCalledOnce();
        }
    });

    it.each(['cancelled', 'cancel_requested'] as const)('keeps a stopped attempt\'s partial result as one card, its status left to the header, for %s (DESIGN-16 D4)', async lifecycle => {
        const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: 'inspect', scope: [] }, attempt: '0', logicalInvocationRecordId: 'stopped',
            timing: { startedAt: '2026-10-12T10:00:00.000Z', finishedAt: '2026-10-12T10:01:00.000Z' }, result: 'Partial findings' };
        const screen = await renderDetail({ progress, lifecycle });
        // The pane's subtitle says the state and the time; the body never repeats them.
        expect(screen.findByTestId('workflow-run-invocation-status')).toBeNull();
        expect(screen.findByTestId('workflow-run-invocation-elapsed')).toBeNull();
        expect(screen.findByTestId('workflow-run-invocation-result-value')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Partial findings');
        // A stopped Wait that was never answered keeps its question, and says it went unanswered.
        const unanswered = await renderDetail({ progress: null, lifecycle, waitPrompt: 'Does #1482 fix the crash?' });
        expect(unanswered.getTextContent()).toContain('Does #1482 fix the crash?');
        expect(unanswered.findByTestId('workflow-run-invocation-unanswered')).not.toBeNull();
    });
    it('puts a structured result\'s Copy in the Result region\'s header, never as a row inside the value (FIN-DESIGN-ACCEPT-2 F6)', async () => {
        const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: 'inspect', scope: [] }, attempt: '0', logicalInvocationRecordId: 'structured',
            timing: { startedAt: '2026-10-12T10:00:00.000Z', finishedAt: '2026-10-12T10:01:00.000Z' }, result: { items: [], cursor: null } };
        const screen = await renderDetail({ progress, lifecycle: 'completed' });
        const { Item } = await import('@/components/ui/lists/Item');
        expect(screen.root.findAllByType(Item).some((item) => item.props.testID === 'workflow-run-invocation-result-copy')).toBe(false);
        const { IconButton } = await import('@/components/ui/buttons/IconButton');
        expect(screen.root.findAllByType(IconButton).some((button) => button.props.testID === 'workflow-run-invocation-result-copy')).toBe(true);
    });

    it('keeps a completed Wait\'s question and says it was continued, never unanswered, when it carries no value', async () => {
        const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'wait',
            invocationPath: { blockId: 'review', scope: [] }, attempt: '0', logicalInvocationRecordId: 'continued',
            timing: { startedAt: '2026-10-12T10:00:00.000Z', finishedAt: '2026-10-12T11:05:00.000Z' } };
        const screen = await renderDetail({ progress, lifecycle: 'completed', waitPrompt: 'Does #1482 fix the crash?' });
        expect(screen.getTextContent()).toContain('Does #1482 fix the crash?');
        expect(screen.findByTestId('workflow-run-invocation-continued')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-invocation-unanswered')).toBeNull();
    });
    afterEach(async () => {
        standardCleanup();
        try {
            expectNoSessionTransport();
        } finally {
            await connection?.dispose();
            connection = undefined;
            await homes.reset();
            storage.setState(originalState, true);
            publishAppliedActiveServerSnapshot(originalAppliedSnapshot, originalRuntimeAvailable);
        }
    });

    it('answers a tool permission through the canonical card, addressed to the exact Execution Run', async () => {
        const onRespondToRequest = vi.fn(async () => {});
        const screen = await renderDetail({ onRespondToRequest });

        const { SessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
        expect(screen.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source)).toEqual([
            expect.objectContaining({ kind: 'app', sessionId: 'exec-1', serverId, actions: expect.any(Object) }),
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

        expect(screen.readModals()).toMatchObject([{ type: 'alert', title: 'common.error', message: 'machine unreachable' }]);
        expect(screen.getTextContent()).toContain('machine unreachable');
        await screen.pressByTestIdAsync('web-modal-button-0');
        await waitForHomeGovernance(() => expect(screen.readModals()).toEqual([]));
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
