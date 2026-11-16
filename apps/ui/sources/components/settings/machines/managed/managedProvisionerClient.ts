import type { ManagedMachinePresetAcquireOriginV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedMachineActionInputSchemasV1, resolveManagedAcquireReviewV1,
    type ManagedMachineActionIdV1, type ManagedMachineActionInputV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { MachinePresetCollectionOptions, MachinePresetCollectionResult } from './machinePresetCollectionClient';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { observeHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { awaitActionApprovalResult } from '@/components/approvals/actionApprovalContinuation';
import { ExternalActionHttpErrorSchema, type ExternalActionManagedAdmissionReceiptV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedNativeFailureDetailsV1Schema, type ManagedNativeFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readManagedMachineActionOutputV1 } from '@/sync/api/machines/managedMachineResponse';
import { isPluginErrorData, type PluginErrorContractData } from '@happier-dev/protocol/plugins/errors';
import { PluginDiagnosticRemediationV1Schema } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import type { PluginActionFailureAuthorPayloadV1 } from '@happier-dev/protocol/plugins/actions/invocation';

export type ManagedProvisionerFailure = Readonly<{ kind: 'failed'; code: string; requestId?: string;
    nativeCause?: MachineProvisionerNativeCauseV1; details?: ManagedNativeFailureDetailsV1; failureCause?: ActionExecuteFailure['failureCause'] }>
    & Pick<PluginErrorContractData, 'message'> & Pick<PluginActionFailureAuthorPayloadV1, 'remediation'>;
export type ManagedProvisionerClientResult<T> = Exclude<MachinePresetCollectionResult<T>, { kind: 'failed' }>
    | ManagedProvisionerFailure
    | Readonly<{ kind: 'admitted'; receipt: ExternalActionManagedAdmissionReceiptV1 }>;
export type ManagedProvisionerReadResult<T> = Exclude<MachinePresetCollectionResult<T>, { kind: 'approval_pending' } | { kind: 'failed' }>
    | ManagedProvisionerFailure;
export type ManagedProvisionerClientOptions<T> = Omit<MachinePresetCollectionOptions<T>, 'onApprovalFailed'> & Readonly<{
    managedPresetOrigin?: ManagedMachinePresetAcquireOriginV1;
    onApprovalAdmitted?: (receipt: ExternalActionManagedAdmissionReceiptV1) => void;
    onApprovalFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>;
export function projectManagedProvisionerFailure(code: string, details?: unknown, requestId?: string, failureCause?: ActionExecuteFailure['failureCause']): ManagedProvisionerFailure {
    // Only the canonical PluginError payload carries an authored reason; arbitrary transport text stays private.
    const authored = isPluginErrorData(details) && details.code === code ? details : undefined;
    const message = authored?.message?.trim();
    const remediation = PluginDiagnosticRemediationV1Schema.safeParse(authored && 'remediation' in authored ? authored.remediation : undefined);
    const native = ManagedNativeFailureDetailsV1Schema.safeParse(authored && 'details' in authored ? authored.details : details);
    return { kind: 'failed', code, ...(requestId ? { requestId } : {}), ...(message ? { message } : {}),
        ...(failureCause ? { failureCause } : {}),
        ...(remediation.success ? { remediation: remediation.data } : {}),
        ...(native.success ? { details: native.data, nativeCause: native.data.nativeCause } : {}) };
}
function admittedReceipt(actionId: ManagedMachineActionIdV1, code: string, details: unknown) {
    if (actionId !== 'machines.managed.acquire' || code !== 'target_unavailable') return null;
    const parsed = ExternalActionHttpErrorSchema.safeParse(details);
    return parsed.success && 'managedAdmission' in parsed.data ? parsed.data.managedAdmission : null;
}

/** Presentation callers use the captured Home and its ordinary Action admission. */
export function createManagedProvisionerClient(scope: ServerAccountScope, homeId: string) {
    const executeAction = scopedHomeActionExecutor(scope);
    async function execute<T extends ManagedMachineActionIdV1>(actionId: T, input: ManagedMachineActionInputV1<T>,
            options?: ManagedProvisionerClientOptions<ManagedMachineActionOutputV1<T>>): Promise<ManagedProvisionerClientResult<ManagedMachineActionOutputV1<T>>> {
            const parsed = ManagedMachineActionInputSchemasV1[actionId].safeParse(input);
            if (!parsed.success) return { kind: 'failed', code: 'invalid_parameters' };
            const actualHome = 'selection' in parsed.data ? resolveManagedAcquireReviewV1(parsed.data).homeId : parsed.data.homeId;
            if (actualHome !== homeId) return { kind: 'failed', code: 'server_target_mismatch' };
            const matchesRequestedController = (value: ManagedMachineActionOutputV1<T>) => {
                if (actionId !== 'machines.provisioners.list') return true;
                if (!('provisioners' in value)) return false;
                const controller = 'controller' in parsed.data ? parsed.data.controller : undefined;
                return !controller || !value.controller
                    || controller.machineId === value.controller.machineId
                        && controller.installationId === value.controller.installationId;
            };
            // Acquire is the configurator's designed Create after its review.
            // Carry that exact confirmation through the existing front door;
            // explicit approval requirements still belong to Action admission.
            const dispatch = actionId === 'machines.managed.acquire' ? executeAction.confirmed : executeAction;
            const result = await dispatch(actionId, parsed.data, {
                    surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
                    ...(options?.managedPresetOrigin ? { managedPresetOrigin: options.managedPresetOrigin } : {}),
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
            const outcome = observeHomeActionOutcome<ManagedMachineActionOutputV1<T>, T>({
                result, actionId, actionInput: parsed.data, scope, signal: options?.signal,
                onSucceeded: value => {
                    if (matchesRequestedController(value)) options?.onApprovalSucceeded?.(value);
                    else options?.onApprovalFailed?.('invalid_action_output');
                }, onFailed: (code, failure) => {
                    const receipt = admittedReceipt(actionId, code, failure?.details);
                    if (receipt) options?.onApprovalAdmitted?.(receipt);
                    else options?.onApprovalFailed?.(code, failure);
                },
            });
            if (outcome.kind === 'failed') {
                const code = homeDomainFailureCode(outcome.failure);
                const receipt = admittedReceipt(actionId, code, outcome.failure.details);
                return receipt ? { kind: 'admitted', receipt } : projectManagedProvisionerFailure(code, result.ok ? undefined : result.details,
                    actionId === 'machines.managed.acquire' && !result.ok ? result.requestId : undefined,
                    result.ok ? undefined : result.failureCause);
            }
            if (outcome.kind === 'approval_pending') {
                options?.onApprovalPending?.(outcome.approval);
                return outcome;
            }
            const output = readManagedMachineActionOutputV1(actionId, outcome.result);
            return output.success && matchesRequestedController(output.data) ? { kind: 'succeeded', value: output.data as ManagedMachineActionOutputV1<T> }
                : { kind: 'failed', code: 'invalid_action_output' };
        }
    function read<T extends 'machines.provisioners.list' | 'machines.provisioners.check' | 'machines.provisioners.options'>(
        actionId: T, input: ManagedMachineActionInputV1<T>, options?: MachinePresetCollectionOptions<ManagedMachineActionOutputV1<T>>,
    ) {
        type Settled = ManagedProvisionerReadResult<ManagedMachineActionOutputV1<T>>;
        const succeeded = (value: ManagedMachineActionOutputV1<T>): Settled => actionId === 'machines.provisioners.options'
            && 'code' in value && value.code
            ? { kind: 'failed', code: value.code, ...(value.nativeCause ? { nativeCause: value.nativeCause } : {}) }
            : { kind: 'succeeded', value };
        return awaitActionApprovalResult<ManagedMachineActionOutputV1<T>, Settled>({
            execute: async callbacks => {
                const result = await execute(actionId, input, { ...options, ...callbacks });
                if (result.kind === 'admitted') return { kind: 'failed', code: 'invalid_action_output' };
                return result.kind === 'approval_pending' ? { approvalPending: true }
                    : result.kind === 'succeeded' ? succeeded(result.value) : result;
            },
            succeeded, failed: (code, failure) => projectManagedProvisionerFailure(code, failure?.details, undefined, failure?.failureCause),
            aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
        });
    }
    return Object.freeze({ execute, read });
}
