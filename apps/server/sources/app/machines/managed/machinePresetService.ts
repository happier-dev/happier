import type { Prisma } from "@prisma/client";
import {
    ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetUpdateInputV1Schema,
    ManagedMachinePresetV1ReadSchema, ManagedMachinePresetV1Schema,
    createManagedMachinePresetV1Schema, createStoredReadSchema,
    isQualifiedConnectedAccountProfileActiveV4,
    sameQualifiedConnectedAccountRef,
    type ManagedMachinePresetV1, type ManagedMachinePresetCreateInputV1,
    type ManagedMachinePresetUpdateInputV1, type ManagedMachinePresetRevisionInputV1,
    type ManagedMachinePresetGetInputV1, type ManagedMachinePresetListInputV1,
    type ManagedMachinePresetGetResultV1, type ManagedMachinePresetListResultV1,
    type PresetMutationResultV1,
} from "@happier-dev/protocol";
import { qualifyPluginContributionReferenceV1 } from "@happier-dev/protocol/plugins/contribution-identity";
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { isMachineProvisionerCredentialPurposeRequiredV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

import { inTx, type Tx } from "@/storage/inTx";
import { db, isPrismaUniqueConstraintError, getActivePrismaRuntime } from "@/storage/db";
import { AccountStatus, TeamMembershipStatus } from "@/storage/enums.generated";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import {
    resolveTeamActorContextInTx, qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextsInTx, qualifyTeamOperationAuthenticationsInTx,
    type TeamOperationAuthenticationContext,
} from "@/app/teams/actorContext";
import { listQualifiedConnectedAccountsInTx } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import {
    ManagedMachineError, requireManagedControllerInTx, resolveManagedDeclarationInTx,
    sameManagedInput,
    type ManagedDeclaration,
} from "./managedRows";

type StoredPreset = Prisma.ManagedMachinePresetGetPayload<Record<string, never>>;
type PresetRefusal = Extract<PresetMutationResultV1, { kind: "refused" }>;
type PresetContext = Readonly<{ accountId: string; authentication?: Partial<TeamOperationAuthenticationContext> }>;

function ownerOf(row: StoredPreset): ManagedMachinePresetV1["owner"] {
    return row.teamId ? { kind: "team", teamId: row.teamId } : { kind: "account", accountId: row.custodianAccountId ?? "" };
}

function projectPreset(row: StoredPreset, declaration?: ManagedDeclaration | null): ManagedMachinePresetV1 {
    const schema = declaration ? createStoredReadSchema(createManagedMachinePresetV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema))) : ManagedMachinePresetV1ReadSchema;
    return ManagedMachinePresetV1Schema.parse(schema.parse({
        id: row.id, homeId: row.homeId, revision: row.revision, name: row.name,
        owner: ownerOf(row),
        recipe: row.launch,
        controller: { machineId: row.controllerMachineId, installationId: row.controllerInstallationId },
        ...(row.retentionOverride !== null ? { retention: row.retentionOverride } : {}),
        ...(row.wakeOnAcceptedMessage !== null ? { wakeOnAcceptedMessage: row.wakeOnAcceptedMessage } : {}),
        ...(row.simultaneousMaximum !== null ? { simultaneousLimit: { maximum: row.simultaneousMaximum } } : {}),
        ...(row.archivedAt !== null ? { archivedAt: row.archivedAt.getTime() } : {}),
    }));
}

async function projectPresetInTx(tx: Tx, row: StoredPreset): Promise<ManagedMachinePresetV1> {
    const controller = await tx.machine.findUnique({ where: { id: row.controllerMachineId }, select: { accountId: true } });
    const recipe = projectPreset(row).recipe;
    const declaration = controller ? await resolveManagedDeclarationInTx(tx, { homeId: row.homeId,
        custodianAccountId: controller.accountId, controller: { machineId: row.controllerMachineId, installationId: row.controllerInstallationId }, provider: recipe.provider }) : null;
    return projectPreset(row, declaration?.schemaVersion === recipe.schemaVersion ? declaration : null);
}

async function mayAccessInTx(tx: Tx, context: PresetContext, owner: ManagedMachinePresetV1["owner"], manage: boolean): Promise<boolean> {
    if (owner.kind === "account") {
        if (owner.accountId !== context.accountId) return false;
        return (await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status === AccountStatus.active;
    }
    const actor = await resolveTeamActorContextInTx(tx, { teamId: owner.teamId, actorAccountId: context.accountId });
    if (!actor || !(manage ? actor.teamCapabilities.manageSettings : actor.teamCapabilities.viewTeam)) return false;
    return (await qualifyTeamOperationAuthenticationInTx(tx, { ...context.authentication, context: actor })).ok;
}

async function requireHomeInTx(tx: Tx, homeId: string): Promise<void> {
    if (await readCurrentServerIdentityId(process.env, tx) !== homeId) throw new ManagedMachineError("permission_denied");
}

async function invalidatePresetInTx(tx: Tx, row: StoredPreset): Promise<void> {
    const accountIds = row.teamId
        ? (await tx.teamMembership.findMany({ where: { teamId: row.teamId, status: TeamMembershipStatus.active, account: { status: AccountStatus.active } }, select: { accountId: true } })).map(member => member.accountId)
        : row.custodianAccountId ? [row.custodianAccountId] : [];
    await markAccountsChanged(tx, { accountIds, entityId: row.id });
}

/** Save and acquire consume the same current declaration and credential-source readers. No material is read. */
export async function validateManagedRecipeInTx(tx: Tx, context: PresetContext, preset: Pick<ManagedMachinePresetV1, "homeId" | "controller" | "recipe">): Promise<Readonly<{ declaration: ManagedDeclaration; custodianAccountId: string }>> {
    if ((await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status !== AccountStatus.active) throw new ManagedMachineError("permission_denied");
    if (await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: context.accountId, machineId: preset.controller.machineId }) !== "manage") throw new ManagedMachineError("permission_denied");
    const controller = await tx.machine.findUniqueOrThrow({ where: { id: preset.controller.machineId }, select: { accountId: true } });
    const custodianAccountId = controller.accountId;
    await requireManagedControllerInTx(tx, { homeId: preset.homeId, custodianAccountId, controller: preset.controller });
    const declaration = await resolveManagedDeclarationInTx(tx, { homeId: preset.homeId, custodianAccountId, controller: preset.controller, provider: preset.recipe.provider });
    if (!declaration || declaration.schemaVersion !== preset.recipe.schemaVersion) throw new ManagedMachineError("provider_unavailable");
    const validated = createManagedMachinePresetV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema)).safeParse({ ...preset, id: "validation", name: "validation", revision: 0, owner: { kind: "account", accountId: custodianAccountId } });
    if (!validated.success) throw new ManagedMachineError("invalid_request");
    const credentials = preset.recipe.credentials ?? [];
    const requests = declaration.acquireCredentialRequests.filter(binding => isMachineProvisionerCredentialPurposeRequiredV1(
        declaration, binding.request.id, validated.data.recipe.choices));
    if (requests.length !== credentials.length) throw new ManagedMachineError("credential_unavailable");
    // Save and acquire validate every distinct native purpose against the
    // same declared Connected-account owner; no material or default is copied.
    for (const credential of credentials) {
        if (!sameManagedInput(credential.purpose.consumer, preset.recipe.provider)) throw new ManagedMachineError("credential_unavailable");
        const matches = requests.filter(binding => binding.request.id === credential.purpose.purpose);
        const request = matches[0]?.request;
        if (matches.length !== 1 || !request || !request.scope.serviceRefs.some(service =>
            sameManagedInput(qualifyPluginContributionReferenceV1(service, preset.recipe.provider.pluginId), credential.account.service))) {
            throw new ManagedMachineError("credential_unavailable");
        }
        const accounts = await listQualifiedConnectedAccountsInTx(tx, { accountId: custodianAccountId, service: credential.account.service });
        const selected = accounts.find(account => sameQualifiedConnectedAccountRef(account.ref, credential.account));
        if (!selected || !isQualifiedConnectedAccountProfileActiveV4(selected, Date.now())) throw new ManagedMachineError("credential_unavailable");
    }
    return { declaration, custodianAccountId };
}

function refusal(error: unknown): PresetRefusal {
    if (error instanceof ManagedMachineError) return { kind: "refused", code: error.code };
    throw error;
}

function definition(preset: ManagedMachinePresetV1): ManagedMachinePresetCreateInputV1 {
    const { revision: _revision, archivedAt: _archivedAt, ...value } = preset;
    return value;
}

export async function createMachinePreset(params: PresetContext & Readonly<{ input: ManagedMachinePresetCreateInputV1 }>): Promise<PresetMutationResultV1> {
    const input = ManagedMachinePresetCreateInputV1Schema.parse(params.input);
    const execute = () => inTx(async tx => {
        await requireHomeInTx(tx, input.homeId);
        if (!await mayAccessInTx(tx, params, input.owner, true)) return { kind: "refused", code: "permission_denied" } as const;
        const existing = await tx.managedMachinePreset.findUnique({ where: { id: input.id } });
        if (existing) {
            if (!await mayAccessInTx(tx, params, ownerOf(existing), true) || existing.homeId !== input.homeId) return { kind: "refused", code: "permission_denied" } as const;
            const current = await projectPresetInTx(tx, existing);
            return sameManagedInput(definition(current), input)
                ? { kind: "saved", preset: current } as const
                : { kind: "conflict", currentRevision: current.revision } as const;
        }
        await validateManagedRecipeInTx(tx, params, input);
        const row = await tx.managedMachinePreset.create({ data: {
            id: input.id, homeId: input.homeId, name: input.name,
            custodianAccountId: input.owner.kind === "account" ? input.owner.accountId : null,
            teamId: input.owner.kind === "team" ? input.owner.teamId : null,
            launch: input.recipe, controllerMachineId: input.controller.machineId, controllerInstallationId: input.controller.installationId,
            ...(input.retention ? { retentionOverride: input.retention } : {}),
            wakeOnAcceptedMessage: input.wakeOnAcceptedMessage,
            simultaneousMaximum: input.simultaneousLimit?.maximum,
        } });
        await invalidatePresetInTx(tx, row);
        return { kind: "saved", preset: await projectPresetInTx(tx, row) } as const;
    });
    try { return await execute(); }
    catch (error) { if (isPrismaUniqueConstraintError(error)) return await execute(); return refusal(error); }
}

export async function getMachinePreset(params: PresetContext & Readonly<{ input: ManagedMachinePresetGetInputV1 }>): Promise<ManagedMachinePresetGetResultV1> {
    try { return await inTx(async tx => {
        await requireHomeInTx(tx, params.input.homeId);
        const row = await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } });
        if (!row || !await mayAccessInTx(tx, params, ownerOf(row), false)) return { kind: "refused", code: "preset_not_found" } as const;
        return { kind: "found", preset: await projectPresetInTx(tx, row) } as const;
    }); } catch (error) { return refusal(error); }
}

export async function listMachinePresets(params: PresetContext & Readonly<{ input: ManagedMachinePresetListInputV1 }>): Promise<ManagedMachinePresetListResultV1> {
    try { return await inTx(async tx => {
        await requireHomeInTx(tx, params.input.homeId);
        const input = params.input;
        if ((await tx.account.findUnique({ where: { id: params.accountId }, select: { status: true } }))?.status !== AccountStatus.active) return { kind: "listed", presets: [] } as const;
        const memberships = await tx.teamMembership.findMany({ where: { accountId: params.accountId, status: TeamMembershipStatus.active,
            ...(input.owner?.kind === "team" ? { teamId: input.owner.teamId } : {}) }, select: { teamId: true } });
        const contexts = await resolveTeamActorContextsInTx(tx, { actorAccountId: params.accountId, teamIds: memberships.map(member => member.teamId) });
        const qualifications = await qualifyTeamOperationAuthenticationsInTx(tx, { ...params.authentication, contexts: [...contexts.values()] });
        const teamIds = [...contexts.values()].filter(context => context.teamCapabilities.viewTeam && qualifications.get(context.team.id)?.ok === true).map(context => context.team.id);
        const rows = await tx.managedMachinePreset.findMany({ where: {
            homeId: input.homeId, ...(!input.includeArchived ? { archivedAt: null } : {}),
            OR: [{ custodianAccountId: params.accountId }, { teamId: { in: teamIds } }],
            ...(input.owner?.kind === "account" ? { custodianAccountId: input.owner.accountId } : {}),
            ...(input.owner?.kind === "team" ? { teamId: input.owner.teamId } : {}),
            ...(input.cursor ? { id: { gt: input.cursor } } : {}),
            ...(input.search ? { name: { contains: input.search } } : {}),
        }, orderBy: { id: "asc" } });
        const presets: ManagedMachinePresetV1[] = [];
        for (const row of rows) presets.push(await projectPresetInTx(tx, row));
        return { kind: "listed", presets } as const;
    }); } catch (error) { return refusal(error); }
}

export async function updateMachinePreset(params: PresetContext & Readonly<{ input: ManagedMachinePresetUpdateInputV1 }>): Promise<PresetMutationResultV1> {
    const input = ManagedMachinePresetUpdateInputV1Schema.parse(params.input);
    try { return await inTx(async tx => {
        await requireHomeInTx(tx, input.homeId);
        const row = await tx.managedMachinePreset.findFirst({ where: { id: input.id, homeId: input.homeId } });
        if (!row || !await mayAccessInTx(tx, params, ownerOf(row), true)) return { kind: "refused", code: "preset_not_found" } as const;
        const current = await projectPresetInTx(tx, row);
        if (row.revision !== input.expectedRevision) return { kind: "conflict", currentRevision: row.revision } as const;
        const { retention, wakeOnAcceptedMessage, simultaneousLimit, ...definitionPatch } = input.patch;
        const nextDefinition = { ...current, ...definitionPatch };
        if (retention === null) delete nextDefinition.retention;
        else if (retention !== undefined) nextDefinition.retention = retention;
        if (wakeOnAcceptedMessage === null) delete nextDefinition.wakeOnAcceptedMessage;
        else if (wakeOnAcceptedMessage !== undefined) nextDefinition.wakeOnAcceptedMessage = wakeOnAcceptedMessage;
        if (simultaneousLimit === null) delete nextDefinition.simultaneousLimit;
        else if (simultaneousLimit !== undefined) nextDefinition.simultaneousLimit = simultaneousLimit;
        const next = ManagedMachinePresetV1Schema.parse(nextDefinition);
        if (input.patch.recipe !== undefined || input.patch.controller !== undefined) await validateManagedRecipeInTx(tx, params, next);
        if (sameManagedInput(next, current)) return { kind: "saved", preset: current } as const;
        const result = await tx.managedMachinePreset.updateMany({ where: { id: row.id, revision: input.expectedRevision }, data: {
            name: next.name, launch: next.recipe, controllerMachineId: next.controller.machineId, controllerInstallationId: next.controller.installationId,
            retentionOverride: next.retention ?? getActivePrismaRuntime().DbNull,
            wakeOnAcceptedMessage: next.wakeOnAcceptedMessage ?? null,
            simultaneousMaximum: next.simultaneousLimit?.maximum ?? null, revision: { increment: 1 },
        } });
        const stored = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        if (!result.count) return { kind: "conflict", currentRevision: stored.revision } as const;
        await invalidatePresetInTx(tx, stored);
        return { kind: "saved", preset: await projectPresetInTx(tx, stored) } as const;
    }); } catch (error) { return refusal(error); }
}

/** Archive changes recipe offers only; acquired rows and capacity are untouched. */
async function setArchived(params: PresetContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>, archived: boolean): Promise<PresetMutationResultV1> {
    try { return await inTx(async tx => {
        await requireHomeInTx(tx, params.input.homeId);
        const row = await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } });
        if (!row || !await mayAccessInTx(tx, params, ownerOf(row), true)) return { kind: "refused", code: "preset_not_found" } as const;
        if (row.revision !== params.input.expectedRevision) return { kind: "conflict", currentRevision: row.revision } as const;
        if ((row.archivedAt !== null) === archived) return { kind: "saved", preset: await projectPresetInTx(tx, row) } as const;
        const result = await tx.managedMachinePreset.updateMany({ where: { id: row.id, revision: row.revision }, data: { archivedAt: archived ? new Date() : null, revision: { increment: 1 } } });
        const current = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        if (!result.count) return { kind: "conflict", currentRevision: current.revision } as const;
        await invalidatePresetInTx(tx, current);
        return { kind: "saved", preset: await projectPresetInTx(tx, current) } as const;
    }); } catch (error) { return refusal(error); }
}

export const archiveMachinePreset = (params: PresetContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>) => setArchived(params, true);
export const restoreMachinePreset = (params: PresetContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>) => setArchived(params, false);

/** C50 calls this inside its admission transaction, before inserting the resource row. */
export async function resolveMachinePresetForAcquireInTx(tx: Tx, params: PresetContext & Readonly<{
    homeId: string; id: string; revision: number;
}>): Promise<Readonly<{ kind: "ready"; preset: ManagedMachinePresetV1; declaration: ManagedDeclaration; custodianAccountId: string }> | PresetRefusal | Extract<PresetMutationResultV1, { kind: "conflict" }>> {
    await requireHomeInTx(tx, params.homeId);
    const row = await tx.managedMachinePreset.findFirst({ where: { id: params.id, homeId: params.homeId } });
    if (!row || !await mayAccessInTx(tx, params, ownerOf(row), false)) return { kind: "refused", code: "preset_not_found" };
    if (row.revision !== params.revision) return { kind: "conflict", currentRevision: row.revision };
    if (row.archivedAt) return { kind: "refused", code: "preset_archived" };
    if (row.teamId && (await tx.team.findUnique({ where: { id: row.teamId }, select: { archivedAt: true } }))?.archivedAt) return { kind: "refused", code: "permission_denied" };
    // The caller's canonical admission transaction owns serializable read/count/create and retries.
    if (row.simultaneousMaximum !== null && await tx.managedMachine.count({ where: { homeId: row.homeId, presetId: row.id, allocation: { not: "confirmed-absent" } } }) >= row.simultaneousMaximum) return { kind: "refused", code: "preset_limit_reached" };
    const preset = await projectPresetInTx(tx, row);
    return { kind: "ready", preset, ...await validateManagedRecipeInTx(tx, params, preset) };
}
