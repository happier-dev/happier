import {
    MachineEnvironmentApplyInputV1Schema, MachineEnvironmentReportInputV1Schema,
    MachineEnvironmentResolveResultV1Schema, ManagedMachineEnvironmentSetupV1Schema,
    ManagedMutationInputV1Schema, createStoredReadSchema, parseSavedSecretRefV1,
    type MachineEnvironmentApplyInputV1, type MachineEnvironmentReportInputV1,
    type ManagedMachineActionInputV1, type ManagedMachineV1,
} from '@happier-dev/protocol';
import { inTx, type Tx } from '@/storage/inTx';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { getMachinePresetInTx } from './machinePresetService';
import { requireManagedMachineAccessInTx } from './managedRead';
import {
    ManagedMachineError, readManagedMachineInTx, projectManagedMachineInTx,
    invalidateManagedMachineInTx, type StoredManagedMachine,
} from './managedRows';

const setupReadSchema = createStoredReadSchema(ManagedMachineEnvironmentSetupV1Schema);
function readSetup(row: StoredManagedMachine) {
    const parsed = setupReadSchema.safeParse(row.environmentSetup);
    if (!parsed.success) throw new ManagedMachineError('request_conflict');
    return parsed.data;
}

async function requireTargetInTx(tx: Tx, params: Readonly<{
    actorAccountId: string; custodianAccountId: string; input: MachineEnvironmentApplyInputV1;
}>) {
    if (await readCurrentServerIdentityId(process.env, tx) !== params.input.homeId) throw new ManagedMachineError('permission_denied');
    const machine = await tx.machine.findUnique({ where: { id: params.input.machineId } });
    if (!machine || machine.accountId !== params.custodianAccountId
        || classifyMachineAvailabilityState(machine) !== 'available'
        || await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: params.actorAccountId, machineId: machine.id }) !== 'manage') {
        throw new ManagedMachineError('permission_denied');
    }
    return machine;
}

function requireCreationSetup(row: StoredManagedMachine, input: MachineEnvironmentApplyInputV1) {
    if (row.homeId !== input.homeId || row.enrolledMachineId !== input.machineId
        || row.presetId !== input.presetId || row.presetRevision !== input.presetRevision
        || row.creationState !== 'active' || row.archivedAt !== null || row.allocation !== 'bound'
        || row.desired === 'delete') throw new ManagedMachineError('intent_changed');
    return readSetup(row);
}

/** Creation consumes its admitted snapshot; an independent apply consumes the current accessible preset. */
export async function resolveMachineEnvironment(params: Readonly<{
    actorAccountId: string; custodianAccountId: string; authentication?: TeamOperationAuthenticationContext;
    input: MachineEnvironmentApplyInputV1; creationManagedId?: string;
}>): Promise<ReturnType<typeof MachineEnvironmentResolveResultV1Schema.parse>> {
    const input = MachineEnvironmentApplyInputV1Schema.parse(params.input);
    return inTx(async tx => {
        const target = await requireTargetInTx(tx, { ...params, input });
        const row = await tx.managedMachine.findUnique({ where: { enrolledMachineId: input.machineId } });
        if (params.creationManagedId && row?.id !== params.creationManagedId) throw new ManagedMachineError('resource_mismatch');
        if (row && row.environmentSetup !== null
            && (params.creationManagedId || row.presetId === input.presetId)) {
            const setup = readSetup(row);
            if (params.creationManagedId || ['pending', 'running', 'failed'].includes(setup.state)) {
                await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
                requireCreationSetup(row, input);
                if (row.custodianAccountId !== target.accountId || setup.state === 'skipped' || setup.state === 'succeeded') {
                    throw new ManagedMachineError('intent_changed');
                }
                return { environment: setup.environment, managedId: row.id };
            }
        }
        const result = await getMachinePresetInTx(tx, { accountId: params.actorAccountId, authentication: params.authentication,
            input: { homeId: input.homeId, id: input.presetId } });
        if (result.kind === 'refused') throw new ManagedMachineError(result.code);
        const preset = result.preset;
        if (preset.revision !== input.presetRevision) throw new ManagedMachineError('request_conflict');
        if (preset.archivedAt !== undefined) throw new ManagedMachineError('preset_archived');
        if (!preset.environment) throw new ManagedMachineError('invalid_request');
        const source = await tx.machine.findUnique({ where: { id: preset.controller.machineId }, select: { accountId: true } });
        if (source?.accountId !== target.accountId && Object.values(preset.environment.secretRefs?.bindings ?? {})
            .some(binding => parseSavedSecretRefV1(binding.ref).kind === 'personal')) throw new ManagedMachineError('credential_unavailable');
        return { environment: preset.environment };
    });
}

/** Reports can change only the exact enrolled creation stage and its current operation. */
export async function reportMachineEnvironment(params: Readonly<{
    actorAccountId: string; custodianAccountId: string; input: MachineEnvironmentReportInputV1;
    creationManagedId?: string;
}>): Promise<Readonly<{ machine: ManagedMachineV1 }>> {
    const input = MachineEnvironmentReportInputV1Schema.parse(params.input);
    if (input.state !== 'failed' && input.errorCode !== undefined) throw new ManagedMachineError('invalid_request');
    return inTx(async tx => {
        await requireTargetInTx(tx, { ...params, input });
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, true);
        if (row.custodianAccountId !== params.custodianAccountId || params.creationManagedId && row.id !== params.creationManagedId) {
            throw new ManagedMachineError('permission_denied');
        }
        const setup = requireCreationSetup(row, input);
        const sameOperation = setup.operation?.operationId === input.operation.operationId;
        if (sameOperation && setup.state === input.state) return { machine: await projectManagedMachineInTx(tx, row) };
        if (input.state === 'running' ? !['pending', 'failed'].includes(setup.state) : setup.state !== 'running' || !sameOperation) {
            throw new ManagedMachineError('intent_changed');
        }
        const next = ManagedMachineEnvironmentSetupV1Schema.parse({ environment: setup.environment, state: input.state,
            operation: input.operation, ...(input.errorCode ? { errorCode: input.errorCode } : {}) });
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
            creationState: 'active', archivedAt: null, allocation: 'bound', desired: { not: 'delete' },
            enrolledMachineId: input.machineId, environmentSetup: { equals: row.environmentSetup } }, data: { environmentSetup: next } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current) };
    });
}

/** Continue without setup preserves the enrolled Machine and native resource; stale reports cannot reverse it. */
export async function skipManagedMachineSetup(params: Readonly<{
    actorAccountId: string; input: ManagedMachineActionInputV1<'machines.managed.setup.skip'>;
}>): Promise<ManagedMachineV1> {
    const input = ManagedMutationInputV1Schema.parse(params.input);
    return inTx(async tx => {
        if (await readCurrentServerIdentityId(process.env, tx) !== input.homeId) throw new ManagedMachineError('permission_denied');
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, true);
        if (row.intentRevision !== input.expectedIntentRevision || !row.enrolledMachineId || !row.presetId || row.presetRevision === null) {
            throw new ManagedMachineError('intent_changed');
        }
        const setup = requireCreationSetup(row, { homeId: row.homeId, machineId: row.enrolledMachineId,
            presetId: row.presetId, presetRevision: row.presetRevision });
        if (setup.state === 'skipped') return projectManagedMachineInTx(tx, row);
        if (setup.state === 'succeeded' || setup.state === 'running') throw new ManagedMachineError('intent_changed');
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
            creationState: 'active', archivedAt: null, desired: { not: 'delete' }, environmentSetup: { equals: row.environmentSetup } },
            data: { environmentSetup: { environment: setup.environment, state: 'skipped', ...(setup.operation ? { operation: setup.operation } : {}) } } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return projectManagedMachineInTx(tx, current);
    });
}
