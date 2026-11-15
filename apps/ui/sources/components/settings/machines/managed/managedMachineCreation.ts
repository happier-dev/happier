import {
    ManagedAcquireInputV1Schema,
    ManagedMachineActionOutputSchemasV1,
    type ManagedAcceptedV1,
    type ManagedAcquireInputV1,
    type ManagedMachineActionIdV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ManagedMachineV1, ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedAcquireAgentStartV1 } from '@happier-dev/protocol/machines/managed/agentStartV1';
import type { SessionAgentUpdateNoticeV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1, type ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import {
    isDeferredManagedMachineAuthorPresetDraft,
    type ManagedMachineAcquisitionDraft,
    type ManagedMachineCreationIntent,
} from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { openManagedMachineReadSnapshots } from '@/sync/ops/machines/machinePresetCollectionClient';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode, homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { managedCreationSetup } from '@/components/settings/machines/managed/managedCreationPresentation';
import { buildReviewedManagedMachineDeleteInput, qualifyManagedMachineDeleteReview } from '@/components/settings/machines/managed/managedMachineDeleteReview';
import { supportedMachineRetentionEffectsV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { prepareMachineSetupPresetApplyInput } from './machineSetupApply';
import { managedMachineOperationMatchesResource, readManagedInstallationPromptSnapshot } from '@/sync/domains/actionOperations/managedMachineOperation';
import { answerManagedCreationEstablish, answerManagedCreationPrompt } from './managedCreationPrompt';
import { describeManagedActionFailureDiagnostic } from './managedNativeFailurePresentation';

export type ManagedMachineCreationProgress =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'approval' }>
    | Readonly<{ kind: 'acquiring'; managedId?: string; operation?: ActionOperationSnapshotV1; operationObservation?: ActionOperationObservation }>
    | Readonly<{ kind: 'enrollment_pending'; managedId: string }>
    | Readonly<{ kind: 'setup_pending'; managedId: string; machineId: string; state: 'pending' | 'running';
        machineSetup: NonNullable<ManagedMachineV1['machineSetup']>; operation?: ActionOperationSnapshotV1 }>
    | Readonly<{ kind: 'ready'; managedId: string; machineId: string }>
    | Readonly<{ kind: 'failed'; code: string; diagnosticDetail?: string; managedId?: string; operation?: ActionOperationSnapshotV1;
        operationObservation?: ActionOperationObservation; retryInstallationAvailable?: boolean;
        machineSetup?: NonNullable<ManagedMachineV1['machineSetup']>; retrySetupAvailable?: boolean }>;

export type ManagedMachineCreationResult =
    | Readonly<{ kind: 'enrolled'; machine: ManagedMachineV1 & { enrolledMachineId: string }; agentUpdate?: SessionAgentUpdateNoticeV1 }>
    | Readonly<{ kind: 'pending'; managedId: string }>
    | Readonly<{ kind: 'delete_requested'; managedId: string }>
    | Readonly<{ kind: 'failed'; code: string; agentStartFailure?: Extract<
        NonNullable<NonNullable<ActionOperationSnapshotV1['error']>['details']>, { kind: 'managedAgentStart' }
    > }>;

type ManagedMachineCreationDraft = ManagedMachineCreationIntent & Readonly<{
    archiveEffect?: 'keep' | 'stop' | 'delete';
}>;

/** Receipt fields disclose consequences; only the strict reviewed effect enters admission. */
export function buildManagedMachineAcquireInput(
    draft: ManagedMachineCreationDraft,
    agentStart?: ManagedAcquireAgentStartV1,
): ManagedAcquireInputV1 | null {
    const common = {
        ...(draft.archiveEffect && draft.archiveEffect !== 'keep' ? { creationScopeRetention: { effect: draft.archiveEffect } } : {}),
        ...(agentStart ? { agentStart } : {}),
    };
    const candidate = isDeferredManagedMachineAuthorPresetDraft(draft)
        ? { ...common, selection: draft.selection, controller: draft.presetOrigin.controller,
            ...(draft.presetOrigin.retention ? { retention: draft.presetOrigin.retention } : {}),
            ...(draft.presetOrigin.wakeOnAcceptedMessage !== undefined ? { wakeOnAcceptedMessage: draft.presetOrigin.wakeOnAcceptedMessage } : {}),
            presetContentOverride: draft.presetContentOverride }
        : draft.selection.kind === 'one-off'
            ? draft.enrollmentIdentity ? { ...common, selection: draft.selection, reviewedFacts: draft.receipt,
                enrollmentIdentity: draft.enrollmentIdentity } : null
            : draft.presetContentOverride ? { ...common, selection: draft.selection, controller: draft.receipt.controller,
                retention: draft.receipt.retention, wakeOnAcceptedMessage: draft.receipt.wakeOnAcceptedMessage,
                presetContentOverride: draft.presetContentOverride } : null;
    const parsed = candidate && ManagedAcquireInputV1Schema.safeParse(candidate);
    return parsed?.success ? parsed.data : null;
}

export function isManagedMachineEnrollmentRequester(
    machine: Pick<ManagedMachineReadSnapshotV1, 'enrollmentAccountId' | 'custodianAccountId'>,
    accountId: string | undefined,
): boolean {
    return accountId !== undefined && machine.enrollmentAccountId === accountId && machine.custodianAccountId !== accountId;
}

/** Admitted Create already includes signing the guest into the requester's Account. */
export function approveManagedMachineEnrollment<T>(input: Readonly<{
    prompt: Extract<ManagedMachineBootstrapPromptV1, { kind: 'auth.approveRemoteProvisioning' }>;
    correlation: Readonly<{ homeId: string; managedId: string; serverId: string; operationId: string; taskId: string }>;
    respond: (input: Readonly<{ homeId: string; managedId: string; serverId: string; operationId: string; taskId: string;
        purpose: 'approve'; prompt: Extract<ManagedMachineBootstrapPromptV1, { kind: 'auth.approveRemoteProvisioning' }>; approved: true }>) => Promise<T>;
}>): Promise<T> {
    return input.respond({ ...input.correlation, purpose: 'approve', prompt: input.prompt, approved: true });
}

/** Explicit Run/Send joins managed creation, then reads the actual enrolled target. */
export async function runManagedMachineCreation(input: Readonly<{
    draft: ManagedMachineCreationDraft;
    acquisition: ManagedMachineAcquisitionDraft;
    agentStart?: ManagedAcquireAgentStartV1;
    teamCredentialPresentation?: ActionExecutorContext['teamCredentialPresentation'];
    scope: ServerAccountScope;
    signal: AbortSignal;
    isCurrent: () => boolean;
    retryInstallation?: boolean;
    setupRecovery?: 'retry' | 'skip' | 'delete';
    reviewDelete?: (census: MachineReferenceCensusV1) => Promise<boolean>;
    onAcquisitionChange: (value: ManagedMachineAcquisitionDraft) => void;
    onProgress: (value: ManagedMachineCreationProgress) => void;
    onApprovalPending: (value: ActionApprovalRegistration) => void;
    executeAction?: FrontDoorActionExecute;
}>): Promise<ManagedMachineCreationResult> {
    const execute = input.executeAction ?? createFrontDoorActionExecute();
    let acquisition = input.acquisition;
    let observedOperation: ActionOperationSnapshotV1 | undefined;
    let agentUpdate: SessionAgentUpdateNoticeV1 | undefined;
    let setupMachine: ManagedMachineV1 | undefined;
    const fail = (code: string, retryInstallationAvailable?: boolean, diagnosticDetail?: string, failure?: ActionExecuteFailure): ManagedMachineCreationResult => {
        diagnosticDetail ??= failure ? describeManagedActionFailureDiagnostic(code, failure.details, failure.requestId, failure.failureCause) : undefined;
        const setup = setupMachine ? managedCreationSetup(setupMachine) : null;
        if (input.isCurrent()) input.onProgress({ kind: 'failed', code,
            ...(diagnosticDetail ? { diagnosticDetail } : {}),
            ...(acquisition.managedId ? { managedId: acquisition.managedId } : {}),
            ...(observedOperation ? { operation: observedOperation } : {}),
            ...(retryInstallationAvailable !== undefined ? { retryInstallationAvailable } : {}),
            ...(setup ? { machineSetup: setupMachine!.machineSetup,
                retrySetupAvailable: setup.recoveryActions.includes('retrySetup') } : {}),
        });
        const details = observedOperation?.error?.details;
        return { kind: 'failed', code,
            ...(details && 'kind' in details && details.kind === 'managedAgentStart' ? { agentStartFailure: details } : {}),
        };
    };
    const current = () => input.isCurrent() && !input.signal.aborted;
    if (!current()) return fail('continuation_retired');
    if (!sameStrictJsonValue(acquisition.selection, input.draft.selection)) return fail('request_conflict');
    const deferredAuthorPreset = isDeferredManagedMachineAuthorPresetDraft(input.draft);
    if (!deferredAuthorPreset) {
        if (input.draft.archiveEffect && input.draft.archiveEffect !== 'keep'
            && !supportedMachineRetentionEffectsV1(input.draft.receipt.retentionCapabilities.supportedIntents).includes(input.draft.archiveEffect)) {
            return fail('native_intent_unsupported');
        }
        if (!acquisition.managedId && (input.draft.receipt.optionStatus !== 'current'
            || input.draft.receipt.prerequisites.some(item => item.status === 'unavailable'))) return fail('review_required');
    }
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
        teamCredentialPresentation: input.teamCredentialPresentation,
        serverId: input.scope.serverId, expectedAccountId: input.scope.accountId, signal: input.signal };
    let controller = deferredAuthorPreset ? input.draft.presetOrigin.controller : input.draft.receipt.controller;
    const withActionDispatch = (dispatch: FrontDoorActionExecute['confirmed']) => async (actionId: ManagedMachineActionIdV1 | 'machines.managed.bootstrap.respond', actionInput: unknown, nativeTarget?: string) =>
        awaitActionApprovalResult<unknown, { kind: 'completed'; value: unknown } | { kind: 'failed'; code: string; failure?: ActionExecuteFailure }>({
            signal: input.signal,
            execute: async callbacks => {
                const result = await dispatch(actionId, actionInput, {
                    ...context, ...(nativeTarget ? { executionRunTargetMachineId: nativeTarget } : {}),
                });
                const outcome = classifyHomeActionOutcome(result);
                if (outcome.kind === 'failed') return { kind: 'failed' as const, code: homeDomainFailureCode(outcome.failure),
                    ...(result.ok ? {} : { failure: result }) };
                if (outcome.kind === 'approval_pending') {
                    input.onApprovalPending(createActionApprovalContinuation<unknown, typeof actionId>({
                        artifactId: outcome.artifactId, actionId, scope: input.scope, expectedInput: actionInput,
                        signal: input.signal, onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                    }));
                    return { approvalPending: true };
                }
                return { kind: 'completed' as const, value: outcome.result };
            },
            succeeded: value => ({ kind: 'completed', value }), failed: (code, failure) => ({ kind: 'failed', code, ...(failure ? { failure } : {}) }),
            aborted: () => ({ kind: 'failed', code: 'continuation_retired' }),
        });
    const executeApproved = withActionDispatch(execute);
    const executeConfirmed = withActionDispatch(execute.confirmed);
    let readFailureCode = 'managed_read_failed';
    let readFailure: ActionExecuteFailure | undefined;
    const read = async (): Promise<ManagedMachineV1 | null> => {
        if (!acquisition.managedId || !current()) return null;
        const result = await execute('machines.managed.get', { homeId: acquisition.selection.homeId, managedId: acquisition.managedId }, context);
        if (!current()) return null;
        const outcome = classifyHomeActionOutcome(result);
        readFailure = result.ok ? undefined : result;
        if (outcome.kind !== 'completed') {
            readFailureCode = outcome.kind === 'failed' ? homeDomainFailureCode(outcome.failure) : 'approval_required';
            return null;
        }
        const parsed = ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(outcome.result);
        const [machine] = await openManagedMachineReadSnapshots(input.scope, [parsed], input.signal);
        if (!current()) return null;
        if (!machine || machine.id !== acquisition.managedId || machine.homeId !== acquisition.selection.homeId
            || controller && !sameStrictJsonValue(machine.controller, controller)) { readFailureCode = 'managed_response_invalid'; return null; }
        return machine;
    };
    const alreadyAdmitted = acquisition.managedId ? await read() : null;
    if (!current()) return fail('continuation_retired');
    if (acquisition.managedId && !alreadyAdmitted) return fail(readFailureCode, undefined, undefined, readFailure);
    if (alreadyAdmitted?.creationState !== undefined && alreadyAdmitted.creationState !== 'active') return fail('enrollment_retired');
    if (!alreadyAdmitted?.enrolledMachineId && (!acquisition.managedId || input.retryInstallation)) {
        if (input.retryInstallation && (!alreadyAdmitted?.resource || alreadyAdmitted.allocation !== 'bound')) return fail('installation_retry_unavailable');
        const actionId = input.retryInstallation ? 'machines.managed.bootstrap.retry' as const : 'machines.managed.acquire' as const;
        const actionInput = input.retryInstallation && alreadyAdmitted
            ? { homeId: alreadyAdmitted.homeId, managedId: alreadyAdmitted.id, expectedIntentRevision: alreadyAdmitted.intentRevision }
            : buildManagedMachineAcquireInput(input.draft, input.agentStart);
        if (!actionInput) return fail('content_unavailable');
        const accepted = await awaitActionApprovalResult<ManagedAcceptedV1, { kind: 'accepted'; value: ManagedAcceptedV1 } | { kind: 'failed'; code: string; diagnosticDetail?: string }>({
            signal: input.signal,
            execute: async callbacks => {
                input.onProgress({ kind: 'acquiring', ...(acquisition.managedId ? { managedId: acquisition.managedId } : {}) });
                // New's Send/Run confirms this reviewed creation. Retain that
                // confirmation rather than dropping it before Account dispatch.
                const dispatch = input.retryInstallation ? execute : execute.confirmed;
                const result = await dispatch(actionId, actionInput, {
                    ...context, actionRequestId: input.retryInstallation ? `${acquisition.requestId}:bootstrap:${alreadyAdmitted?.intentRevision}` : acquisition.requestId,
                    ...(actionId === 'machines.managed.acquire' && input.draft.presetOrigin
                        ? { managedPresetOrigin: input.draft.presetOrigin } : {}),
                    ...(controller ? { executionRunTargetMachineId: controller.machineId } : {}),
                });
                const outcome = classifyHomeActionOutcome(result);
                if (outcome.kind === 'failed') {
                    const code = homeDomainFailureCode(outcome.failure);
                    return { kind: 'failed' as const, code, diagnosticDetail: describeManagedActionFailureDiagnostic(code,
                        result.ok ? undefined : result.details, result.ok ? acquisition.requestId : result.requestId ?? acquisition.requestId,
                        result.ok ? undefined : result.failureCause) };
                }
                if (outcome.kind === 'approval_pending') {
                    input.onProgress({ kind: 'approval' });
                    input.onApprovalPending(createActionApprovalContinuation<ManagedAcceptedV1, typeof actionId>({
                        artifactId: outcome.artifactId, actionId, scope: input.scope, expectedInput: actionInput,
                        signal: input.signal, onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                    }));
                    return { approvalPending: true };
                }
                return { kind: 'accepted' as const, value: ManagedMachineActionOutputSchemasV1[actionId].parse(outcome.result) };
            },
            succeeded: value => ({ kind: 'accepted', value }), failed: (code, failure) => ({ kind: 'failed', code,
                diagnosticDetail: describeManagedActionFailureDiagnostic(code, failure?.details, failure?.requestId ?? acquisition.requestId, failure?.failureCause) }),
            aborted: () => ({ kind: 'failed', code: 'continuation_retired' }),
        });
        if (accepted.kind === 'failed') return fail(accepted.code, undefined, accepted.diagnosticDetail);
        if (acquisition.managedId && acquisition.managedId !== accepted.value.managedId) return fail('resource_mismatch');
        acquisition = { ...acquisition, managedId: accepted.value.managedId, operation: accepted.value.operation };
        // A retired draft must not write the accepted row into its replacement.
        // The admitted Account row remains the paid-resource recovery authority.
        if (current()) input.onAcquisitionChange(acquisition);
    }
    if (!current()) return fail('continuation_retired');
    let operationFailure: string | null = null;
    const awaitingSetupWithoutGuestOperation = alreadyAdmitted?.machineSetup
        && (alreadyAdmitted.machineSetup.state === 'pending' || alreadyAdmitted.machineSetup.state === 'running')
        && !alreadyAdmitted.machineSetup.operation;
    // Pool selection binds the controller at admission. Continue from that exact
    // admitted row rather than selecting again or requiring a controller grant.
    const scopedMachine = alreadyAdmitted ?? (acquisition.operation && acquisition.selection.kind === 'preset' ? await read() : null);
    if (!current()) return fail('continuation_retired');
    if (acquisition.operation && acquisition.selection.kind === 'preset' && !scopedMachine) return fail(readFailureCode, undefined, undefined, readFailure);
    controller ??= scopedMachine?.controller;
    let machine: ManagedMachineV1 | null = null;
    if (controller && acquisition.operation && (!alreadyAdmitted?.enrolledMachineId || awaitingSetupWithoutGuestOperation)) {
        let requesterMachine = scopedMachine && isManagedMachineEnrollmentRequester(scopedMachine, input.scope.accountId) ? scopedMachine : null;
        input.onProgress({ kind: 'acquiring', managedId: acquisition.managedId });
        while (current()) {
            const result = await execute('action.operations.get', { serverId: input.scope.serverId, machineId: controller.machineId,
                ...(requesterMachine ? { managed: { homeId: requesterMachine.homeId, managedId: requesterMachine.id }, includeManagedPrompt: true } : {}),
                ...acquisition.operation, waitForTerminal: true }, context);
            if (!current()) return fail('continuation_retired');
            const outcome = classifyHomeActionOutcome(result);
            if (outcome.kind !== 'completed') return fail(outcome.kind === 'failed' ? homeDomainFailureCode(outcome.failure) : 'approval_required',
                undefined, undefined, result.ok ? undefined : result);
            const found = ActionOperationGetV1ResponseSchema.parse(outcome.result);
            if (found.kind === 'not_found') return fail('operation_not_found');
            if (found.operation.operationId !== acquisition.operation.operationId || found.operation.scope.machineId !== controller.machineId
                || found.operation.scope.accountId !== input.scope.accountId) return fail('operation_scope_mismatch');
            if (requesterMachine) {
                // Allocation can advance while the operation waits. Correlate its
                // resource with the current row, not the row read at admission.
                machine = await read();
                if (!current()) return fail('continuation_retired');
                if (!machine) return fail(readFailureCode, undefined, undefined, readFailure);
                if (!managedMachineOperationMatchesResource(machine, found.operation)) return fail('operation_scope_mismatch');
                requesterMachine = machine;
            }
            observedOperation = found.operation;
            if (found.operation.domainRef?.kind === 'managedMachine') agentUpdate = found.operation.domainRef.agentUpdate;
            input.onProgress({ kind: 'acquiring', managedId: acquisition.managedId, operation: found.operation });
            const question = requesterMachine ? readManagedInstallationPromptSnapshot(found.operation) : null;
            if (requesterMachine && question) {
                const { taskId, ...prompt } = question;
                const resource = { homeId: requesterMachine.homeId, managedId: requesterMachine.id };
                const expectedIntentRevision = requesterMachine.intentRevision;
                const correlation = { ...resource, serverId: input.scope.serverId, operationId: found.operation.operationId, taskId };
                const answered = prompt.kind === 'administrator.establish'
                    ? await answerManagedCreationEstablish({ prompt, isCurrent: current,
                        respond: password => executeApproved('machines.managed.bootstrap.respond', {
                            ...correlation, purpose: 'establish', promptId: prompt.promptId, password }),
                        // No answer means no administrator, so the paid creation is cancelled through its own Action.
                        decline: () => executeConfirmed('machines.managed.cancel', { ...resource,
                            expectedIntentRevision }),
                    })
                    : prompt.kind === 'auth.approveRemoteProvisioning'
                    ? await approveManagedMachineEnrollment({ prompt, correlation,
                        respond: answer => executeApproved('machines.managed.bootstrap.respond', answer) })
                    : await answerManagedCreationPrompt({ prompt, isCurrent: current,
                        respond: approved => executeApproved('machines.managed.bootstrap.respond', {
                            ...correlation, purpose: 'approve', prompt, approved }),
                    });
                if (!current()) return fail('continuation_retired');
                if (answered.kind === 'failed') return fail(answered.code, undefined, undefined, answered.failure);
                // Only a delivered answer advances the existing event-backed wait.
                continue;
            }
            if (found.operation.state === 'accepted' || found.operation.state === 'running') {
                return acquisition.managedId ? { kind: 'pending', managedId: acquisition.managedId } : fail('managed_response_invalid');
            }
            operationFailure = found.operation.state === 'failed' ? found.operation.error?.errorCode ?? 'installation_failed'
                : found.operation.state === 'cancelled' ? 'creation_canceled' : null;
            break;
        }
    }
    machine ??= await read();
    if (!current()) return fail('continuation_retired');
    if (!machine) return fail(readFailureCode, undefined, undefined, readFailure);
    if (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent') return fail('enrollment_retired');
    setupMachine = machine;
    if (operationFailure) return fail(machine.machineSetup?.state === 'failed' ? machine.machineSetup.errorCode ?? operationFailure : operationFailure,
        Boolean(!machine.enrolledMachineId && machine.resource && machine.allocation === 'bound'));
    if (!machine.enrolledMachineId) {
        input.onProgress({ kind: 'enrollment_pending', managedId: machine.id });
        return { kind: 'pending', managedId: machine.id };
    }
    setupMachine = machine;
    const enrolledMachineId = machine.enrolledMachineId;
    let setup = managedCreationSetup(machine);
    if (input.setupRecovery === 'delete') {
        if (!setup?.recoveryActions.includes('delete')) return fail('setup_recovery_unavailable');
        const census = await executeApproved('machines.managed.references.get', { homeId: machine.homeId, managedId: machine.id });
        if (!current()) return fail('continuation_retired');
        if (census.kind === 'failed') return fail(census.code, undefined, undefined, census.failure);
        const review = qualifyManagedMachineDeleteReview(machine, census.value);
        if (!review) return fail('managed_response_invalid');
        if (!input.reviewDelete) return fail('review_required');
        const confirmed = await input.reviewDelete(review.census);
        if (!current()) return fail('continuation_retired');
        if (!confirmed) return fail(setup.errorCode ?? 'setup_failed');
        const currentMachine = await read();
        if (!current()) return fail('continuation_retired');
        if (!currentMachine) return fail(readFailureCode, undefined, undefined, readFailure);
        const deleteInput = buildReviewedManagedMachineDeleteInput(currentMachine, review);
        if (!deleteInput) return fail('intent_changed');
        const deleted = await executeConfirmed('machines.managed.delete', deleteInput, currentMachine.controller?.machineId);
        if (!current()) return fail('continuation_retired');
        if (deleted.kind === 'failed') return fail(deleted.code, undefined, undefined, deleted.failure);
        const result = ManagedMachineActionOutputSchemasV1['machines.managed.delete'].parse(deleted.value);
        if (result.kind === 'conflict') return fail('intent_changed');
        if (result.kind === 'refused') return fail(result.code);
        if (result.managedId !== machine.id) return fail('managed_response_invalid');
        input.onProgress({ kind: 'idle' });
        return { kind: 'delete_requested', managedId: machine.id };
    }
    if (input.setupRecovery) {
        if (!setup?.recoveryActions.includes(input.setupRecovery === 'retry' ? 'retrySetup' : 'continueWithoutSetup')) {
            return fail('setup_recovery_unavailable');
        }
        const actionId = input.setupRecovery === 'retry' ? 'machines.setup.apply' as const : 'machines.managed.setup.skip' as const;
        let actionInput: unknown = { homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision };
        if (input.setupRecovery === 'retry') {
            if (!machine.preset || !machine.machineSetup) return fail('setup_recovery_unavailable');
            const prepared = await prepareMachineSetupPresetApplyInput({ executeAction: execute, context,
                homeId: machine.homeId, machineId: enrolledMachineId,
                preset: { ...machine.preset, setup: machine.machineSetup.setup }, isCurrent: current });
            if (!current()) return fail('continuation_retired');
            if (!prepared) {
                input.onProgress({ kind: 'idle' });
                return { kind: 'pending', managedId: machine.id };
            }
            if (!prepared.ok) return fail(homeDomainFailureCode(homeDomainFailureFromActionFailure(prepared)), undefined, undefined, prepared);
            actionInput = prepared.input;
        }
        const result = await executeApproved(actionId, actionInput);
        if (!current()) return fail('continuation_retired');
        if (result.kind === 'failed') return fail(result.code, undefined, undefined, result.failure);
        const setupResult = ManagedMachineActionOutputSchemasV1[actionId].parse(result.value);
        if ('operationId' in setupResult) {
            const acceptedOperation = { operationId: setupResult.operationId };
            const observed = await read();
            if (!current()) return fail('continuation_retired');
            if (!observed) return fail(readFailureCode, undefined, undefined, readFailure);
            if (observed.creationState !== 'active' || observed.allocation === 'confirmed-absent'
                || observed.enrolledMachineId !== enrolledMachineId) return fail('enrollment_retired');
            machine = observed;
            setupMachine = machine;
            const observedSetup = managedCreationSetup(machine);
            if (!observedSetup) return fail('managed_response_invalid');
            // The accepted reference selects the wait; only the actual row establishes its stage.
            setup = { ...observedSetup, operation: acceptedOperation };
        }
    }
    if (setup?.operation && setup.state !== 'succeeded' && setup.state !== 'skipped'
        && (setup.state !== 'failed' || input.setupRecovery === 'retry')) {
        if (setup.state === 'pending' || setup.state === 'running') {
            input.onProgress({ kind: 'setup_pending', managedId: machine.id, machineId: enrolledMachineId,
                state: setup.state, machineSetup: machine.machineSetup! });
        }
        const result = await execute('action.operations.get', {
            serverId: input.scope.serverId, machineId: enrolledMachineId, ...setup.operation, waitForTerminal: true,
        }, context);
        const outcome = classifyHomeActionOutcome(result);
        if (!current()) return fail('continuation_retired');
        if (outcome.kind !== 'completed') return fail(outcome.kind === 'failed' ? homeDomainFailureCode(outcome.failure) : 'approval_required',
            undefined, undefined, result.ok ? undefined : result);
        const found = ActionOperationGetV1ResponseSchema.parse(outcome.result);
        if (found.kind === 'not_found') return fail('operation_not_found');
        if (found.operation.operationId !== setup.operation.operationId || found.operation.scope.machineId !== enrolledMachineId
            || found.operation.scope.accountId !== input.scope.accountId) return fail('operation_scope_mismatch');
        observedOperation = found.operation;
    }
    if (input.setupRecovery || setup?.operation) {
        machine = await read();
        if (!current()) return fail('continuation_retired');
        if (!machine) return fail(readFailureCode, undefined, undefined, readFailure);
        if (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent'
            || machine.enrolledMachineId !== enrolledMachineId) return fail('enrollment_retired');
        setupMachine = machine;
        setup = managedCreationSetup(machine);
    }
    if (setup?.state === 'failed') return fail(setup.errorCode ?? 'setup_failed');
    if (setup?.state === 'pending' || setup?.state === 'running') {
        input.onProgress({ kind: 'setup_pending', managedId: machine.id, machineId: enrolledMachineId,
            state: setup.state, machineSetup: machine.machineSetup!, ...(observedOperation ? { operation: observedOperation } : {}) });
        return { kind: 'pending', managedId: machine.id };
    }
    input.onProgress({ kind: 'ready', managedId: machine.id, machineId: enrolledMachineId });
    return { kind: 'enrolled', machine: { ...machine, enrolledMachineId }, ...(agentUpdate ? { agentUpdate } : {}) };
}
