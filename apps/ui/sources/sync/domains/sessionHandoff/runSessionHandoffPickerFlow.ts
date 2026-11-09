import type {
    ActionExecuteResult} from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
    ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import type {
    ActionUiPlacement,
} from '@happier-dev/protocol/actions/actionUiPlacements';
import { router } from 'expo-router';

import { openSessionHandoffPicker } from '@/components/sessions/handoff/openSessionHandoffPicker';
import type { SessionHandoffPickerResult } from '@/components/sessions/handoff/openSessionHandoffPicker';
import { openObservedSessionHandoffProgressModal } from '@/components/sessions/handoff/openSessionHandoffProgressModal';
import { openWorkspaceSyncConflictDetails } from '@/components/workspaces/sync/openWorkspaceSyncRelationshipDetails';
import { sync } from '@/sync/sync';
import { randomUUID } from '@/platform/randomUUID';
import { getStorage } from '@/sync/domains/state/storageStore';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import {
    actionOperationStore,
    type ActionOperationStore,
} from '@/sync/domains/actionOperations/actionOperationStore';

import {
    executeSessionHandoffAction,
    type ExecuteSessionHandoffActionResult,
} from './executeSessionHandoffAction';
import type { SessionHandoffUiAvailability } from './resolveSessionHandoffUiAvailability';

type ExecuteAction = (
    actionId: 'session.handoff',
    input: unknown,
    context?: ActionExecutorContext,
) => Promise<ActionExecuteResult>;

/**
 * The destination confirmation belongs to the Action approval corridor: the
 * target daemon inspects the exact destination and stamps one proof covering
 * replacement and exact-mirror deletion together. A picker-side prompt here
 * would ask a second time and would not be bound to what the daemon observed.
 */
export async function runSessionHandoffPickerFlow(args: Readonly<{
    execute: ExecuteAction;
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
    placement: ActionUiPlacement;
    availability?: SessionHandoffUiAvailability;
    operationStore?: Pick<ActionOperationStore, 'getSnapshot' | 'subscribe'>;
}>): Promise<ExecuteSessionHandoffActionResult | null> {
    if (args.availability?.available === false) return null;
    let closePicker = () => {};
    let setAwaitingAdmission = (_awaiting: boolean) => {};
    let setInlineError = (_code: string | null) => {};
    let isPickerOpen = () => true;
    let submitting = false;
    const runSelection = async (selection: SessionHandoffPickerResult): Promise<ExecuteSessionHandoffActionResult | null> => {
    if (submitting || !isPickerOpen()) return null;
    submitting = true;
    setAwaitingAdmission(true);
    setInlineError(null);
    const releaseUserRequestLease = sync.acquireUserRequestLease();
    const profileScope = getStorage().getState().profileScope;
    const accountId = profileScope?.serverId === args.serverId
        ? profileScope.accountId ?? ''
        : '';
    // Picking a new destination is a new submission. Reopening an already
    // admitted operation belongs to its existing Action Operation entry.
    const requestId = randomUUID();
    const workspaceSyncEnabled = selection.workspaceAction !== undefined
        && selection.workspaceAction.kind !== 'none';
    let result: ExecuteSessionHandoffActionResult | null = null;
    let progressDismissed = false;
    const openProgress = () => openObservedSessionHandoffProgressModal({
        requestId,
        sessionId: args.sessionId,
        serverId: args.serverId,
        accountId,
        workspaceSyncEnabled,
        onDismiss: () => { progressDismissed = true; if (result?.ok) closePicker(); },
        ...(selection.workspaceSyncReviewResource ? { onOpenConflicts: (blockedRelationshipId: string | null) => {
            const verifiedBlockedId = blockedRelationshipId && selection.workspaceSyncReviewRelationshipIds?.includes(blockedRelationshipId)
                ? blockedRelationshipId : null;
            openWorkspaceSyncConflictDetails({
                ...selection.workspaceSyncReviewResource!,
                ...(verifiedBlockedId ? { initialRelationshipId: verifiedBlockedId } : {}),
            });
        } } : {}),
    });
    let progressPresentation: ReturnType<typeof openObservedSessionHandoffProgressModal> | null = null;
    const currentProgress = (): ReturnType<typeof openObservedSessionHandoffProgressModal> | null => progressPresentation;
    const ensureProgress = () => {
        if (progressPresentation?.isAttached()) return progressPresentation;
        progressPresentation = openProgress();
        return progressPresentation;
    };
    const operationStore = args.operationStore ?? actionOperationStore;
    const showAdmittedProgress = () => {
        if (progressDismissed || !isPickerOpen()) return;
        if (progressPresentation?.isAttached()) return;
        const admitted = [...operationStore.getSnapshot().operationsByKey.values()].some((operation) => (
            operation.serverId === args.serverId
            && operation.snapshot.requestId === requestId
            && operation.snapshot.actionId === 'session.handoff'
            && operation.snapshot.scope.accountId === accountId
        ));
        if (admitted) {
            setAwaitingAdmission(false);
            ensureProgress();
        }
    };
    const unsubscribeAdmission = operationStore.subscribe(showAdmittedProgress);
    showAdmittedProgress();
    actionOperationPresentationCoordinator.register({
        serverId: args.serverId,
        accountId: profileScope?.serverId === args.serverId ? profileScope.accountId : '',
        requestId,
        onStart: 'current',
        origin: {
            resolve: (snapshot) => (
                snapshot.state === 'accepted' || snapshot.state === 'running'
                    ? () => {
                        progressDismissed = false;
                        const presentation = ensureProgress();
                        if (result && !result.ok) presentation.showRequestFailure(result);
                    }
                    : null
            ),
        },
    });
    try {
        result = await executeSessionHandoffAction({
            execute: args.execute,
            sessionId: args.sessionId,
            targetMachineId: selection.targetMachineId,
            ...(selection.targetPath ? { targetPath: selection.targetPath } : {}),
            targetSessionStorageMode: selection.targetSessionStorageMode,
            stateTransfer: selection.stateTransfer,
            workspaceAction: selection.workspaceAction,
            context: {
                defaultSessionId: args.sessionId,
                serverId: args.serverId,
                surface: 'ui',
                placement: args.placement,
                actionRequestId: requestId,
            },
        });
        setAwaitingAdmission(false);
        if (!result.ok && selection.stateTransfer === 'existing' && result.errorCode === 'existing_session_state_unavailable') {
            if (isPickerOpen()) setInlineError(result.errorCode);
            return result;
        }
        if (result.ok && 'kind' in result && result.kind === 'approval_required') {
            unsubscribeAdmission();
            if (!isPickerOpen()) return result;
            closePicker();
            router.push(`/inbox/approvals/${encodeURIComponent(result.artifactId)}${args.serverId
                ? `?serverId=${encodeURIComponent(args.serverId)}`
                : ''}` as never);
            return result;
        }
        showAdmittedProgress();
        if (!result.ok && !progressDismissed && isPickerOpen()) {
            ensureProgress().showRequestFailure(result);
        }
        if (result.ok && progressDismissed) closePicker();
        if (result.ok && !progressDismissed && isPickerOpen() && !currentProgress()?.isAttached()) {
            // A completed Action result proves admission even when its operation
            // projection has not reached this client yet.
            ensureProgress();
        }
        return result;
    } finally {
        unsubscribeAdmission();
        // Workspace outcomes and failures remain visible through the canonical
        // Action operation result. Only an ordinary handoff with no workspace
        // result retains the compact auto-close behavior.
        if (result?.ok && 'result' in result && result.result.workspace?.kind === 'none') {
            currentProgress()?.close();
            closePicker();
        }
        releaseUserRequestLease();
        setAwaitingAdmission(false);
        submitting = false;
    }
    };
    const selection = await openSessionHandoffPicker({
        sessionId: args.sessionId,
        sourceMachineId: args.sourceMachineId ?? null,
        serverId: args.serverId,
        retainOnSubmit: true,
        onRetained: (close, setPending, isOpen, setError) => { closePicker = close; setAwaitingAdmission = setPending; isPickerOpen = isOpen; setInlineError = setError; },
        onSubmitAgain: (next) => { void runSelection(next); },
    });
    return selection ? await runSelection(selection) : null;
}
