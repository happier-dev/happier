import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachinePoolErrorV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import type {
    MachinePoolActionIdV1,
    MachinePoolActionInputV1,
    MachinePoolActionOutputV1,
    MachinePoolCreateInputV1,
    MachinePoolDeleteInputV1,
    MachinePoolResolveInputV1,
    MachinePoolResolveResultV1,
    MachinePoolUpdateInputV1,
    MachinePoolViewV1,
} from '@happier-dev/protocol';
import { randomUUID } from '@/platform/randomUUID';
import { MachinePoolActionError } from '@/sync/api/machines/machinePoolActions';
import { isActionAccountScopeChangedError, withDefaultActionExecuteContext } from '@/sync/ops/actions/defaultActionExecutor';
import { storage } from '@/sync/domains/state/storage';

/** A refusal from the shared Action front door: this intent never reached the Home. */
export class MachinePoolActionRefusedError extends Error {
    constructor(public readonly errorCode: string) {
        super(errorCode);
        this.name = 'MachinePoolActionRefusedError';
        Object.setPrototypeOf(this, MachinePoolActionRefusedError.prototype);
    }
}

/**
 * The shared approval policy deferred this intent: an approval request exists and the Home has not
 * been changed. It is neither a failure nor a result, so nothing may be published for it.
 */
export class MachinePoolActionApprovalPendingError extends Error {
    constructor(public readonly artifactId: string) {
        super('machine_pool_action_approval_pending');
        this.name = 'MachinePoolActionApprovalPendingError';
        Object.setPrototypeOf(this, MachinePoolActionApprovalPendingError.prototype);
    }
}

function machinePoolErrorStatus(errorCode: string): number {
    if (errorCode === 'pool_changed') return 409;
    if (errorCode === 'pool_not_found') return 404;
    if (errorCode === 'invalid_request' || errorCode === 'member_machine_not_eligible') return 400;
    return 500;
}

function machinePoolActionRequestId<TActionId extends MachinePoolActionIdV1>(
    actionId: TActionId,
    input: MachinePoolActionInputV1<TActionId>,
    accountId: string,
): string {
    const value = input as Readonly<{ poolId?: string; requestKey?: string; expectedRevision?: number }>;
    if (value.requestKey) return `${actionId}:${value.requestKey}`;
    if (value.poolId) {
        return `${actionId}:${value.poolId}${value.expectedRevision === undefined ? '' : `:${value.expectedRevision}`}`;
    }
    return `${actionId}:${accountId}`;
}

async function executeMachinePoolAction<TActionId extends MachinePoolActionIdV1, TResult>(
    serverId: string,
    actionId: TActionId,
    input: MachinePoolActionInputV1<TActionId>,
    consume: (result: MachinePoolActionOutputV1<TActionId>, sourceServerId: string, sourceAccountId: string) => TResult,
    onStart?: (sourceServerId: string, sourceAccountId: string) => void,
    expectedAccountId?: string,
    onCurrentError?: (error: unknown) => void,
): Promise<TResult> {
    const normalizedServerId = serverId.trim();
    if (!normalizedServerId) throw new Error('action_home_not_found');
    return await withDefaultActionExecuteContext(undefined, {
        serverId: normalizedServerId,
        ...(expectedAccountId !== undefined ? { expectedAccountId } : {}),
        ...(onCurrentError !== undefined ? { onCurrentError } : {}),
    }, async (executor, account) => {
        account.assertCurrent();
        storage.getState().beginMachinePoolAccountScope(account.serverId, account.accountId);
        onStart?.(account.serverId, account.accountId);
        const outcome = await executor.execute(actionId, input, {
            surface: 'ui',
            serverId: account.serverId,
            runtimeAccountId: account.accountId,
            actionRequestId: machinePoolActionRequestId(actionId, input, account.accountId),
        });
        account.assertCurrent();
        if (!outcome.ok) {
            const parsedDetail = MachinePoolErrorV1Schema.safeParse(outcome.details);
            if (parsedDetail.success) {
                throw new MachinePoolActionError(machinePoolErrorStatus(parsedDetail.data.code), parsedDetail.data);
            }
            throw new MachinePoolActionRefusedError(String(outcome.errorCode ?? 'unsupported_action'));
        }
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result);
        if (approval.success) throw new MachinePoolActionApprovalPendingError(approval.data.artifactId);
        const result = outcome.result as MachinePoolActionOutputV1<TActionId>;
        account.assertCurrent();
        return consume(result, account.serverId, account.accountId);
    });
}

export async function refreshMachinePools(serverId: string): Promise<readonly MachinePoolViewV1[]> {
    const normalizedServerId = serverId.trim();
    if (!normalizedServerId) return [];
    let baseline: readonly MachinePoolViewV1[] = [];
    try {
        return await executeMachinePoolAction(normalizedServerId, 'machines.pools.list', {}, (result, sourceServerId, sourceAccountId) => {
            storage.getState().replaceMachinePools(result.pools, { sourceServerId, sourceAccountId, baseline });
            return result.pools;
        }, (sourceServerId) => {
            storage.getState().setMachinePoolListStatus(sourceServerId, 'loading');
            baseline = storage.getState().machinePoolListByServerId[sourceServerId] ?? [];
        });
    } catch (error) {
        if (isActionAccountScopeChangedError(error)) throw error;
        storage.getState().setMachinePoolListStatus(
            normalizedServerId,
            String((error as Error)?.message) === 'action_home_signed_out' ? 'signedOut' : 'error',
        );
        throw error;
    }
}

export async function createMachinePool(serverId: string, input: Omit<MachinePoolCreateInputV1, 'poolId'> & Readonly<{ poolId?: string }>): Promise<MachinePoolViewV1> {
    const poolId = input.poolId ?? randomUUID();
    return await executeMachinePoolAction(serverId, 'machines.pools.create', { ...input, poolId }, (result, sourceServerId, sourceAccountId) => {
        storage.getState().patchMachinePool(result, { sourceServerId, sourceAccountId });
        return result;
    });
}

export async function updateMachinePool(serverId: string, input: MachinePoolUpdateInputV1): Promise<MachinePoolViewV1> {
    return await executeMachinePoolAction(serverId, 'machines.pools.update', input, (result, sourceServerId, sourceAccountId) => {
        storage.getState().patchMachinePool(result, { sourceServerId, sourceAccountId });
        return result;
    });
}

export async function deleteMachinePool(serverId: string, input: MachinePoolDeleteInputV1): Promise<void> {
    await executeMachinePoolAction(serverId, 'machines.pools.delete', input, (_result, sourceServerId, sourceAccountId) => {
        storage.getState().removeMachinePool(input.poolId, { sourceServerId, sourceAccountId });
    });
}

export async function resolveMachinePool(
    serverId: string,
    input: MachinePoolResolveInputV1,
    options?: Readonly<{
        expectedAccountId: string;
        /** Runs synchronously while the exact Home/Account Action lifetime is still current. */
        onSettled?: (settlement:
            | Readonly<{ kind: 'result'; result: MachinePoolResolveResultV1 }>
            | Readonly<{ kind: 'error'; error: unknown }>) => void;
    }>,
) {
    return await executeMachinePoolAction(
        serverId,
        'machines.pools.resolve',
        input,
        (result) => {
            options?.onSettled?.({ kind: 'result', result });
            return result;
        },
        undefined,
        options?.expectedAccountId,
        (error) => options?.onSettled?.({ kind: 'error', error }),
    );
}
