import { createManagedMachinePresetV1Schema, type ManagedMachinePresetCreationV1, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { resolveMachinePoolForManagedPresetInTx } from '@/app/machines/pools/machinePoolService';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { AccountStatus } from '@/storage/enums.generated';
import type { Tx } from '@/storage/inTx';
import { ManagedMachineError, readManagedProjectionFactsInTx, type ManagedDeclaration } from './managedRows';

export type PresetCreation = Pick<ManagedMachinePresetV1, 'homeId'> & ManagedMachinePresetCreationV1
    & Partial<Pick<ManagedMachinePresetV1, 'owner'>>;
export type PresetContext = Readonly<{ accountId: string; authentication?: Partial<TeamOperationAuthenticationContext> }>;

export async function requireManagedLaunchManagerInTx(tx: Tx, context: PresetContext, machineId: string): Promise<void> {
    if ((await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status !== AccountStatus.active
        || await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: context.accountId, machineId }) !== 'manage') {
        throw new ManagedMachineError('permission_denied');
    }
}

/** A known matching declaration validates configuration, without requiring it to be available. */
export function validateManagedPresetLaunchChoices(preset: PresetCreation, declaration: ManagedDeclaration): PresetCreation['launch'] {
    const schema = createManagedMachinePresetV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema));
    const validated = schema.safeParse({ ...preset, id: 'validation', name: 'validation', revision: 0,
        owner: { kind: 'account', accountId: 'validation' } });
    if (!validated.success || !validated.data.launch) throw new ManagedMachineError('invalid_request');
    return validated.data.launch;
}

/** Saving configuration needs its owner's authority; availability is decided by acquisition. */
export async function authorizeMachinePresetCreationSaveInTx(tx: Tx, context: PresetContext, preset: PresetCreation): Promise<void> {
    if (preset.controllerPoolId) {
        const pool = await resolveMachinePoolForManagedPresetInTx(tx, { actorAccountId: context.accountId,
            ...(preset.owner?.kind === 'team' ? { teamId: preset.owner.teamId } : {}),
            poolId: preset.controllerPoolId, presence: { state: 'unavailable' }, authentication: context.authentication });
        if (!pool.ok || pool.value.custodianAccountId !== context.accountId) throw new ManagedMachineError('permission_denied');
        return;
    }
    if (!preset.controller) {
        if (preset.owner?.kind === 'team'
            || (await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status !== AccountStatus.active) {
            throw new ManagedMachineError('permission_denied');
        }
        return;
    }
    await requireManagedLaunchManagerInTx(tx, context, preset.controller.machineId);
    const input = { homeId: preset.homeId, controller: preset.controller, provider: preset.launch.provider };
    const declaration = (await readManagedProjectionFactsInTx(tx, [input])).declarationFor(input);
    if (declaration?.schemaVersion === preset.launch.schemaVersion) validateManagedPresetLaunchChoices(preset, declaration);
}
