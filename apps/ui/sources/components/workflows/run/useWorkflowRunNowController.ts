import React from 'react';

import { WorkflowRunStartRequestV1Schema, WorkflowRunStartResultV1Schema, WorkflowRunGetResultV1Schema, type WorkflowRunStartRequestV1, type WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

import {
    resolveWorkflowProblemPresentation,
    type WorkflowProblemPresentation,
} from '@/components/workflows/presentation/workflowProblemPresentation';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import {
    useTransientCommandAcknowledgement,
    type TransientCommandState,
} from '@/hooks/ui/useTransientCommandAcknowledgement';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

import { projectAcceptedWorkflowRunTarget } from './projectAcceptedWorkflowRunTarget';

/**
 * Transient command state for one **Run now** press.
 *
 * `acknowledged` means the server accepted the admission — it is not a Run
 * state. Whether that Run is queued, running, waiting for an approval or
 * already finished is read from the canonical Run projection, never inferred
 * from this vocabulary. The machine itself is the shared transient-command
 * owner, so this press and the Automation one cannot drift apart.
 */
export type WorkflowRunNowState = TransientCommandState;

export type WorkflowRunNowRequest = Readonly<{
    /**
     * Explicit recovery identity (for example a held Plan's derived Run id).
     * Ordinary starts omit this: the controller retains their identity until
     * admission settles, independently of the composer's dismissal/reopening.
     */
    runId?: string;
    source: WorkflowRunStartRequestV1['source'];
    metadata?: WorkflowRunStartRequestV1['metadata'];
    /** Declared-input values collected by the input sheet, in the Protocol shape. */
    inputs?: WorkflowRunStartRequestV1['inputs'];
    /** Reviewed run-layer overrides; admission resolves and freezes them. */
    roleOverrides?: WorkflowRunStartRequestV1['roleOverrides'];
    /**
     * Run-wide runtime choice. Session is the protocol default and is omitted
     * on the wire so older/current callers retain the same canonical shape.
     */
    executionTarget?: WorkflowRunStartRequestV1['executionTarget'];
    onComplete?: WorkflowRunStartRequestV1['onComplete'];
    /** Exact page-selected project, stamped as host context rather than Action input. */
    project?: WorkflowProjectTargetV1;
    /**
     * The invoking session, stamped as host context `defaultSessionId`: FIN's one origin producer
     * records it as the Run's `origin.originSessionId` (`origin_session` steps, result delivery).
     */
    originSessionId?: string;
    /** Whether the pressing surface is still mounted/current, for error presentation only. */
    isInvocationCurrent?: () => boolean;
    /**
     * Where a refusal is said. A surface that keeps the reviewed composer open
     * (04 §4.8) takes it `inline` from {@link WorkflowRunNowController.refusal};
     * every other caller interrupts with the same problem as an alert.
     */
    refusal?: 'alert' | 'inline';
}>;

export type WorkflowRunNowController = Readonly<{
    /** The controller-owned ordinary admission, not an admitted Run's lifecycle. */
    pendingRunId: string | null;
    stateFor: (runId: string) => WorkflowRunNowState;
    isPending: (runId: string) => boolean;
    /**
     * Admits the reviewed draft and returns the exact admitted handle, so the
     * caller navigates to the Run the server settled rather than guessing it
     * from the newest history row. `null` means no handle is returned by this
     * call: no active Account, an admission already in flight for this id, a
     * retired Account scope, or a failure that was surfaced to the user.
     */
    runNow: (request: WorkflowRunNowRequest) => Promise<WorkflowRunStartResultV1 | null>;
    /**
     * The last `inline` refusal, as the canonical problem owner describes it.
     * The next press replaces it; `clearRefusal` drops it when the composer that
     * showed it closes.
     */
    refusal: WorkflowProblemPresentation | null;
    clearRefusal: () => void;
}>;

async function startWorkflowRun(request: WorkflowRunNowRequest & Readonly<{ runId: string }>): Promise<WorkflowRunStartResultV1> {
    const input = WorkflowRunStartRequestV1Schema.parse({
        runId: request.runId,
        source: request.source,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
        ...(request.roleOverrides === undefined ? {} : { roleOverrides: request.roleOverrides }),
        ...(request.executionTarget === undefined || request.executionTarget.kind === 'session'
            ? {}
            : { executionTarget: request.executionTarget }),
        ...(request.onComplete === undefined ? {} : { onComplete: request.onComplete }),
    });
    // Dispatch and failure mapping stay at the one shared workflow Action seam.
    const result = await callWorkflowAction({
        actionId: 'workflow.run.start',
        input,
        parseResult: (value) => WorkflowRunStartResultV1Schema.parse(value),
        fallbackMessage: 'Workflow run request failed',
        ...(request.project === undefined && request.originSessionId === undefined
            ? {}
            : { context: {
                ...(request.originSessionId === undefined ? {} : { defaultSessionId: request.originSessionId }),
                ...(request.project === undefined ? {} : { externalActionTarget: {
                    kind: 'machine' as const,
                    machineId: request.project.machineId,
                    project: projectAcceptedWorkflowRunTarget(request.project),
                } }),
            } }),
    });
    return result;
}

/** Observe the exact admitted identity; absence is still unknown after a lost reply. */
function reconcileWorkflowRunStart(runId: string, lifetime: ActiveServerAccountScopeLifetime): Promise<WorkflowRunStartResultV1> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let reading = false;
        let invalidated = false;
        let unsubscribe = () => {};
        let retirement: Readonly<{ dispose(): void }> | undefined;
        const cleanup = () => { unsubscribe(); retirement?.dispose(); };
        const retire = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' }));
        };
        const read = async () => {
            if (settled) return;
            if (!lifetime.isCurrent()) { retire(); return; }
            if (reading) { invalidated = true; return; }
            reading = true;
            invalidated = false;
            try {
                const detail = await callWorkflowAction({
                    actionId: 'workflow.run.get', input: { runId },
                    parseResult: (value) => WorkflowRunGetResultV1Schema.parse(value),
                    fallbackMessage: 'Workflow admission outcome unavailable',
                });
                if (!lifetime.isCurrent()) { retire(); return; }
                if (!settled) {
                    settled = true;
                    cleanup();
                    resolve({ run: detail.run, admission: 'existing' });
                }
            } catch {
                // run_not_found, a temporarily unavailable read, or inaccessible
                // content cannot prove that the in-flight start was rejected.
                if (!lifetime.isCurrent()) retire();
            } finally {
                reading = false;
                // A wake during the read must not be lost. This is feed-driven,
                // never a timer or a retry loop on an unchanged missing row.
                if (invalidated && !settled) void read();
            }
        };
        unsubscribe = subscribeVisibleWorkflowRunListInvalidation({
            lifetime, runId, isVisibleWindowLoaded: () => true, invalidate: () => { void read(); },
        });
        retirement = lifetime.onRetire(retire);
        if (settled) cleanup();
        else void read();
    });
}

/**
 * The UI admission owner for `workflow.run.start`.
 *
 * It owns one thing: turning an explicit press into exactly one canonical
 * admission and handing back the Run the server settled. The admitted body is
 * merged into the existing Account-scoped Run row map so the exact route can
 * open it immediately; this controller keeps no Run cache, no polling and no
 * Run-state interpretation of its own.
 */
export function useWorkflowRunNowController(): WorkflowRunNowController {
    const command = useTransientCommandAcknowledgement<WorkflowRunStartResultV1>('workflow.runNow');
    type OwnedAdmission = Readonly<{ runId: string; lifetime: ActiveServerAccountScopeLifetime }>;
    const ownedRef = React.useRef<OwnedAdmission | null>(null);
    const [owned, setOwned] = React.useState<OwnedAdmission | null>(null);
    const [refusal, setRefusal] = React.useState<WorkflowProblemPresentation | null>(null);
    const clearRefusal = React.useCallback(() => setRefusal(null), []);

    return React.useMemo(() => ({
        pendingRunId: owned?.lifetime.isCurrent() ? owned.runId : null,
        stateFor: command.stateFor,
        isPending: (runId) => {
            const state = command.stateFor(runId);
            return state === 'submitting' || state === 'reconciling';
        },
        // A second press while the first is still unsettled is the same intent,
        // not a second Run: the identical `runId` is already in flight.
        refusal,
        clearRefusal,
        runNow: async (request) => {
            setRefusal(null);
            let admission: OwnedAdmission | null = null;
            if (request.runId === undefined) {
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (lifetime === null) return null;
                admission = ownedRef.current?.lifetime.isCurrent() ? ownedRef.current : { runId: randomUUID(), lifetime };
                ownedRef.current = admission;
                setOwned(admission);
            }
            const runId = request.runId ?? admission?.runId;
            if (runId === undefined) return null;
            const result = await command.run({
                commandId: runId,
                submit: () => startWorkflowRun({ ...request, runId }),
                recoverUnknownOutcome: {
                    isUnknown: (error) => error instanceof WorkflowActionError && error.code === 'workflow_outcome_unresolved',
                    reconcile: (lifetime) => reconcileWorkflowRunStart(runId, lifetime),
                },
                // Merged into the existing Account-scoped Run row map only while
                // the pressing Account is still active, so the exact route can open
                // the settled Run immediately.
                onAccepted: (result) => {
                    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                        result.run,
                        request.metadata ? { kind: 'available', value: request.metadata } : null,
                    )]);
                },
                ...(request.isInvocationCurrent
                    ? { isInvocationCurrent: request.isInvocationCurrent }
                    : {}),
                onError: async (error) => {
                    // The Automation formatter knows no workflow code, so every
                    // admission refusal — no access, a conflicting rejoin, a
                    // definition that needs repair — read as one generic sentence.
                    const problem = resolveWorkflowProblemPresentation(error);
                    if (request.refusal === 'inline') setRefusal(problem);
                    else await Modal.alert(problem.title, problem.message);
                },
            });
            const state = command.stateFor(runId);
            // A duplicate press returns null while the first is still pending;
            // only a settled result/refusal or retired scope releases its id.
            if (admission !== null && ownedRef.current === admission && state !== 'submitting' && state !== 'reconciling') {
                ownedRef.current = null;
                setOwned(null);
            }
            return result;
        },
    }), [clearRefusal, command, owned, refusal]);
}
