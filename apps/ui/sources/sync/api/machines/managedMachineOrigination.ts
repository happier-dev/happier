import { MANAGED_RESIZE_ACTION_ID_V1, MANAGED_RETIRE_ACTION_ID_V1, readManagedProvisionerCredentialRootRoleV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { unwrapManagedMachineReadV1, ManagedMachineActionInputSchemasV1, ManagedAdmissionOutputV1Schema, resolveManagedAcquireReviewV1,
    type ManagedMachineActionIdV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachinePoolResolveInputV1 } from '@happier-dev/protocol/machines/pools';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ManagedControllerAccessV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ActionOperationActionInputSchemasV1, ActionOperationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/actionOperations';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createManagedMachineActionClient, ManagedMachineActionError } from './managedMachineActions';
import { readManagedMachineActionOutputV1 } from './managedMachineResponse';
import { executeOriginalAccountActionTransport, executeOriginalAccountMachineAction, readOriginalAccountActionAuthentication,
    readOriginalAccountActionMachine, resolveOriginalAccountPluginInvocation } from '@/sync/api/externalActionAccountTransport';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { bindManagedPresetAcquireOriginV1, ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { executeUiManagedAccountAcquire, executeUiManagedAccountRecovery } from './managedMachineAccountAcquire';
import { executeUiManagedAccountControl } from './managedMachineAccountControl';
import { createUiManagedAccountHomeRequest } from './managedMachineAccountHome';
import { projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { UiManagedMachineEnrollmentDependencies } from './managedMachineEnrollment';
import { isHostAdmittedReviewedChildPolicyV1, readHostReviewedChildOperationV1,
    readHostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { isOrdinaryMachineSetupNativeActionIdV1, isMachineSetupCombinedActionIdV1, MACHINE_SETUP_APPLY_ACTION_ID_V1,
    SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';

import { MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });

export { isManagedRetainedControlInvocation as isManagedMachineRetainedControlAction } from '@happier-dev/protocol/machines/managed/actionsV1';

type ManagedMachineNativeActionParams = Readonly<{
    account: LazyActionAccountContext;
    actionId: ManagedMachineActionIdV1 | 'action.operations.list' | 'action.operations.get';
    input: unknown;
    context: ActionExecutorContext;
    confirmInFlow?: boolean;
    /** The receiving Machine's carried review this in-flow confirmation answers. */
    reviewDigest?: string;
    retainedMachine?: ManagedMachineActionOutputV1<'machines.managed.get'>;
    /** Exact local structural origin for a newly selected Preset; never sent to Home. */
    presetOrigin?: Parameters<typeof bindManagedPresetAcquireOriginV1>[0]['preset'];
    /** The mounted UI Action executor's canonical Pool route. */
    resolvePresetPool?: (input: MachinePoolResolveInputV1) => Promise<ActionExecuteResult>;
    signal?: AbortSignal;
    /** Optional host strategy for transferring the actual guest payload bytes. */
    installNativePayload?: UiManagedMachineEnrollmentDependencies['installNativePayload'];
}>;

/** Ordinary captured Account ingress. The server, not this client, admits and signs the native role. */
export async function executeManagedMachineNativeAction(params: ManagedMachineNativeActionParams): Promise<ActionExecuteResult> {
    params.signal?.throwIfAborted();
    const { account, actionId } = params;
    let context = params.context;
    account.assertCurrent();
    // Parent replay can read the setup Plan through its captured Account; effect children use their own reviewed port.
    const pluginCaller = context.surface === 'plugin' && context.actionCaller?.kind === 'plugin'
        && context.authority === 'account_automation';
    // The captured Account owner already resolved authority with its preference.
    if ((context.bypassApprovals && actionId !== SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action)
        || (!pluginCaller && ((context.surface !== 'ui' && context.surface !== 'voice')
            || context.authority === undefined))) return failure('admission_unavailable');
    const invocation = resolveOriginalAccountPluginInvocation(context.actionCaller);
    if (!invocation.ok) return invocation;
    if (!account.serverIdentityId || !context.actionRequestId) return failure('admission_unavailable');
    const requestId = context.actionRequestId;
    const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
    if (!authentication) return failure('admission_unavailable');
    const operationActionId = actionId === 'action.operations.list' || actionId === 'action.operations.get' ? actionId : null;
    const parsedInput = actionId === 'action.operations.list' || actionId === 'action.operations.get'
        ? ActionOperationActionInputSchemasV1[actionId].safeParse(params.input)
        : ManagedMachineActionInputSchemasV1[actionId].safeParse(params.input);
    if (!parsedInput.success) return failure('invalid_parameters');
    let input = parsedInput.data;
    let review = actionId === 'machines.managed.acquire'
        ? resolveManagedAcquireReviewV1(ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(input)) : null;
    const managedObservation = 'managed' in input ? input.managed : undefined;
    if (operationActionId && !managedObservation) return failure('admission_unavailable');
    const homeId = review?.homeId ?? managedObservation?.homeId ?? ('homeId' in input ? input.homeId : undefined);
    if (homeId !== account.serverIdentityId) return failure('server_target_mismatch');
    const validateExecution = (execution: ActionExecuteResult): ActionExecuteResult => {
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success && approval.data.actionId === actionId) return { ok: true, result: approval.data };
        const output = actionId === 'action.operations.list' || actionId === 'action.operations.get'
            ? ActionOperationActionOutputSchemasV1[actionId].safeParse(execution.result)
            : readManagedMachineActionOutputV1(actionId, execution.result);
        return output.success ? { ok: true, result: output.data } : failure('managed_response_invalid');
    };
    let scopedControllerAccess: ManagedControllerAccessV1 | undefined;
    const presetOrigin = params.presetOrigin ?? context.managedPresetOrigin;
    if (actionId === 'machines.managed.acquire' && presetOrigin) {
        let poolFailure: Extract<ActionExecuteResult, { ok: false }> | undefined;
        const bound = await bindManagedPresetAcquireOriginV1({
            input: ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(input),
            preset: presetOrigin,
            requestKey: requestId,
            resolveExact: async exactInput => {
                const response = await account.request(MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exactInput),
                    ...(params.signal ? { signal: params.signal } : {}),
                }, { includeAuth: true, retry: 'none' });
                return await response.json();
            },
            resolvePool: async poolInput => {
                const result = await (params.resolvePresetPool?.(poolInput) ?? Promise.resolve(failure('admission_unavailable')));
                if (result.ok) return result.result;
                poolFailure = result;
                return null;
            },
        });
        params.signal?.throwIfAborted();
        account.assertCurrent();
        if (poolFailure) return poolFailure;
        if (bound.kind === 'refused') return failure(bound.code);
        input = bound.input;
        review = resolveManagedAcquireReviewV1(bound.input);
        scopedControllerAccess = bound.controllerAccess;
    }
    if (isOrdinaryMachineSetupNativeActionIdV1(actionId) || isMachineSetupCombinedActionIdV1(actionId)) {
        const selected = ManagedMachineActionInputSchemasV1[actionId].parse(input);
        const addressedContext = { ...context, externalActionTarget: context.externalActionTarget?.kind === 'machine'
            ? context.externalActionTarget : { kind: 'machine' as const, machineId: selected.machineId } };
        const reviewedOperation = actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1 && isPresentUserHostInvocation(context)
            ? readHostReviewedChildOperationV1(context, actionId, selected) : null;
        const admittedChild = reviewedOperation && isHostAdmittedReviewedChildPolicyV1(reviewedOperation, actionId, selected);
        // The host's private exact child is the person's reviewed Apply. Rebind
        // the parent's marker to that child through the ordinary Account path.
        context = admittedChild || params.confirmInFlow
            ? bindPresentUserActionConfirmation(actionId, selected,
                admittedChild ? { ...addressedContext, presentUserConfirmation: undefined } : addressedContext, params.reviewDigest)
            : addressedContext;
        const confirmation = context.presentUserConfirmation?.inputDigest === undefined ? undefined : context.presentUserConfirmation;
        const reviewedParent = readHostReviewedParentV1(context);
        const requester = confirmation || reviewedParent ? ExternalActionRequesterInvocationV1Schema.safeParse({
            caller: context.actionCaller ?? { kind: 'host' }, surface: context.surface, authority: context.authority,
            callerPermissionMode: context.callerPermissionMode, callerInputConstraints: context.callerInputConstraints,
            workspaceWrites: context.workspaceWrites,
            ...(context.defaultSessionId != null ? { defaultSessionId: context.defaultSessionId } : {}),
            ...(confirmation ? { presentUserConfirmation: confirmation } : {}),
            ...(reviewedParent ? { reviewedParent } : {}),
        }) : null;
        if (requester && !requester.success) return failure('admission_unavailable');
        return validateExecution(await executeOriginalAccountMachineAction({ account, actionId, input: selected,
            machineId: selected.machineId, requestId, authority: context.authority,
            machineTarget: context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget : undefined,
            ...(requester?.success ? { invocation: requester.data } : {}),
            ...(context.invocationServices?.managedContinuation
                ? { managedContinuation: context.invocationServices.managedContinuation } : {}),
            ...(context.actionCaller ? { actionCaller: context.actionCaller } : {}),
            ...(params.signal ? { signal: params.signal } : {}) }));
    }
    let controller = review?.controller ?? ('controller' in input ? input.controller : undefined);
    const managedId = managedObservation?.managedId ?? ('managedId' in input ? input.managedId
        : 'managedMachineId' in input ? input.managedMachineId : undefined);
    let foreignManagedCustody = false;
    let retainedMachine: ManagedMachineV1 | undefined;
    if (managedId) {
        let read: ManagedMachineActionOutputV1<'machines.managed.get'>;
        try {
            read = params.retainedMachine ?? await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', {
                homeId, managedId,
            }, { signal: params.signal });
        } catch (error) {
            if (error instanceof ManagedMachineActionError) {
                if (actionId === 'machines.managed.power.set' && error.code === 'permission_denied') {
                    const power = ManagedMachineActionInputSchemasV1[actionId].parse(input);
                    return validateExecution(await executeUiManagedAccountControl(params, { action: 'machines.managed.power.set', input: power }));
                }
                return failure(error.code);
            }
            throw error;
        }
        account.assertCurrent();
        const row = unwrapManagedMachineReadV1(read);
        if (row.id !== managedId || row.homeId !== homeId) return failure('managed_response_invalid');
        retainedMachine = row;
        foreignManagedCustody = row.custodianAccountId !== account.accountId;
        if ((actionId === 'machines.managed.bootstrap.retry' || actionId === 'machines.managed.inspect' || actionId === 'machines.managed.delete' || operationActionId)
            && row.enrollmentAccountId === account.accountId) {
            if (foreignManagedCustody && !row.controllerAccess) return failure('controller_unavailable');
            scopedControllerAccess = row.controllerAccess;
        }
        // Move is admitted at its selected receiver; other retained operations
        // still execute through the resource's current controller.
        if (actionId !== 'machines.managed.controller.update') controller = row.controller;
    }
    if (!controller && actionId === 'machines.managed.acquire') {
        const acquire = ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(input);
        try {
            return validateExecution({ ok: true, result: await executeUiManagedAccountAcquire({
                account, context, requestId, input: acquire,
                signal: params.signal, installNativePayload: params.installNativePayload,
            }) });
        } catch (error) {
            if (error instanceof ManagedMachineControllerError || error instanceof SystemTaskExecutionError) {
                return { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
            }
            throw error;
        }
    }
    if (!controller && actionId === MANAGED_RESIZE_ACTION_ID_V1) {
        return validateExecution(await executeUiManagedAccountControl(params, { action: actionId,
            input: ManagedMachineActionInputSchemasV1[actionId].parse(input) }));
    }
    if (!controller && actionId === 'machines.managed.power.set') {
        const power = ManagedMachineActionInputSchemasV1[actionId].parse(input);
        return validateExecution(await executeUiManagedAccountControl(params, { action: 'machines.managed.power.set', input: power }));
    }
    if (actionId === 'machines.managed.cancel') {
        const canceled = await createManagedMachineActionClient({ request: account.request }).execute(actionId,
            ManagedMachineActionInputSchemasV1[actionId].parse(input), { signal: params.signal });
        if (canceled.machine.controller || canceled.machine.allocation === 'confirmed-absent') {
            return validateExecution({ ok: true, result: canceled });
        }
        const deletion = await executeUiManagedAccountControl(params, { action: 'machines.managed.delete', input: {
            homeId: canceled.machine.homeId, managedId: canceled.machine.id, intent: 'delete', when: 'now',
            expectedRevision: canceled.machine.intentRevision, reviewedDependencies: true,
        } });
        if (!deletion.ok) return deletion;
        const read = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', {
            homeId: canceled.machine.homeId, managedId: canceled.machine.id,
        }, { signal: params.signal });
        const machine = unwrapManagedMachineReadV1(read);
        return validateExecution({ ok: true, result: { machine } });
    }
    if (!controller && actionId === 'machines.managed.delete') {
        return await executeUiManagedAccountControl(params, { action: actionId,
            input: ManagedMachineActionInputSchemasV1[actionId].parse(input) });
    }
    if (!controller && retainedMachine && (actionId === 'machines.managed.inspect' || actionId === 'machines.managed.bootstrap.retry')) {
        try {
            return validateExecution({ ok: true, result: await executeUiManagedAccountRecovery({
                account, context, requestId, action: actionId, input: ManagedMachineActionInputSchemasV1[actionId].parse(input),
                machine: retainedMachine, signal: params.signal, installNativePayload: params.installNativePayload,
            }) });
        } catch (error) {
            if (error instanceof ManagedMachineControllerError || error instanceof SystemTaskExecutionError) {
                return { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
            }
            throw error;
        }
    }
    if (actionId === MANAGED_RETIRE_ACTION_ID_V1) {
        try {
            const output = await createUiManagedAccountHomeRequest(params)('admit-control',
                { action: actionId, input, requestId }, ManagedAdmissionOutputV1Schema);
            return validateExecution({ ok: true, result: 'presetContent' in output
                ? { machine: output.machine, presetContent: projectManagedMachinePresetForRecipientV1({
                    ...output.presetContent, recipientAccountId: account.accountId }) }
                : output.machine });
        } catch (error) {
            if (error instanceof ManagedMachineControllerError) return { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
            throw error;
        }
    }
    if (!controller) return failure('admission_unavailable');
    if (operationActionId && (!('machineId' in input) || input.machineId !== controller.machineId)) return failure('controller_retired');
    const { accountMode, encryption } = await account.resolveAccountEncryption();
    params.signal?.throwIfAborted();
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const addressedContext = { ...context, externalActionTarget: context.externalActionTarget ?? target };
    context = params.confirmInFlow ? bindPresentUserActionConfirmation(actionId, input, addressedContext, params.reviewDigest) : addressedContext;
    const confirmation = context.presentUserConfirmation?.inputDigest === undefined ? undefined : context.presentUserConfirmation;
    const binding: ExternalActionEncryptionBindingV2 = { serverIdentityId: account.serverIdentityId, accountId: account.accountId,
        authentication, actionId, requestId, target };
    const provisionerRole = readManagedProvisionerCredentialRootRoleV1(actionId);
    const provisionerRead = provisionerRole === 'check' || provisionerRole === 'options';
    let material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }> | undefined;
    let usesControllerCodec = false;
    let machineCustody: Parameters<typeof executeOriginalAccountActionTransport>[0]['machineCustody'];
    if (accountMode === 'e2ee' || actionId === 'machines.managed.acquire' || foreignManagedCustody || confirmation || provisionerRead) {
        if (accountMode === 'e2ee' && !encryption) return failure('content_unavailable');
        if (scopedControllerAccess) {
            machineCustody = { accountMode, installationId: controller.installationId,
                installationPublicKey: decodeBase64(scopedControllerAccess.installationPublicKey, 'base64url'),
                custodian: scopedControllerAccess.custodian };
        } else {
            const row = await readOriginalAccountActionMachine(account, target.machineId, params.signal);
            const access = row?.access;
            const foreignController = access !== undefined && access.custodian.accountId !== account.accountId;
            if ((foreignController || confirmation || provisionerRead) && row && access) {
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
        }
        usesControllerCodec = Boolean(machineCustody && machineCustody.custodian.accountId !== account.accountId
            && (actionId === 'machines.managed.acquire' || actionId === 'machines.managed.inspect' || actionId === 'machines.managed.bootstrap.retry'
                || actionId === 'machines.managed.delete' && scopedControllerAccess !== undefined || operationActionId));
        if (encryption && !usesControllerCodec) material = { type: 'dataKey', machineKey: encryption.getContentPrivateKey() };
    }
    // Narrow the authenticated Account carrier before the installed daemon's
    // canonical Action policy creates the Ask. Human replay stays with that owner.
    params.signal?.throwIfAborted();
    const codecInvocation = usesControllerCodec || confirmation || provisionerRead ? ExternalActionRequesterInvocationV1Schema.safeParse({
        caller: context.actionCaller ?? { kind: 'host' }, surface: context.surface, authority: context.authority,
        callerPermissionMode: context.callerPermissionMode, callerInputConstraints: context.callerInputConstraints,
        workspaceWrites: context.workspaceWrites,
        ...(context.defaultSessionId != null ? { defaultSessionId: context.defaultSessionId } : {}),
        ...(confirmation ? { presentUserConfirmation: confirmation } : {}),
    }) : undefined;
    if (codecInvocation && !codecInvocation.success) return failure('admission_unavailable');
    const execution = await executeOriginalAccountActionTransport({ account, binding, input, authority: context.authority,
        ...(codecInvocation?.success ? { invocation: codecInvocation.data } : {}),
        ...(invocation.pluginInvocation ? { pluginInvocation: invocation.pluginInvocation } : {}),
        ...(material ? { material } : {}),
        ...(machineCustody ? { machineCustody } : {}),
        ...(usesControllerCodec ? { prepareManagedControllerCodec: true } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        invalidResponseCode: 'managed_response_invalid', requestFailureCode: 'managed_request_failed' });
    return validateExecution(execution);
}
