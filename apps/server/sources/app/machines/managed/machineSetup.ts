import { MachineSetupResolveInputV1Schema, MachineSetupReportInputV1Schema, MachineSetupResolveResultV1Schema, ManagedMutationInputV1Schema, type MachineSetupResolveInputV1, type MachineSetupPresetApplyInputV1, type MachineSetupReportInputV1, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineSetupV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { matchesMachineSetupCreationSourcesV1 } from '@happier-dev/protocol';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { getMachinePresetInTx } from './machinePresetService';
import { requireManagedCreationAccessInTx, requireManagedMachineAccessInTx, projectManagedMachineForActorInTx } from './managedRead';
import {
    ManagedMachineError, readManagedMachineInTx,
    invalidateManagedMachineInTx, inManagedMachinePublicationTx, type StoredManagedMachine,
    readManagedJsonEqualityOperand,
    readManagedEnrollmentAccountId,
} from './managedRows';

const setupReadSchema = createStoredReadSchema(ManagedMachineSetupV1Schema);
function readSetup(row: StoredManagedMachine) {
    const parsed = setupReadSchema.safeParse(row.machineSetup);
    if (!parsed.success) throw new ManagedMachineError('request_conflict');
    return parsed.data;
}

async function requireTargetInTx(tx: Tx, params: Readonly<{
    actorAccountId: string; custodianAccountId: string; input: Readonly<{ homeId: string; machineId: string }>;
    admittedMachineRole?: MachineAccessRoleV1;
}>) {
    if (await readCurrentServerIdentityId(process.env, tx) !== params.input.homeId) throw new ManagedMachineError('permission_denied');
    const machine = await tx.machine.findUnique({ where: { id: params.input.machineId } });
    if (!machine || machine.accountId !== params.custodianAccountId
        || classifyMachineAvailabilityState(machine) !== 'available'
        || (params.admittedMachineRole ?? await resolveEffectiveMachineRoleInTx(tx,
            { actorAccountId: params.actorAccountId, machineId: machine.id })) !== 'manage') {
        throw new ManagedMachineError('permission_denied');
    }
    return machine;
}

function requireCreationSetup(row: StoredManagedMachine, input: MachineSetupPresetApplyInputV1) {
    if (row.homeId !== input.homeId || row.enrolledMachineId !== input.machineId
        || row.presetId !== input.presetId || row.presetRevision !== input.presetRevision
        || row.creationState !== 'active' || row.archivedAt !== null || row.allocation !== 'bound'
        || row.desired === 'delete') throw new ManagedMachineError('intent_changed');
    return readSetup(row);
}

/** Creation consumes its admitted snapshot; an independent apply consumes the current accessible preset. */
export async function resolveMachineSetup(params: Readonly<{
    actorAccountId: string; custodianAccountId: string; authentication?: TeamOperationAuthenticationContext;
    admittedMachineRole?: MachineAccessRoleV1;
    input: MachineSetupResolveInputV1; creationManagedId?: string;
}>): Promise<ReturnType<typeof MachineSetupResolveResultV1Schema.parse>> {
    const input = MachineSetupResolveInputV1Schema.parse(params.input);
    return inReadSnapshot(async tx => {
        const target = await requireTargetInTx(tx, { ...params, input });
        const row = await tx.managedMachine.findUnique({ where: { enrolledMachineId: input.machineId } });
        if (params.creationManagedId && row?.id !== params.creationManagedId) throw new ManagedMachineError('resource_mismatch');
        if ('purpose' in input) {
            const absent = { purpose: 'creationOrigin' as const };
            if (!row || !row.presetId || row.presetRevision === null || row.machineSetup === null) {
                if (params.creationManagedId) throw new ManagedMachineError('intent_changed');
                return absent;
            }
            const setup = readSetup(row);
            const candidate = input.candidates.find(candidate => candidate.kind === 'accountPreset'
                && candidate.presetId === row.presetId && candidate.presetRevision === row.presetRevision
                && sameStrictJsonValue(candidate.setup, setup.setup));
            if (!candidate || !['pending', 'failed'].includes(setup.state)) {
                if (params.creationManagedId) throw new ManagedMachineError('intent_changed');
                return absent;
            }
            if (params.creationManagedId && (input.candidates.length !== 1 || !sameStrictJsonValue(candidate,
                { kind: 'accountPreset', presetId: row.presetId, presetRevision: row.presetRevision, setup: setup.setup }))) {
                throw new ManagedMachineError('intent_changed');
            }
            await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
            requireCreationSetup(row, { homeId: input.homeId, machineId: input.machineId,
                presetId: row.presetId, presetRevision: row.presetRevision });
            if (readManagedEnrollmentAccountId(row) !== target.accountId) throw new ManagedMachineError('permission_denied');
            return { purpose: 'creationOrigin' as const, creation: { managedId: row.id,
                preset: { id: row.presetId, revision: row.presetRevision } } };
        }
        const resolvePreset = async (selected: MachineSetupPresetApplyInputV1,
            creationRequired: boolean): Promise<Readonly<{ setup: MachineSetupV1; managedId?: string }>> => {
        if (row && row.machineSetup !== null
            && (creationRequired || row.presetId === selected.presetId)) {
            const setup = readSetup(row);
            if (creationRequired || ['pending', 'running', 'failed'].includes(setup.state)) {
                await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
                requireCreationSetup(row, selected);
                if (readManagedEnrollmentAccountId(row) !== target.accountId || setup.state === 'skipped' || setup.state === 'succeeded') {
                    throw new ManagedMachineError('intent_changed');
                }
                return { setup: setup.setup, managedId: row.id };
            }
        }
        const result = await getMachinePresetInTx(tx, { accountId: params.actorAccountId, authentication: params.authentication,
            input: { homeId: selected.homeId, id: selected.presetId } });
        if (result.kind === 'refused') throw new ManagedMachineError(result.code);
        const preset = result.preset;
        if (preset.revision !== selected.presetRevision) throw new ManagedMachineError('request_conflict');
        if (preset.archivedAt !== undefined) throw new ManagedMachineError('preset_archived');
        if (!preset.setup) throw new ManagedMachineError('invalid_request');
        if (Object.values(preset.setup.secretRefs?.bindings ?? {})
            .some(binding => parseSavedSecretRefV1(binding.ref).kind === 'personal')) {
            const sourceAccountId = preset.controller
                ? (await tx.machine.findUnique({ where: { id: preset.controller.machineId }, select: { accountId: true } }))?.accountId
                : preset.owner.kind === 'account' ? preset.owner.accountId : undefined;
            if (sourceAccountId !== target.accountId) throw new ManagedMachineError('credential_unavailable');
        }
        return { setup: preset.setup };
        };
        if (params.creationManagedId && (!row?.presetId || row.presetRevision === null
            || !matchesMachineSetupCreationSourcesV1(input.sources,
                { preset: { id: row.presetId, revision: row.presetRevision }, setup: readSetup(row).setup }))) {
            throw new ManagedMachineError('intent_changed');
        }
        const sources: typeof input.sources = [];
        let creation: Readonly<{ managedId: string; preset: { id: string; revision: number } }> | undefined;
        for (const source of input.sources) {
            if (source.kind === 'direct') { sources.push(source); continue; }
            // Bundled declarations are target-daemon catalog authority, not a
            // Home-owned Preset. Do not certify an unresolved catalog copy.
            if (source.kind === 'bundledPreset') throw new ManagedMachineError('invalid_request');
            const resolved = await resolvePreset({ homeId: input.homeId, machineId: input.machineId,
                presetId: source.presetId, presetRevision: source.presetRevision },
            Boolean(params.creationManagedId && row?.presetId === source.presetId));
            if (!sameStrictJsonValue(source.setup, resolved.setup)) throw new ManagedMachineError('request_conflict');
            if (resolved.managedId) creation = { managedId: resolved.managedId,
                preset: { id: source.presetId, revision: source.presetRevision } };
            sources.push({ ...source, setup: resolved.setup });
        }
        if (params.creationManagedId && creation?.managedId !== params.creationManagedId) throw new ManagedMachineError('intent_changed');
        return { sources, ...(creation ? { creation } : {}) };
    });
}

/** Reports can change only the exact enrolled creation stage and its current operation. */
export async function reportMachineSetup(params: Readonly<{
    actorAccountId: string; custodianAccountId: string; input: MachineSetupReportInputV1;
    admittedMachineRole?: MachineAccessRoleV1;
    creationManagedId?: string;
}>): Promise<Readonly<{ machine: ManagedMachineV1 }>> {
    const input = MachineSetupReportInputV1Schema.parse(params.input);
    if (input.state !== 'failed' && input.errorCode !== undefined) throw new ManagedMachineError('invalid_request');
    return inManagedMachinePublicationTx(input, async tx => {
        await requireTargetInTx(tx, { ...params, input });
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedCreationAccessInTx(tx, row, params.actorAccountId);
        if (readManagedEnrollmentAccountId(row) !== params.custodianAccountId || params.creationManagedId && row.id !== params.creationManagedId) {
            throw new ManagedMachineError('permission_denied');
        }
        const setup = requireCreationSetup(row, input);
        const sameOperation = setup.operation?.operationId === input.operation.operationId;
        if (sameOperation && setup.state === input.state) return { machine: await projectManagedMachineForActorInTx(tx, row, params.actorAccountId) };
        if (input.state === 'running' ? !['pending', 'failed'].includes(setup.state) : setup.state !== 'running' || !sameOperation) {
            throw new ManagedMachineError('intent_changed');
        }
        const next = ManagedMachineSetupV1Schema.parse({ setup: setup.setup, state: input.state,
            operation: input.operation, ...(input.state !== 'running' ? { settledAtMs: Date.now() } : {}),
            ...(input.errorCode ? { errorCode: input.errorCode } : {}) });
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
            creationState: 'active', archivedAt: null, allocation: 'bound', desired: { not: 'delete' },
            enrolledMachineId: input.machineId, machineSetup: { equals: readManagedJsonEqualityOperand(row.machineSetup) } }, data: { machineSetup: next } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineForActorInTx(tx, current, params.actorAccountId) };
    });
}

/** Continue without setup preserves the enrolled Machine and native resource; stale reports cannot reverse it. */
export async function skipManagedMachineSetup(params: Readonly<{
    actorAccountId: string; input: ManagedMachineActionInputV1<'machines.managed.setup.skip'>;
}>): Promise<ManagedMachineV1> {
    const input = ManagedMutationInputV1Schema.parse(params.input);
    return inManagedMachinePublicationTx(input, async tx => {
        if (await readCurrentServerIdentityId(process.env, tx) !== input.homeId) throw new ManagedMachineError('permission_denied');
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedCreationAccessInTx(tx, row, params.actorAccountId);
        if (row.intentRevision !== input.expectedIntentRevision || !row.enrolledMachineId || !row.presetId || row.presetRevision === null) {
            throw new ManagedMachineError('intent_changed');
        }
        const setup = requireCreationSetup(row, { homeId: row.homeId, machineId: row.enrolledMachineId,
            presetId: row.presetId, presetRevision: row.presetRevision });
        if (setup.state === 'skipped') return projectManagedMachineForActorInTx(tx, row, params.actorAccountId);
        if (setup.state === 'succeeded' || setup.state === 'running') throw new ManagedMachineError('intent_changed');
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
            creationState: 'active', archivedAt: null, desired: { not: 'delete' }, machineSetup: { equals: readManagedJsonEqualityOperand(row.machineSetup) } },
            data: { machineSetup: { setup: setup.setup, state: 'skipped', ...(setup.operation ? { operation: setup.operation } : {}) } } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return projectManagedMachineForActorInTx(tx, current, params.actorAccountId);
    });
}
