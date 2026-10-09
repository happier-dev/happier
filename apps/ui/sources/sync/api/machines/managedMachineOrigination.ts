import { ManagedAdmissionComputeInputV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, resolveManagedAcquireReviewV1,
    type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createManagedMachineActionClient } from './managedMachineActions';
import { executeOriginalAccountActionTransport, readOriginalAccountActionAuthentication,
    readOriginalAccountActionMachine } from '@/sync/api/externalActionAccountTransport';

const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });

/** Ordinary captured Account ingress. The server, not this client, admits and signs the native role. */
export async function executeManagedMachineNativeAction(params: Readonly<{
    account: LazyActionAccountContext;
    actionId: ManagedMachineActionIdV1;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>): Promise<ActionExecuteResult> {
    const { account, actionId, context } = params;
    account.assertCurrent();
    // The ordinary ingress has no producer for the outer UI approval Artifact's replay custody.
    if (context.bypassApprovals || context.surface !== 'ui' || context.authority !== 'present_user') return failure('admission_unavailable');
    if (!account.serverIdentityId || !context.actionRequestId) return failure('admission_unavailable');
    const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
    if (!authentication) return failure('admission_unavailable');
    const input = ManagedMachineActionInputSchemasV1[actionId].parse(params.input);
    const review = actionId === 'machines.managed.acquire'
        ? resolveManagedAcquireReviewV1(ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(input)) : null;
    const homeId = review?.homeId ?? ('homeId' in input ? input.homeId : undefined);
    if (homeId !== account.serverIdentityId) return failure('server_target_mismatch');
    let controller = review?.controller ?? ('controller' in input ? input.controller : undefined);
    const managedId = 'managedId' in input ? input.managedId
        : 'managedMachineId' in input ? input.managedMachineId : undefined;
    let foreignManagedCustody = false;
    if (managedId) {
        const row = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', {
            homeId, managedId,
        }, { signal: params.signal });
        account.assertCurrent();
        if (row.id !== managedId || row.homeId !== homeId) return failure('managed_response_invalid');
        foreignManagedCustody = row.custodianAccountId !== account.accountId;
        // Move is admitted at its selected receiver; other retained operations
        // still execute through the resource's current controller.
        if (actionId !== 'machines.managed.controller.update') controller = row.controller;
    }
    if (!controller) return failure('admission_unavailable');
    const { accountMode, encryption } = await account.resolveAccountEncryption();
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const binding: ExternalActionEncryptionBindingV2 = { serverIdentityId: account.serverIdentityId, accountId: account.accountId,
        authentication, actionId, requestId: context.actionRequestId, target };
    let material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }> | undefined;
    let machineCustody: Parameters<typeof executeOriginalAccountActionTransport>[0]['machineCustody'];
    if (accountMode === 'e2ee' || actionId === 'machines.managed.acquire' || foreignManagedCustody) {
        if (accountMode === 'e2ee' && !encryption) return failure('content_unavailable');
        const row = await readOriginalAccountActionMachine(account, target.machineId, params.signal);
        const access = row?.access;
        const foreignController = access !== undefined && access.custodian.accountId !== account.accountId;
        if (foreignController && row && access) {
            if (!row.installationId || !row.installationPublicKey) return failure('content_unavailable');
            machineCustody = { accountMode, installationId: row.installationId,
                installationPublicKey: row.installationPublicKey, custodian: access.custodian };
        }
        // Own acquisition still proves controller custody; foreign custody has its own exact private carrier.
        if (actionId === 'machines.managed.acquire' && !foreignController
            && row?.access?.custodian.accountId !== account.accountId) return failure('admission_unavailable');
        if (!row || row.kind !== 'persistent' || row.installationId !== controller.installationId
            || row.revokedAt !== null || row.replacedByMachineId !== null
            || (row.access && (row.access.accessState !== 'ready'
                || (!foreignController && row.access.resourceMode !== accountMode)))) return failure('content_unavailable');
        if (encryption) material = { type: 'dataKey', machineKey: encryption.getContentPrivateKey() };
    }
    const acquire = actionId === 'machines.managed.acquire'
        ? ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(input) : undefined;
    const managedAdmission = acquire ? (() => {
        const { agentStart, ...compute } = acquire;
        return { actionId: 'machines.managed.acquire' as const, input: ManagedAdmissionComputeInputV1Schema.parse(compute), continuationPresent: Boolean(agentStart) };
    })() : undefined;
    const execution = await executeOriginalAccountActionTransport({ account, binding, input,
        ...(material ? { material } : {}), ...(managedAdmission ? { managedAdmission } : {}),
        ...(machineCustody ? { machineCustody } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        invalidResponseCode: 'managed_response_invalid', requestFailureCode: 'managed_request_failed' });
    if (!execution.ok) return execution;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
    if (approval.success && approval.data.actionId === actionId) return { ok: true, result: approval.data };
    const output = ManagedMachineActionOutputSchemasV1[actionId].safeParse(execution.result);
    return output.success ? { ok: true, result: output.data } : failure('managed_response_invalid');
}
