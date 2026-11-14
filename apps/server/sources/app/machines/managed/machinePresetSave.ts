import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { resolveMachinePoolForManagedPresetInTx } from '@/app/machines/pools/machinePoolService';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { AccountStatus } from '@/storage/enums.generated';
import type { Tx } from '@/storage/inTx';
import { ManagedMachineError } from './managedRows';

/** Structural save target only; private preset content is admitted separately. */
export type PresetCreation = Pick<ManagedMachinePresetV1, 'homeId'>
    & Partial<Pick<ManagedMachinePresetV1, 'owner' | 'controller' | 'controllerPoolId'>>;

export type PresetContext = Readonly<{
    accountId: string;
    authentication?: Partial<TeamOperationAuthenticationContext>;
}>;

export async function requireManagedLaunchManagerInTx(tx: Tx, context: PresetContext, machineId: string): Promise<void> {
    if ((await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status !== AccountStatus.active
        || await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: context.accountId, machineId }) !== 'manage') {
        throw new ManagedMachineError('permission_denied');
    }
}

/** Saving selects an owner/controller/pool once; availability remains an acquire-time concern. */
export async function authorizeMachinePresetCreationSaveInTx(tx: Tx, context: PresetContext, preset: PresetCreation): Promise<void> {
    if (preset.controllerPoolId) {
        const pool = await resolveMachinePoolForManagedPresetInTx(tx, {
            actorAccountId: context.accountId,
            ...(preset.owner?.kind === 'team' ? { teamId: preset.owner.teamId } : {}),
            poolId: preset.controllerPoolId,
            presence: { state: 'unavailable' },
            authentication: context.authentication,
        });
        if (!pool.ok || pool.value.custodianAccountId !== context.accountId) {
            throw new ManagedMachineError('permission_denied');
        }
        return;
    }
    if (!preset.controller) {
        if ((await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status !== AccountStatus.active) {
            throw new ManagedMachineError('permission_denied');
        }
        return;
    }
    await requireManagedLaunchManagerInTx(tx, context, preset.controller.machineId);
}
