import {
    AUTOMATIC_SESSION_FOLLOW_STATE_V1,
    AccountSessionFollowV1Schema,
    EXPLICIT_SESSION_UNFOLLOW_STATE_V1,
    SessionAutoFollowPreferencesV1Schema,
    SetSessionFollowRequestSchema,
    ReplaceSessionVoiceInclusionsRequestSchema,
    compareSessionFollowFrontierProgressV1,
    encodePersistedSessionFollowFrontierV1,
    isSessionFollowConsumptionWithinCurrentV1,
    isSessionFollowFrontierEqualV1,
    isSessionFollowTurnEqualV1,
    parsePersistedSessionFollowFrontierV1,
    projectSessionFollowFrontierFromSourceV1,
    isActiveHomeAccountStatus,
    type AccountSessionFollowV1,
    type SessionAutoFollowPreferencesV1,
    type SetSessionFollowRequest,
    type GetSessionFollowResponse,
    type SessionFollowFrontierV1,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from "@happier-dev/protocol";

import { resolveEffectiveSessionAccess, resolveSessionAccessForAccountsInTx, resolveStructuralSessionAccessForAccountsInTx } from "@/app/session/access/sessionAccess";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import {
    beginViewerReadTrackingOnFollowEntriesInTx,
    beginViewerReadTrackingOnFollowEntryInTx,
    filterPersonallyTrackedSessionsForAccountsInTx,
    isSessionPersonallyTrackedInTx,
} from "@/app/session/personal/readState";
import { inTx, type Tx } from "@/storage/inTx";
import { AccountStatus, getDbProviderFromEnv, prismaRuntime as Prisma } from "@/storage/prisma";
import { markSessionFollowsChangedForAccountsInTx, markSessionFollowsChangedInTx } from "./changes";
import { hasCanonicalFollowProviderInputAcceptanceInTx } from "./providerInputAcceptance";

export type CurrentAccountVoiceExecutionRunAuthority = Readonly<{
    executionRunId: string;
    occurrenceId: string;
    parentSessionId: string;
    intent: 'voice_agent';
    runtimeState: 'active_turn' | 'idle';
}>;

async function hasCurrentPrivateAccountVoicePublisherInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<boolean> {
    const authority = input.runtimeAuthority;
    if (!authority
        || !authority.executionRunId.trim()
        || !authority.occurrenceId.trim()
        || authority.intent !== 'voice_agent'
        || authority.parentSessionId !== input.voiceSessionId) return false;
    const voiceSession = await tx.session.findUnique({
        where: { id: input.voiceSessionId },
        select: {
            accountId: true,
            archivedAt: true,
            tag: true,
            shares: { select: { id: true }, take: 1 },
            teamGrants: { select: { sessionId: true }, take: 1 },
            groupGrants: { select: { sessionId: true }, take: 1 },
            publicShare: { select: { sessionId: true } },
        },
    });
    return voiceSession?.accountId === input.accountId
        && voiceSession.archivedAt === null
        && voiceSession.tag === VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG
        && voiceSession.shares.length === 0
        && voiceSession.teamGrants.length === 0
        && voiceSession.groupGrants.length === 0
        && voiceSession.publicShare === null;
}

export type AccountFollowFailure = "invalid_parameters" | "account_inactive" | "session_not_found" | "session_archived";
export type AccountFollowResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: AccountFollowFailure }>;
const FOLLOW_SELECT = {
    sessionId: true,
    following: true,
    notificationLevel: true,
    includeInVoice: true,
    voiceDeliveredFrontier: true,
} as const;
const ACCOUNT_SELECT = {
    status: true,
    sessionAutoFollowAssigned: true,
    sessionAutoFollowDirect: true,
    sessionAutoFollowTeam: true,
    sessionAutoFollowGroup: true,
} as const;
type AccountPreferencesRow = Readonly<{
    sessionAutoFollowAssigned: boolean;
    sessionAutoFollowDirect: boolean;
    sessionAutoFollowTeam: boolean;
    sessionAutoFollowGroup: boolean;
}>;
function projectPreferences(row: AccountPreferencesRow): SessionAutoFollowPreferencesV1 {
    return {
        assigned: row.sessionAutoFollowAssigned, direct: row.sessionAutoFollowDirect,
        team: row.sessionAutoFollowTeam, group: row.sessionAutoFollowGroup,
    };
}
function isVoiceInitialSnapshotPending(row: Readonly<{
    following: boolean;
    includeInVoice: boolean;
    voiceDeliveredFrontier: string | null;
}> | null): boolean {
    return row?.following === true && row.includeInVoice && row.voiceDeliveredFrontier === null;
}

/** Private Voice custody is selected for pending-state calculation, never exposed as an editable preference. */
function projectAccountSessionFollow(row: Readonly<{
    sessionId: string;
    following: boolean;
    notificationLevel: string;
    includeInVoice: boolean;
}>): AccountSessionFollowV1 {
    return AccountSessionFollowV1Schema.parse({
        sessionId: row.sessionId,
        following: row.following,
        notificationLevel: row.notificationLevel,
        includeInVoice: row.includeInVoice,
    });
}
async function activeAccount(tx: Tx, accountId: string) {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: ACCOUNT_SELECT });
    return account && isActiveHomeAccountStatus(account.status) ? account : null;
}
async function readableSession(tx: Tx, input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>) {
    if ((await resolveEffectiveSessionAccess(tx, input))?.capabilities.readTranscript !== true) return null;
    return await tx.session.findUnique({ where: { id: input.sessionId }, select: { accountId: true, archivedAt: true } });
}

/** Reads only the authenticated Account's personal choice after current Session read admission. */
export async function getAccountSessionFollow(input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>): Promise<AccountFollowResult<GetSessionFollowResponse>> {
    return await inTx(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const session = await readableSession(tx, input);
        if (!session) return { ok: false, error: "session_not_found" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        return { ok: true, value: {
            follow: row ? projectAccountSessionFollow(row) : null,
            isSessionOwner: session.accountId === input.accountId,
            capabilities: { manageFollow: true },
            voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(row),
        } };
    }, { readOnly: true });
}

/** Replaces a personal Follow choice and seeds newly entered tracking through its canonical owner. */
export async function setAccountSessionFollow(input: Readonly<{
    accountId: string; sessionId: string; preferences: SetSessionFollowRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{
    changed: boolean;
    follow: AccountSessionFollowV1;
    voiceInitialSnapshotPending: boolean;
}>>> {
    const parsed = SetSessionFollowRequestSchema.safeParse(input.preferences);
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const preferences = parsed.data;
    return await inTx(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const session = await readableSession(tx, input);
        if (!session) return { ok: false, error: "session_not_found" };
        if (session.archivedAt !== null) return { ok: false, error: "session_archived" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        if (existing?.following && existing.notificationLevel === preferences.notificationLevel && existing.includeInVoice === preferences.includeInVoice) {
            return { ok: true, value: {
                changed: false,
                follow: projectAccountSessionFollow(existing),
                voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(existing),
            } };
        }
        const wasTracked = await isSessionPersonallyTrackedInTx(tx, { ...key, ownerAccountId: session.accountId });
        const row = await tx.accountSessionFollow.upsert({
            where: { accountId_sessionId: key },
            create: { ...key, following: true, ...preferences, voiceDeliveredFrontier: null },
            update: { following: true, ...preferences,
                ...(!preferences.includeInVoice || !existing?.includeInVoice ? { voiceDeliveredFrontier: null } : {}) },
            select: FOLLOW_SELECT,
        });
        await beginViewerReadTrackingOnFollowEntryInTx({ tx, ...key, wasTracked, authentication: input.authentication });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: {
            changed: true,
            follow: projectAccountSessionFollow(row),
            voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(row),
        } };
    });
}

/** Explicit Unfollow persists suppression, including after visibility loss, without disclosing a Session. */
export async function removeAccountSessionFollow(input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>): Promise<AccountFollowResult<Readonly<{ changed: boolean }>>> {
    return await inTx(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        if (!existing && !await readableSession(tx, input)) return { ok: false, error: "session_not_found" };
        if (existing && !existing.following) return { ok: true, value: { changed: false } };
        const suppressed = { ...EXPLICIT_SESSION_UNFOLLOW_STATE_V1, voiceDeliveredFrontier: null };
        await tx.accountSessionFollow.upsert({ where: { accountId_sessionId: key }, create: { ...key, ...suppressed }, update: suppressed });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true } };
    });
}

/** Atomically replaces one Home's durable Include in Voice membership. */
export async function replaceAccountSessionVoiceInclusions(input: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{ changed: boolean; sessionIds: string[] }>>> {
    const parsed = ReplaceSessionVoiceInclusionsRequestSchema.safeParse({ sessionIds: input.sessionIds });
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const sessionIds = [...new Set(parsed.data.sessionIds)].sort();
    return await inTx(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const sessions = new Map<string, Readonly<{ accountId: string; archivedAt: Date | null }>>();
        for (const sessionId of sessionIds) {
            const session = await readableSession(tx, { ...input, sessionId });
            if (!session) return { ok: false, error: "session_not_found" };
            if (session.archivedAt !== null) return { ok: false, error: "session_archived" };
            sessions.set(sessionId, session);
        }
        const desired = new Set(sessionIds);
        const existing = await tx.accountSessionFollow.findMany({
            where: { accountId: input.accountId },
            select: FOLLOW_SELECT,
        });
        const existingBySessionId = new Map(existing.map(row => [row.sessionId, row] as const));
        let changed = false;
        for (const row of existing) {
            if (!row.following || !row.includeInVoice || desired.has(row.sessionId)) continue;
            await tx.accountSessionFollow.update({
                where: { accountId_sessionId: { accountId: input.accountId, sessionId: row.sessionId } },
                data: { includeInVoice: false, voiceDeliveredFrontier: null },
            });
            changed = true;
        }
        for (const sessionId of sessionIds) {
            const key = { accountId: input.accountId, sessionId };
            const row = existingBySessionId.get(sessionId);
            if (row?.following && row.includeInVoice) continue;
            const session = sessions.get(sessionId)!;
            const wasTracked = await isSessionPersonallyTrackedInTx(tx, { ...key, ownerAccountId: session.accountId });
            await tx.accountSessionFollow.upsert({
                where: { accountId_sessionId: key },
                create: { ...key, following: true, notificationLevel: 'none', includeInVoice: true, voiceDeliveredFrontier: null },
                update: {
                    following: true,
                    includeInVoice: true,
                    voiceDeliveredFrontier: null,
                    ...(row?.following ? {} : { notificationLevel: 'none' }),
                },
            });
            await beginViewerReadTrackingOnFollowEntryInTx({ tx, ...key, wasTracked, authentication: input.authentication });
            changed = true;
        }
        if (changed) await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed, sessionIds } };
    });
}

/** Gets the four prospective operational defaults; no encrypted settings mirror exists. */
export async function getSessionAutoFollowPreferences(input: Readonly<{ accountId: string }>): Promise<AccountFollowResult<SessionAutoFollowPreferencesV1>> {
    return await inTx(async tx => {
        const account = await activeAccount(tx, input.accountId);
        return account ? { ok: true, value: projectPreferences(account) } : { ok: false, error: "account_inactive" };
    }, { readOnly: true });
}

/** Replaces future relationship defaults without scanning or mutating historical relationships. */
export async function setSessionAutoFollowPreferences(input: Readonly<{
    accountId: string; preferences: SessionAutoFollowPreferencesV1;
}>): Promise<AccountFollowResult<SessionAutoFollowPreferencesV1>> {
    const parsed = SessionAutoFollowPreferencesV1Schema.safeParse(input.preferences);
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const preferences = parsed.data;
    return await inTx(async tx => {
        const account = await activeAccount(tx, input.accountId);
        if (!account) return { ok: false, error: "account_inactive" };
        const current = projectPreferences(account);
        if (Object.keys(preferences).some(key => current[key as keyof typeof current] !== preferences[key as keyof typeof preferences])) {
            await tx.account.update({ where: { id: input.accountId }, data: {
                sessionAutoFollowAssigned: preferences.assigned, sessionAutoFollowDirect: preferences.direct,
                sessionAutoFollowTeam: preferences.team, sessionAutoFollowGroup: preferences.group,
            } });
            await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        }
        return { ok: true, value: preferences };
    });
}

/**
 * Set-oriented automatic-entry authority.
 *
 * The composite Follow key remains the authority: only rows with no prior
 * per-Session choice are inserted (ignore-on-conflict), so an explicit Follow,
 * Unfollow suppression, or concurrent winner is never overwritten. Non-MySQL
 * uses one bulk INSERT...RETURNING to learn the exact inserted set atomically;
 * MySQL uses one bulk createMany plus one post-read filtered to the automatic
 * state (same-values concurrent explicit same-state overcount is fresh-baseline
 * safe and noted as a provider gate). A zero/empty set means another choice
 * won and no tracking baseline may be touched. Chunked to respect provider
 * variable limits; test fixtures settle in one chunk.
 */
async function insertAutomaticSessionFollowsIfAbsentInTx(
    tx: Tx,
    params: Readonly<{ sessionId: string; accountIds: readonly string[] }>,
): Promise<readonly string[]> {
    const unique = [...new Set(params.accountIds)].filter(accountId => typeof accountId === 'string' && accountId.length > 0);
    if (unique.length === 0) return [];
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const CHUNK = 200;
    const inserted: string[] = [];
    for (let offset = 0; offset < unique.length; offset += CHUNK) {
        const chunk = unique.slice(offset, offset + CHUNK);
        if (provider === 'mysql') {
            await tx.accountSessionFollow.createMany({
                data: chunk.map(accountId => ({
                    accountId,
                    sessionId: params.sessionId,
                    ...AUTOMATIC_SESSION_FOLLOW_STATE_V1,
                    voiceDeliveredFrontier: null,
                })),
                skipDuplicates: true,
            });
            // Post-read filtered to the automatic state learns the inserted set
            // except for the rare same-state concurrent explicit winner, which
            // is fresh-baseline safe (both seed to the current ceiling).
            const rows = await tx.accountSessionFollow.findMany({
                where: {
                    sessionId: params.sessionId,
                    accountId: { in: chunk },
                    following: true,
                    notificationLevel: 'important',
                    includeInVoice: false,
                },
                select: { accountId: true },
            });
            for (const row of rows) inserted.push(row.accountId);
        } else {
            const rows = Prisma.join(chunk.map(accountId => Prisma.sql`(${accountId}, ${params.sessionId}, ${AUTOMATIC_SESSION_FOLLOW_STATE_V1.following}, ${AUTOMATIC_SESSION_FOLLOW_STATE_V1.notificationLevel}, ${AUTOMATIC_SESSION_FOLLOW_STATE_V1.includeInVoice}, NULL)`));
            const returned = await tx.$queryRaw<Array<{ accountId: string }>>(Prisma.sql`
                INSERT INTO "AccountSessionFollow" ("accountId", "sessionId", "following", "notificationLevel", "includeInVoice", "voiceDeliveredFrontier")
                VALUES ${rows}
                ON CONFLICT("accountId", "sessionId") DO NOTHING
                RETURNING "accountId"
            `);
            for (const row of returned) inserted.push(row.accountId);
        }
    }
    return [...new Set(inserted)];
}

/**
 * Called only with new relationship evidence from the canonical assignment/access
 * transaction. Eligibility, current access, the existing-row check and the
 * tracking predicate are resolved for the whole Account set through their
 * set-oriented owners, so a bulk Team or directory change never degrades into a
 * per-Account authorization loop inside the mutation transaction.
 */
export async function applySessionAutoFollowForRelationshipChangeInTx(tx: Tx, input: Readonly<{
    sessionId: string; accountIds: readonly string[]; relationship: keyof SessionAutoFollowPreferencesV1;
}>): Promise<number> {
    if (!await isServerFeatureEnabledForHome("sessions.following", { tx })) return 0;
    const requested = [...new Set(input.accountIds)];
    if (requested.length === 0) return 0;
    const session = await tx.session.findUnique({ where: { id: input.sessionId }, select: { accountId: true, archivedAt: true } });
    if (!session || session.archivedAt !== null) return 0;
    const preferenceColumn = {
        assigned: "sessionAutoFollowAssigned", direct: "sessionAutoFollowDirect",
        team: "sessionAutoFollowTeam", group: "sessionAutoFollowGroup",
    } as const;
    const [accounts, existing] = await Promise.all([
        tx.account.findMany({
            where: { id: { in: requested }, status: AccountStatus.active, [preferenceColumn[input.relationship]]: true },
            select: { id: true },
        }),
        tx.accountSessionFollow.findMany({
            where: { sessionId: input.sessionId, accountId: { in: requested } },
            select: { accountId: true },
        }),
    ]);
    const alreadyChosen = new Set(existing.map(row => row.accountId));
    const eligible = accounts.map(account => account.id).filter(accountId => !alreadyChosen.has(accountId));
    if (eligible.length === 0) return 0;

    const [access, tracked] = await Promise.all([
        resolveSessionAccessForAccountsInTx(tx, {
            sessionId: input.sessionId,
            accountIds: eligible,
            authentication: backgroundDeliveryAuthentication(),
        }),
        filterPersonallyTrackedSessionsForAccountsInTx(tx, { accountIds: eligible, sessionIds: [input.sessionId] }),
    ]);
    const readableEligible = eligible.filter(accountId => access.get(accountId)?.capabilities.readTranscript === true);
    if (readableEligible.length === 0) return 0;
    // Bulk conditional inserts learn the exact newly inserted set; another
    // explicit choice winning the key means no baseline may be touched.
    const insertedAccountIds = await insertAutomaticSessionFollowsIfAbsentInTx(tx, {
        sessionId: input.sessionId,
        accountIds: readableEligible,
    });
    if (insertedAccountIds.length === 0) return 0;
    const wasTrackedByAccountId = new Map(insertedAccountIds.map(accountId => [
        accountId,
        tracked.get(accountId)?.has(input.sessionId) === true,
    ] as const));
    // Newly inserted eligible followers initialize as a set: one session
    // ceiling read plus one bulk session upsert plus one bulk Discussion matrix
    // upsert, preserving fresh-baseline (wasTracked false) versus preserve
    // (wasTracked true, e.g. owner) semantics without per-Account loops.
    await beginViewerReadTrackingOnFollowEntriesInTx({
        tx,
        sessionId: input.sessionId,
        accountIds: insertedAccountIds,
        wasTrackedByAccountId,
        authentication: backgroundDeliveryAuthentication(),
    });
    await markSessionFollowsChangedForAccountsInTx(tx, insertedAccountIds);
    return insertedAccountIds.length;
}

/** Final effective read loss contracts active interest; explicit user suppression remains intact. */
export async function removeAccountSessionFollowsOnAccessLossInTx(tx: Tx, input: Readonly<{
    sessionId: string; accountIds: readonly string[];
}>): Promise<number> {
    const candidates = await tx.accountSessionFollow.findMany({ where: {
        sessionId: input.sessionId, accountId: { in: [...new Set(input.accountIds)] }, following: true,
    }, select: { accountId: true } });
    if (candidates.length === 0) return 0;
    const access = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: input.sessionId, accountIds: candidates.map(row => row.accountId),
    });
    const revoked = candidates
        .map(row => row.accountId)
        .filter(accountId => access.get(accountId)?.capabilities.readTranscript !== true);
    if (revoked.length === 0) return 0;
    const result = await tx.accountSessionFollow.deleteMany({ where: { sessionId: input.sessionId, accountId: { in: revoked }, following: true } });
    await markSessionFollowsChangedForAccountsInTx(tx, revoked);
    return result.count;
}

const VOICE_SOURCE_SELECT = {
    id: true,
    archivedAt: true,
    seq: true,
    latestReadyEventSeq: true,
    agentStateVersion: true,
    latestTurnId: true,
    latestTurnStatus: true,
} as const;

export type PendingAccountVoiceFollowObservationV1 = Readonly<{
    sourceSessionId: string;
    voiceSessionId: string;
    expected: SessionFollowFrontierV1 | null;
    observed: SessionFollowFrontierV1;
}>;

/** Content-free Account Voice observer; null means one current snapshot is pending. */
export async function observePendingAccountVoiceFollowInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    authentication: SessionAccessAuthentication;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<readonly PendingAccountVoiceFollowObservationV1[] | null> {
    if (!await activeAccount(tx, input.accountId)) return null;
    if (!await hasCurrentPrivateAccountVoicePublisherInTx(tx, input)) return null;
    const follows = await tx.accountSessionFollow.findMany({
        where: { accountId: input.accountId, following: true, includeInVoice: true },
        select: { sessionId: true, voiceDeliveredFrontier: true },
        orderBy: { sessionId: 'asc' },
    });
    const pending: PendingAccountVoiceFollowObservationV1[] = [];
    for (const follow of follows) {
        if (follow.sessionId === input.voiceSessionId) continue;
        const source = await tx.session.findUnique({ where: { id: follow.sessionId }, select: VOICE_SOURCE_SELECT });
        if (!source || source.archivedAt !== null) continue;
        if ((await resolveEffectiveSessionAccess(tx, {
            accountId: input.accountId,
            sessionId: source.id,
            authentication: input.authentication,
        }))?.capabilities.readTranscript !== true) continue;
        const expected = follow.voiceDeliveredFrontier === null
            ? null
            : parsePersistedSessionFollowFrontierV1(follow.voiceDeliveredFrontier);
        // Malformed persisted bytes fail closed; null alone is the pending-current sentinel.
        if (follow.voiceDeliveredFrontier !== null && expected === null) continue;
        const observed = projectSessionFollowFrontierFromSourceV1(source);
        if (expected !== null && compareSessionFollowFrontierProgressV1(expected, observed) !== 'ahead') continue;
        pending.push({ sourceSessionId: source.id, voiceSessionId: input.voiceSessionId, expected, observed });
    }
    return pending;
}

export type AccountVoiceFollowAcknowledgeRejection =
    | 'forbidden'
    | 'not_followed'
    | 'session_archived'
    | 'stale_expected_frontier'
    | 'stale_terminal_turn'
    | 'invalid_consumed_frontier'
    | 'provider_acceptance_unverified'
    | 'source_forbidden';

export async function acknowledgeAccountVoiceFollowInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    sourceSessionId: string;
    expected: SessionFollowFrontierV1 | null;
    observed: SessionFollowFrontierV1;
    consumed: SessionFollowFrontierV1;
    acceptance: Readonly<{ localInputId: string; userMessageSeq: number | null }>;
    authentication: SessionAccessAuthentication;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<Readonly<{ ok: true; delivered: SessionFollowFrontierV1 }>
    | Readonly<{ ok: false; rejection: AccountVoiceFollowAcknowledgeRejection }>> {
    if (!await activeAccount(tx, input.accountId)) return { ok: false, rejection: 'forbidden' };
    if (!await hasCurrentPrivateAccountVoicePublisherInTx(tx, input)) return { ok: false, rejection: 'forbidden' };
    if (
        !input.acceptance
        || typeof input.acceptance.localInputId !== 'string'
        || input.acceptance.localInputId.trim().length === 0
        || !(
            input.acceptance.userMessageSeq === null
            || Number.isSafeInteger(input.acceptance.userMessageSeq) && input.acceptance.userMessageSeq >= 0
        )
    ) return { ok: false, rejection: 'provider_acceptance_unverified' };
    if (!await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
        destinationSessionId: input.voiceSessionId,
        localInputId: input.acceptance.localInputId,
        userMessageSeq: input.acceptance.userMessageSeq,
    })) return { ok: false, rejection: 'provider_acceptance_unverified' };
    const source = await tx.session.findUnique({ where: { id: input.sourceSessionId }, select: VOICE_SOURCE_SELECT });
    if (!source) return { ok: false, rejection: 'not_followed' };
    if (source.archivedAt !== null) return { ok: false, rejection: 'session_archived' };
    if ((await resolveEffectiveSessionAccess(tx, {
        accountId: input.accountId,
        sessionId: source.id,
        authentication: input.authentication,
    }))?.capabilities.readTranscript !== true) return { ok: false, rejection: 'source_forbidden' };
    const key = { accountId: input.accountId, sessionId: input.sourceSessionId };
    const follow = await tx.accountSessionFollow.findUnique({
        where: { accountId_sessionId: key },
        select: { following: true, includeInVoice: true, voiceDeliveredFrontier: true },
    });
    if (!follow?.following || !follow.includeInVoice) return { ok: false, rejection: 'not_followed' };
    const stored = follow.voiceDeliveredFrontier === null
        ? null
        : parsePersistedSessionFollowFrontierV1(follow.voiceDeliveredFrontier);
    if (follow.voiceDeliveredFrontier !== null && stored === null) return { ok: false, rejection: 'stale_expected_frontier' };
    if (stored === null ? input.expected !== null : input.expected === null || !isSessionFollowFrontierEqualV1(stored, input.expected)) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    const current = projectSessionFollowFrontierFromSourceV1(source);
    const baseline = input.expected ?? { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    if (!isSessionFollowConsumptionWithinCurrentV1({
        expected: baseline,
        observed: input.observed,
        consumed: input.consumed,
        current,
    })) {
        return { ok: false, rejection: 'invalid_consumed_frontier' };
    }
    if (!isSessionFollowTurnEqualV1(current.turn, input.consumed.turn)) {
        return { ok: false, rejection: 'stale_terminal_turn' };
    }
    const written = await tx.accountSessionFollow.updateMany({
        where: {
            ...key,
            following: true,
            includeInVoice: true,
            voiceDeliveredFrontier: follow.voiceDeliveredFrontier,
        },
        data: { voiceDeliveredFrontier: encodePersistedSessionFollowFrontierV1(input.consumed) },
    });
    return written.count === 1
        ? { ok: true, delivered: input.consumed }
        : { ok: false, rejection: 'stale_expected_frontier' };
}
