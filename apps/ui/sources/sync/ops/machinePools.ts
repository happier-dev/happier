import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import {
    MachinePoolDescriptionV1Schema,
    MachinePoolErrorV1Schema,
    MachinePoolNameV1Schema,
} from '@happier-dev/protocol/machines/pools/v1';
import type {
    MachinePoolActionIdV1,
    MachinePoolActionInputV1,
    MachinePoolActionOutputV1,
} from '@happier-dev/protocol/machines/pools/actionsV1';
import type {
    MachinePoolCreateInputV1,
    MachinePoolDeleteInputV1,
    MachinePoolAudienceV1,
    MachinePoolMemberEligibilityV1,
    MachinePoolResolveInputV1,
    MachinePoolResolveResultV1,
    MachinePoolUpdateInputV1,
    MachinePoolViewV1,
} from '@happier-dev/protocol/machines/pools/v1';
import { randomUUID } from '@/platform/randomUUID';
import { MachinePoolActionError } from '@/sync/api/machines/machinePoolActions';
import { isActionAccountScopeChangedError, withDefaultActionExecuteContext } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveActionsSettingsV1FromState } from '@/sync/domains/settings/actionsSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import type { LazyActionAccountContext } from './actions/actionAccountContext';
import {
    createMachinePoolPrivateLabelClientForAccount,
    openMachinePoolPrivateViewV1,
} from './machinePoolPrivateLabelProjection';

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

type MachinePoolActionPreparation<TActionId extends MachinePoolActionIdV1> = (context: Readonly<{
    account: LazyActionAccountContext;
    settings: Settings;
}>) => Promise<MachinePoolActionInputV1<TActionId>>;

type MachinePoolActionConsumeContext = Readonly<{
    sourceServerId: string;
    sourceAccountId: string;
    labels: ReturnType<typeof createMachinePoolPrivateLabelClientForAccount>;
    assertCurrent: () => void;
}>;

async function executeMachinePoolAction<TActionId extends MachinePoolActionIdV1, TResult>(
    serverId: string,
    actionId: TActionId,
    input: MachinePoolActionInputV1<TActionId> | MachinePoolActionPreparation<TActionId>,
    consume: (result: MachinePoolActionOutputV1<TActionId>, context: MachinePoolActionConsumeContext) => TResult | Promise<TResult>,
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
    }, async (executor, account, settings) => {
        account.assertCurrent();
        storage.getState().beginMachinePoolAccountScope(account.serverId, account.accountId);
        onStart?.(account.serverId, account.accountId);
        const preparedInput = typeof input === 'function'
            ? await input({ account, settings })
            : input;
        account.assertCurrent();
        const labels = createMachinePoolPrivateLabelClientForAccount(account);
        const outcome = await executor.execute(actionId, preparedInput, {
            surface: 'ui',
            serverId: account.serverId,
            runtimeAccountId: account.accountId,
            actionRequestId: machinePoolActionRequestId(actionId, preparedInput, account.accountId),
        });
        account.assertCurrent();
        if (!outcome.ok) {
            const parsedDetail = MachinePoolErrorV1Schema.safeParse(outcome.details);
            if (parsedDetail.success) {
                const currentView = parsedDetail.data.code === 'pool_changed' && parsedDetail.data.current
                    ? await openMachinePoolPrivateViewV1({ view: parsedDetail.data.current, labels })
                    : undefined;
                account.assertCurrent();
                throw new MachinePoolActionError(machinePoolErrorStatus(parsedDetail.data.code), parsedDetail.data, currentView);
            }
            throw new MachinePoolActionRefusedError(String(outcome.errorCode ?? 'unsupported_action'));
        }
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result);
        if (approval.success) throw new MachinePoolActionApprovalPendingError(approval.data.artifactId);
        const result = outcome.result as MachinePoolActionOutputV1<TActionId>;
        account.assertCurrent();
        return await consume(result, {
            sourceServerId: account.serverId,
            sourceAccountId: account.accountId,
            labels,
            assertCurrent: () => account.assertCurrent(),
        });
    });
}

export type MachinePoolCreateDraftV1 = Omit<MachinePoolCreateInputV1, 'poolId' | 'name' | 'description'> & Readonly<{
    poolId?: string;
    name: string;
    description?: string | null;
}>;

export type MachinePoolUpdateDraftV1 = Omit<MachinePoolUpdateInputV1, 'name' | 'description'> & Readonly<{
    name: string;
    description?: string | null;
}>;

function normalizedMachinePoolName(value: string): string {
    return MachinePoolNameV1Schema.parse(value.trim());
}

function normalizedMachinePoolDescription(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return value;
    const normalized = MachinePoolDescriptionV1Schema.parse(value.trim());
    return normalized || null;
}

async function prepareMachinePoolPrivateLabels(params: Readonly<{
    actionId: 'machines.pools.create' | 'machines.pools.update';
    account: LazyActionAccountContext;
    settings: Settings;
    input: Readonly<{
        name: string;
        description?: string | null;
        audience?: MachinePoolCreateInputV1['audience'];
    }>;
    poolId: string;
}>) {
    // This is only an early, non-material-preparation check. The shared executor repeats the
    // canonical policy check after labels are sealed, so a live settings change still wins.
    const actionSettings = resolveActionsSettingsV1FromState({
        settings: params.account.readLiveSettings() ?? params.settings,
    });
    if (!isActionEnabledByActionsSettings(params.actionId, actionSettings, { surface: 'ui' })) {
        throw new MachinePoolActionRefusedError('action_disabled');
    }
    const name = normalizedMachinePoolName(params.input.name);
    const description = normalizedMachinePoolDescription(params.input.description);
    const owner = params.input.audience?.kind === 'team'
        ? { kind: 'team' as const, teamId: params.input.audience.teamId }
        : { kind: 'account' as const, accountId: params.account.accountId };
    const labels = createMachinePoolPrivateLabelClientForAccount(params.account);
    const sealedName = await labels.seal({
        owner,
        binding: { entity: 'machine_pool', field: 'name', id: params.poolId },
        value: name,
    });
    if (!sealedName) throw new MachinePoolActionRefusedError('machine_pool_private_label_unavailable');
    if (description === undefined) return { name: sealedName };
    if (description === null) return { name: sealedName, description: null };
    const sealedDescription = await labels.seal({
        owner,
        binding: { entity: 'machine_pool', field: 'description', id: params.poolId },
        value: description,
    });
    if (!sealedDescription) throw new MachinePoolActionRefusedError('machine_pool_private_label_unavailable');
    return { name: sealedName, description: sealedDescription };
}

export async function refreshMachinePools(serverId: string): Promise<readonly MachinePoolViewV1[]> {
    const normalizedServerId = serverId.trim();
    if (!normalizedServerId) return [];
    let baseline: readonly MachinePoolViewV1[] = [];
    try {
        return await executeMachinePoolAction(normalizedServerId, 'machines.pools.list', {}, async (result, context) => {
            const pools = result.pools;
            context.assertCurrent();
            storage.getState().replaceMachinePools(pools, {
                sourceServerId: context.sourceServerId,
                sourceAccountId: context.sourceAccountId,
                baseline,
            });
            return pools;
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

/** Reads the server admission owner's decision without changing the saved Pool projection. */
export async function getMachinePoolMemberEligibility(serverId: string, machineIds: readonly string[]): Promise<readonly MachinePoolMemberEligibilityV1[]> {
    return await executeMachinePoolAction(serverId, 'machines.pools.list', { memberMachineIds: [...machineIds] }, (result) => {
        if (result.memberEligibility === undefined) throw new Error('Machine Pool eligibility is unavailable.');
        return result.memberEligibility;
    });
}

export async function createMachinePool(serverId: string, input: MachinePoolCreateDraftV1): Promise<MachinePoolViewV1> {
    const poolId = input.poolId ?? randomUUID();
    return await executeMachinePoolAction(serverId, 'machines.pools.create', async ({ account, settings }) => {
        const { name: _name, description: _description, poolId: _poolId, ...definition } = input;
        const labels = await prepareMachinePoolPrivateLabels({
            actionId: 'machines.pools.create',
            account,
            settings,
            input,
            poolId,
        });
        return { ...definition, poolId, ...labels };
    }, async (result, context) => {
        const view = result;
        context.assertCurrent();
        storage.getState().patchMachinePool(view, {
            sourceServerId: context.sourceServerId,
            sourceAccountId: context.sourceAccountId,
        });
        return view;
    });
}

/**
 * An omitted update audience retains the saved Pool audience server-side. Read that structural
 * fact through the same Action front door before sealing, so a Team Pool's label envelopes name
 * its Team readers rather than only the editor. The mutation below pins this observed Account.
 */
async function readMachinePoolUpdateAudience(serverId: string, poolId: string): Promise<Readonly<{
    audience: MachinePoolAudienceV1;
    accountId: string;
}>> {
    return await executeMachinePoolAction(serverId, 'machines.pools.get', { poolId }, (result, context) => {
        context.assertCurrent();
        return {
            audience: result.pool.audience ?? { kind: 'private' },
            accountId: context.sourceAccountId,
        };
    });
}

export async function updateMachinePool(serverId: string, input: MachinePoolUpdateDraftV1): Promise<MachinePoolViewV1> {
    const retainedAudience = input.audience === undefined
        ? await readMachinePoolUpdateAudience(serverId, input.poolId)
        : undefined;
    const effectiveInput = retainedAudience === undefined
        ? input
        : { ...input, audience: retainedAudience.audience };
    return await executeMachinePoolAction(serverId, 'machines.pools.update', async ({ account, settings }) => {
        const { name: _name, description: _description, ...definition } = effectiveInput;
        const labels = await prepareMachinePoolPrivateLabels({
            actionId: 'machines.pools.update',
            account,
            settings,
            input: effectiveInput,
            poolId: effectiveInput.poolId,
        });
        return { ...definition, ...labels };
    }, async (result, context) => {
        const view = result;
        context.assertCurrent();
        storage.getState().patchMachinePool(view, {
            sourceServerId: context.sourceServerId,
            sourceAccountId: context.sourceAccountId,
        });
        return view;
    }, undefined, retainedAudience?.accountId);
}

export async function deleteMachinePool(serverId: string, input: MachinePoolDeleteInputV1): Promise<void> {
    await executeMachinePoolAction(serverId, 'machines.pools.delete', input, (_result, context) => {
        storage.getState().removeMachinePool(input.poolId, {
            sourceServerId: context.sourceServerId,
            sourceAccountId: context.sourceAccountId,
        });
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
