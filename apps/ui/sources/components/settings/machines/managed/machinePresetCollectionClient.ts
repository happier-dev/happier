import {
    MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
    type MachinePresetActionIdV1, type MachinePresetActionInputV1, type MachinePresetActionOutputV1,
} from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    awaitActionApprovalResult, createActionApprovalContinuation,
    type ActionApprovalContinuation, type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';

export type MachinePresetCollectionResult<T> =
    | Readonly<{ kind: 'succeeded'; value: T }>
    | Readonly<{ kind: 'approval_pending'; approval: ActionApprovalContinuation }>
    | Readonly<{ kind: 'failed'; code: string }>;
export type MachinePresetCollectionSettledResult<T> = Exclude<MachinePresetCollectionResult<T>, { kind: 'approval_pending' }>;
export type MachinePresetCollectionOptions<T> = Readonly<{
    signal?: AbortSignal;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
    onApprovalSucceeded?: (value: T) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;
export type MachinePresetHistoryData = Readonly<{ preset: ManagedMachinePresetV1; machines: readonly ManagedMachineV1[] }>;

/** Settings reads and mutations all pass through the existing exact-Home Action front door. */
export function createMachinePresetCollectionClient(scope: ServerAccountScope, homeId: string) {
    const executeAction = scopedHomeActionExecutor(scope);
    const context = (signal?: AbortSignal) => ({ surface: 'ui' as const, authority: 'present_user' as const,
        serverId: scope.serverId, expectedAccountId: scope.accountId, ...(signal ? { signal } : {}) });

    async function execute<T extends MachinePresetActionIdV1>(actionId: T, input: MachinePresetActionInputV1<T>,
        options?: MachinePresetCollectionOptions<MachinePresetActionOutputV1<T>>): Promise<MachinePresetCollectionResult<MachinePresetActionOutputV1<T>>> {
        const parsed = MachinePresetActionInputSchemasV1[actionId].safeParse(input);
        if (!parsed.success || parsed.data.homeId !== homeId) return { kind: 'failed', code: 'invalid_parameters' };
        const outcome = classifyHomeActionOutcome(await executeAction(actionId, parsed.data, context(options?.signal)));
        if (outcome.kind === 'failed') return { kind: 'failed', code: homeDomainFailureCode(outcome.failure) };
        if (outcome.kind === 'approval_pending') {
            const approval = createActionApprovalContinuation<MachinePresetActionOutputV1<T>, T>({
                artifactId: outcome.artifactId, actionId, scope, expectedInput: parsed.data,
                ...(options?.signal ? { signal: options.signal } : {}),
                onSucceeded: async value => await options?.onApprovalSucceeded?.(value), onFailed: options?.onApprovalFailed,
            });
            options?.onApprovalPending?.(approval);
            return { kind: 'approval_pending', approval };
        }
        const output = MachinePresetActionOutputSchemasV1[actionId].safeParse(outcome.result);
        return output.success ? { kind: 'succeeded', value: output.data as MachinePresetActionOutputV1<T> }
            : { kind: 'failed', code: 'invalid_action_output' };
    }

    function read<T extends MachinePresetActionIdV1>(actionId: T, input: MachinePresetActionInputV1<T>,
        options?: MachinePresetCollectionOptions<MachinePresetActionOutputV1<T>>) {
        return awaitActionApprovalResult<MachinePresetActionOutputV1<T>, MachinePresetCollectionSettledResult<MachinePresetActionOutputV1<T>>>({
            execute: async callbacks => {
                const result = await execute(actionId, input, { ...options, ...callbacks });
                return result.kind === 'approval_pending' ? { approvalPending: true } : result;
            },
            succeeded: value => ({ kind: 'succeeded', value }), failed: code => ({ kind: 'failed', code }),
            aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
        });
    }

    async function list(options?: MachinePresetCollectionOptions<readonly ManagedMachinePresetV1[]>): Promise<MachinePresetCollectionSettledResult<readonly ManagedMachinePresetV1[]>> {
        const presets: ManagedMachinePresetV1[] = [];
        let cursor: string | undefined;
        do {
            const result = await read('machines.presets.list', { homeId, includeArchived: true, ...(cursor ? { cursor } : {}) },
                { signal: options?.signal, onApprovalPending: options?.onApprovalPending });
            if (result.kind === 'failed') return result;
            if (result.value.kind === 'refused') return { kind: 'failed', code: result.value.code };
            presets.push(...result.value.presets);
            cursor = result.value.cursor;
        } while (cursor);
        return { kind: 'succeeded', value: presets };
    }

    async function detail(id: string, options?: MachinePresetCollectionOptions<MachinePresetHistoryData>): Promise<MachinePresetCollectionSettledResult<MachinePresetHistoryData>> {
        const result = await read('machines.presets.get', { homeId, id }, { signal: options?.signal, onApprovalPending: options?.onApprovalPending });
        if (result.kind === 'failed') return result;
        if (result.value.kind === 'refused') return { kind: 'failed', code: result.value.code };
        // Archived managed rows are not part of the ordinary inventory response. Both reads
        // are required for history; neither modifies a resource or counts client-side capacity.
        const results = await Promise.all([false, true].map(async archived => {
            const input = { homeId, ...(archived ? { archived: true } : {}) };
            return awaitActionApprovalResult<ManagedMachineV1[], MachinePresetCollectionSettledResult<ManagedMachineV1[]>>({
                execute: async callbacks => {
                    const outcome = classifyHomeActionOutcome(await executeAction('machines.managed.list', input, context(options?.signal)));
                    if (outcome.kind === 'failed') return { kind: 'failed', code: homeDomainFailureCode(outcome.failure) };
                    if (outcome.kind === 'approval_pending') {
                        const approval = createActionApprovalContinuation<{ machines: ManagedMachineV1[] }, 'machines.managed.list'>({
                            artifactId: outcome.artifactId, actionId: 'machines.managed.list', scope, expectedInput: input,
                            ...(options?.signal ? { signal: options.signal } : {}),
                            onSucceeded: value => callbacks.onApprovalSucceeded(value.machines), onFailed: callbacks.onApprovalFailed,
                        });
                        options?.onApprovalPending?.(approval);
                        return { approvalPending: true };
                    }
                    const output = ManagedListOutputV1Schema.safeParse(outcome.result);
                    return output.success ? { kind: 'succeeded', value: output.data.machines }
                        : { kind: 'failed', code: 'invalid_action_output' };
                },
                succeeded: value => ({ kind: 'succeeded', value }), failed: code => ({ kind: 'failed', code }),
                aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
            });
        }));
        const failed = results.find(item => item.kind === 'failed');
        if (failed?.kind === 'failed') return failed;
        const rows = results.flatMap(item => item.kind === 'succeeded' ? item.value : [])
            .filter(machine => machine.homeId === homeId && machine.preset?.id === id);
        // A row can move to archive between the two reads; it remains one resource.
        const machines = [...new Map(rows.map(machine => [machine.id, machine])).values()];
        return { kind: 'succeeded', value: { preset: result.value.preset, machines } };
    }

    return Object.freeze({ execute, read, list, detail });
}
