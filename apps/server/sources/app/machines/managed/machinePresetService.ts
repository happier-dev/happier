import type { Prisma } from "@prisma/client";
import { z } from 'zod/mini';
import { ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetUpdateInputV1Schema, ManagedMachinePresetV1ReadSchema, ManagedMachinePresetV1Schema, createManagedMachinePresetV1Schema, type ManagedMachinePresetV1, type ManagedMachinePresetCreateInputV1, type ManagedMachinePresetUpdateInputV1, type ManagedMachinePresetRevisionInputV1, type ManagedMachinePresetGetInputV1, type ManagedMachinePresetListInputV1, type ManagedMachinePresetGetResultV1, type ManagedMachinePresetListResultV1, type PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isQualifiedConnectedAccountProfileActiveV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { qualifyPluginContributionReferenceV1 } from "@happier-dev/protocol/plugins/contribution-identity";
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { isMachineProvisionerCredentialPurposeRequiredV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1, hasManagedMachinePresetCreationV1, type ManagedMachinePresetCreationV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { inReadSnapshot, inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { db, isPrismaUniqueConstraintError, getActivePrismaRuntime } from "@/storage/db";
import { AccountStatus, TeamMembershipStatus } from "@/storage/enums.generated";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveEffectiveMachineRoleInTx, resolveEffectiveMachineAccessForMachinesInTx } from "@/app/machines/machineAccess";
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from "@/app/changes/markAccountChanged";
import {
    resolveTeamActorContextInTx, qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextsInTx, qualifyTeamOperationAuthenticationsInTx,
    readActiveTeamMembershipsInTx,
} from "@/app/teams/actorContext";
import { listQualifiedConnectedAccountsInTx } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { createQualifiedConnectedAccountIdentityDigest } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import {
    ManagedMachineError, requireManagedControllerInTx, resolveManagedDeclarationInTx,
    sameManagedInput, projectManagedControllerAccess, readManagedProjectionFactsInTx,
    type ManagedDeclaration, type ManagedProjectionFacts, readManagedReviewedDeclaration,
} from "./managedRows";
import { readTeamResourcePublicationAudienceInTx } from '@/app/teams/resourcePublicationAudience';
import { readManagedPresetPoolCandidatesInTx } from './machinePresetPool';
import { buildManagedPresetSavedReview } from './machinePresetReview';
import { selectMachinePoolCandidate } from '@happier-dev/protocol/machines/pools';
import type { ManagedControllerV1, ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { authorizeMachinePresetCreationSaveInTx, requireManagedLaunchManagerInTx, validateManagedPresetLaunchChoices, type PresetContext, type PresetCreation } from './machinePresetSave';

type StoredPreset = Prisma.ManagedMachinePresetGetPayload<Record<string, never>>;
type PresetRefusal = Extract<PresetMutationResultV1, { kind: "refused" }>;
type PresetCredentialProfiles = ReadonlyMap<string, ReadonlyMap<string, QualifiedConnectedAccountProfileV4>>;

/** Split the known storage-only presentation field; the existing Preset reader validates launch. */
const StoredPresetLaunchReadSchema = z.looseObject({
    controllerDisplayName: ManagedMachinePresetV1Schema.shape.controllerDisplayName,
    controllerPoolId: ManagedMachinePresetV1Schema.shape.controllerPoolId,
});

function storePresetLaunch(preset: Pick<ManagedMachinePresetV1, 'launch' | 'controllerDisplayName' | 'controllerPoolId'>) {
    return preset.launch ? { ...preset.launch,
        ...(preset.controllerDisplayName === undefined ? {} : { controllerDisplayName: preset.controllerDisplayName }),
        ...(preset.controllerPoolId === undefined ? {} : { controllerPoolId: preset.controllerPoolId }),
    } : getActivePrismaRuntime().DbNull;
}

/** This plaintext presentation is published only by a Plain author for delegated Team use. */
async function omitPrivateControllerDisplayNameInTx(tx: Tx, accountId: string,
    preset: Pick<ManagedMachinePresetV1, 'owner' | 'teamAcquireDelegated' | 'controllerDisplayName'>): Promise<void> {
    if (preset.controllerDisplayName === undefined) return;
    if (preset.owner.kind !== 'team' || preset.teamAcquireDelegated !== true
        || (await tx.account.findUnique({ where: { id: accountId }, select: { encryptionMode: true } }))?.encryptionMode !== 'plain') {
        delete preset.controllerDisplayName;
    }
}

/** Gather the collection's selected identities before reading their current profiles. */
async function readPresetCredentialProfilesInTx(tx: Tx, rows: readonly StoredPreset[], facts: ManagedProjectionFacts): Promise<PresetCredentialProfiles> {
    const refsByAccount = new Map<string, QualifiedConnectedAccountRef[]>();
    for (const row of rows) {
        if (!row.controllerMachineId) continue;
        const accountId = facts.controllers.get(row.controllerMachineId)?.accountId;
        if (!accountId) continue;
        const refs = refsByAccount.get(accountId) ?? [];
        refs.push(...(projectPreset(row).launch?.credentials ?? []).flatMap(credential => 'account' in credential ? [credential.account] : []));
        refsByAccount.set(accountId, refs);
    }
    return new Map(await Promise.all([...refsByAccount].map(async ([accountId, refs]) => {
        const profiles = await listQualifiedConnectedAccountsInTx(tx, { accountId, refs });
        return [accountId, new Map(profiles.map(profile => [createQualifiedConnectedAccountIdentityDigest(profile.ref), profile]))] as const;
    })));
}

function ownerOf(row: StoredPreset): ManagedMachinePresetV1["owner"] {
    return row.teamId ? { kind: "team", teamId: row.teamId } : { kind: "account", accountId: row.custodianAccountId ?? "" };
}

/** Team archive is inherited for reads and new selection, never written into the Preset row. */
function inheritPresetOwnerArchive(row: StoredPreset, teamArchivedAt: Date | null | undefined): StoredPreset {
    return row.archivedAt === null && teamArchivedAt ? { ...row, archivedAt: teamArchivedAt } : row;
}

function projectPreset(row: StoredPreset, declaration?: ManagedDeclaration | null): ManagedMachinePresetV1 {
    const schema = declaration ? createStoredReadSchema(createManagedMachinePresetV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema))) : ManagedMachinePresetV1ReadSchema;
    const storedLaunch = row.launch === null ? null : StoredPresetLaunchReadSchema.parse(row.launch);
    const { controllerDisplayName, controllerPoolId, ...launch } = storedLaunch ?? {};
    return ManagedMachinePresetV1Schema.parse(schema.parse({
        id: row.id, homeId: row.homeId, revision: row.revision, name: row.name,
        owner: ownerOf(row),
        ...(storedLaunch ? { launch, ...(controllerDisplayName === undefined ? {} : { controllerDisplayName }) } : {}),
        ...(controllerPoolId === undefined ? {} : { controllerPoolId }),
        ...(row.controllerMachineId !== null || row.controllerInstallationId !== null
            ? { controller: { machineId: row.controllerMachineId, installationId: row.controllerInstallationId } } : {}),
        ...(row.setup !== null ? { setup: row.setup } : {}),
        ...(row.retentionOverride !== null ? { retention: row.retentionOverride } : {}),
        ...(row.wakeOnAcceptedMessage !== null ? { wakeOnAcceptedMessage: row.wakeOnAcceptedMessage } : {}),
        ...(row.teamAcquireDelegated ? { teamAcquireDelegated: true } : {}),
        ...(row.simultaneousMaximum !== null ? { simultaneousLimit: { maximum: row.simultaneousMaximum } } : {}),
        ...(row.archivedAt !== null ? { archivedAt: row.archivedAt.getTime() } : {}),
    }));
}

async function projectPresetInTx(tx: Tx, row: StoredPreset,
    context?: PresetContext & Readonly<{ canManageController: boolean }>,
    credentialProfiles?: PresetCredentialProfiles, facts?: ManagedProjectionFacts): Promise<ManagedMachinePresetV1> {
    const preset = projectPreset(row);
    if (!hasManagedMachinePresetCreationV1(preset)) return preset;
    if (preset.controllerPoolId && context) {
        const { credentials: _credentials, ...launch } = preset.launch;
        const publicPreset = { ...preset, launch };
        try {
            if (row.archivedAt) throw new ManagedMachineError('preset_archived');
            const pool = await readManagedPresetPoolCandidatesInTx(tx, context, preset);
            if (pool.custodianAccountId !== context.accountId && !row.teamAcquireDelegated) throw new ManagedMachineError('permission_denied');
            const declaration = pool.candidates[0]!.declaration;
            return ManagedMachinePresetV1Schema.parse({ ...publicPreset,
                ...(pool.custodianAccountId === context.accountId ? { launch: preset.launch } : {}), delegatedAcquire: { kind: 'ready',
                provisioner: declaration.provisioner, reviewedFacts: buildManagedPresetSavedReview(preset, declaration) } });
        } catch (error) {
            if (!(error instanceof ManagedMachineError)) throw error;
            return { ...publicPreset, delegatedAcquire: { kind: 'unavailable', code: error.code } };
        }
    }
    if (context && !context.canManageController && row.teamId && preset.controller) {
        const { credentials: _credentials, ...launch } = preset.launch;
        const publicPreset = { ...preset, launch };
        if (!row.teamAcquireDelegated) return { ...publicPreset, delegatedAcquire: { kind: 'unavailable', code: 'permission_denied' } };
        try {
            if (row.archivedAt) throw new ManagedMachineError('preset_archived');
            const projection = facts ?? await readManagedProjectionFactsInTx(tx, [{ homeId: preset.homeId,
                controller: preset.controller, provider: preset.launch.provider }]);
            const { declaration, controller } = await validateStoredManagedLaunchInTx(tx, preset, credentialProfiles, projection);
            const access = projectManagedControllerAccess(controller, preset.controller);
            if (!access || !controller.active) throw new ManagedMachineError('controller_unavailable');
            return ManagedMachinePresetV1Schema.parse({ ...publicPreset, delegatedAcquire: { kind: 'ready', controller: access,
                provisioner: declaration.provisioner, reviewedFacts: buildManagedPresetSavedReview(preset, declaration, preset.controller) } });
        } catch (error) {
            if (!(error instanceof ManagedMachineError)) throw error;
            return { ...publicPreset, delegatedAcquire: { kind: 'unavailable', code: error.code } };
        }
    }
    const launch = preset.launch;
    const input = { homeId: row.homeId, controller: preset.controller, provider: launch.provider };
    const declaration = (facts ?? await readManagedProjectionFactsInTx(tx, [input])).declarationFor(input);
    return projectPreset(row, declaration?.schemaVersion === launch.schemaVersion ? declaration : null);
}

/** Mutation replies obey the same controller-private boundary as preset reads. */
async function projectPresetForActorInTx(tx: Tx, row: StoredPreset, accountId: string,
    authentication?: PresetContext['authentication']): Promise<ManagedMachinePresetV1> {
    const projection = row.teamId || projectPreset(row).controllerPoolId ? { accountId, authentication,
        canManageController: row.controllerMachineId !== null && await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: accountId, machineId: row.controllerMachineId }) === 'manage' } : undefined;
    return projectPresetInTx(tx, row, projection);
}

async function resolvePresetAccessInTx(tx: Tx, context: PresetContext, owner: ManagedMachinePresetV1["owner"],
    operation: 'read' | 'manage' | 'archive'): Promise<Readonly<{ teamArchivedAt: Date | null }> | null> {
    if (owner.kind === "account") {
        if (owner.accountId !== context.accountId) return null;
        return (await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status === AccountStatus.active
            ? { teamArchivedAt: null } : null;
    }
    const actor = await resolveTeamActorContextInTx(tx, { teamId: owner.teamId, actorAccountId: context.accountId });
    if (!actor) return null;
    const permitted = operation === 'read' ? actor.teamCapabilities.viewTeam
        : operation === 'archive' && actor.team.archivedAt !== null ? actor.teamCapabilities.restoreTeam
            : actor.teamCapabilities.manageSettings;
    if (!permitted || !(await qualifyTeamOperationAuthenticationInTx(tx, { ...context.authentication, context: actor })).ok) return null;
    return { teamArchivedAt: actor.team.archivedAt };
}

async function requireHomeInTx(tx: Tx, homeId: string): Promise<void> {
    if (await readCurrentServerIdentityId(process.env, tx) !== homeId) throw new ManagedMachineError("permission_denied");
}

export async function invalidatePresetInTx(tx: Tx, row: StoredPreset): Promise<void> {
    const accountIds = await readMachinePresetPublicationAudienceInTx(tx, ownerOf(row));
    await markAccountsChanged(tx, { accountIds, entityId: MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1 });
}

export async function readMachinePresetPublicationAudienceInTx(tx: Tx, owner: ManagedMachinePresetV1['owner']): Promise<string[]> {
    return owner.kind === 'team'
        ? readTeamResourcePublicationAudienceInTx(tx, owner.teamId)
        : [owner.accountId];
}

/** Launch authority and every actual preset recipient enter in one sorted Account batch. */
async function acquirePresetMutationAccountsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; owner: ManagedMachinePresetV1['owner']; controllerMachineIds: readonly string[];
}>): Promise<void> {
    const read = async () => [input.actorAccountId, ...await readMachinePresetPublicationAudienceInTx(tx, input.owner),
        ...(input.controllerMachineIds.length ? await tx.machine.findMany({
            where: { id: { in: [...input.controllerMachineIds] } }, select: { accountId: true },
        }) : []).map(machine => machine.accountId)];
    const accountIds = await read();
    await acquireAccountChangePublicationLocksInTx(tx, accountIds, { includeSingleAccount: true });
    const admitted = new Set(accountIds);
    if ((await read()).some(accountId => !admitted.has(accountId))) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    beforeAccountChangePublication(tx, accountIds, async () => assertAccountChangePublicationAudienceInTx(tx, await read()));
}

/** Acquisition consumes current declarations and credential-source readers. No material is read. */
export async function validateManagedLaunchInTx(tx: Tx, context: PresetContext, preset: PresetCreation,
    reviewedFacts?: unknown): Promise<Readonly<{ declaration: ManagedDeclaration | null; custodianAccountId: string }>> {
    if (preset.controllerPoolId) {
        const pool = await readManagedPresetPoolCandidatesInTx(tx, context, preset);
        if (pool.custodianAccountId !== context.accountId) throw new ManagedMachineError('permission_denied');
        return { declaration: pool.candidates[0]!.declaration, custodianAccountId: pool.custodianAccountId };
    }
    if (!preset.controller) {
        await requireHomeInTx(tx, preset.homeId);
        if (preset.owner?.kind === 'team' || (await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status !== AccountStatus.active) {
            throw new ManagedMachineError('permission_denied');
        }
        const declaration = reviewedFacts === undefined ? null : readManagedReviewedDeclaration(reviewedFacts);
        if (reviewedFacts !== undefined && (!declaration || declaration.billing.location !== 'cloud'
            || declaration.schemaVersion !== preset.launch.schemaVersion)) throw new ManagedMachineError('invalid_request');
        const schema = declaration ? createManagedMachinePresetV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema)) : ManagedMachinePresetV1Schema;
        if (!schema.safeParse({ ...preset, id: 'validation', name: 'validation', revision: 0,
            owner: { kind: 'account', accountId: context.accountId } }).success) throw new ManagedMachineError('invalid_request');
        return { declaration, custodianAccountId: context.accountId };
    }
    await requireManagedLaunchManagerInTx(tx, context, preset.controller.machineId);
    return validateStoredManagedLaunchInTx(tx, preset);
}

/** Source validation is shared; only preset admission can substitute its explicit spend approval for Manage. */
export async function validateStoredManagedLaunchInTx(tx: Tx, preset: PresetCreation,
    credentialProfiles?: PresetCredentialProfiles, facts?: ManagedProjectionFacts) {
    if (!preset.controller) throw new ManagedMachineError('invalid_request');
    const controller = facts ? facts.controllers.get(preset.controller.machineId)
        : await tx.machine.findUnique({ where: { id: preset.controller.machineId }, select: {
        accountId: true, kind: true, installationId: true, installationPublicKey: true, active: true,
        revokedAt: true, replacedByMachineId: true, account: { select: { status: true } },
    } });
    if (!controller || controller.account.status !== AccountStatus.active) throw new ManagedMachineError('permission_denied');
    const custodianAccountId = controller.accountId;
    await requireManagedControllerInTx(tx, { homeId: preset.homeId, custodianAccountId, controller: preset.controller }, facts);
    const input = { homeId: preset.homeId, custodianAccountId, controller: preset.controller, provider: preset.launch.provider };
    const declaration = facts ? facts.declarationFor(input) : await resolveManagedDeclarationInTx(tx, input);
    if (!declaration || declaration.schemaVersion !== preset.launch.schemaVersion) throw new ManagedMachineError("provider_unavailable");
    const validatedLaunch = validateManagedPresetLaunchChoices(preset, declaration);
    const credentials = preset.launch.credentials ?? [];
    const requests = declaration.acquireCredentialRequests.filter(binding => isMachineProvisionerCredentialPurposeRequiredV1(
        declaration, binding.request.id, validatedLaunch.choices));
    if (requests.length !== credentials.length) throw new ManagedMachineError("credential_unavailable");
    // Save and acquire validate every distinct native purpose against the
    // same declared Connected-account owner; no material or default is copied.
    for (const credential of credentials) {
        if (!sameManagedInput(credential.purpose.consumer, preset.launch.provider)) throw new ManagedMachineError("credential_unavailable");
        const matches = requests.filter(binding => binding.request.id === credential.purpose.purpose);
        const request = matches[0]?.request;
        if (matches.length !== 1 || !request || 'account' in credential && !request.scope.serviceRefs.some(service =>
            sameManagedInput(qualifyPluginContributionReferenceV1(service, preset.launch.provider.pluginId), credential.account.service))) {
            throw new ManagedMachineError("credential_unavailable");
        }
    }
    const profiles = credentialProfiles
        ? credentialProfiles.get(custodianAccountId)
        : new Map((await listQualifiedConnectedAccountsInTx(tx, { accountId: custodianAccountId,
            refs: credentials.flatMap(credential => 'account' in credential ? [credential.account] : []) }))
            .map(profile => [createQualifiedConnectedAccountIdentityDigest(profile.ref), profile]));
    for (const credential of credentials) {
        if (!('account' in credential)) continue;
        const selected = profiles?.get(createQualifiedConnectedAccountIdentityDigest(credential.account));
        if (!selected || !isQualifiedConnectedAccountProfileActiveV4(selected, Date.now())) throw new ManagedMachineError("credential_unavailable");
    }
    return { declaration, custodianAccountId, controller };
}

function refusal(error: unknown): PresetRefusal {
    if (error instanceof ManagedMachineError) return { kind: "refused", code: error.code };
    throw error;
}

function definition(preset: ManagedMachinePresetV1): ManagedMachinePresetCreateInputV1 {
    const { revision: _revision, archivedAt: _archivedAt, delegatedAcquire: _delegatedAcquire, ...value } = preset;
    return value;
}

export async function createMachinePreset(params: PresetContext & Readonly<{ input: ManagedMachinePresetCreateInputV1 }>): Promise<PresetMutationResultV1> {
    const input = ManagedMachinePresetCreateInputV1Schema.parse(params.input);
    if (input.teamAcquireDelegated === false) delete input.teamAcquireDelegated;
    const execute = () => inTx(async tx => {
        await acquirePresetMutationAccountsInTx(tx, { actorAccountId: params.accountId, owner: input.owner,
            controllerMachineIds: input.controller ? [input.controller.machineId] : [] });
        await requireHomeInTx(tx, input.homeId);
        if (!await resolvePresetAccessInTx(tx, params, input.owner, 'manage')) return { kind: "refused", code: "permission_denied" } as const;
        if (input.teamAcquireDelegated && (input.owner.kind !== 'team' || !hasManagedMachinePresetCreationV1(input))) throw new ManagedMachineError('invalid_request');
        await omitPrivateControllerDisplayNameInTx(tx, params.accountId, input);
        const existing = await tx.managedMachinePreset.findUnique({ where: { id: input.id } });
        if (existing) {
            if (!await resolvePresetAccessInTx(tx, params, ownerOf(existing), 'manage') || existing.homeId !== input.homeId) return { kind: "refused", code: "permission_denied" } as const;
            const current = await projectPresetInTx(tx, existing);
            return sameManagedInput(definition(current), input)
                ? { kind: "saved", preset: await projectPresetForActorInTx(tx, existing, params.accountId, params.authentication) } as const
                : { kind: "conflict", currentRevision: current.revision } as const;
        }
        if (hasManagedMachinePresetCreationV1(input)) await authorizeMachinePresetCreationSaveInTx(tx, params, input);
        const row = await tx.managedMachinePreset.create({ data: {
            id: input.id, homeId: input.homeId, name: input.name,
            custodianAccountId: input.owner.kind === "account" ? input.owner.accountId : null,
            teamId: input.owner.kind === "team" ? input.owner.teamId : null,
            launch: storePresetLaunch(input),
            controllerMachineId: input.controller?.machineId ?? null, controllerInstallationId: input.controller?.installationId ?? null,
            ...(input.setup !== undefined ? { setup: input.setup } : {}),
            ...(input.retention ? { retentionOverride: input.retention } : {}),
            wakeOnAcceptedMessage: input.wakeOnAcceptedMessage,
            teamAcquireDelegated: input.teamAcquireDelegated ?? false,
            simultaneousMaximum: input.simultaneousLimit?.maximum,
        } });
        await invalidatePresetInTx(tx, row);
        return { kind: "saved", preset: await projectPresetForActorInTx(tx, row, params.accountId, params.authentication) } as const;
    });
    try { return await execute(); }
    catch (error) { if (isPrismaUniqueConstraintError(error)) return await execute(); return refusal(error); }
}

export async function getMachinePreset(params: PresetContext & Readonly<{ input: ManagedMachinePresetGetInputV1 }>): Promise<ManagedMachinePresetGetResultV1> {
    try { return await inTx(tx => getMachinePresetInTx(tx, params)); } catch (error) { return refusal(error); }
}

/** Setup consumes the same current preset reader in its exact-target transaction. */
export async function getMachinePresetInTx(tx: Tx, params: PresetContext & Readonly<{ input: ManagedMachinePresetGetInputV1 }>): Promise<ManagedMachinePresetGetResultV1> {
    await requireHomeInTx(tx, params.input.homeId);
    const row = await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } });
    const access = row ? await resolvePresetAccessInTx(tx, params, ownerOf(row), 'read') : null;
    if (!row || !access) return { kind: "refused", code: "preset_not_found" };
    return { kind: "found", preset: await projectPresetForActorInTx(tx, inheritPresetOwnerArchive(row, access.teamArchivedAt), params.accountId, params.authentication) };
}

export async function listMachinePresets(params: PresetContext & Readonly<{ input: ManagedMachinePresetListInputV1 }>): Promise<ManagedMachinePresetListResultV1> {
    try { return await inReadSnapshot(async tx => {
        await requireHomeInTx(tx, params.input.homeId);
        const input = params.input;
        if ((await tx.account.findUnique({ where: { id: params.accountId }, select: { status: true } }))?.status !== AccountStatus.active) return { kind: "listed", presets: [] } as const;
        const memberships = await tx.teamMembership.findMany({ where: { accountId: params.accountId, status: TeamMembershipStatus.active,
            ...(input.owner?.kind === "team" ? { teamId: input.owner.teamId } : {}) }, select: { teamId: true } });
        const contexts = await resolveTeamActorContextsInTx(tx, { actorAccountId: params.accountId, teamIds: memberships.map(member => member.teamId) });
        const qualifications = await qualifyTeamOperationAuthenticationsInTx(tx, { ...params.authentication, contexts: [...contexts.values()] });
        const teamIds = [...contexts.values()].filter(context => context.teamCapabilities.viewTeam
            && (input.includeArchived || context.team.archivedAt === null)
            && qualifications.get(context.team.id)?.ok === true).map(context => context.team.id);
        const rowsById = new Map<string, StoredPreset>();
        // Home, custodian, archive/cursor/search and Prisma pagination are fixed;
        // Team membership contributes one bind per selected id.
        const teamChunks = portableQueryChunks({ values: teamIds, bindingsPerValue: 1,
            fixedBindings: 7 + (input.owner ? 1 : 0) });
        for (const [index, ids] of (teamChunks.length ? teamChunks : [[]]).entries()) {
            const selected = await tx.managedMachinePreset.findMany({ where: {
            homeId: input.homeId, ...(!input.includeArchived ? { archivedAt: null } : {}),
            OR: [...(index === 0 ? [{ custodianAccountId: params.accountId }] : []), { teamId: { in: [...ids] } }],
            ...(input.owner?.kind === "account" ? { custodianAccountId: input.owner.accountId } : {}),
            ...(input.owner?.kind === "team" ? { teamId: input.owner.teamId } : {}),
            ...(input.cursor ? { id: { gt: input.cursor } } : {}),
            ...(input.search ? { name: { contains: input.search } } : {}),
        }, orderBy: { id: "asc" } });
            for (const row of selected) rowsById.set(row.id, row);
        }
        const rows = [...rowsById.values()].map(row => inheritPresetOwnerArchive(row,
            row.teamId ? contexts.get(row.teamId)?.team.archivedAt : null)).sort((left, right) => left.id.localeCompare(right.id));
        const projectionAccess = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
            machineIds: rows.flatMap(row => row.teamId && row.controllerMachineId ? [row.controllerMachineId] : []),
            accountIds: [params.accountId],
        });
        const projectionFacts = await readManagedProjectionFactsInTx(tx, rows.flatMap(row => {
            const preset = projectPreset(row);
            if (!hasManagedMachinePresetCreationV1(preset) || row.teamId
                && (!preset.controller || projectionAccess.get(preset.controller.machineId)?.get(params.accountId) !== 'manage')
                && (!row.teamAcquireDelegated || row.archivedAt)) return [];
            return [{ homeId: row.homeId, controller: preset.controller, provider: preset.launch.provider }];
        }));
        const credentialProfiles = await readPresetCredentialProfilesInTx(tx, rows.filter(row => row.teamId && row.controllerMachineId
            && row.teamAcquireDelegated && !row.archivedAt
            && projectionAccess.get(row.controllerMachineId)?.get(params.accountId) !== 'manage'), projectionFacts);
        const presets: ManagedMachinePresetV1[] = [];
        for (const row of rows) presets.push(await projectPresetInTx(tx, row, row.teamId || projectPreset(row).controllerPoolId
            ? { accountId: params.accountId, authentication: params.authentication, canManageController: row.controllerMachineId !== null && projectionAccess.get(row.controllerMachineId)?.get(params.accountId) === 'manage' }
            : undefined, credentialProfiles, projectionFacts));
        return { kind: "listed", presets } as const;
    }); } catch (error) { return refusal(error); }
}

export async function updateMachinePreset(params: PresetContext & Readonly<{ input: ManagedMachinePresetUpdateInputV1 }>): Promise<PresetMutationResultV1> {
    const input = ManagedMachinePresetUpdateInputV1Schema.parse(params.input);
    try { return await inTx(async tx => {
        const discovered = await tx.managedMachinePreset.findFirst({ where: { id: input.id, homeId: input.homeId } });
        if (discovered) await acquirePresetMutationAccountsInTx(tx, { actorAccountId: params.accountId, owner: ownerOf(discovered),
            controllerMachineIds: [...(discovered.controllerMachineId ? [discovered.controllerMachineId] : []), ...(input.patch.controller ? [input.patch.controller.machineId] : [])] });
        const row = discovered ? await tx.managedMachinePreset.findFirst({ where: { id: input.id, homeId: input.homeId } }) : null;
        if (row && row.controllerMachineId !== discovered?.controllerMachineId) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
        await requireHomeInTx(tx, input.homeId);
        if (!row || !await resolvePresetAccessInTx(tx, params, ownerOf(row), 'manage')) return { kind: "refused", code: "preset_not_found" } as const;
        const current = await projectPresetInTx(tx, row);
        if (row.revision !== input.expectedRevision) return { kind: "conflict", currentRevision: row.revision } as const;
        const { retention, wakeOnAcceptedMessage, simultaneousLimit, setup, launch, controller, controllerPoolId, controllerDisplayName, ...definitionPatch } = input.patch;
        const nextDefinition = { ...current, ...definitionPatch };
        if (launch === null) delete nextDefinition.launch;
        else if (launch !== undefined) nextDefinition.launch = launch;
        if (controller === null) delete nextDefinition.controller;
        else if (controller !== undefined) nextDefinition.controller = controller;
        if (controllerPoolId === null) delete nextDefinition.controllerPoolId;
        else if (controllerPoolId !== undefined) nextDefinition.controllerPoolId = controllerPoolId;
        if (controllerDisplayName !== undefined && controllerDisplayName !== null && nextDefinition.controller && nextDefinition.launch) {
            nextDefinition.controllerDisplayName = controllerDisplayName;
        } else if (controllerDisplayName === null || !nextDefinition.launch || !nextDefinition.controller
            || controller !== undefined && !sameManagedInput(controller, current.controller)) {
            delete nextDefinition.controllerDisplayName;
        }
        if (nextDefinition.teamAcquireDelegated === false) delete nextDefinition.teamAcquireDelegated;
        await omitPrivateControllerDisplayNameInTx(tx, params.accountId, nextDefinition);
        if (setup === null) delete nextDefinition.setup;
        else if (setup !== undefined) nextDefinition.setup = setup;
        if (retention === null) delete nextDefinition.retention;
        else if (retention !== undefined) nextDefinition.retention = retention;
        if (wakeOnAcceptedMessage === null) delete nextDefinition.wakeOnAcceptedMessage;
        else if (wakeOnAcceptedMessage !== undefined) nextDefinition.wakeOnAcceptedMessage = wakeOnAcceptedMessage;
        if (simultaneousLimit === null) delete nextDefinition.simultaneousLimit;
        else if (simultaneousLimit !== undefined) nextDefinition.simultaneousLimit = simultaneousLimit;
        const parsed = ManagedMachinePresetV1Schema.safeParse(nextDefinition);
        if (!parsed.success) throw new ManagedMachineError('invalid_request');
        const next = parsed.data;
        if (next.teamAcquireDelegated && (next.owner.kind !== 'team' || !hasManagedMachinePresetCreationV1(next))) throw new ManagedMachineError('invalid_request');
        // Every edit to an approved delegated recipe keeps its controller's spend
        // approver. Withdrawal needs Manage even if the selected credential retired.
        const requiresDelegationManager = row.teamAcquireDelegated || input.patch.teamAcquireDelegated !== undefined;
        const validateLaunch = input.patch.launch !== undefined || input.patch.controller !== undefined || input.patch.controllerPoolId !== undefined
            || next.teamAcquireDelegated === true && !row.teamAcquireDelegated;
        const nextCreation = hasManagedMachinePresetCreationV1(next) ? next : undefined;
        const delegatedControllerMachineId = requiresDelegationManager ? row.controllerMachineId ?? next.controller?.machineId : undefined;
        if (validateLaunch && nextCreation) await authorizeMachinePresetCreationSaveInTx(tx, params, nextCreation);
        else if (requiresDelegationManager && nextCreation?.controllerPoolId) await authorizeMachinePresetCreationSaveInTx(tx, params, nextCreation);
        else if (delegatedControllerMachineId) await requireManagedLaunchManagerInTx(tx, params, delegatedControllerMachineId);
        if (sameManagedInput(next, current)) return { kind: "saved", preset: await projectPresetForActorInTx(tx, row, params.accountId, params.authentication) } as const;
        const result = await tx.managedMachinePreset.updateMany({ where: { id: row.id, revision: input.expectedRevision }, data: {
            name: next.name, launch: storePresetLaunch(next),
            controllerMachineId: next.controller?.machineId ?? null, controllerInstallationId: next.controller?.installationId ?? null,
            setup: next.setup ?? getActivePrismaRuntime().DbNull,
            retentionOverride: next.retention ?? getActivePrismaRuntime().DbNull,
            wakeOnAcceptedMessage: next.wakeOnAcceptedMessage ?? null,
            teamAcquireDelegated: next.teamAcquireDelegated ?? false,
            simultaneousMaximum: next.simultaneousLimit?.maximum ?? null, revision: { increment: 1 },
        } });
        const stored = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        if (!result.count) return { kind: "conflict", currentRevision: stored.revision } as const;
        await invalidatePresetInTx(tx, stored);
        return { kind: "saved", preset: await projectPresetForActorInTx(tx, stored, params.accountId, params.authentication) } as const;
    }); } catch (error) { return refusal(error); }
}

/** Archive changes launch offers only; acquired rows and capacity are untouched. */
async function setArchived(params: PresetContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>, archived: boolean): Promise<PresetMutationResultV1> {
    try { return await inTx(async tx => {
        const discovered = await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } });
        if (discovered) await acquirePresetMutationAccountsInTx(tx, { actorAccountId: params.accountId, owner: ownerOf(discovered),
            controllerMachineIds: discovered.controllerMachineId ? [discovered.controllerMachineId] : [] });
        const row = discovered ? await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } }) : null;
        if (row && row.controllerMachineId !== discovered?.controllerMachineId) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
        await requireHomeInTx(tx, params.input.homeId);
        const access = row ? await resolvePresetAccessInTx(tx, params, ownerOf(row), archived ? 'archive' : 'manage') : null;
        if (!row || !access) return { kind: "refused", code: "preset_not_found" } as const;
        if (row.revision !== params.input.expectedRevision) return { kind: "conflict", currentRevision: row.revision } as const;
        const effective = inheritPresetOwnerArchive(row, access.teamArchivedAt);
        if ((effective.archivedAt !== null) === archived) return { kind: "saved", preset: await projectPresetForActorInTx(tx, effective, params.accountId, params.authentication) } as const;
        const result = await tx.managedMachinePreset.updateMany({ where: { id: row.id, revision: row.revision }, data: { archivedAt: archived ? new Date() : null, revision: { increment: 1 } } });
        const current = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        if (!result.count) return { kind: "conflict", currentRevision: current.revision } as const;
        await invalidatePresetInTx(tx, current);
        return { kind: "saved", preset: await projectPresetForActorInTx(tx, current, params.accountId, params.authentication) } as const;
    }); } catch (error) { return refusal(error); }
}

export const archiveMachinePreset = (params: PresetContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>) => setArchived(params, true);
export const restoreMachinePreset = (params: PresetContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>) => setArchived(params, false);

/** New delegated work consumes only a current Team member's compute authority. */
async function requirePresetDelegationInTx(tx: Tx, row: StoredPreset, custodianAccountId: string, delegated: boolean): Promise<void> {
    if (!delegated) return;
    if (!row.teamId || row.teamAcquireDelegated !== true
        || (await readActiveTeamMembershipsInTx(tx, { memberships: [{ teamId: row.teamId, accountId: custodianAccountId }] }))
            .get(row.teamId)?.has(custodianAccountId) !== true) {
        throw new ManagedMachineError('permission_denied');
    }
}

/** C50 calls this inside its admission transaction, before inserting the resource row. */
export async function resolveMachinePresetForAcquireInTx(tx: Tx, params: PresetContext & Readonly<{
    homeId: string; id: string; revision: number;
    /** Preflight/proof reads omit capacity; the inserting admission always enforces it. */
    checkCapacity?: boolean;
    reviewedFacts?: unknown;
    boundController?: ManagedControllerV1;
    poolSelection?: Readonly<{ requestKey: string; presence: MachineDaemonPresenceInventory }>;
}>): Promise<Readonly<{ kind: "ready"; preset: ManagedMachinePresetV1 & ManagedMachinePresetCreationV1; declaration: ManagedDeclaration; custodianAccountId: string; delegated: boolean;
    controllerAccess?: ManagedControllerAccessV1; poolPriorityTier?: number }> | PresetRefusal | Extract<PresetMutationResultV1, { kind: "conflict" }>> {
    await requireHomeInTx(tx, params.homeId);
    const stored = await tx.managedMachinePreset.findFirst({ where: { id: params.id, homeId: params.homeId } });
    const access = stored ? await resolvePresetAccessInTx(tx, params, ownerOf(stored), 'read') : null;
    if (!stored || !access) return { kind: "refused", code: "preset_not_found" };
    const row = inheritPresetOwnerArchive(stored, access.teamArchivedAt);
    if (row.revision !== params.revision) return { kind: "conflict", currentRevision: row.revision };
    if (row.archivedAt) return { kind: "refused", code: "preset_archived" };
    const preset = projectPreset(row);
    if (!hasManagedMachinePresetCreationV1(preset)) return { kind: 'refused', code: 'invalid_request' };
    // Admission's controller Account fence serializes this preset's count/create.
    if (params.checkCapacity !== false && row.simultaneousMaximum !== null && await tx.managedMachine.count({ where: { homeId: row.homeId, presetId: row.id, allocation: { not: "confirmed-absent" } } }) >= row.simultaneousMaximum) return { kind: "refused", code: "preset_limit_reached" };
    if (preset.controllerPoolId) {
        const pool = await readManagedPresetPoolCandidatesInTx(tx, params, preset, params.poolSelection?.presence);
        const delegated = pool.custodianAccountId !== params.accountId;
        await requirePresetDelegationInTx(tx, row, pool.custodianAccountId, delegated);
        const selection = params.poolSelection ? selectMachinePoolCandidate({ members: pool.snapshot.members,
            availableMachineIds: new Set(pool.candidates.filter(candidate => pool.snapshot.availableMachineIds.has(candidate.controller.machineId))
                .map(candidate => candidate.controller.machineId)), requestKey: params.poolSelection.requestKey, purpose: 'session' }) : null;
        const controller = selection ? pool.candidates.find(candidate => candidate.controller.machineId === selection.machineId)?.controller : params.boundController;
        const selected = controller && pool.candidates.find(candidate => sameManagedInput(candidate.controller, controller));
        if (!selected) throw new ManagedMachineError('controller_unavailable');
        const { controllerPoolId: _pool, ...definition } = preset;
        return { kind: 'ready', preset: { ...definition, controller: selected.controller }, delegated,
            custodianAccountId: pool.custodianAccountId, declaration: selected.declaration, controllerAccess: selected.access,
            ...(selection ? { poolPriorityTier: selection.priorityTier } : {}) };
    }
    if (!preset.controller) {
        if (preset.owner.kind !== 'account' || preset.owner.accountId !== params.accountId) throw new ManagedMachineError('permission_denied');
        const validated = await validateManagedLaunchInTx(tx, params, preset, params.reviewedFacts);
        if (!validated.declaration) throw new ManagedMachineError('invalid_request');
        return { kind: 'ready', preset, declaration: validated.declaration, custodianAccountId: validated.custodianAccountId, delegated: false };
    }
    const delegated = await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: params.accountId, machineId: preset.controller.machineId }) !== 'manage';
    const validated = await validateStoredManagedLaunchInTx(tx, preset);
    await requirePresetDelegationInTx(tx, row, validated.custodianAccountId, delegated);
    const admitted = projectPreset(row, validated.declaration);
    if (!hasManagedMachinePresetCreationV1(admitted)) throw new ManagedMachineError('invalid_request');
    return { kind: 'ready', preset: admitted, delegated,
        declaration: validated.declaration, custodianAccountId: validated.custodianAccountId };
}
