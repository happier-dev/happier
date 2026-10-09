import {
    ManagedAcquireInputV1Schema,
    ManagedMachineActionOutputSchemasV1,
    type ManagedAcceptedV1,
    type ManagedAcquireInputV1,
    type ManagedMachineActionIdV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type { ManagedMachineSelectionDraft, ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { managedCreationSetup } from '@/components/settings/machines/managed/managedCreationPresentation';
import { buildReviewedManagedMachineDeleteInput, qualifyManagedMachineDeleteReview } from '@/components/settings/machines/managed/managedMachineDeleteReview';

export type ManagedMachineCreationProgress =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'approval' }>
    | Readonly<{ kind: 'acquiring'; managedId?: string; operation?: ActionOperationSnapshotV1; operationObservation?: ActionOperationObservation }>
    | Readonly<{ kind: 'enrollment_pending'; managedId: string }>
    | Readonly<{ kind: 'setup_pending'; managedId: string; machineId: string; state: 'pending' | 'running';
        environmentSetup: NonNullable<ManagedMachineV1['environmentSetup']>; operation?: ActionOperationSnapshotV1 }>
    | Readonly<{ kind: 'ready'; managedId: string; machineId: string }>
    | Readonly<{ kind: 'failed'; code: string; managedId?: string; operation?: ActionOperationSnapshotV1;
        operationObservation?: ActionOperationObservation; retryInstallationAvailable?: boolean;
        environmentSetup?: NonNullable<ManagedMachineV1['environmentSetup']>; retrySetupAvailable?: boolean }>;

export type NewSessionManagedCreationResult =
    | Readonly<{ kind: 'enrolled'; machine: ManagedMachineV1 & { enrolledMachineId: string } }>
    | Readonly<{ kind: 'pending'; managedId: string }>
    | Readonly<{ kind: 'delete_requested'; managedId: string }>
    | Readonly<{ kind: 'failed'; code: string }>;

/** Receipt fields disclose consequences; only the strict reviewed effect enters admission. */
export function buildNewSessionManagedAcquireInput(draft: ManagedMachineSelectionDraft): ManagedAcquireInputV1 {
    return ManagedAcquireInputV1Schema.parse(draft.selection.kind === 'one-off'
        ? { selection: draft.selection, reviewedFacts: draft.receipt }
        : { selection: draft.selection, controller: draft.receipt.controller,
            retention: draft.receipt.retention, wakeOnAcceptedMessage: draft.receipt.wakeOnAcceptedMessage,
            reviewedFacts: draft.receipt });
}

/** Explicit Send joins the admitted controller operation, then reads the actual enrolled target. */
export async function runNewSessionManagedCreation(input: Readonly<{
    draft: ManagedMachineSelectionDraft;
    acquisition: ManagedMachineAcquisitionDraft;
    scope: ServerAccountScope;
    signal: AbortSignal;
    isCurrent: () => boolean;
    retryInstallation?: boolean;
    setupRecovery?: 'retry' | 'skip' | 'delete';
    reviewDelete?: (census: MachineReferenceCensusV1) => Promise<boolean>;
    onAcquisitionChange: (value: ManagedMachineAcquisitionDraft) => void;
    onProgress: (value: ManagedMachineCreationProgress) => void;
    onApprovalPending: (value: ActionApprovalRegistration) => void;
    executeAction?: ReturnType<typeof createFrontDoorActionExecute>;
}>): Promise<NewSessionManagedCreationResult> {
    const execute = input.executeAction ?? createFrontDoorActionExecute();
    let acquisition = input.acquisition;
    let observedOperation: ActionOperationSnapshotV1 | undefined;
    let setupMachine: ManagedMachineV1 | undefined;
    const fail = (code: string, retryInstallationAvailable?: boolean): NewSessionManagedCreationResult => {
        const setup = setupMachine ? managedCreationSetup(setupMachine) : null;
        if (input.isCurrent()) input.onProgress({ kind: 'failed', code,
            ...(acquisition.managedId ? { managedId: acquisition.managedId } : {}),
            ...(observedOperation ? { operation: observedOperation } : {}),
            ...(retryInstallationAvailable !== undefined ? { retryInstallationAvailable } : {}),
            ...(setup ? { environmentSetup: setupMachine!.environmentSetup,
                retrySetupAvailable: setup.recoveryActions.includes('retrySetup') } : {}),
        });
        return { kind: 'failed', code };
    };
    const current = () => input.isCurrent() && !input.signal.aborted;
    if (!current()) return fail('continuation_retired');
    if (!sameStrictJsonValue(acquisition.selection, input.draft.selection)) return fail('request_conflict');
    if (input.draft.archiveEffect !== 'keep' && !input.draft.receipt.retentionCapabilities.supportedIntents.includes(input.draft.archiveEffect)) {
        return fail('native_intent_unsupported');
    }
    if (!acquisition.managedId && (input.draft.receipt.optionStatus !== 'current'
        || input.draft.receipt.prerequisites.some(item => item.status !== 'available'))) return fail('review_required');
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
        serverId: input.scope.serverId, expectedAccountId: input.scope.accountId, signal: input.signal };
    const controller = input.draft.receipt.controller;
    const executeApproved = async (actionId: ManagedMachineActionIdV1, actionInput: unknown, nativeTarget?: string) =>
        awaitActionApprovalResult<unknown, { kind: 'completed'; value: unknown } | { kind: 'failed'; code: string }>({
            signal: input.signal,
            execute: async callbacks => {
                const outcome = classifyHomeActionOutcome(await execute(actionId, actionInput, {
                    ...context, ...(nativeTarget ? { executionRunTargetMachineId: nativeTarget } : {}),
                }));
                if (outcome.kind === 'failed') return { kind: 'failed' as const, code: homeDomainFailureCode(outcome.failure) };
                if (outcome.kind === 'approval_pending') {
                    input.onApprovalPending(createActionApprovalContinuation<unknown, typeof actionId>({
                        artifactId: outcome.artifactId, actionId, scope: input.scope, expectedInput: actionInput,
                        signal: input.signal, onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                    }));
                    return { approvalPending: true };
                }
                return { kind: 'completed' as const, value: outcome.result };
            },
            succeeded: value => ({ kind: 'completed', value }), failed: code => ({ kind: 'failed', code }),
            aborted: () => ({ kind: 'failed', code: 'continuation_retired' }),
        });
    const read = async (): Promise<ManagedMachineV1 | null> => {
        if (!acquisition.managedId || !current()) return null;
        const result = await execute('machines.managed.get', { homeId: acquisition.selection.homeId, managedId: acquisition.managedId }, context);
        if (!current()) return null;
        const outcome = classifyHomeActionOutcome(result);
        if (outcome.kind !== 'completed') {
            fail(outcome.kind === 'failed' ? homeDomainFailureCode(outcome.failure) : 'approval_required');
            return null;
        }
        const machine = ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(outcome.result);
        if (machine.id !== acquisition.managedId || machine.homeId !== acquisition.selection.homeId
            || !sameStrictJsonValue(machine.controller, controller)) { fail('managed_response_invalid'); return null; }
        return machine;
    };
    const alreadyAdmitted = acquisition.managedId ? await read() : null;
    if (!current()) return fail('continuation_retired');
    if (acquisition.managedId && !alreadyAdmitted) return { kind: 'failed', code: 'managed_read_failed' };
    if (alreadyAdmitted?.creationState !== undefined && alreadyAdmitted.creationState !== 'active') return fail('enrollment_retired');
    if (!alreadyAdmitted?.enrolledMachineId && (!acquisition.managedId || input.retryInstallation)) {
        if (input.retryInstallation && (!alreadyAdmitted?.resource || alreadyAdmitted.allocation !== 'bound')) return fail('installation_retry_unavailable');
        const actionId = input.retryInstallation ? 'machines.managed.bootstrap.retry' as const : 'machines.managed.acquire' as const;
        const actionInput = input.retryInstallation && alreadyAdmitted
            ? { homeId: alreadyAdmitted.homeId, managedId: alreadyAdmitted.id, expectedIntentRevision: alreadyAdmitted.intentRevision }
            : buildNewSessionManagedAcquireInput(input.draft);
        const accepted = await awaitActionApprovalResult<ManagedAcceptedV1, { kind: 'accepted'; value: ManagedAcceptedV1 } | { kind: 'failed'; code: string }>({
            signal: input.signal,
            execute: async callbacks => {
                input.onProgress({ kind: 'acquiring', ...(acquisition.managedId ? { managedId: acquisition.managedId } : {}) });
                const outcome = classifyHomeActionOutcome(await execute(actionId, actionInput, {
                    ...context, actionRequestId: input.retryInstallation ? `${acquisition.requestId}:bootstrap:${alreadyAdmitted?.intentRevision}` : acquisition.requestId,
                    executionRunTargetMachineId: controller.machineId,
                }));
                if (outcome.kind === 'failed') return { kind: 'failed' as const, code: homeDomainFailureCode(outcome.failure) };
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
            succeeded: value => ({ kind: 'accepted', value }), failed: code => ({ kind: 'failed', code }),
            aborted: () => ({ kind: 'failed', code: 'continuation_retired' }),
        });
        if (accepted.kind === 'failed') return fail(accepted.code);
        if (acquisition.managedId && acquisition.managedId !== accepted.value.managedId) return fail('resource_mismatch');
        acquisition = { ...acquisition, managedId: accepted.value.managedId, operation: accepted.value.operation };
        // A retired draft must not write the accepted row into its replacement.
        // The admitted Account row remains the paid-resource recovery authority.
        if (current()) input.onAcquisitionChange(acquisition);
    }
    if (!current()) return fail('continuation_retired');
    let operationFailure: string | null = null;
    const awaitingSetupWithoutGuestOperation = alreadyAdmitted?.environmentSetup
        && (alreadyAdmitted.environmentSetup.state === 'pending' || alreadyAdmitted.environmentSetup.state === 'running')
        && !alreadyAdmitted.environmentSetup.operation;
    if (acquisition.operation && (!alreadyAdmitted?.enrolledMachineId || awaitingSetupWithoutGuestOperation)) {
        input.onProgress({ kind: 'acquiring', managedId: acquisition.managedId });
        const result = await execute('action.operations.get', { serverId: input.scope.serverId, machineId: controller.machineId,
            ...acquisition.operation, waitForTerminal: true }, context);
        if (!current()) return fail('continuation_retired');
        const outcome = classifyHomeActionOutcome(result);
        if (outcome.kind !== 'completed') return fail(outcome.kind === 'failed' ? homeDomainFailureCode(outcome.failure) : 'approval_required');
        const found = ActionOperationGetV1ResponseSchema.parse(outcome.result);
        if (found.kind === 'not_found') return fail('operation_not_found');
        if (found.operation.operationId !== acquisition.operation.operationId || found.operation.scope.machineId !== controller.machineId
            || found.operation.scope.accountId !== input.scope.accountId) return fail('operation_scope_mismatch');
        observedOperation = found.operation;
        input.onProgress({ kind: 'acquiring', managedId: acquisition.managedId, operation: found.operation });
        if (found.operation.state === 'accepted' || found.operation.state === 'running') {
            return acquisition.managedId ? { kind: 'pending', managedId: acquisition.managedId } : fail('managed_response_invalid');
        }
        operationFailure = found.operation.state === 'failed' ? found.operation.error?.errorCode ?? 'installation_failed'
            : found.operation.state === 'cancelled' ? 'creation_canceled' : null;
    }
    let machine = await read();
    if (!current()) return fail('continuation_retired');
    if (!machine) return { kind: 'failed', code: 'managed_read_failed' };
    if (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent') return fail('enrollment_retired');
    setupMachine = machine;
    if (operationFailure) return fail(machine.environmentSetup?.state === 'failed' ? machine.environmentSetup.errorCode ?? operationFailure : operationFailure,
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
        if (census.kind === 'failed') return fail(census.code);
        const review = qualifyManagedMachineDeleteReview(machine, census.value);
        if (!review) return fail('managed_response_invalid');
        if (!input.reviewDelete) return fail('review_required');
        const confirmed = await input.reviewDelete(review.census);
        if (!current()) return fail('continuation_retired');
        if (!confirmed) return fail(setup.errorCode ?? 'setup_failed');
        const currentMachine = await read();
        if (!current()) return fail('continuation_retired');
        if (!currentMachine) return { kind: 'failed', code: 'managed_read_failed' };
        const deleteInput = buildReviewedManagedMachineDeleteInput(currentMachine, review);
        if (!deleteInput) return fail('intent_changed');
        const deleted = await executeApproved('machines.managed.delete', deleteInput, currentMachine.controller.machineId);
        if (!current()) return fail('continuation_retired');
        if (deleted.kind === 'failed') return fail(deleted.code);
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
        const actionId = input.setupRecovery === 'retry' ? 'machines.environment.apply' as const : 'machines.managed.setup.skip' as const;
        const actionInput = input.setupRecovery === 'retry'
            ? { homeId: machine.homeId, machineId: enrolledMachineId, presetId: machine.preset!.id, presetRevision: machine.preset!.revision }
            : { homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision };
        const result = await executeApproved(actionId, actionInput);
        if (!current()) return fail('continuation_retired');
        if (result.kind === 'failed') return fail(result.code);
        const setupResult = ManagedMachineActionOutputSchemasV1[actionId].parse(result.value);
        if ('operationId' in setupResult) {
            const acceptedOperation = { operationId: setupResult.operationId };
            const observed = await read();
            if (!current()) return fail('continuation_retired');
            if (!observed) return { kind: 'failed', code: 'managed_read_failed' };
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
                state: setup.state, environmentSetup: machine.environmentSetup! });
        }
        const outcome = classifyHomeActionOutcome(await execute('action.operations.get', {
            serverId: input.scope.serverId, machineId: enrolledMachineId, ...setup.operation, waitForTerminal: true,
        }, context));
        if (!current()) return fail('continuation_retired');
        if (outcome.kind !== 'completed') return fail(outcome.kind === 'failed' ? homeDomainFailureCode(outcome.failure) : 'approval_required');
        const found = ActionOperationGetV1ResponseSchema.parse(outcome.result);
        if (found.kind === 'not_found') return fail('operation_not_found');
        if (found.operation.operationId !== setup.operation.operationId || found.operation.scope.machineId !== enrolledMachineId
            || found.operation.scope.accountId !== input.scope.accountId) return fail('operation_scope_mismatch');
        observedOperation = found.operation;
    }
    if (input.setupRecovery || setup?.operation) {
        machine = await read();
        if (!current()) return fail('continuation_retired');
        if (!machine) return { kind: 'failed', code: 'managed_read_failed' };
        if (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent'
            || machine.enrolledMachineId !== enrolledMachineId) return fail('enrollment_retired');
        setupMachine = machine;
        setup = managedCreationSetup(machine);
    }
    if (setup?.state === 'failed') return fail(setup.errorCode ?? 'setup_failed');
    if (setup?.state === 'pending' || setup?.state === 'running') {
        input.onProgress({ kind: 'setup_pending', managedId: machine.id, machineId: enrolledMachineId,
            state: setup.state, environmentSetup: machine.environmentSetup!, ...(observedOperation ? { operation: observedOperation } : {}) });
        return { kind: 'pending', managedId: machine.id };
    }
    input.onProgress({ kind: 'ready', managedId: machine.id, machineId: enrolledMachineId });
    return { kind: 'enrolled', machine: { ...machine, enrolledMachineId } };
}
