import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, resolveManagedAcquireReviewV1,
    type ManagedMachineActionIdV1, type ManagedMachineActionInputV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { MachinePresetCollectionOptions, MachinePresetCollectionResult } from './machinePresetCollectionClient';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { awaitActionApprovalResult, createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { ExternalActionHttpErrorSchema, type ExternalActionManagedAdmissionReceiptV1 } from '@happier-dev/protocol/actions/externalActionApi';

export type ManagedProvisionerClientResult<T> = MachinePresetCollectionResult<T>
    | Readonly<{ kind: 'admitted'; receipt: ExternalActionManagedAdmissionReceiptV1 }>;
export type ManagedProvisionerClientOptions<T> = MachinePresetCollectionOptions<T> & Readonly<{
    onApprovalAdmitted?: (receipt: ExternalActionManagedAdmissionReceiptV1) => void;
}>;
function admittedReceipt(actionId: ManagedMachineActionIdV1, code: string, details: unknown) {
    if (actionId !== 'machines.managed.acquire' || code !== 'target_unavailable') return null;
    const parsed = ExternalActionHttpErrorSchema.safeParse(details);
    return parsed.success && 'managedAdmission' in parsed.data ? parsed.data.managedAdmission : null;
}

/** Presentation callers use ordinary approval and the captured Home, never a private native-role RPC. */
export function createManagedProvisionerClient(scope: ServerAccountScope, homeId: string) {
    const executeAction = scopedHomeActionExecutor(scope);
    async function execute<T extends ManagedMachineActionIdV1>(actionId: T, input: ManagedMachineActionInputV1<T>,
            options?: ManagedProvisionerClientOptions<ManagedMachineActionOutputV1<T>>): Promise<ManagedProvisionerClientResult<ManagedMachineActionOutputV1<T>>> {
            const parsed = ManagedMachineActionInputSchemasV1[actionId].safeParse(input);
            if (!parsed.success) return { kind: 'failed', code: 'invalid_parameters' };
            const actualHome = 'selection' in parsed.data ? resolveManagedAcquireReviewV1(parsed.data).homeId : parsed.data.homeId;
            if (actualHome !== homeId) return { kind: 'failed', code: 'server_target_mismatch' };
            const matchesRequestedController = (value: unknown) => {
                if (actionId !== 'machines.provisioners.list') return true;
                const request = ManagedMachineActionInputSchemasV1['machines.provisioners.list'].safeParse(parsed.data);
                const catalog = ManagedMachineActionOutputSchemasV1['machines.provisioners.list'].safeParse(value);
                return request.success && catalog.success && (!request.data.controller || !catalog.data.controller
                    || request.data.controller.machineId === catalog.data.controller.machineId
                        && request.data.controller.installationId === catalog.data.controller.installationId);
            };
            const outcome = classifyHomeActionOutcome(await executeAction(actionId, parsed.data, {
                surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
                ...(options?.signal ? { signal: options.signal } : {}),
            }));
            if (outcome.kind === 'failed') {
                const code = homeDomainFailureCode(outcome.failure);
                const receipt = admittedReceipt(actionId, code, outcome.failure.details);
                return receipt ? { kind: 'admitted', receipt } : { kind: 'failed', code };
            }
            if (outcome.kind === 'approval_pending') {
                const approval = createActionApprovalContinuation<ManagedMachineActionOutputV1<T>, T>({
                    artifactId: outcome.artifactId, actionId, scope, expectedInput: parsed.data,
                    ...(options?.signal ? { signal: options.signal } : {}),
                    onSucceeded: value => {
                        if (matchesRequestedController(value)) options?.onApprovalSucceeded?.(value);
                        else options?.onApprovalFailed?.('invalid_action_output');
                    }, onFailed: (code, failure) => {
                        const receipt = admittedReceipt(actionId, code, failure?.details);
                        if (receipt) options?.onApprovalAdmitted?.(receipt);
                        else options?.onApprovalFailed?.(code);
                    },
                });
                options?.onApprovalPending?.(approval);
                return { kind: 'approval_pending', approval };
            }
            const output = ManagedMachineActionOutputSchemasV1[actionId].safeParse(outcome.result);
            return output.success && matchesRequestedController(output.data) ? { kind: 'succeeded', value: output.data as ManagedMachineActionOutputV1<T> }
                : { kind: 'failed', code: 'invalid_action_output' };
        }
    function read<T extends 'machines.provisioners.list' | 'machines.provisioners.check' | 'machines.provisioners.options'>(
        actionId: T, input: ManagedMachineActionInputV1<T>, options?: MachinePresetCollectionOptions<ManagedMachineActionOutputV1<T>>,
    ) {
        type Settled = Exclude<MachinePresetCollectionResult<ManagedMachineActionOutputV1<T>>, { kind: 'approval_pending' }>;
        return awaitActionApprovalResult<ManagedMachineActionOutputV1<T>, Settled>({
            execute: async callbacks => {
                const result = await execute(actionId, input, { ...options, ...callbacks });
                if (result.kind === 'admitted') return { kind: 'failed', code: 'invalid_action_output' };
                return result.kind === 'approval_pending' ? { approvalPending: true } : result;
            },
            succeeded: value => ({ kind: 'succeeded', value }), failed: code => ({ kind: 'failed', code }),
            aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
        });
    }
    return Object.freeze({ execute, read });
}
