import type { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from 'node:util';
import { ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema, ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetRecipientCensusInputV1Schema, ManagedMachinePresetUpdateInputV1Schema, ManagedMachinePresetV1Schema, type AccountEncryptionMigrateManagedMachinePresetsDirectiveV1, type ManagedMachinePresetAccountEncryptionMigrationInventoryV1, type ManagedMachinePresetV1, type ManagedMachinePresetCreateInputV1, type ManagedMachinePresetRecipientCensusInputV1, type ManagedMachinePresetRecipientCensusResultV1, type ManagedMachinePresetUpdateInputV1, type ManagedMachinePresetRevisionInputV1, type ManagedMachinePresetGetInputV1, type ManagedMachinePresetListInputV1, type ManagedMachinePresetGetResultV1, type ManagedMachinePresetListResultV1, type PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { isManagedResizeActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ManagedOpaqueMachineSetupStateV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ProviderObservationV1Schema, projectManagedOpaquePresetObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { isQualifiedConnectedAccountProfileActiveV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { qualifyPluginContributionReferenceV1 } from "@happier-dev/protocol/plugins/contribution-identity";
import { isMachineProvisionerCredentialPurposeRequiredV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

import { inReadSnapshot, inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { db, isPrismaUniqueConstraintError, getActivePrismaRuntime } from "@/storage/db";
import { AccountStatus, TeamMembershipStatus } from "@/storage/enums.generated";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import { resolveMachinePoolForManagedPresetInTx } from '@/app/machines/pools/machinePoolService';
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from "@/app/changes/markAccountChanged";
import {
    resolveTeamActorContextInTx, qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextsInTx, qualifyTeamOperationAuthenticationsInTx,
    readActiveTeamMembershipsInTx,
} from "@/app/teams/actorContext";
import { listQualifiedConnectedAccountsInTx } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { createQualifiedConnectedAccountIdentityDigest } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import {
    ManagedMachineError, requireManagedControllerInTx, requireManagedHomeInTx, resolveManagedDeclarationInTx,
    sameManagedInput, projectManagedControllerAccess, readManagedJsonEqualityOperand,
    readStoredOpaquePresetLaunch, storeOpaquePresetLaunch, invalidateManagedMachineInTx,
    type ManagedDeclaration, type ManagedDeclarationBodies, type StoredManagedMachine, readManagedReviewedDeclaration,
    readManagedAdmissionState, projectManagedPresetAdmissionForOpaqueStorage,
} from "./managedRows";
import { readTeamResourcePublicationAudienceInTx } from '@/app/teams/resourcePublicationAudience';
import { readManagedPresetPoolCandidatesInTx } from './machinePresetPool';
import {
    authorizeMachinePresetCreationSaveInTx,
    requireManagedLaunchManagerInTx,
    type PresetContext,
    type PresetCreation,
} from './machinePresetSave';
import { hasStoredOpaquePresetEnvelope, readStoredPresetSnapshotContent } from './managedMachineProjection';
import { selectMachinePoolCandidate } from '@happier-dev/protocol/machines/pools';
import { createValidatedLaunchSnapshotV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { ManagedControllerV1, ManagedControllerAccessV1, ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import {
    RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    readRequiredResourceRecipientEnvelopeRejectionV1,
    readSavedSecretAudienceRecipientEnvelopeCensusInTx,
    readTargetOwnerRecipientEnvelopeRejectionV1,
    type ResourceRecipientAccountRow,
    type ResourceRecipientEnvelopeRow,
} from '@/app/encryption/savedSecretRecipientEnvelopeCensus';

type StoredPreset = Prisma.ManagedMachinePresetGetPayload<Record<string, never>>;
type StoredPresetSnapshot = StoredManagedMachine;
type OneOffManagedLaunchValidationInput = Readonly<{
    homeId: string;
    controller?: ManagedControllerV1;
    launch: ValidatedLaunchSnapshotV1;
}>;
type PresetRefusal = Extract<PresetMutationResultV1, { kind: "refused" }>;
export type ManagedMachinePresetManageContext = PresetContext;
type PresetPreparationContext = PresetContext & Readonly<{
    /** The HTTP purpose owner verified this original signed admission against the exact route operands. */
    presetPreparationAdmission?: ManagedMachinePresetRevisionInputV1;
}>;

/** Opaque preset admission can route only to an explicit controller or Pool. */
function hasPresetControllerTarget(preset: Pick<ManagedMachinePresetV1, 'controller' | 'controllerPoolId'>): boolean {
    return preset.controller !== undefined || preset.controllerPoolId !== undefined;
}

/** Storage keeps the canonical Saved Secret envelope wire; the census owner consumes its bytes. */
function readPresetRecipientEnvelopeRows(recipients: ManagedMachinePresetV1['recipients']): readonly ResourceRecipientEnvelopeRow[] | null {
    try {
        return recipients.map((recipient) => ({
            accountId: recipient.accountId,
            encryptedDataKey: decodeBase64(recipient.envelope.encryptedDataKey, 'base64'),
            recipientContentPublicKeyFingerprint: recipient.envelope.recipientContentPublicKeyFingerprint,
        }));
    } catch {
        return null;
    }
}

function ownerOf(row: Pick<StoredPreset, 'teamId' | 'custodianAccountId'>): ManagedMachinePresetV1["owner"] {
    return row.teamId ? { kind: "team", teamId: row.teamId } : { kind: "account", accountId: row.custodianAccountId ?? "" };
}

/** Team archive is inherited for reads and new selection, never written into the Preset row. */
function inheritPresetOwnerArchive<T extends { archivedAt: Date | null }>(row: T, teamArchivedAt: Date | null | undefined): T {
    return row.archivedAt === null && teamArchivedAt ? { ...row, archivedAt: teamArchivedAt } : row;
}

function readStoredPresetContent(row: StoredPreset) {
    if (hasStoredOpaquePresetEnvelope(row.launch)) return readStoredOpaquePresetLaunch(row.launch);
    if (row.launch !== null && (typeof row.launch !== 'object' || Array.isArray(row.launch))) {
        throw new ManagedMachineError('invalid_request');
    }
    // Legacy database JSON is an object here; its member values remain unknown.
    const { controllerPoolId, controllerDisplayName, ...launch } = (row.launch ?? {}) as Readonly<Record<string, unknown>>;
    if (controllerPoolId !== undefined && typeof controllerPoolId !== 'string') throw new ManagedMachineError('invalid_request');
    return storeOpaquePresetLaunch({
        contentEncryptionMode: 'plain', recipients: [],
        content: { t: 'plain', v: { v: 1, name: row.name,
            ...(row.launch === null ? {} : { launch }),
            ...(row.setup === null ? {} : { setup: row.setup }),
            ...(controllerDisplayName === undefined ? {} : { controllerDisplayName }),
        } },
        ...(controllerPoolId === undefined ? {} : { controllerPoolId }),
    });
}

function projectPreset(row: StoredPreset): ManagedMachinePresetV1 {
    const stored = readStoredPresetContent(row);
    return ManagedMachinePresetV1Schema.parse({
        id: row.id, homeId: row.homeId, revision: row.revision, configurationRevision: row.configurationRevision,
        setupRevision: row.setupRevision, owner: ownerOf(row),
        contentEncryptionMode: stored.contentEncryptionMode,
        content: stored.content, recipients: stored.recipients,
        ...(stored.controllerPoolId === undefined ? {} : { controllerPoolId: stored.controllerPoolId }),
        ...(row.controllerMachineId !== null || row.controllerInstallationId !== null
            ? { controller: { machineId: row.controllerMachineId, installationId: row.controllerInstallationId } } : {}),
        ...(row.retentionOverride !== null ? { retention: row.retentionOverride } : {}),
        ...(row.wakeOnAcceptedMessage !== null ? { wakeOnAcceptedMessage: row.wakeOnAcceptedMessage } : {}),
        ...(row.teamAcquireDelegated ? { teamAcquireDelegated: true } : {}),
        ...(row.simultaneousMaximum !== null ? { simultaneousLimit: { maximum: row.simultaneousMaximum } } : {}),
        ...(row.archivedAt !== null ? { archivedAt: row.archivedAt.getTime() } : {}),
    });
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

/** Shared in-transaction Team/account manage admission for a mutation that owns its own transaction. */
export async function requireMachinePresetManageInTx(tx: Tx, context: ManagedMachinePresetManageContext,
    owner: ManagedMachinePresetV1['owner']): Promise<void> {
    if (await resolvePresetAccessInTx(tx, context, owner, 'manage') === null) {
        throw new ManagedMachineError('permission_denied');
    }
}

async function requireHomeInTx(tx: Tx, homeId: string): Promise<void> {
    if (await readCurrentServerIdentityId(process.env, tx) !== homeId) throw new ManagedMachineError("permission_denied");
}

/** Finite preset work admits its original revision once; later content writes retain their CAS. */
export async function admitMachinePresetFiniteOperationInTx(tx: Tx, params: PresetContext & Readonly<{
    input: ManagedMachinePresetRevisionInputV1;
    actionId: 'prepare' | 'archive';
}>): Promise<void> {
    await requireHomeInTx(tx, params.input.homeId);
    const row = await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } });
    if (!row || params.actionId === 'prepare' && row.archivedAt !== null) throw new ManagedMachineError('preset_not_found');
    if (await resolvePresetAccessInTx(tx, params, ownerOf(row), params.actionId === 'archive' ? 'archive' : 'manage') === null) {
        throw new ManagedMachineError('permission_denied');
    }
    if (row.revision !== params.input.expectedRevision) throw new ManagedMachineError('request_conflict');
}

/** A fresh content writer's persisted mode admits tagged content; recipient selection stays server-owned. */
async function requirePresetContentModeInTx(tx: Tx, authorAccountId: string | null, preset: Pick<ManagedMachinePresetV1,
    'content' | 'contentEncryptionMode' | 'recipients'>): Promise<'plain' | 'e2ee'> {
    const mode = preset.content.t === 'plain' ? 'plain' : 'e2ee';
    if (preset.contentEncryptionMode !== mode) {
        throw new ManagedMachineError('account_mode_mismatch');
    }
    if (authorAccountId !== null) {
        const account = await tx.account.findUnique({ where: { id: authorAccountId }, select: { encryptionMode: true } });
        if (!account) throw new ManagedMachineError('permission_denied');
        if (account.encryptionMode !== mode) throw new ManagedMachineError('account_mode_mismatch');
    }
    if (mode === 'plain' && preset.recipients.length !== 0) throw new ManagedMachineError('invalid_request');
    return mode;
}

/** Current controller custody is an envelope audience fact, never a private-launch read. */
async function readPresetRecipientCustodianAccountIdInTx(tx: Tx, context: PresetContext,
    preset: Pick<ManagedMachinePresetV1, 'homeId' | 'owner' | 'controller' | 'controllerPoolId'>): Promise<string | null> {
    if (preset.controllerPoolId) {
        const pool = await resolveMachinePoolForManagedPresetInTx(tx, {
            actorAccountId: context.accountId,
            ...(preset.owner.kind === 'team' ? { teamId: preset.owner.teamId } : {}),
            poolId: preset.controllerPoolId,
            presence: { state: 'unavailable' },
            authentication: context.authentication,
        });
        if (!pool.ok) throw new ManagedMachineError('controller_unavailable');
        return pool.value.custodianAccountId;
    }
    if (!preset.controller) return null;
    // Envelope audience is a persistence-time structural fact. It deliberately
    // does not reuse fresh acquire's availability/installation admission.
    await requireManagedHomeInTx(tx, preset.homeId);
    const controller = await tx.machine.findUnique({ where: { id: preset.controller.machineId }, select: { accountId: true } });
    if (!controller) throw new ManagedMachineError('permission_denied');
    return controller.accountId;
}

async function readPresetRecipientAudienceCensusInTx(tx: Tx, context: PresetContext,
    preset: Pick<ManagedMachinePresetV1, 'homeId' | 'owner' | 'controller' | 'controllerPoolId'>,
    envelopes: readonly ResourceRecipientEnvelopeRow[] = []) {
    const custodianAccountId = await readPresetRecipientCustodianAccountIdInTx(tx, context, preset);
    const census = await readSavedSecretAudienceRecipientEnvelopeCensusInTx(tx, {
        // A Team row has no separate recipient grant for its writer: current Team
        // principals decide the complete audience. Account rows retain their owner.
        ownerAccountId: preset.owner.kind === 'account' ? preset.owner.accountId : undefined,
        accountIds: [],
        teamIds: preset.owner.kind === 'team' ? [preset.owner.teamId] : [],
        groupIds: [],
        envelopes,
    });
    if (custodianAccountId !== null && !census.recipientAccountIds.includes(custodianAccountId)) {
        throw new ManagedMachineError('credential_unavailable');
    }
    return census;
}

/** Every content or recipients CAS rechecks the live Team/custodian audience. */
async function validatePresetRecipientsInTx(tx: Tx, context: PresetContext,
    preset: Pick<ManagedMachinePresetV1, 'homeId' | 'owner' | 'controller' | 'controllerPoolId' | 'content' | 'contentEncryptionMode' | 'recipients'>,
    authorAccountId: string | null): Promise<void> {
    const mode = await requirePresetContentModeInTx(tx, authorAccountId, preset);
    if (mode === 'plain') return;
    const envelopes = readPresetRecipientEnvelopeRows(preset.recipients);
    if (envelopes === null) throw new ManagedMachineError('credential_unavailable');
    const census = await readPresetRecipientAudienceCensusInTx(tx, context, preset, envelopes);
    await validatePresetRecipientEnvelopeCensusInTx(tx, census.recipientAccountIds, envelopes);
}

/** Source saves and retained reports consume the same complete-audience envelope validator. */
async function validatePresetRecipientEnvelopeCensusInTx(tx: Tx, recipientAccountIds: readonly string[],
    envelopes: readonly ResourceRecipientEnvelopeRow[]): Promise<void> {
    const recipientRows = recipientAccountIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: [...recipientAccountIds] } },
        select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    });
    const rejection = readRequiredResourceRecipientEnvelopeRejectionV1({
        expectedRecipientAccountIds: recipientAccountIds,
        envelopes,
        recipientsById: new Map(recipientRows.map((recipient) => [recipient.id, recipient])),
    });
    if (rejection !== null) throw new ManagedMachineError('credential_unavailable');
}

/**
 * Rewrites only an opaque source-preset envelope inside a caller-owned transaction.
 * Secret promotion/deletion uses this rather than the public mutation route so its
 * reference rewrite and preset revision form one atomic effect.
 */
export async function rewriteMachinePresetContentInTx(tx: Tx, input: Readonly<{
    context: ManagedMachinePresetManageContext;
    presetId: string;
    expectedRevision: number;
    replacement: Pick<ManagedMachinePresetV1, 'content' | 'recipients'>;
}>): Promise<Readonly<{ kind: 'saved'; revision: number }> | Readonly<{ kind: 'conflict'; currentRevision: number }> | Readonly<{ kind: 'not_found' }>> {
    const discovered = await tx.managedMachinePreset.findUnique({ where: { id: input.presetId } });
    if (!discovered) return { kind: 'not_found' };
    await acquirePresetMutationAccountsInTx(tx, {
        actorAccountId: input.context.accountId,
        owner: ownerOf(discovered),
        controllerMachineIds: discovered.controllerMachineId ? [discovered.controllerMachineId] : [],
    });
    const row = await tx.managedMachinePreset.findUnique({ where: { id: input.presetId } });
    if (!row) return { kind: 'not_found' };
    if (row.controllerMachineId !== discovered.controllerMachineId) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    await requireMachinePresetManageInTx(tx, input.context, ownerOf(row));
    if (row.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: row.revision };
    const current = projectPreset(row);
    const next = ManagedMachinePresetV1Schema.parse({ ...current, ...input.replacement });
    await validatePresetRecipientsInTx(tx, input.context, next, input.context.accountId);
    if (hasStoredOpaquePresetEnvelope(row.launch) && sameManagedInput(next, current)) return { kind: 'saved', revision: row.revision };
    const updated = await tx.managedMachinePreset.updateMany({
        where: { id: row.id, revision: input.expectedRevision },
        data: { name: '', setup: getActivePrismaRuntime().DbNull, launch: storeOpaquePresetLaunch(next), revision: { increment: 1 } },
    });
    if (!updated.count) {
        const current = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        return { kind: 'conflict', currentRevision: current.revision };
    }
    await invalidatePresetInTx(tx, row);
    return { kind: 'saved', revision: row.revision + 1 };
}

export async function invalidatePresetInTx(tx: Tx, row: Pick<StoredPreset, 'teamId' | 'custodianAccountId'>): Promise<void> {
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

/** Acquisition consumes current controller authority. Preset content is never opened here. */
export async function validateManagedLaunchInTx(tx: Tx, context: PresetContext, input: OneOffManagedLaunchValidationInput,
    reviewedFacts?: unknown, declarationBodies?: ManagedDeclarationBodies): Promise<Readonly<{ declaration: ManagedDeclaration | null; custodianAccountId: string }>> {
    if (!input.controller) {
        await requireHomeInTx(tx, input.homeId);
        if ((await tx.account.findUnique({ where: { id: context.accountId }, select: { status: true } }))?.status !== AccountStatus.active) {
            throw new ManagedMachineError('permission_denied');
        }
        const declaration = reviewedFacts === undefined ? null : readManagedReviewedDeclaration(reviewedFacts);
        if (reviewedFacts !== undefined && (!declaration || declaration.billing.location !== 'cloud'
            || declaration.schemaVersion !== input.launch.schemaVersion)) throw new ManagedMachineError('invalid_request');
        if (declaration && !createValidatedLaunchSnapshotV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema))
            .safeParse(input.launch).success) throw new ManagedMachineError('invalid_request');
        return { declaration, custodianAccountId: context.accountId };
    }
    await requireManagedLaunchManagerInTx(tx, context, input.controller.machineId);
    const authority = await resolvePresetControllerAuthorityInTx(tx, { homeId: input.homeId, controller: input.controller });
    const declaration = await resolveManagedDeclarationInTx(tx, { homeId: input.homeId, custodianAccountId: authority.custodianAccountId,
        controller: input.controller, provider: input.launch.provider }, { declarationBodies });
    if (!declaration || declaration.schemaVersion !== input.launch.schemaVersion) throw new ManagedMachineError("provider_unavailable");
    if (!createValidatedLaunchSnapshotV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema))
        .safeParse(input.launch).success) throw new ManagedMachineError('invalid_request');
    const credentials = input.launch.credentials ?? [];
    const requests = declaration.acquireCredentialRequests.filter(binding => isMachineProvisionerCredentialPurposeRequiredV1(
        declaration, binding.request.id, input.launch.choices));
    if (requests.length !== credentials.length) throw new ManagedMachineError("credential_unavailable");
    // One-off admission validates each selected native purpose against the
    // controller's current Connected-account profile. Preset content never
    // reaches this branch.
    for (const credential of credentials) {
        if (!sameManagedInput(credential.purpose.consumer, input.launch.provider)) throw new ManagedMachineError("credential_unavailable");
        const matches = requests.filter(binding => binding.request.id === credential.purpose.purpose);
        const request = matches[0]?.request;
        if (matches.length !== 1 || !request || 'account' in credential && !request.scope.serviceRefs.some(service =>
            sameManagedInput(qualifyPluginContributionReferenceV1(service, input.launch.provider.pluginId), credential.account.service))) {
            throw new ManagedMachineError("credential_unavailable");
        }
    }
    const profiles = new Map((await listQualifiedConnectedAccountsInTx(tx, { accountId: authority.custodianAccountId,
        refs: credentials.flatMap(credential => 'account' in credential ? [credential.account] : []) }))
        .map(profile => [createQualifiedConnectedAccountIdentityDigest(profile.ref), profile]));
    for (const credential of credentials) {
        if (!('account' in credential)) continue;
        const selected = profiles.get(createQualifiedConnectedAccountIdentityDigest(credential.account));
        if (!selected || !isQualifiedConnectedAccountProfileActiveV4(selected, Date.now())) throw new ManagedMachineError("credential_unavailable");
    }
    return { declaration, custodianAccountId: authority.custodianAccountId };
}

/** Resolves only current controller custody; opaque preset content is never an input. */
async function resolvePresetControllerAuthorityInTx(tx: Tx, preset: Pick<PresetCreation, 'homeId' | 'controller'>) {
    if (!preset.controller) throw new ManagedMachineError('invalid_request');
    const controller = await tx.machine.findUnique({ where: { id: preset.controller.machineId }, select: {
        accountId: true, kind: true, installationId: true, installationPublicKey: true, active: true,
        revokedAt: true, replacedByMachineId: true, account: { select: { status: true } },
    } });
    if (!controller || controller.account.status !== AccountStatus.active) throw new ManagedMachineError('permission_denied');
    const custodianAccountId = controller.accountId;
    await requireManagedControllerInTx(tx, { homeId: preset.homeId, custodianAccountId, controller: preset.controller });
    return { custodianAccountId, controller };
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
    input.configurationRevision ??= 0;
    input.setupRevision ??= 0;
    if (input.teamAcquireDelegated === false) delete input.teamAcquireDelegated;
    const execute = () => inTx(async tx => {
        await acquirePresetMutationAccountsInTx(tx, { actorAccountId: params.accountId, owner: input.owner,
            controllerMachineIds: input.controller ? [input.controller.machineId] : [] });
        await requireHomeInTx(tx, input.homeId);
        if (!await resolvePresetAccessInTx(tx, params, input.owner, 'manage')) return { kind: "refused", code: "permission_denied" } as const;
        if (input.teamAcquireDelegated && (input.owner.kind !== 'team' || !hasPresetControllerTarget(input))) throw new ManagedMachineError('invalid_request');
        const existing = await tx.managedMachinePreset.findUnique({ where: { id: input.id } });
        if (existing) {
            if (!await resolvePresetAccessInTx(tx, params, ownerOf(existing), 'manage') || existing.homeId !== input.homeId) return { kind: "refused", code: "permission_denied" } as const;
            const current = projectPreset(existing);
            return sameManagedInput(definition(current), input)
                ? { kind: "saved", preset: projectPreset(existing) } as const
                : { kind: "conflict", currentRevision: current.revision } as const;
        }
        await authorizeMachinePresetCreationSaveInTx(tx, params, input);
        await validatePresetRecipientsInTx(tx, params, input, params.accountId);
        const row = await tx.managedMachinePreset.create({ data: {
            id: input.id, homeId: input.homeId, name: '', configurationRevision: input.configurationRevision,
            setupRevision: input.setupRevision,
            custodianAccountId: input.owner.kind === "account" ? input.owner.accountId : null,
            teamId: input.owner.kind === "team" ? input.owner.teamId : null,
            launch: storeOpaquePresetLaunch(input),
            controllerMachineId: input.controller?.machineId ?? null, controllerInstallationId: input.controller?.installationId ?? null,
            setup: getActivePrismaRuntime().DbNull,
            ...(input.retention ? { retentionOverride: input.retention } : {}),
            wakeOnAcceptedMessage: input.wakeOnAcceptedMessage,
            teamAcquireDelegated: input.teamAcquireDelegated ?? false,
            simultaneousMaximum: input.simultaneousLimit?.maximum,
        } });
        await invalidatePresetInTx(tx, row);
        return { kind: "saved", preset: projectPreset(row) } as const;
    });
    try { return await execute(); }
    catch (error) { if (isPrismaUniqueConstraintError(error)) return await execute(); return refusal(error); }
}

/**
 * One server-owned fresh recipient audience for an opaque preset seal or
 * rewrap. It authorizes only structural owner/controller routing and never
 * inspects the private content that will be encrypted to these recipients.
 */
function matchesRecipientCensusTarget(input: ManagedMachinePresetRecipientCensusInputV1,
    preset: Pick<ManagedMachinePresetV1, 'owner' | 'controller' | 'controllerPoolId'>): boolean {
    if ('managedId' in input) return false;
    return sameManagedInput(input.owner, preset.owner)
        && sameManagedInput(input.controller, preset.controller)
        && input.controllerPoolId === preset.controllerPoolId;
}

export async function readMachinePresetRecipientCensus(params: PresetContext & Readonly<{
    input: ManagedMachinePresetRecipientCensusInputV1;
}>): Promise<ManagedMachinePresetRecipientCensusResultV1> {
    const input = ManagedMachinePresetRecipientCensusInputV1Schema.parse(params.input);
    try {
        return await inReadSnapshot(async tx => {
            await requireHomeInTx(tx, input.homeId);
            if ('managedId' in input) {
                const row = await tx.managedMachine.findFirst({ where: { id: input.managedId, homeId: input.homeId } });
                if (!row || row.custodianAccountId !== params.accountId) throw new ManagedMachineError('permission_denied');
                const stored = readStoredOpaquePresetLaunch(row.launch);
                if (stored.contentEncryptionMode === 'plain') {
                    return { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] } as const;
                }
                const census = await readManagedPresetSnapshotRecipientCensusInTx(tx, row, stored.recipients);
                return { kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [...census.recipients] } as const;
            }
            if (input.presetId !== undefined) {
                const row = await tx.managedMachinePreset.findFirst({ where: { id: input.presetId, homeId: input.homeId } });
                if (!row || !await resolvePresetAccessInTx(tx, params, ownerOf(row), 'manage')) {
                    return { kind: 'refused', code: 'preset_not_found' } as const;
                }
                const preset = projectPreset(row);
                if (!matchesRecipientCensusTarget(input, preset)) {
                    return { kind: 'refused', code: 'invalid_request' } as const;
                }
                const targetMode = hasStoredOpaquePresetEnvelope(row.launch) ? preset.contentEncryptionMode
                    : (await tx.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { encryptionMode: true } })).encryptionMode;
                if (targetMode === 'plain') {
                    return { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] } as const;
                }
                const envelopes = readPresetRecipientEnvelopeRows(preset.recipients);
                if (envelopes === null) throw new ManagedMachineError('request_conflict');
                const census = await readPresetRecipientAudienceCensusInTx(tx, params, preset, envelopes);
                return { kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [...census.recipients] } as const;
            }

            if (!await resolvePresetAccessInTx(tx, params, input.owner, 'manage')) {
                return { kind: 'refused', code: 'permission_denied' } as const;
            }
            await authorizeMachinePresetCreationSaveInTx(tx, params, input);
            const account = await tx.account.findUnique({ where: { id: params.accountId }, select: { status: true, encryptionMode: true } });
            if (!account || account.status !== AccountStatus.active) {
                return { kind: 'refused', code: 'permission_denied' } as const;
            }
            if (account.encryptionMode === 'plain') {
                return { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] } as const;
            }
            const census = await readPresetRecipientAudienceCensusInTx(tx, params, input);
            return { kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [...census.recipients] } as const;
        });
    } catch (error) {
        return refusal(error);
    }
}

/** Retained snapshots keep their own key; the source relation supplies only their current audience. */
async function readManagedPresetSnapshotRecipientCensusInTx(tx: Tx, row: StoredManagedMachine,
    recipients: ManagedMachinePresetV1['recipients']) {
    const preset = row.presetId === null ? null : await tx.managedMachinePreset.findFirst({
        where: { id: row.presetId, homeId: row.homeId },
    });
    if (!preset) throw new ManagedMachineError('preset_not_found');
    const envelopes = readPresetRecipientEnvelopeRows(recipients);
    if (envelopes === null) throw new ManagedMachineError('credential_unavailable');
    const owner = ownerOf(preset);
    const census = await readSavedSecretAudienceRecipientEnvelopeCensusInTx(tx, {
        ownerAccountId: owner.kind === 'account' ? owner.accountId : undefined,
        accountIds: [], teamIds: owner.kind === 'team' ? [owner.teamId] : [], groupIds: [], envelopes,
    });
    if (!census.recipientAccountIds.includes(row.custodianAccountId)) throw new ManagedMachineError('credential_unavailable');
    return census;
}

/** Existing controller report authority may rewrap only to the exact current owner audience. */
export async function validateManagedPresetSnapshotRecipientsInTx(tx: Tx, row: StoredManagedMachine,
    recipients: ManagedMachinePresetV1['recipients']): Promise<void> {
    const stored = readStoredOpaquePresetLaunch(row.launch);
    if (stored.contentEncryptionMode === 'plain') {
        if (recipients.length !== 0) throw new ManagedMachineError('invalid_request');
        return;
    }
    const envelopes = readPresetRecipientEnvelopeRows(recipients);
    if (envelopes === null) throw new ManagedMachineError('credential_unavailable');
    const census = await readManagedPresetSnapshotRecipientCensusInTx(tx, row, recipients);
    await validatePresetRecipientEnvelopeCensusInTx(tx, census.recipientAccountIds, envelopes);
}

type AccountManagedMachinePresetEncryptionMigrationResult = Readonly<{
    status: 'applied' | 'migration_incomplete' | 'invalid_content';
}>;

type AccountManagedMachinePresetMigrationRows = Readonly<{
    presets: readonly StoredPreset[];
    snapshots: readonly StoredPresetSnapshot[];
}>;

/** The Account transition owns only personal source rows and their retained launch snapshots. */
async function readAccountManagedMachinePresetMigrationRowsInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountManagedMachinePresetMigrationRows> {
    const presets = await tx.managedMachinePreset.findMany({
        where: { custodianAccountId: accountId, teamId: null },
        orderBy: { id: 'asc' },
    });
    const snapshots: StoredPresetSnapshot[] = [];
    for (const presetIds of portableQueryChunks({
        values: presets.map((preset) => preset.id),
        bindingsPerValue: 1,
    })) {
        snapshots.push(...await tx.managedMachine.findMany({
            where: { presetId: { in: [...presetIds] } },
            orderBy: { id: 'asc' },
        }));
    }
    snapshots.sort((left, right) => left.id.localeCompare(right.id));
    return { presets, snapshots };
}

/** One recipient projection is enough for the source Account to reseal its own private body. */
export async function readAccountManagedMachinePresetEncryptionMigrationInventoryInTx(
    tx: Tx,
    input: Readonly<{ accountId: string }>,
): Promise<ManagedMachinePresetAccountEncryptionMigrationInventoryV1> {
    const rows = await readAccountManagedMachinePresetMigrationRowsInTx(tx, input.accountId);
    return ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema.parse({
        presets: rows.presets.map((preset) => {
            const stored = readStoredPresetContent(preset);
            const projection = projectManagedMachinePresetForRecipientV1({
                content: stored.content,
                recipients: stored.recipients,
                recipientAccountId: input.accountId,
            });
            return {
                presetId: preset.id,
                expectedRevision: preset.revision,
                contentEncryptionMode: stored.contentEncryptionMode,
                ...projection,
            };
        }),
        snapshots: rows.snapshots.map((snapshot) => {
            if (snapshot.presetId === null) {
                throw new Error('Managed preset snapshot is missing its source preset');
            }
            const stored = readStoredPresetSnapshotContent(snapshot);
            const projection = projectManagedMachinePresetForRecipientV1({
                content: stored.content,
                recipients: stored.recipients,
                recipientAccountId: input.accountId,
            });
            return {
                managedId: snapshot.id,
                presetId: snapshot.presetId,
                contentEncryptionMode: stored.contentEncryptionMode,
                ...projection,
            };
        }),
    });
}

function readStoredPresetSnapshotForAccountMigration(row: StoredPresetSnapshot) {
    try {
        return readStoredPresetSnapshotContent(row);
    } catch {
        return null;
    }
}

function readCurrentAccountPresetRecipients(
    recipients: ManagedMachinePresetV1['recipients'],
    accountId: string,
    recipientsById: ReadonlyMap<string, ResourceRecipientAccountRow>,
): boolean {
    const envelopes = readPresetRecipientEnvelopeRows(recipients);
    return envelopes !== null && readRequiredResourceRecipientEnvelopeRejectionV1({
        expectedRecipientAccountIds: [accountId],
        envelopes,
        recipientsById,
    }) === null;
}

async function hasCurrentPersonalPresetCustodianInTx(
    tx: Tx,
    accountId: string,
    preset: Pick<ManagedMachinePresetV1, 'homeId' | 'owner' | 'controller' | 'controllerPoolId'>,
): Promise<boolean> {
    try {
        const custodianAccountId = await readPresetRecipientCustodianAccountIdInTx(
            tx,
            { accountId },
            preset,
        );
        return custodianAccountId === null || custodianAccountId === accountId;
    } catch (error) {
        if (error instanceof ManagedMachineError) return false;
        throw error;
    }
}

function matchingPresetMigrationMode(
    mode: 'plain' | 'e2ee',
    content: ManagedMachinePresetV1['content'],
): boolean {
    return (mode === 'plain') === (content.t === 'plain');
}

function buildPresetMigrationReplacement(
    source: ManagedMachinePresetV1,
    toMode: 'plain' | 'e2ee',
    replacement: Pick<ManagedMachinePresetV1, 'content' | 'recipients'>,
): ManagedMachinePresetV1 | null {
    const next = ManagedMachinePresetV1Schema.safeParse({
        ...source,
        contentEncryptionMode: toMode,
        ...replacement,
    });
    return next.success ? next.data : null;
}

/**
 * Atomically reseals every personal preset and retained snapshot before the
 * enclosing Account transition changes its persisted encryption mode. The
 * server never opens the private body: source projections/currentness and
 * recipient envelopes are the complete authority it can verify.
 */
export async function migrateAccountManagedMachinePresetsForModeInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        fromMode: 'plain' | 'e2ee';
        toMode: 'plain' | 'e2ee';
        ownerContentPublicKeyFingerprint: string | null;
        directive: AccountEncryptionMigrateManagedMachinePresetsDirectiveV1 | undefined;
    }>,
): Promise<AccountManagedMachinePresetEncryptionMigrationResult> {
    const rows = await readAccountManagedMachinePresetMigrationRowsInTx(tx, input.accountId);
    const directive = input.directive ?? { presets: [], snapshots: [] };
    const presetDirectives = new Map(directive.presets.map((item) => [item.presetId, item]));
    const snapshotDirectives = new Map(directive.snapshots.map((item) => [item.managedId, item]));
    if (
        presetDirectives.size !== directive.presets.length
        || snapshotDirectives.size !== directive.snapshots.length
        || presetDirectives.size !== rows.presets.length
        || snapshotDirectives.size !== rows.snapshots.length
        || rows.presets.some((preset) => !presetDirectives.has(preset.id))
        || rows.snapshots.some((snapshot) => !snapshotDirectives.has(snapshot.id))
    ) {
        return { status: 'migration_incomplete' };
    }

    const currentRecipients = await tx.account.findMany({
        where: { id: input.accountId },
        select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    });
    const currentRecipientsById = new Map(
        currentRecipients.map((recipient) => [recipient.id, recipient]),
    );
    const presetSources = new Map<string, ManagedMachinePresetV1>();
    const presetRewrites: Array<Readonly<{
        row: StoredPreset;
        targetLaunch: ReturnType<typeof storeOpaquePresetLaunch>;
    }>> = [];

    for (const row of rows.presets) {
        const directiveItem = presetDirectives.get(row.id);
        if (!directiveItem) return { status: 'invalid_content' };
        let source: ManagedMachinePresetV1;
        try {
            source = projectPreset(row);
        } catch {
            return { status: 'invalid_content' };
        }
        if (directiveItem.expectedRevision !== row.revision) {
            return { status: 'migration_incomplete' };
        }
        if (
            source.owner.kind !== 'account'
            || source.owner.accountId !== input.accountId
            || (hasStoredOpaquePresetEnvelope(row.launch) && source.contentEncryptionMode !== input.fromMode)
            || !matchingPresetMigrationMode(source.contentEncryptionMode, source.content)
            || (input.toMode === 'e2ee'
                && !await hasCurrentPersonalPresetCustodianInTx(tx, input.accountId, source))
        ) {
            return { status: 'invalid_content' };
        }
        if (
            source.contentEncryptionMode === 'plain'
                ? source.recipients.length !== 0
                : !readCurrentAccountPresetRecipients(
                    source.recipients,
                    input.accountId,
                    currentRecipientsById,
                )
        ) {
            return { status: 'invalid_content' };
        }
        const target = buildPresetMigrationReplacement(source, input.toMode, directiveItem.replacement);
        const targetRecipientEnvelopes = target === null
            ? null
            : readPresetRecipientEnvelopeRows(target.recipients);
        if (
            target === null
            || !matchingPresetMigrationMode(input.toMode, target.content)
            || (input.toMode === 'plain'
                ? target.recipients.length !== 0
                : input.ownerContentPublicKeyFingerprint === null
                    || targetRecipientEnvelopes === null
                    || readTargetOwnerRecipientEnvelopeRejectionV1({
                        ownerAccountId: input.accountId,
                        ownerContentPublicKeyFingerprint: input.ownerContentPublicKeyFingerprint,
                        envelopes: targetRecipientEnvelopes,
                    }) !== null)
        ) {
            return { status: 'invalid_content' };
        }
        presetSources.set(row.id, source);
        presetRewrites.push({ row, targetLaunch: storeOpaquePresetLaunch(target) });
    }

    const snapshotRewrites: Array<Readonly<{
        row: StoredPresetSnapshot;
        sourceLaunch: Prisma.InputJsonValue;
        targetAdmission: ReturnType<typeof projectManagedPresetAdmissionForOpaqueStorage>;
        targetLaunch: ReturnType<typeof storeOpaquePresetLaunch>;
    }>> = [];
    for (const row of rows.snapshots) {
        const directiveItem = snapshotDirectives.get(row.id);
        if (!directiveItem || row.presetId === null || directiveItem.presetId !== row.presetId) {
            return { status: 'migration_incomplete' };
        }
        const sourcePreset = presetSources.get(row.presetId);
        const admission = readManagedAdmissionState(row.admittedInput);
        const control = admission.currentAdmission;
        // The controller first incorporates an admitted private delta into its
        // snapshot. Inventory contains only that exact incorporated body.
        if (admission.presetContentOverride || control?.kind === 'control'
            && isManagedResizeActionIdV1(control.request.action) && !control.resizeSettled) {
            return { status: 'invalid_content' };
        }
        const stored = readStoredPresetSnapshotForAccountMigration(row);
        if (!sourcePreset || !stored) return { status: 'invalid_content' };
        let sourceProjection: ReturnType<typeof projectManagedMachinePresetForRecipientV1>;
        let sourceLaunch: Prisma.InputJsonValue;
        try {
            sourceProjection = projectManagedMachinePresetForRecipientV1({
                content: stored.content,
                recipients: stored.recipients,
                recipientAccountId: input.accountId,
            });
            sourceLaunch = readManagedJsonEqualityOperand(row.launch);
        } catch {
            return { status: 'invalid_content' };
        }
        if (
            directiveItem.expectedContentEncryptionMode !== stored.contentEncryptionMode
            || !isDeepStrictEqual(directiveItem.expectedContent, stored.content)
            || !isDeepStrictEqual(directiveItem.expectedRecipientEnvelope, sourceProjection.recipientEnvelope)
        ) {
            return { status: 'migration_incomplete' };
        }
        if (
            (input.toMode === 'e2ee' && row.custodianAccountId !== input.accountId)
            || (hasStoredOpaquePresetEnvelope(row.launch) && stored.contentEncryptionMode !== input.fromMode)
            || !matchingPresetMigrationMode(stored.contentEncryptionMode, stored.content)
            || (stored.contentEncryptionMode === 'plain'
                ? stored.recipients.length !== 0
                : !readCurrentAccountPresetRecipients(
                    stored.recipients,
                    input.accountId,
                    currentRecipientsById,
                ))
        ) {
            return { status: 'invalid_content' };
        }
        const targetRecipientEnvelopes = readPresetRecipientEnvelopeRows(
            directiveItem.replacement.recipients,
        );
        if (
            !matchingPresetMigrationMode(input.toMode, directiveItem.replacement.content)
            || (input.toMode === 'plain'
                ? directiveItem.replacement.recipients.length !== 0
                : input.ownerContentPublicKeyFingerprint === null
                    || targetRecipientEnvelopes === null
                    || readTargetOwnerRecipientEnvelopeRejectionV1({
                        ownerAccountId: input.accountId,
                        ownerContentPublicKeyFingerprint: input.ownerContentPublicKeyFingerprint,
                        envelopes: targetRecipientEnvelopes,
                    }) !== null)
        ) {
            return { status: 'invalid_content' };
        }
        let targetAdmission: ReturnType<typeof projectManagedPresetAdmissionForOpaqueStorage>;
        try {
            targetAdmission = projectManagedPresetAdmissionForOpaqueStorage(row.admittedInput, directiveItem.replacement.content);
        } catch {
            return { status: 'invalid_content' };
        }
        snapshotRewrites.push({
            row,
            sourceLaunch,
            targetAdmission,
            targetLaunch: storeOpaquePresetLaunch({
                contentEncryptionMode: input.toMode,
                content: directiveItem.replacement.content,
                recipients: directiveItem.replacement.recipients,
                ...(stored.controllerPoolId === undefined
                    ? {}
                    : { controllerPoolId: stored.controllerPoolId }),
            }),
        });
    }

    for (const rewrite of presetRewrites) {
        const sourceLaunch = readManagedJsonEqualityOperand(rewrite.row.launch);
        const updated = await tx.managedMachinePreset.updateMany({
            where: {
                id: rewrite.row.id,
                custodianAccountId: input.accountId,
                teamId: null,
                revision: rewrite.row.revision,
                launch: { equals: sourceLaunch },
            },
            data: { name: '', setup: getActivePrismaRuntime().DbNull, launch: rewrite.targetLaunch, revision: { increment: 1 } },
        });
        if (updated.count !== 1) return { status: 'migration_incomplete' };
        await invalidatePresetInTx(tx, rewrite.row);
    }
    for (const rewrite of snapshotRewrites) {
        const updated = await tx.managedMachine.updateMany({
            where: {
                id: rewrite.row.id,
                presetId: rewrite.row.presetId,
                ...(input.toMode === 'e2ee'
                    ? { custodianAccountId: input.accountId }
                    : {}),
                launch: { equals: rewrite.sourceLaunch },
            },
            data: { launch: rewrite.targetLaunch, admittedInput: rewrite.targetAdmission,
                resource: getActivePrismaRuntime().DbNull,
                nativeOperationRef: getActivePrismaRuntime().DbNull,
                recovery: getActivePrismaRuntime().DbNull,
                reviewedFacts: getActivePrismaRuntime().DbNull,
                ...(rewrite.row.observation === null ? {} : { observation: projectManagedOpaquePresetObservationV1(
                    ProviderObservationV1Schema.parse(rewrite.row.observation)) }),
                ...(rewrite.row.machineSetup === null ? {} : { machineSetup: createStoredReadSchema(ManagedOpaqueMachineSetupStateV1Schema)
                    .parse(rewrite.row.machineSetup) }),
            },
        });
        if (updated.count !== 1) return { status: 'migration_incomplete' };
        await invalidateManagedMachineInTx(tx, rewrite.row);
    }
    return { status: 'applied' };
}

export async function getMachinePreset(params: PresetPreparationContext & Readonly<{ input: ManagedMachinePresetGetInputV1 }>): Promise<ManagedMachinePresetGetResultV1> {
    try { return await inTx(tx => getMachinePresetInTx(tx, params)); } catch (error) { return refusal(error); }
}

/** Setup consumes the same current preset reader in its exact-target transaction. */
export async function getMachinePresetInTx(tx: Tx, params: PresetPreparationContext & Readonly<{ input: ManagedMachinePresetGetInputV1 }>): Promise<ManagedMachinePresetGetResultV1> {
    if (!params.presetPreparationAdmission) await requireHomeInTx(tx, params.input.homeId);
    const row = await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } });
    const access = row ? params.presetPreparationAdmission ? { teamArchivedAt: null }
        : await resolvePresetAccessInTx(tx, params, ownerOf(row), 'read') : null;
    if (!row || !access) return { kind: "refused", code: "preset_not_found" };
    return { kind: "found", preset: projectPreset(inheritPresetOwnerArchive(row, access.teamArchivedAt)) };
}

export async function listMachinePresets(params: PresetContext & Readonly<{ input: ManagedMachinePresetListInputV1 }>): Promise<ManagedMachinePresetListResultV1> {
    try { return await inReadSnapshot(async tx => {
        await requireHomeInTx(tx, params.input.homeId);
        const input = params.input;
        // Revision demand never reads the private content or recipient envelopes.
        const revisionSelect = { id: true, homeId: true, revision: true, setupRevision: true,
            archivedAt: true, teamId: true } as const;
        const readRows = (where: Prisma.ManagedMachinePresetWhereInput) => input.projection === 'revisions'
            ? tx.managedMachinePreset.findMany({ where, select: revisionSelect, orderBy: { id: 'asc' } })
            : tx.managedMachinePreset.findMany({ where, orderBy: { id: 'asc' } });
        const projectRows = (rows: Awaited<ReturnType<typeof readRows>>): ManagedMachinePresetListResultV1 =>
            input.projection === 'revisions' ? { kind: 'revisions', presets: rows.map(row => ({
                id: row.id, homeId: row.homeId, revision: row.revision, setupRevision: row.setupRevision,
                ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt.getTime() }),
            })) } : { kind: 'listed', presets: rows.flatMap(row => 'launch' in row ? [projectPreset(row)] : []) };
        if ((await tx.account.findUnique({ where: { id: params.accountId }, select: { status: true } }))?.status !== AccountStatus.active) return projectRows([]);
        const memberships = await tx.teamMembership.findMany({ where: { accountId: params.accountId, status: TeamMembershipStatus.active,
            ...(input.owner?.kind === "team" ? { teamId: input.owner.teamId } : {}) }, select: { teamId: true } });
        const contexts = await resolveTeamActorContextsInTx(tx, { actorAccountId: params.accountId, teamIds: memberships.map(member => member.teamId) });
        const qualifications = await qualifyTeamOperationAuthenticationsInTx(tx, { ...params.authentication, contexts: [...contexts.values()] });
        const teamIds = [...contexts.values()].filter(context => context.teamCapabilities.viewTeam
            && (input.includeArchived || context.team.archivedAt === null)
            && qualifications.get(context.team.id)?.ok === true).map(context => context.team.id);
        const rowsById = new Map<string, Awaited<ReturnType<typeof readRows>>[number]>();
        // Home, custodian, archive/cursor and Prisma pagination are fixed;
        // Team membership contributes one bind per selected id.
        const teamChunks = portableQueryChunks({ values: teamIds, bindingsPerValue: 1,
            fixedBindings: 7 + (input.owner ? 1 : 0) });
        for (const [index, ids] of (teamChunks.length ? teamChunks : [[]]).entries()) {
            const selected = await readRows({
            homeId: input.homeId, ...(!input.includeArchived ? { archivedAt: null } : {}),
            OR: [...(index === 0 ? [{ custodianAccountId: params.accountId }] : []), { teamId: { in: [...ids] } }],
            ...(input.owner?.kind === "account" ? { custodianAccountId: input.owner.accountId } : {}),
            ...(input.owner?.kind === "team" ? { teamId: input.owner.teamId } : {}),
            ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        });
            for (const row of selected) rowsById.set(row.id, row);
        }
        const rows = [...rowsById.values()].map(row => inheritPresetOwnerArchive(row,
            row.teamId ? contexts.get(row.teamId)?.team.archivedAt : null)).sort((left, right) => left.id.localeCompare(right.id));
        return projectRows(rows);
    }); } catch (error) { return refusal(error); }
}

/** An admitted build can replace private bytes, never mode, recipient identity or preset definition. */
async function updatePreparedPresetContentInTx(tx: Tx, row: StoredPreset, current: ManagedMachinePresetV1,
    input: ManagedMachinePresetUpdateInputV1): Promise<PresetMutationResultV1> {
    const { content, recipients, ...definitionPatch } = input.patch;
    if (Object.keys(definitionPatch).length !== 0 || content === null
        || content !== undefined && content.t !== current.content.t) throw new ManagedMachineError('permission_denied');
    const next = ManagedMachinePresetV1Schema.parse({ ...current,
        ...(content === undefined ? {} : { content }), ...(recipients === undefined ? {} : { recipients }) });
    const currentRecipients = new Map(current.recipients.map(recipient => [recipient.accountId, recipient.envelope.recipientContentPublicKeyFingerprint]));
    if (next.recipients.length !== current.recipients.length || next.recipients.some(recipient =>
        currentRecipients.get(recipient.accountId) !== recipient.envelope.recipientContentPublicKeyFingerprint)) {
        throw new ManagedMachineError('permission_denied');
    }
    if (sameManagedInput(next, current)) return { kind: 'saved', preset: current };
    const result = await tx.managedMachinePreset.updateMany({ where: { id: row.id, revision: input.expectedRevision },
        data: { launch: storeOpaquePresetLaunch(next), revision: { increment: 1 } } });
    if (!result.count) {
        const latest = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        return { kind: 'conflict', currentRevision: latest.revision };
    }
    await invalidatePresetInTx(tx, row);
    return { kind: 'saved', preset: { ...next, revision: row.revision + 1 } };
}

export async function updateMachinePreset(params: PresetPreparationContext & Readonly<{ input: ManagedMachinePresetUpdateInputV1 }>): Promise<PresetMutationResultV1> {
    const input = ManagedMachinePresetUpdateInputV1Schema.parse(params.input);
    try { return await inTx(async tx => {
        const discovered = await tx.managedMachinePreset.findFirst({ where: { id: input.id, homeId: input.homeId } });
        if (discovered) await acquirePresetMutationAccountsInTx(tx, { actorAccountId: params.accountId, owner: ownerOf(discovered),
            controllerMachineIds: [...(discovered.controllerMachineId ? [discovered.controllerMachineId] : []), ...(input.patch.controller ? [input.patch.controller.machineId] : [])] });
        const row = discovered ? await tx.managedMachinePreset.findFirst({ where: { id: input.id, homeId: input.homeId } }) : null;
        if (row && row.controllerMachineId !== discovered?.controllerMachineId) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
        if (!params.presetPreparationAdmission) await requireHomeInTx(tx, input.homeId);
        if (!row || !params.presetPreparationAdmission && !await resolvePresetAccessInTx(tx, params, ownerOf(row), 'manage')) return { kind: "refused", code: "preset_not_found" } as const;
        const current = projectPreset(row);
        if (row.revision !== input.expectedRevision) return { kind: "conflict", currentRevision: row.revision } as const;
        if (params.presetPreparationAdmission) return await updatePreparedPresetContentInTx(tx, row, current, input);
        const { content, recipients, retention, wakeOnAcceptedMessage, simultaneousLimit, controller, controllerPoolId, ...definitionPatch } = input.patch;
        const nextDefinition = { ...current, ...definitionPatch };
        if (content === null) throw new ManagedMachineError('invalid_request');
        else if (content !== undefined) nextDefinition.content = content;
        if (recipients !== undefined) nextDefinition.recipients = recipients;
        if (controller === null) delete nextDefinition.controller;
        else if (controller !== undefined) nextDefinition.controller = controller;
        if (controllerPoolId === null) delete nextDefinition.controllerPoolId;
        else if (controllerPoolId !== undefined) nextDefinition.controllerPoolId = controllerPoolId;
        if (nextDefinition.teamAcquireDelegated === false) delete nextDefinition.teamAcquireDelegated;
        if (retention === null) delete nextDefinition.retention;
        else if (retention !== undefined) nextDefinition.retention = retention;
        if (wakeOnAcceptedMessage === null) delete nextDefinition.wakeOnAcceptedMessage;
        else if (wakeOnAcceptedMessage !== undefined) nextDefinition.wakeOnAcceptedMessage = wakeOnAcceptedMessage;
        if (simultaneousLimit === null) delete nextDefinition.simultaneousLimit;
        else if (simultaneousLimit !== undefined) nextDefinition.simultaneousLimit = simultaneousLimit;
        const parsed = ManagedMachinePresetV1Schema.safeParse(nextDefinition);
        if (!parsed.success) throw new ManagedMachineError('invalid_request');
        const next = parsed.data;
        if (next.teamAcquireDelegated && (next.owner.kind !== 'team' || !hasPresetControllerTarget(next))) throw new ManagedMachineError('invalid_request');
        // Every edit to an approved delegated recipe keeps its controller's spend
        // approver. Withdrawal needs Manage even if the selected credential retired.
        const recipientRepairOnly = input.patch.recipients !== undefined
            && input.patch.content === undefined && input.patch.contentEncryptionMode === undefined
            && input.patch.configurationRevision === undefined
            && input.patch.setupRevision === undefined
            && input.patch.controller === undefined && input.patch.controllerPoolId === undefined
            && input.patch.retention === undefined && input.patch.wakeOnAcceptedMessage === undefined
            && input.patch.teamAcquireDelegated === undefined && input.patch.simultaneousLimit === undefined;
        const requiresDelegationManager = !recipientRepairOnly
            && (row.teamAcquireDelegated || input.patch.teamAcquireDelegated !== undefined);
        const validateStructure = input.patch.controller !== undefined || input.patch.controllerPoolId !== undefined
            || next.teamAcquireDelegated === true && !row.teamAcquireDelegated;
        const nextCreation = next;
        const delegatedControllerMachineId = requiresDelegationManager ? row.controllerMachineId ?? next.controller?.machineId : undefined;
        if (validateStructure) await authorizeMachinePresetCreationSaveInTx(tx, params, nextCreation);
        else if (requiresDelegationManager && nextCreation?.controllerPoolId) await authorizeMachinePresetCreationSaveInTx(tx, params, nextCreation);
        else if (delegatedControllerMachineId) await requireManagedLaunchManagerInTx(tx, params, delegatedControllerMachineId);
        await validatePresetRecipientsInTx(tx, params, next,
            input.patch.content !== undefined || input.patch.contentEncryptionMode !== undefined || !hasStoredOpaquePresetEnvelope(row.launch) ? params.accountId : null);
        if (hasStoredOpaquePresetEnvelope(row.launch) && sameManagedInput(next, current)) return { kind: "saved", preset: projectPreset(row) } as const;
        const result = await tx.managedMachinePreset.updateMany({ where: { id: row.id, revision: input.expectedRevision }, data: {
            // `name` is a legacy storage key only; private content remains in
            // the opaque envelope and is never projected or searched here.
            name: '', launch: storeOpaquePresetLaunch(next), configurationRevision: next.configurationRevision,
            setupRevision: next.setupRevision,
            controllerMachineId: next.controller?.machineId ?? null, controllerInstallationId: next.controller?.installationId ?? null,
            setup: getActivePrismaRuntime().DbNull,
            retentionOverride: next.retention ?? getActivePrismaRuntime().DbNull,
            wakeOnAcceptedMessage: next.wakeOnAcceptedMessage ?? null,
            teamAcquireDelegated: next.teamAcquireDelegated ?? false,
            simultaneousMaximum: next.simultaneousLimit?.maximum ?? null, revision: { increment: 1 },
        } });
        const stored = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        if (!result.count) return { kind: "conflict", currentRevision: stored.revision } as const;
        await invalidatePresetInTx(tx, stored);
        return { kind: "saved", preset: projectPreset(stored) } as const;
    }); } catch (error) { return refusal(error); }
}

/** Archive follows admitted image cleanup; acquired rows and capacity are untouched. */
async function setArchived(params: PresetPreparationContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>, archived: boolean): Promise<PresetMutationResultV1> {
    try { return await inTx(async tx => {
        const discovered = await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } });
        if (discovered) await acquirePresetMutationAccountsInTx(tx, { actorAccountId: params.accountId, owner: ownerOf(discovered),
            controllerMachineIds: discovered.controllerMachineId ? [discovered.controllerMachineId] : [] });
        const row = discovered ? await tx.managedMachinePreset.findFirst({ where: { id: params.input.id, homeId: params.input.homeId } }) : null;
        if (row && row.controllerMachineId !== discovered?.controllerMachineId) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
        if (!params.presetPreparationAdmission) await requireHomeInTx(tx, params.input.homeId);
        const access = row ? params.presetPreparationAdmission && archived ? { teamArchivedAt: null }
            : await resolvePresetAccessInTx(tx, params, ownerOf(row), archived ? 'archive' : 'manage') : null;
        if (!row || !access) return { kind: "refused", code: "preset_not_found" } as const;
        if (row.revision !== params.input.expectedRevision) return { kind: "conflict", currentRevision: row.revision } as const;
        const effective = inheritPresetOwnerArchive(row, access.teamArchivedAt);
        if ((effective.archivedAt !== null) === archived) return { kind: "saved", preset: projectPreset(effective) } as const;
        const result = await tx.managedMachinePreset.updateMany({ where: { id: row.id, revision: row.revision }, data: { archivedAt: archived ? new Date() : null, revision: { increment: 1 } } });
        const current = await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: row.id } });
        if (!result.count) return { kind: "conflict", currentRevision: current.revision } as const;
        await invalidatePresetInTx(tx, current);
        return { kind: "saved", preset: projectPreset(current) } as const;
    }); } catch (error) { return refusal(error); }
}

export const archiveMachinePreset = (params: PresetPreparationContext & Readonly<{ input: ManagedMachinePresetRevisionInputV1 }>) => setArchived(params, true);
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

/**
 * The selected controller must be able to open the exact persisted E2EE
 * envelope. Pool candidates are already constrained to the Pool custodian in
 * `readManagedPresetPoolCandidatesInTx`; direct controllers supply theirs here.
 */
function requirePresetCustodianRecipient(preset: Pick<ManagedMachinePresetV1, 'contentEncryptionMode' | 'recipients'>,
    custodianAccountId: string): void {
    if (preset.contentEncryptionMode === 'e2ee'
        && !preset.recipients.some((recipient) => recipient.accountId === custodianAccountId)) {
        throw new ManagedMachineError('credential_unavailable');
    }
}

/** Capacity is consumed only when admission needs a new allocation. */
export async function hasMachinePresetAcquireCapacityInTx(tx: Tx, input: Readonly<{
    homeId: string; id: string; maximum: number | null;
}>): Promise<boolean> {
    return input.maximum === null || await tx.managedMachine.count({ where: {
        homeId: input.homeId, presetId: input.id, allocation: { not: 'confirmed-absent' },
    } }) < input.maximum;
}

/** C50 calls this inside its admission transaction, before inserting the resource row. */
export async function resolveMachinePresetForAcquireInTx(tx: Tx, params: PresetContext & Readonly<{
    homeId: string; id: string; revision: number;
    /** Preflight/proof reads omit capacity; the inserting admission always enforces it. */
    checkCapacity?: boolean;
    boundController?: ManagedControllerV1;
    poolSelection?: Readonly<{ requestKey: string; presence: MachineDaemonPresenceInventory }>;
}>): Promise<Readonly<{ kind: "ready"; preset: ManagedMachinePresetV1; custodianAccountId: string; delegated: boolean;
    presetContent: Pick<ManagedMachinePresetV1, 'content' | 'recipients'>;
    controllerAccess?: ManagedControllerAccessV1; poolPriorityTier?: number }> | PresetRefusal | Extract<PresetMutationResultV1, { kind: "conflict" }>> {
    await requireHomeInTx(tx, params.homeId);
    const stored = await tx.managedMachinePreset.findFirst({ where: { id: params.id, homeId: params.homeId } });
    const access = stored ? await resolvePresetAccessInTx(tx, params, ownerOf(stored), 'read') : null;
    if (!stored || !access) return { kind: "refused", code: "preset_not_found" };
    const row = inheritPresetOwnerArchive(stored, access.teamArchivedAt);
    if (row.revision !== params.revision) return { kind: "conflict", currentRevision: row.revision };
    if (row.archivedAt) return { kind: "refused", code: "preset_archived" };
    const preset = projectPreset(row);
    const presetContent = { content: preset.content, recipients: preset.recipients } as const;
    // Admission's controller Account fence serializes this preset's count/create.
    if (params.checkCapacity !== false && !await hasMachinePresetAcquireCapacityInTx(tx, {
        homeId: row.homeId, id: row.id, maximum: row.simultaneousMaximum,
    })) return { kind: "refused", code: "preset_limit_reached" };
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
        requirePresetCustodianRecipient(preset, pool.custodianAccountId);
        const { controllerPoolId: _pool, ...definition } = preset;
        return { kind: 'ready', preset: { ...definition, controller: selected.controller }, delegated,
            custodianAccountId: pool.custodianAccountId, presetContent, controllerAccess: selected.access,
            ...(selection ? { poolPriorityTier: selection.priorityTier } : {}) };
    }
    // An Account owner can execute its own opaque preset through its existing
    // Account host. This path deliberately has no controller declaration for
    // the server to inspect; the keyholding host opens the content after
    // admission. Team presets still need their explicit controller/Pool route.
    if (!preset.controller) {
        if (preset.owner.kind !== 'account' || preset.owner.accountId !== params.accountId) {
            return { kind: 'refused', code: 'invalid_request' };
        }
        requirePresetCustodianRecipient(preset, preset.owner.accountId);
        return { kind: 'ready', preset, delegated: false, custodianAccountId: preset.owner.accountId, presetContent };
    }
    const role = await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: params.accountId, machineId: preset.controller.machineId });
    // `preset` carries no `launch`, so this only resolves current controller
    // authority and custodian routing; it does not parse private content.
    const authority = await resolvePresetControllerAuthorityInTx(tx, { homeId: preset.homeId, controller: preset.controller });
    const delegated = role !== 'manage'
        || (row.teamAcquireDelegated === true && authority.custodianAccountId !== params.accountId);
    requirePresetCustodianRecipient(preset, authority.custodianAccountId);
    await requirePresetDelegationInTx(tx, row, authority.custodianAccountId, delegated);
    const controllerAccess = projectManagedControllerAccess(authority.controller, preset.controller);
    return { kind: 'ready', preset, delegated, presetContent,
        custodianAccountId: authority.custodianAccountId,
        ...(controllerAccess ? { controllerAccess } : {}) };
}
