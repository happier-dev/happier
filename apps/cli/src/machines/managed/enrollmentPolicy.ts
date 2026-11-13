import { MachineAdminAccessMutationResultV1Schema, MachineAdminAccessFieldV1, type ActionExecuteResult } from '@happier-dev/protocol';
import { resolveManagedMachineEnrollmentAdminAccessV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineRolesMutationResultV1Schema, machineRolesMetadataFieldV1, resolveManagedMachineEnrollmentRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { dispatchManagedMachineAdminAccess, dispatchLocalManagedMachineAdminAccess, dispatchManagedMachineRoles, dispatchLocalManagedMachineRoles } from '@/api/externalActionExecutionAuthorization';
import { logger } from '@/ui/logger';
import type { ManagedMachineAcquisitionDriverInput, ManagedMachineExecutionOptions } from './acquire';
import { ManagedMachineControllerError } from './controllerErrors';
import { resolveManagedCreationChildMaterial } from './creationChildMaterial';
import { initializeManagedMachineEnrollmentIsolation } from './enrollmentIsolation';

/** One signed creation child on the exact enrolled guest: remote continuation or the original local host path. */
async function dispatchEnrollmentPolicyChild<TInput extends Readonly<{ machineId: string }>>(input: ManagedMachineAcquisitionDriverInput,
    machine: ManagedMachineV1, options: ManagedMachineExecutionOptions, request: TInput,
    dispatch: Readonly<{
        remote: (params: Omit<Parameters<typeof dispatchManagedMachineAdminAccess>[0], 'input'> & Readonly<{ input: TInput }>) => Promise<ActionExecuteResult>;
        local: (params: Omit<Parameters<typeof dispatchLocalManagedMachineAdminAccess>[0], 'input'> & Readonly<{ input: TInput }>) => Promise<ActionExecuteResult>;
    }>): Promise<ActionExecuteResult> {
    const context = options.context;
    if (!context || !machine.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
    const continuation = { managedId: machine.id, creationRequestId: options.requestId, expectedIntentRevision: machine.intentRevision };
    const authorization = context.externalActionExecutionAuthorization;
    if (authorization) {
        if (!input.externalActionMachineRequestPrivateKey || authorization.binding.machineId !== input.controller.machineId
            || authorization.binding.installationId !== input.controller.installationId
            || authorization.binding.serverIdentityId !== machine.homeId) throw new ManagedMachineControllerError('admission_unavailable');
        const material = await resolveManagedCreationChildMaterial(authorization, machine.homeId, options.signal);
        return dispatch.remote({ input: request, serverId: context.serverId ?? machine.homeId, homeTarget: input.homeTarget,
            observeRecordedApprovalExecution: input.observeRecordedApprovalExecution,
            context, continuation, authorization, authority: context.authority,
            installationId: input.controller.installationId, privateKey: input.externalActionMachineRequestPrivateKey,
            serverHttpBaseUrl: input.serverUrl, ...(material ? { material } : {}), signal: options.signal });
    }
    return dispatch.local({ input: request, homeId: machine.homeId, context,
        observeRecordedApprovalExecution: input.observeRecordedApprovalExecution, managedContinuation: continuation,
        credentials: input.credentials, custodianAccountId: machine.custodianAccountId, serverHttpBaseUrl: input.serverUrl,
        isCurrent: async () => !options.signal?.aborted });
}

async function recordEnrollmentAdministratorAccess(input: ManagedMachineAcquisitionDriverInput, machine: ManagedMachineV1, options: ManagedMachineExecutionOptions): Promise<void> {
    const policy = resolveManagedMachineEnrollmentAdminAccessV1(machine.enrollmentIdentity);
    if (!policy) return;
    options.context?.operationProgress?.update({ phase: 'machines.setup.adminAccess.set', label: 'Configuring administrator access' });
    if (!options.context || !machine.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
    // The initial field is None; field comparison may rebase unrelated
    // metadata versions but never replaces an independently changed policy.
    // The continuation retains the original creation even when the public
    // retry carrying this first enrollment has a new request identity.
    const request = { serverId: machine.homeId, machineId: machine.enrolledMachineId, expectedMetadataVersion: 0,
        expectedAdminAccess: { version: 1 as const, mode: 'none' as const }, adminAccess: policy, comparison: 'field' as const };
    const execution = await dispatchEnrollmentPolicyChild(input, machine, options, request,
        { remote: dispatchManagedMachineAdminAccess, local: dispatchLocalManagedMachineAdminAccess });
    if (!execution.ok) throw ManagedMachineControllerError.fromActionFailure(execution, 'machines.setup.adminAccess.set');
    const result = MachineAdminAccessMutationResultV1Schema.safeParse(execution.result);
    if (!result.success || result.data.status === 'outcomeUnknown') {
        throw new ManagedMachineControllerError('action_outcome_unknown');
    }
    if (!['applied', 'satisfied', 'unchanged'].includes(result.data.status)
        || !('policy' in result.data) || !MachineAdminAccessFieldV1.equal(result.data.policy, policy)) {
        throw new ManagedMachineControllerError('administrator_policy_unconfirmed');
    }
}

/** Seeds the owner-approved role set for this install type over the missing field (OWNER-RULINGS 2026-11-12). */
async function recordEnrollmentRoles(input: ManagedMachineAcquisitionDriverInput, machine: ManagedMachineV1, options: ManagedMachineExecutionOptions): Promise<void> {
    const policy = resolveManagedMachineEnrollmentRolesV1(machine.enrollmentIdentity);
    if (!policy) return;
    options.context?.operationProgress?.update({ phase: 'machines.roles.set', label: 'Choosing machine roles' });
    if (!options.context || !machine.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
    // Field comparison over the missing field (every core role): a role set the
    // owner already changed is a conflict and is never replaced.
    const request = { serverId: machine.homeId, machineId: machine.enrolledMachineId, expectedMetadataVersion: 0,
        expectedPolicy: machineRolesMetadataFieldV1.defaultValue(), policy };
    const execution = await dispatchEnrollmentPolicyChild(input, machine, options, request,
        { remote: dispatchManagedMachineRoles, local: dispatchLocalManagedMachineRoles });
    if (!execution.ok) throw ManagedMachineControllerError.fromActionFailure(execution, 'machines.roles.set');
    const result = MachineRolesMutationResultV1Schema.safeParse(execution.result);
    if (!result.success || result.data.status === 'outcomeUnknown') throw new ManagedMachineControllerError('action_outcome_unknown');
    if (!['applied', 'satisfied', 'unchanged'].includes(result.data.status)
        || !('policy' in result.data) || !machineRolesMetadataFieldV1.equal(result.data.policy, policy)) {
        throw new ManagedMachineControllerError('machine_roles_unconfirmed');
    }
}

/** Enrollment owns creation; an optional roles seed cannot turn its success into a bootstrap failure. */
export async function initializeManagedMachineEnrollmentPolicies(input: ManagedMachineAcquisitionDriverInput,
    machine: ManagedMachineV1, options: ManagedMachineExecutionOptions): Promise<void> {
    await recordEnrollmentAdministratorAccess(input, machine, options);
    try {
        await recordEnrollmentRoles(input, machine, options);
    } catch (error) {
        options.signal?.throwIfAborted();
        // Keep the current role policy and report the public code, never a remote message or input.
        logger.warn('[MANAGED MACHINE] Enrollment roles seed failed', {
            managedId: machine.id, machineId: machine.enrolledMachineId,
            code: error instanceof ManagedMachineControllerError ? error.code : 'internal_error',
        });
    }
    await initializeManagedMachineEnrollmentIsolation(machine, input, options);
}
