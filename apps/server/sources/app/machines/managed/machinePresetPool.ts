import type { ManagedMachinePresetCreationV1, ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachinePoolResolveInputV1, MachinePoolResolveResultV1 } from '@happier-dev/protocol/machines/pools/v1';
import { createQualifiedConnectedAccountIdentityDigest } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { listQualifiedConnectedAccountsInTx } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { resolveMachinePoolForManagedPresetInTx } from '@/app/machines/pools/machinePoolService';
import { getMachineDaemonPresenceInventory, type MachineDaemonPresenceInventory, type MachineDaemonPresenceSocketServer } from '@/app/machines/machineDaemonPresence';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { ManagedMachineError, projectManagedControllerAccess, readManagedProjectionFactsInTx, sameManagedInput } from './managedRows';
import { getMachinePresetInTx, resolveMachinePresetForAcquireInTx, validateStoredManagedLaunchInTx } from './machinePresetService';
import { buildManagedPresetSavedReview } from './machinePresetReview';

type Context = Readonly<{ accountId: string; authentication?: Partial<TeamOperationAuthenticationContext> }>;
type Creation = Pick<ManagedMachinePresetV1, 'homeId'> & ManagedMachinePresetCreationV1
    & Partial<Pick<ManagedMachinePresetV1, 'owner'>>;

/** Pool authority stays internal: neither the roster nor private declarations leave this owner. */
export async function readManagedPresetPoolCandidatesInTx(tx: Tx, context: Context, preset: Creation,
    presence: MachineDaemonPresenceInventory = { state: 'unavailable' }) {
    if (!preset.controllerPoolId) throw new ManagedMachineError('invalid_request');
    const pool = await resolveMachinePoolForManagedPresetInTx(tx, { actorAccountId: context.accountId,
        poolId: preset.controllerPoolId, ...(preset.owner?.kind === 'team' ? { teamId: preset.owner.teamId } : {}),
        authentication: context.authentication, presence });
    if (!pool.ok) throw new ManagedMachineError('controller_unavailable');
    const { custodianAccountId, snapshot } = pool.value;
    const machineIds = snapshot.members.filter(member => member.enabled).map(member => member.machineId);
    // No enabled member is the pool's state, which its managers can change; it is not an unavailable controller.
    if (!machineIds.length) throw new ManagedMachineError('pool_no_available_machine');
    const controllers: ManagedControllerV1[] = [];
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const rows = await tx.machine.findMany({ where: { id: { in: [...ids] }, accountId: custodianAccountId },
            select: { id: true, installationId: true } });
        for (const row of rows) if (row.installationId) controllers.push({ machineId: row.id, installationId: row.installationId });
    }
    const inputs = controllers.map(controller => ({ homeId: preset.homeId, custodianAccountId, controller, provider: preset.launch.provider }));
    const facts = await readManagedProjectionFactsInTx(tx, inputs);
    const profiles = await listQualifiedConnectedAccountsInTx(tx, { accountId: custodianAccountId,
        refs: (preset.launch.credentials ?? []).flatMap(credential => 'account' in credential ? [credential.account] : []) });
    const credentials = new Map([[custodianAccountId, new Map(profiles.map(profile => [createQualifiedConnectedAccountIdentityDigest(profile.ref), profile]))]]);
    const candidates: Array<Omit<Awaited<ReturnType<typeof validateStoredManagedLaunchInTx>>, 'controller'> & {
        controller: ManagedControllerV1;
        access: NonNullable<ReturnType<typeof projectManagedControllerAccess>>;
    }> = [];
    let refusal: ConstructorParameters<typeof ManagedMachineError>[0] = 'controller_unavailable';
    const { controllerPoolId: _pool, ...definition } = preset;
    for (const controller of controllers) {
        try {
            const validated = await validateStoredManagedLaunchInTx(tx, { ...definition, controller }, credentials, facts);
            if (validated.declaration.accountAcquire) throw new ManagedMachineError('provider_unavailable');
            const access = projectManagedControllerAccess(validated.controller, controller);
            if (access && validated.controller.active) candidates.push({ ...validated, controller, access });
            else refusal = 'controller_unavailable';
        } catch (error) {
            if (!(error instanceof ManagedMachineError)) throw error;
            refusal = error.code;
        }
    }
    if (!candidates.length) throw new ManagedMachineError(refusal);
    // Presence does not pin review. Every enabled compatible installation, including offline ones, must agree.
    const review = (declaration: typeof candidates[number]['declaration']) => ({
        provisioner: declaration.provisioner, billing: declaration.billing, retention: declaration.retention,
    });
    if (candidates.some(candidate => !sameManagedInput(review(candidate.declaration), review(candidates[0]!.declaration)))) {
        throw new ManagedMachineError('provider_unavailable');
    }
    return { custodianAccountId, snapshot, candidates };
}

/** The only pool selection: fresh acquire resolves once; admission later consumes its exact input. */
export async function resolveManagedPresetPool(params: Context & Readonly<{
    input: Extract<MachinePoolResolveInputV1, { purpose: 'managed-preset' }>;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<Readonly<{ ok: true; value: MachinePoolResolveResultV1 }>> {
    const unavailable = (code: ConstructorParameters<typeof ManagedMachineError>[0],
        reason: Extract<MachinePoolResolveResultV1, { kind: 'unavailable' }>['reason'] = 'managed_preset_unavailable') =>
        ({ ok: true as const, value: { kind: 'unavailable' as const, poolId: params.input.poolId, reason, code } });
    try {
        const initial = await inReadSnapshot(async tx => {
            const found = await getMachinePresetInTx(tx, { ...params, input: { homeId: params.input.preset.homeId, id: params.input.preset.id } });
            if (found.kind === 'refused') throw new ManagedMachineError(found.code);
            const preset = found.preset;
            if (preset.revision !== params.input.preset.revision) throw new ManagedMachineError('request_conflict');
            if (preset.controllerPoolId !== params.input.poolId) throw new ManagedMachineError('permission_denied');
            if (preset.delegatedAcquire?.kind === 'unavailable') throw new ManagedMachineError(preset.delegatedAcquire.code);
            const pool = await resolveMachinePoolForManagedPresetInTx(tx, { actorAccountId: params.accountId,
                authentication: params.authentication, poolId: params.input.poolId,
                ...(preset.owner.kind === 'team' ? { teamId: preset.owner.teamId } : {}), presence: { state: 'unavailable' } });
            if (!pool.ok) throw new ManagedMachineError('controller_unavailable');
            return pool.value;
        });
        if (!initial.snapshot.members.some(member => member.enabled)) return unavailable('pool_no_available_machine', 'empty');
        const presence = await getMachineDaemonPresenceInventory({ accountId: initial.custodianAccountId, io: params.io,
            machineIds: initial.snapshot.members.filter(member => member.enabled).map(member => member.machineId) });
        if (presence.state === 'unavailable') return unavailable('controller_unavailable', 'presence_unavailable');
        if (presence.machineIds.size === 0) return unavailable('controller_unavailable',
            presence.state === 'known' ? 'no_available_machine' : 'presence_unavailable');
        const selected = await inReadSnapshot(tx => resolveMachinePresetForAcquireInTx(tx, { ...params,
            ...params.input.preset, checkCapacity: false, poolSelection: { requestKey: params.input.requestKey, presence } }));
        if (selected.kind === 'conflict') return unavailable('request_conflict');
        if (selected.kind === 'refused') return unavailable(selected.code);
        const controller = selected.preset.controller;
        if (!controller || !selected.controllerAccess || selected.poolPriorityTier === undefined) throw new ManagedMachineError('controller_unavailable');
        const reviewedFacts = buildManagedPresetSavedReview(selected.preset, selected.declaration, controller);
        // Own invocations retain saved references for admission; delegated invocations never disclose them.
        return { ok: true, value: { kind: 'resolved', poolId: params.input.poolId, machineId: controller.machineId,
            priorityTier: selected.poolPriorityTier, managedPreset: { controller, controllerAccess: selected.controllerAccess,
                provisioner: selected.declaration.provisioner,
                reviewedFacts: selected.delegated ? reviewedFacts : { ...reviewedFacts, launch: { ...selected.preset.launch, name: reviewedFacts.launch.name } } } } };
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return unavailable(error.code, error.code === 'controller_unavailable' ? 'no_available_machine' : 'managed_preset_unavailable');
    }
}
