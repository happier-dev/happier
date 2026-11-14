import type {
    PrivateLabelBindingV1,
    PrivateLabelReadPolicyV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import type {
    MachinePoolPrivateLabelProjectionV1,
    MachinePoolPrivateViewV1,
    MachinePoolViewV1,
} from '@happier-dev/protocol/machines/pools/v1';

import { t } from '@/text';
import {
    createPrivateLabelClientForActionAccountContext,
    isPrivateLabelLifecycleFailureV1,
    type PrivateLabelActionAccountContextV1,
    type PrivateLabelOpenInputV1,
} from '@/sync/ops/privateLabels/privateLabelClient';
import type { LazyActionAccountContext } from './actions/actionAccountContext';

type MachinePoolPrivateLabelOpenerV1 = Readonly<{
    open(input: PrivateLabelOpenInputV1): Promise<string | null>;
    readPolicyForPool(view: MachinePoolPrivateViewV1, signal?: AbortSignal): Promise<PrivateLabelReadPolicyV1>;
}>;

type MachinePoolPrivateLabelAccountContext = PrivateLabelActionAccountContextV1 & Pick<LazyActionAccountContext, 'resolveAccountMode'>;

type OpenedMachinePoolPrivateLabelV1 =
    | Readonly<{ kind: 'available'; value: string }>
    | Readonly<{ kind: 'unavailable' }>;

function machinePoolPrivateLabelBinding(poolId: string, field: 'name' | 'description'): PrivateLabelBindingV1 {
    return { entity: 'machine_pool', field, id: poolId };
}

async function openMachinePoolPrivateLabelV1(params: Readonly<{
    poolId: string;
    field: 'name' | 'description';
    label: MachinePoolPrivateLabelProjectionV1 | null;
    labels: MachinePoolPrivateLabelOpenerV1;
    readPolicy: PrivateLabelReadPolicyV1;
    signal?: AbortSignal;
}>): Promise<OpenedMachinePoolPrivateLabelV1> {
    params.signal?.throwIfAborted();
    if (!params.label || params.label.kind !== 'available') return { kind: 'unavailable' };
    try {
        const value = await params.labels.open({
            binding: machinePoolPrivateLabelBinding(params.poolId, params.field),
            label: params.label.label,
            readPolicy: params.readPolicy,
            ...(params.signal ? { signal: params.signal } : {}),
        });
        params.signal?.throwIfAborted();
        return value === null ? { kind: 'unavailable' } : { kind: 'available', value };
    } catch (error) {
        if (isPrivateLabelLifecycleFailureV1(error, params.signal)) throw error;
        return { kind: 'unavailable' };
    }
}

/** Opens a recipient-only server view before it reaches local Pool presentation state. */
export async function openMachinePoolPrivateViewV1(params: Readonly<{
    view: MachinePoolPrivateViewV1;
    labels: MachinePoolPrivateLabelOpenerV1;
    signal?: AbortSignal;
}>): Promise<MachinePoolViewV1> {
    const readPolicy = await params.labels.readPolicyForPool(params.view, params.signal);
    params.signal?.throwIfAborted();
    const name = await openMachinePoolPrivateLabelV1({
        poolId: params.view.pool.id,
        field: 'name',
        label: params.view.pool.name,
        labels: params.labels,
        readPolicy,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    const description = await openMachinePoolPrivateLabelV1({
        poolId: params.view.pool.id,
        field: 'description',
        label: params.view.pool.description,
        labels: params.labels,
        readPolicy,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    return {
        ...params.view,
        pool: {
            ...params.view.pool,
            name: name.kind === 'available' ? name.value : t('common.unavailable'),
            description: description.kind === 'available' ? description.value : null,
        },
    };
}

/** Binds the canonical private-label adapter to this exact Action Account lifetime. */
export function createMachinePoolPrivateLabelClientForAccount(account: MachinePoolPrivateLabelAccountContext) {
    let accountOwnedReadPolicy: Promise<PrivateLabelReadPolicyV1> | undefined;
    const client = createPrivateLabelClientForActionAccountContext(account);
    return {
        ...client,
        readPolicyForPool: async (view: MachinePoolPrivateViewV1, signal?: AbortSignal): Promise<PrivateLabelReadPolicyV1> => {
            signal?.throwIfAborted();
            if (view.pool.audience?.kind === 'team') return { kind: 'team-resource' };
            accountOwnedReadPolicy ??= (async () => {
                const contentEncryptionMode = await account.resolveAccountMode(signal);
                account.assertCurrent();
                return { kind: 'account-owned', contentEncryptionMode };
            })();
            return await accountOwnedReadPolicy;
        },
    };
}
