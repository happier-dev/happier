import { createHash } from "node:crypto";
import { decodeTeamKeysetCursorV1, encodeTeamKeysetCursorV1, readTeamKeysetIdV1, readTeamKeysetTimeV1 } from '@happier-dev/protocol/teams';
import { TeamCredentialActivityKindV1Schema, type TeamCredentialActivityKindV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { Tx } from "@/storage/inTx";
import { resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { admitSavedSecretResourceManagementInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { SavedSecretDisclosureOutcomeV1Schema, SavedSecretCopyOutcomeV1Schema, SavedSecretDisclosureHistoryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1, savedSecretDisclosureActivityEntityIdV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';

type ActivityCursor = Readonly<{ createdAt: number; id: string }>;

function directDeliveryActivityId(resourceId: string, recipientAccountId: string): string {
    const digest = createHash("sha256")
        .update(JSON.stringify([resourceId, recipientAccountId]), "utf8")
        .digest("base64url");
    return `team-credential-direct-delivered:${digest}`;
}

function activityCursorQueryKey(resourceId: string, ownerAccountId?: string): string {
    return ownerAccountId ? `saved-secret-activity:v1:${ownerAccountId.length}:${ownerAccountId}${resourceId}`
        : `team-credential-activity:v1:${resourceId}`;
}

function encodeActivityCursor(input: ActivityCursor, resourceId: string, ownerAccountId?: string): string {
    return encodeTeamKeysetCursorV1({
        queryKey: activityCursorQueryKey(resourceId, ownerAccountId),
        parts: [input.createdAt, input.id],
    });
}

function decodeActivityCursor(value: string, resourceId: string, ownerAccountId?: string): ActivityCursor | null {
    const decoded = decodeTeamKeysetCursorV1(value, activityCursorQueryKey(resourceId, ownerAccountId));
    if (decoded.status !== "ok") return null;
    const createdAt = readTeamKeysetTimeV1(decoded.parts[0]);
    const id = readTeamKeysetIdV1(decoded.parts[1]);
    return createdAt === null || id === null ? null : { createdAt, id };
}

export type ReadTeamCredentialActivityResult =
    | Readonly<{ ok: true; page: { items: readonly Readonly<{
        kind: TeamCredentialActivityKindV1;
        actorDisplayName: string | null;
        subjectDisplayName: string;
        createdAt: string;
    }>[]; nextCursor: string | null } }>
    | Readonly<{ ok: false; error: "resource_not_found" | "resource_forbidden" | "invalid_resource_input" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

/** Reads the narrow metadata history through the same Team capability owner as mutations. */
export async function readTeamCredentialActivityInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; actorAccountId: string; cursor?: string; limit?: number; authentication: TeamOperationAuthenticationContext }>,
): Promise<ReadTeamCredentialActivityResult> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !input.resourceId.trim()) {
        return { ok: false, error: "invalid_resource_input" };
    }
    const live = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: { teamId: true },
    });
    const historical = live ? null : await tx.teamCredentialActivityEvent.findFirst({
        where: { subjectKind: 'team_credential', resourceId: input.resourceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { teamId: true },
    });
    const teamId = live?.teamId ?? historical?.teamId;
    if (!teamId) return { ok: false, error: "resource_not_found" };
    const actor = await resolveTeamActorContextInTx(tx, { teamId, actorAccountId: input.actorAccountId });
    if (!actor || !resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials) {
        return { ok: false, error: "resource_forbidden" };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;
    const cursor = input.cursor === undefined ? null : decodeActivityCursor(input.cursor, input.resourceId);
    if (input.cursor !== undefined && cursor === null) return { ok: false, error: "invalid_resource_input" };
    const rows = await tx.teamCredentialActivityEvent.findMany({
        where: {
            subjectKind: 'team_credential',
            resourceId: input.resourceId,
            ...(cursor ? {
                OR: [
                    { createdAt: { lt: new Date(cursor.createdAt) } },
                    { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                ],
            } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
        select: {
            id: true, kind: true, subjectDisplayName: true, createdAt: true,
            actorAccount: { select: { name: true, username: true } },
        },
    });
    const page = rows.slice(0, limit);
    const items = page.map(row => ({
        kind: TeamCredentialActivityKindV1Schema.parse(row.kind),
        actorDisplayName: row.actorAccount
            ? resolveAccountDisplayLabelV1(row.actorAccount)
            : null,
        subjectDisplayName: row.subjectDisplayName,
        createdAt: row.createdAt.toISOString(),
    }));
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last
        ? encodeActivityCursor({ createdAt: last.createdAt.getTime(), id: last.id }, input.resourceId)
        : null;
    return { ok: true, page: { items, nextCursor } };
}

export const TeamCredentialActivityKindSchema = TeamCredentialActivityKindV1Schema;

export type TeamCredentialActivityActor =
    | Readonly<{ kind: "account"; accountId: string }>
    | Readonly<{ kind: "system" }>;

/** Records only public administrative context in the transaction that changes it. */
export async function recordTeamCredentialActivityInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        resourceId: string;
        kind: TeamCredentialActivityKindV1;
        actor: TeamCredentialActivityActor;
        subjectDisplayName: string;
    }>,
): Promise<void> {
    await tx.teamCredentialActivityEvent.create({ data: {
        subjectKind: 'team_credential',
        teamId: input.teamId,
        resourceId: input.resourceId,
        kind: TeamCredentialActivityKindSchema.parse(input.kind),
        actorAccountId: input.actor.kind === "account" ? input.actor.accountId : null,
        subjectDisplayName: input.subjectDisplayName,
    } });
}

/**
 * Records the first irreversible disclosure for one resource recipient.
 * The existing Activity primary key is the idempotency owner, so concurrent
 * successful opens converge without a delivery ledger or acknowledgement.
 */
export async function recordTeamCredentialDirectDeliveryActivityInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        resourceId: string;
        recipientAccountId: string;
        subjectDisplayName: string;
    }>,
): Promise<void> {
    await tx.teamCredentialActivityEvent.upsert({
        where: { id: directDeliveryActivityId(input.resourceId, input.recipientAccountId) },
        update: {},
        create: {
            subjectKind: 'team_credential',
            id: directDeliveryActivityId(input.resourceId, input.recipientAccountId),
            teamId: input.teamId,
            resourceId: input.resourceId,
            kind: "direct_delivered",
            actorAccountId: input.recipientAccountId,
            subjectDisplayName: input.subjectDisplayName,
        },
    });
}

/**
 * Whether usable material of this resource was ever delivered to anyone. Once
 * it has been, use outside Happier is possible and unknowable, whatever the
 * current audience says. Retained metadata only, like the per-recipient read.
 */
export async function hasTeamCredentialResourceDirectDeliveryActivityInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string }>,
): Promise<boolean> {
    return (await tx.teamCredentialActivityEvent.findFirst({
        where: { subjectKind: 'team_credential', resourceId: input.resourceId, kind: "direct_delivered" },
        select: { id: true },
    })) !== null;
}

/** Reads only the retained metadata fact; live authority remains resource-owned. */
export async function hasTeamCredentialDirectDeliveryActivityInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; recipientAccountId: string }>,
): Promise<boolean> {
    return (await tx.teamCredentialActivityEvent.findUnique({
        where: { id: directDeliveryActivityId(input.resourceId, input.recipientAccountId) },
        select: { id: true },
    })) !== null;
}

type SavedSecretDisclosureContext = Readonly<{
    actorAccountId: string; resourceId: string; expectedRevision: number; deviceId: string;
    authentication: TeamOperationAuthenticationContext;
}>;
type DisclosureFailure = Readonly<{ ok: false; error: 'resource_not_found' | 'resource_forbidden' | 'resource_changed' | 'invalid_resource_input' }>;
type DisclosureMutationResult = Readonly<{ ok: true; historyEntryId: string }> | DisclosureFailure;

async function admitSavedSecretDisclosureInTx(tx: Tx, input: SavedSecretDisclosureContext) {
    if (input.authentication.authenticationAuthority !== 'present_user' || !input.deviceId.trim()) {
        return { ok: false as const, error: 'resource_forbidden' as const };
    }
    const admitted = await admitSavedSecretResourceManagementInTx(tx, { accountId: input.actorAccountId,
        resourceId: input.resourceId, expectedRevision: input.expectedRevision });
    return admitted.ok ? admitted : { ok: false as const, error: admitted.error === 'resource_changed'
        ? 'resource_changed' as const : admitted.error === 'forbidden' ? 'resource_forbidden' as const : 'resource_not_found' as const };
}

async function publishSavedSecretActivityInTx(tx: Tx, accountId: string, resourceId: string): Promise<void> {
    // Only the history cursor advances. This never invokes the Saved Secret writer/publication.
    await markAccountsChanged(tx, { accountIds: [accountId], kind: 'account', entityId: savedSecretDisclosureActivityEntityIdV1(resourceId) });
}

/** Appends or settles one person disclosure; values never enter the metadata owner. */
export async function recordSavedSecretDisclosureActivityInTx(tx: Tx, input: SavedSecretDisclosureContext & Readonly<{
    outcome: ReturnType<typeof SavedSecretDisclosureOutcomeV1Schema.parse>; historyEntryId?: string;
}>): Promise<DisclosureMutationResult> {
    const admitted = await admitSavedSecretDisclosureInTx(tx, input);
    if (!admitted.ok) return admitted;
    const outcome = SavedSecretDisclosureOutcomeV1Schema.parse(input.outcome);
    if (input.historyEntryId) {
        const existing = await tx.teamCredentialActivityEvent.findUnique({ where: { id: input.historyEntryId } });
        if (!existing || existing.subjectKind !== 'saved_secret' || existing.ownerAccountId !== input.actorAccountId
            || existing.actorAccountId !== input.actorAccountId || existing.resourceId !== input.resourceId
            || existing.resourceRevision !== input.expectedRevision || existing.deviceId !== input.deviceId) {
            return { ok: false, error: 'resource_forbidden' };
        }
        if (existing.outcome === outcome) return { ok: true, historyEntryId: existing.id };
        await tx.teamCredentialActivityEvent.update({ where: { id: existing.id }, data: { outcome } });
        await publishSavedSecretActivityInTx(tx, input.actorAccountId, input.resourceId);
        return { ok: true, historyEntryId: existing.id };
    }
    const event = await tx.teamCredentialActivityEvent.create({ data: {
        subjectKind: 'saved_secret', ownerAccountId: admitted.value.ownerAccountId, resourceId: input.resourceId,
        resourceRevision: input.expectedRevision, actorAccountId: input.actorAccountId, deviceId: input.deviceId,
        kind: 'secret_reveal', outcome, subjectDisplayName: admitted.value.displayName,
    }, select: { id: true } });
    await publishSavedSecretActivityInTx(tx, input.actorAccountId, input.resourceId);
    return { ok: true, historyEntryId: event.id };
}

/** Copy is a gesture/result on the existing disclosure entry, not another Action or row. */
export async function recordSavedSecretCopyActivityInTx(tx: Tx, input: SavedSecretDisclosureContext & Readonly<{
    historyEntryId: string; outcome: ReturnType<typeof SavedSecretCopyOutcomeV1Schema.parse>;
}>): Promise<DisclosureMutationResult> {
    const admitted = await admitSavedSecretDisclosureInTx(tx, input);
    if (!admitted.ok) return admitted;
    const outcome = SavedSecretCopyOutcomeV1Schema.parse(input.outcome);
    const event = await tx.teamCredentialActivityEvent.findUnique({ where: { id: input.historyEntryId } });
    if (!event || event.subjectKind !== 'saved_secret' || event.ownerAccountId !== input.actorAccountId
        || event.actorAccountId !== input.actorAccountId || event.resourceId !== input.resourceId
        || event.resourceRevision !== input.expectedRevision || event.deviceId !== input.deviceId || event.outcome !== 'displayed') {
        return { ok: false, error: 'resource_forbidden' };
    }
    if (event.copyOutcome === outcome) return { ok: true, historyEntryId: event.id };
    await tx.teamCredentialActivityEvent.update({ where: { id: event.id }, data: {
        copyOutcome: outcome, ...(outcome === 'requested' ? { copyRequestedAt: new Date() } : {}),
    } });
    await publishSavedSecretActivityInTx(tx, input.actorAccountId, input.resourceId);
    return { ok: true, historyEntryId: event.id };
}

/** Reads this scoped subject through Saved Secret management, preserving deletion history. */
export async function readSavedSecretDisclosureActivityInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; resourceId: string; authentication: TeamOperationAuthenticationContext; cursor?: string; limit?: number;
}>): Promise<Readonly<{ ok: true; page: ReturnType<typeof SavedSecretDisclosureHistoryV1Schema.parse> }> | DisclosureFailure> {
    const limit = input.limit ?? 50; // Same history paging contract as the Team reader.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !input.resourceId.trim()) return { ok: false, error: 'invalid_resource_input' };
    if (input.authentication.authenticationAuthority !== 'present_user') return { ok: false, error: 'resource_forbidden' };
    const admitted = await admitSavedSecretResourceManagementInTx(tx, { accountId: input.actorAccountId, resourceId: input.resourceId,
    });
    if (!admitted.ok) {
        // Resource ids can be reused after deletion. Retained history belongs to
        // its recorded owning scope, never to a later same-id resource's owner.
        const retained = await tx.teamCredentialActivityEvent.findFirst({ where: { subjectKind: 'saved_secret',
            ownerAccountId: input.actorAccountId, resourceId: input.resourceId }, select: { id: true } });
        if (!retained) return { ok: false, error: admitted.error === 'resource_not_found' ? 'resource_not_found' : 'resource_forbidden' };
    }
    const cursor = input.cursor === undefined ? null : decodeActivityCursor(input.cursor, input.resourceId, input.actorAccountId);
    if (input.cursor !== undefined && !cursor) return { ok: false, error: 'invalid_resource_input' };
    const rows = await tx.teamCredentialActivityEvent.findMany({
        where: { subjectKind: 'saved_secret', ownerAccountId: input.actorAccountId, resourceId: input.resourceId,
            ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        select: { id: true, resourceRevision: true, deviceId: true, createdAt: true, outcome: true, actorAccountId: true,
            copyOutcome: true, copyRequestedAt: true, actorAccount: { select: { name: true, username: true } } },
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { ok: true, page: SavedSecretDisclosureHistoryV1Schema.parse({
        items: page.map(row => ({ id: row.id, ref: formatSharedSavedSecretRefV1(input.resourceId), resourceRevision: row.resourceRevision,
            deviceId: row.deviceId, createdAt: row.createdAt.toISOString(), outcome: row.outcome,
            actorDisplayName: row.actorAccount ? resolveAccountDisplayLabelV1(row.actorAccount) : null,
            actorIsSelf: row.actorAccountId === input.actorAccountId,
            copyOutcome: row.copyOutcome, copyRequestedAt: row.copyRequestedAt?.toISOString() ?? null })),
        nextCursor: rows.length > limit && last ? encodeActivityCursor({ id: last.id, createdAt: last.createdAt.getTime() }, input.resourceId, input.actorAccountId) : null,
    }) };
}
