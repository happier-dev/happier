import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { isStoredOpaquePresetMachine } from './managedMachineProjection';
import { MachineSetupResolveInputV1Schema, MachineSetupReportInputV1Schema, MachineSetupResolveResultV1Schema, ManagedMutationInputV1Schema, type MachineSetupResolveInputV1, type MachineSetupPresetApplyInputV1, type MachineSetupReportInputV1, type ManagedMachineActionInputV1, type ManagedMachineReadV1, type MachineSetupOpaquePresetSourceV1, type MachineSetupResolvedSourceEntryV1, type MachineSetupResolvedSourceV1, type MachineSetupSourceApplyEntryV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineSetupV1Schema, ManagedOpaqueMachineSetupStateV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import {
    projectManagedMachinePresetForRecipientV1,
    readManagedMachinePresetContentOverrideForModeV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { getActivePrismaRuntime } from '@/storage/db';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { getMachinePresetInTx } from './machinePresetService';
import { requireManagedCreationAccessInTx, requireManagedMachineAccessInTx, projectManagedMachineForActorInTx, projectManagedMachineReadForActorInTx } from './managedRead';
import {
    ManagedMachineError, readManagedMachineInTx,
    invalidateManagedMachineInTx, inManagedMachinePublicationTx, type StoredManagedMachine,
    readManagedJsonEqualityOperand,
    readManagedEnrollmentAccountId,
    readStoredOpaquePresetLaunch,
    storeOpaquePresetLaunch,
    readManagedAdmissionState,
    markManagedBootstrapInstalled,
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
    const machine = await tx.machine.findUnique({ where: { id: params.input.machineId } }).then(decodeMachineStoredContent);
    if (!machine || machine.accountId !== params.custodianAccountId
        || classifyMachineAvailabilityState(machine) !== 'available'
        || (params.admittedMachineRole ?? await resolveEffectiveMachineRoleInTx(tx,
            { actorAccountId: params.actorAccountId, machineId: machine.id })) !== 'manage') {
        throw new ManagedMachineError('permission_denied');
    }
    return machine;
}

function requireCreationTarget(row: StoredManagedMachine, input: MachineSetupPresetApplyInputV1 | MachineSetupReportInputV1) {
    const targetMatches = 'target' in input
        ? row.controllerMachineId === input.target.controller.machineId
            && row.controllerInstallationId === input.target.controller.installationId
            && readManagedAdmissionState(row.admittedInput).acquisitionMode === 'resource-bound'
        : row.enrolledMachineId === input.machineId;
    if (row.homeId !== input.homeId || !targetMatches
        || row.presetId !== input.presetId || row.presetRevision !== input.presetRevision
        || row.creationState !== 'active' || row.archivedAt !== null || row.allocation !== 'bound'
        || row.desired === 'delete') throw new ManagedMachineError('intent_changed');
}

function requireCreationSetup(row: StoredManagedMachine, input: MachineSetupPresetApplyInputV1 | MachineSetupReportInputV1) {
    requireCreationTarget(row, input);
    return readSetup(row);
}

/** Opaque preset setup keeps only lifecycle state; its setup recipe is daemon-private content. */
function requireOpaqueCreationSetup(row: StoredManagedMachine, input: MachineSetupPresetApplyInputV1 | MachineSetupReportInputV1) {
    requireCreationTarget(row, input);
    return row.machineSetup === null
        ? ManagedOpaqueMachineSetupStateV1Schema.parse({ state: 'pending' })
        : ManagedOpaqueMachineSetupStateV1Schema.parse(row.machineSetup);
}

function requireOpaquePresetSourceMode(source: MachineSetupOpaquePresetSourceV1, contentEncryptionMode: 'plain' | 'e2ee'): void {
    if (source.contentEncryptionMode !== contentEncryptionMode) throw new ManagedMachineError('account_mode_mismatch');
}

/** The server binds an optional opaque edit to the persisted author mode without opening it. */
function readOpaquePresetSourceOverride(
    source: MachineSetupOpaquePresetSourceV1,
    contentEncryptionMode: 'plain' | 'e2ee',
) {
    if (source.presetContentOverride === undefined) return undefined;
    const override = readManagedMachinePresetContentOverrideForModeV1({
        mode: contentEncryptionMode,
        override: source.presetContentOverride,
    });
    if (override === null) throw new ManagedMachineError('account_mode_mismatch');
    return override;
}

function storedSetupEquality(row: StoredManagedMachine) {
    return row.machineSetup === null
        ? getActivePrismaRuntime().DbNull
        : readManagedJsonEqualityOperand(row.machineSetup);
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
        if (row !== null && isStoredOpaquePresetMachine(row)) {
            const match = (source: MachineSetupSourceApplyEntryV1): source is MachineSetupOpaquePresetSourceV1 => source.kind === 'accountPresetOpaque'
                && source.presetId === row.presetId && source.presetRevision === row.presetRevision;
            if ('purpose' in input) {
                const candidate = input.candidates.find(match);
                if (!candidate) {
                    if (params.creationManagedId) throw new ManagedMachineError('intent_changed');
                    return { purpose: 'creationOrigin' as const };
                }
                await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
                const stored = readStoredOpaquePresetLaunch(row.launch);
                requireOpaquePresetSourceMode(candidate, stored.contentEncryptionMode);
                readOpaquePresetSourceOverride(candidate, stored.contentEncryptionMode);
                const setup = requireOpaqueCreationSetup(row, { homeId: input.homeId, machineId: input.machineId,
                    presetId: candidate.presetId, presetRevision: candidate.presetRevision });
                if (readManagedEnrollmentAccountId(row) !== target.accountId) throw new ManagedMachineError('permission_denied');
                if (setup.state === 'skipped') return { purpose: 'creationOrigin' as const };
                return { purpose: 'creationOrigin' as const,
                    creation: { managedId: row.id, preset: { id: candidate.presetId, revision: candidate.presetRevision } } };
            }
            if (!params.creationManagedId) throw new ManagedMachineError('invalid_request');
            const opaque = input.sources.find(match);
            const direct = input.sources.find(source => source.kind === 'direct');
            if (!opaque || input.sources.length !== 2 || !direct || !sameStrictJsonValue(direct, { kind: 'direct', setup: {} })) {
                throw new ManagedMachineError('intent_changed');
            }
            await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
            const stored = readStoredOpaquePresetLaunch(row.launch);
            requireOpaquePresetSourceMode(opaque, stored.contentEncryptionMode);
            const presetContentOverride = readOpaquePresetSourceOverride(opaque, stored.contentEncryptionMode);
            const setup = requireOpaqueCreationSetup(row, { homeId: input.homeId, machineId: input.machineId,
                presetId: opaque.presetId, presetRevision: opaque.presetRevision });
            if (setup.state === 'skipped') throw new ManagedMachineError('intent_changed');
            if (readManagedEnrollmentAccountId(row) !== target.accountId) throw new ManagedMachineError('permission_denied');
            return {
                sources: [
                    { kind: 'accountPresetOpaque' as const, presetId: opaque.presetId, presetRevision: opaque.presetRevision,
                        contentEncryptionMode: stored.contentEncryptionMode,
                        presetContent: projectManagedMachinePresetForRecipientV1({ content: stored.content,
                            recipients: stored.recipients, recipientAccountId: params.actorAccountId }),
                        ...(presetContentOverride === undefined ? {} : { presetContentOverride }),
                    },
                    direct,
                ],
                creation: { managedId: row.id, preset: { id: opaque.presetId, revision: opaque.presetRevision } },
            };
        }
        if ('purpose' in input) {
            if (params.creationManagedId) throw new ManagedMachineError('intent_changed');
            return { purpose: 'creationOrigin' as const };
        }
        if (params.creationManagedId) throw new ManagedMachineError('intent_changed');
        const resolvePreset = async (selected: Extract<MachineSetupSourceApplyEntryV1,
            { kind: 'accountPresetOpaque' }> & MachineSetupPresetApplyInputV1): Promise<Readonly<{
                source: MachineSetupResolvedSourceEntryV1;
            }>> => {
        const result = await getMachinePresetInTx(tx, { accountId: params.actorAccountId, authentication: params.authentication,
            input: { homeId: selected.homeId, id: selected.presetId } });
        if (result.kind === 'refused') throw new ManagedMachineError(result.code);
        const preset = result.preset;
        if (preset.revision !== selected.presetRevision) throw new ManagedMachineError('request_conflict');
        if (preset.archivedAt !== undefined) throw new ManagedMachineError('preset_archived');
        requireOpaquePresetSourceMode(selected, preset.contentEncryptionMode);
        const presetContentOverride = readOpaquePresetSourceOverride(selected, preset.contentEncryptionMode);
        return { source: { kind: 'accountPresetOpaque', presetId: selected.presetId, presetRevision: selected.presetRevision,
            contentEncryptionMode: preset.contentEncryptionMode,
            presetContent: projectManagedMachinePresetForRecipientV1({ content: preset.content,
                recipients: preset.recipients, recipientAccountId: params.actorAccountId }),
            ...(presetContentOverride === undefined ? {} : { presetContentOverride }) } };
        };
        const sources: MachineSetupResolvedSourceV1 = [];
        for (const source of input.sources) {
            if (source.kind === 'direct') { sources.push(source); continue; }
            // Bundled declarations are target-daemon catalog authority, not a
            // Home-owned Preset. Do not certify an unresolved catalog copy.
            if (source.kind === 'bundledPreset') throw new ManagedMachineError('invalid_request');
            const resolved = await resolvePreset({ ...source, homeId: input.homeId, machineId: input.machineId });
            if (resolved.source.kind !== 'accountPresetOpaque'
                || resolved.source.presetId !== source.presetId || resolved.source.presetRevision !== source.presetRevision) {
                throw new ManagedMachineError('request_conflict');
            }
            sources.push(resolved.source);
        }
        return { sources };
    });
}

/** Reports change the exact admitted target's creation stage and current operation. */
export async function reportMachineSetup(params: Readonly<{
    actorAccountId: string; custodianAccountId: string; input: MachineSetupReportInputV1;
    admittedMachineRole?: MachineAccessRoleV1;
    creationManagedId?: string;
}>): Promise<Readonly<{ machine: ManagedMachineV1 }>> {
    const input = MachineSetupReportInputV1Schema.parse(params.input);
    if ('state' in input && input.state !== 'failed' && input.errorCode !== undefined) throw new ManagedMachineError('invalid_request');
    return inManagedMachinePublicationTx(input, async tx => {
        if ('target' in input) {
            if (params.creationManagedId !== input.managedId
                || await readCurrentServerIdentityId(process.env, tx) !== input.homeId) throw new ManagedMachineError('permission_denied');
        } else await requireTargetInTx(tx, { ...params, input });
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedCreationAccessInTx(tx, row, params.actorAccountId);
        if (('target' in input ? row.custodianAccountId : readManagedEnrollmentAccountId(row)) !== params.custodianAccountId
            || params.creationManagedId && row.id !== params.creationManagedId) {
            throw new ManagedMachineError('permission_denied');
        }
        if ('bootstrapInstalled' in input) {
            requireCreationTarget(row, input);
            if (readManagedAdmissionState(row.admittedInput).bootstrapInstalled) {
                return { machine: await projectManagedMachineForActorInTx(tx, row, params.actorAccountId) };
            }
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                creationState: 'active', archivedAt: null, allocation: 'bound', desired: { not: 'delete' },
                admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) },
            }, data: { admittedInput: markManagedBootstrapInstalled(row.admittedInput) } });
            if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
            const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, current);
            return { machine: await projectManagedMachineForActorInTx(tx, current, params.actorAccountId) };
        }
        const opaque = isStoredOpaquePresetMachine(row);
        const setup = opaque ? requireOpaqueCreationSetup(row, input) : requireCreationSetup(row, input);
        const stored = opaque ? readStoredOpaquePresetLaunch(row.launch) : undefined;
        if ('target' in input && (opaque ? input.sourceFacts !== undefined : input.presetContent !== undefined)) {
            throw new ManagedMachineError('invalid_request');
        }
        const override = stored && 'target' in input && input.presetContent !== undefined
            ? readManagedMachinePresetContentOverrideForModeV1({ mode: stored.contentEncryptionMode, override: input.presetContent })
            : undefined;
        if (override === null) throw new ManagedMachineError('account_mode_mismatch');
        const sameOperation = setup.operation?.operationId === input.operation.operationId;
        if (sameOperation && setup.state === input.state) return { machine: await projectManagedMachineForActorInTx(tx, row, params.actorAccountId) };
        if (input.state === 'running' ? !['pending', 'failed'].includes(setup.state) : setup.state !== 'running' || !sameOperation) {
            throw new ManagedMachineError('intent_changed');
        }
        const lifecycle = { state: input.state, operation: input.operation,
            ...(input.state !== 'running' ? { settledAtMs: Date.now() } : {}),
            ...(input.errorCode ? { errorCode: input.errorCode } : {}) };
        const next = opaque ? ManagedOpaqueMachineSetupStateV1Schema.parse(lifecycle)
            : ManagedMachineSetupV1Schema.parse({ ...lifecycle,
                ...('setup' in setup ? { setup: setup.setup } : {}),
                ...('sourceFacts' in setup ? { sourceFacts: setup.sourceFacts } : {}),
                ...('target' in input && input.sourceFacts !== undefined ? { sourceFacts: input.sourceFacts } : {}),
            });
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
            creationState: 'active', archivedAt: null, allocation: 'bound', desired: { not: 'delete' },
            ...('target' in input ? {} : { enrolledMachineId: input.machineId }),
            machineSetup: { equals: storedSetupEquality(row) },
            ...(override === undefined ? {} : { launch: { equals: readManagedJsonEqualityOperand(row.launch) } }),
        }, data: { machineSetup: next,
            ...(stored && override ? { launch: storeOpaquePresetLaunch({ ...stored, content: override.content }) } : {}),
        } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineForActorInTx(tx, current, params.actorAccountId) };
    });
}

/** Continue without setup preserves the enrolled Machine and native resource; stale reports cannot reverse it. */
export async function skipManagedMachineSetup(params: Readonly<{
    actorAccountId: string; input: ManagedMachineActionInputV1<'machines.managed.setup.skip'>;
}>): Promise<ManagedMachineReadV1> {
    const input = ManagedMutationInputV1Schema.parse(params.input);
    return inManagedMachinePublicationTx(input, async tx => {
        if (await readCurrentServerIdentityId(process.env, tx) !== input.homeId) throw new ManagedMachineError('permission_denied');
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedCreationAccessInTx(tx, row, params.actorAccountId);
        if (row.intentRevision !== input.expectedIntentRevision || !row.enrolledMachineId || !row.presetId || row.presetRevision === null) {
            throw new ManagedMachineError('intent_changed');
        }
        if (isStoredOpaquePresetMachine(row)) {
            const setup = requireOpaqueCreationSetup(row, { homeId: row.homeId, machineId: row.enrolledMachineId,
                presetId: row.presetId, presetRevision: row.presetRevision });
            if (setup.state === 'skipped') return projectManagedMachineReadForActorInTx(tx, row, params.actorAccountId);
            if (setup.state === 'succeeded' || setup.state === 'running') throw new ManagedMachineError('intent_changed');
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                creationState: 'active', archivedAt: null, desired: { not: 'delete' }, machineSetup: { equals: storedSetupEquality(row) } },
                data: { machineSetup: { state: 'skipped', ...(setup.operation ? { operation: setup.operation } : {}) } } });
            if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
            const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, current);
            return projectManagedMachineReadForActorInTx(tx, current, params.actorAccountId);
        }
        const setup = requireCreationSetup(row, { homeId: row.homeId, machineId: row.enrolledMachineId,
            presetId: row.presetId, presetRevision: row.presetRevision });
        if (setup.state === 'skipped') return projectManagedMachineReadForActorInTx(tx, row, params.actorAccountId);
        if (setup.state === 'succeeded' || setup.state === 'running') throw new ManagedMachineError('intent_changed');
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
            creationState: 'active', archivedAt: null, desired: { not: 'delete' }, machineSetup: { equals: readManagedJsonEqualityOperand(row.machineSetup) } },
            data: { machineSetup: { setup: setup.setup, state: 'skipped', ...(setup.operation ? { operation: setup.operation } : {}) } } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return projectManagedMachineReadForActorInTx(tx, current, params.actorAccountId);
    });
}
