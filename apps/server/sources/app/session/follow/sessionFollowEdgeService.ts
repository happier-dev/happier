import {
    compareSessionFollowFrontierProgressV1,
    deriveSessionFollowWakeEventLocalIdV1,
    isPlainMachineDataKeyMarker,
    isSessionFollowFrontierEqualV1,
    isSessionFollowTurnEqualV1,
    isSessionFollowConsumptionWithinCurrentV1,
    type SessionFollowFrontierV1,
    type SessionFollowAcknowledgeRequestV1,
    type SessionFollowSourceV1,
    type SessionFollowSourceProjectionRequestV1,
    type SessionFollowSourceProjectionResponseV1,
    SessionFollowSourceProjectionResponseV1Schema,
    SessionMessageRoleSchema,
} from "@happier-dev/protocol";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";

import {
    resolveEffectiveSessionAccess,
} from "@/app/session/access/sessionAccess";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import {
    assertSessionFollowSourceReadInTx,
    evaluateCurrentSessionContextPairInTx,
    mayInjectSessionContextInTx,
    resolveSessionFollowRuntimePrincipalAuthenticationInTx,
    type SessionFollowRuntimePrincipalV1,
} from "@/app/session/access/sessionContextInjection";
import { AccountStatus } from "@/storage/prisma";
import { inTx, type Tx } from "@/storage/inTx";
import {
    readCurrentSourceSessionFollowFrontier,
    readStoredSessionFollowFrontier,
    writeSessionFollowFrontierColumns,
} from "@/app/session/relations/sessionEdgeFrontier";
import {
    hasCanonicalFollowProviderInputAcceptanceInTx,
    hasCanonicalFollowWakeEventAcceptanceInTx,
} from "./providerInputAcceptance";
import { projectSessionMessageAccountActors } from "@/app/session/messages/projectSessionMessageAccountActors";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "@/app/session/access/sessionRecipients";
import { readSessionPendingReviewRunCountsInTx } from '@/app/session/awareness/sessionReportsProjection';
import {
    invalidateSessionRelationProjectionsInTx as invalidateSessionFollowDestinationsInTx,
    scheduleSessionRelationBroadcastAfterTx as scheduleSessionFollowDestinationBroadcastAfterTx,
} from "@/app/session/relations/sessionRelationChanges";

/**
 * The canonical `SessionFollowEdge` owner.
 *
 * Every HTTP route, generated Action, and internal Session-socket operation
 * delegates here, so authorization, seeding, dormancy and the acknowledgment
 * compare-and-set have exactly one implementation. This module stores no
 * content, no delivery Account, no configuring author, and no runtime state.
 */

const SESSION_SELECT = {
    id: true,
    accountId: true,
    archivedAt: true,
    publisherGeneration: true,
    seq: true,
    latestReadyEventSeq: true,
    agentStateVersion: true,
    latestTurnId: true,
    latestTurnStatus: true,
    active: true,
} as const;

const EDGE_SELECT = {
    sourceSessionId: true,
    destinationSessionId: true,
    deliveredTranscriptSeq: true,
    deliveredReadyEventSeq: true,
    deliveredAgentStateVersion: true,
    deliveredTurnId: true,
    deliveredTurnStatus: true,
    mode: true,
} as const;

export async function projectSessionFollowSourceForRunnerInTx(
    tx: Tx,
    input: Readonly<{
        principal: VerifiedEphemeralSessionRunnerPrincipal;
        destinationSessionId: string;
        request: SessionFollowSourceProjectionRequestV1;
    }>,
): Promise<SessionFollowSourceProjectionResponseV1 | null> {
    if (input.principal.sessionId !== input.destinationSessionId) return null;
    if (input.request.sourceSessionId === input.destinationSessionId) return null;
    if (!await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)) return null;
    const followEdge = input.request.edgeKind === 'reports_to' ? null : await tx.sessionFollowEdge.findUnique({
        where: { destinationSessionId_sourceSessionId: {
            destinationSessionId: input.destinationSessionId,
            sourceSessionId: input.request.sourceSessionId,
        } },
        select: EDGE_SELECT,
    }) as EdgeRow | null;
    const reportsTo = input.request.edgeKind === 'reports_to' ? await tx.sessionReportsTo.findUnique({
        where: { sessionId: input.request.sourceSessionId }, select: REPORTS_TO_EDGE_SELECT,
    }) : null;
    const edge = followEdge ?? (reportsTo?.leadSessionId === input.destinationSessionId ? asReportsToContextEdge(reportsTo) : null);
    if (!edge) return null;
    if (edge.edgeKind === 'reports_to' && edge.attachedAt!.getTime() !== input.request.attachedAt) return null;
    const snapshot = input.request.readMode === 'initial_current_snapshot';
    if (snapshot && edge.edgeKind !== 'reports_to') return null;
    if (!(await assertSessionFollowSourceReadInTx(tx, {
        principal: input.principal,
        sourceSessionId: input.request.sourceSessionId,
        edge,
    })).ok) return null;
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.archivedAt !== null || !await isActingAccountActive(tx, input.principal.accountId)) return null;
    if (!await canSubmitDestinationInput(
        tx,
        input.principal.accountId,
        input.destinationSessionId,
        await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal),
    )) return null;

    const source = await tx.session.findUnique({
        where: { id: input.request.sourceSessionId },
        select: {
            id: true, seq: true, encryptionMode: true, metadata: true, metadataLayoutVersion: true,
            archivedAt: true, createdAt: true, updatedAt: true, active: true, lastActiveAt: true,
            thinking: true, thinkingAt: true, latestTurnStatus: true, latestTurnStatusObservedAt: true,
            latestReadyEventSeq: true, latestReadyEventAt: true, meaningfulActivityAt: true,
            agentStateVersion: true, pendingPermissionRequestCount: true, pendingUserActionRequestCount: true,
            pendingRequestObservedAt: true, pendingCount: true, pendingBlockedCount: true,
            runtimeActivityState: true, runtimeActivityActiveCount: true,
        },
    });
    if (!source || source.archivedAt !== null || (source.encryptionMode !== "plain" && source.encryptionMode !== "e2ee")) return null;
    const pendingReviewRuns = await readSessionPendingReviewRunCountsInTx(tx, [source.id]);
    // The Runner reports the observation it is hydrating, but those sequence
    // numbers are never read authority. Bound the lower bound by the exact
    // transaction-loaded edge frontier so a stale or malicious caller cannot
    // replay already-delivered history, and reject an upper bound beyond the
    // source frontier this same transaction can currently observe. A cursor
    // above the frontier is a continuation inside the same pending range: a
    // wake scans past a full nonhuman page for protected human ingress (09D
    // §6.3), which delivery and ACK never skip.
    if (
        (!snapshot && input.request.afterTranscriptSeq < edge.deliveredTranscriptSeq)
        || input.request.observedTranscriptSeq > source.seq
    ) return null;
    const fetched = await tx.sessionMessage.findMany({
        where: {
            sessionId: source.id,
            seq: { gt: input.request.afterTranscriptSeq, lte: input.request.observedTranscriptSeq },
        },
        select: {
            seq: true, content: true, messageRole: true, createdAt: true,
            inputAdmissionReceipt: true, authorAccountId: true,
        },
        orderBy: { seq: snapshot ? 'desc' : 'asc' },
        take: input.request.limit + 1,
    });
    const hasMore = fetched.length > input.request.limit;
    const page = fetched.slice(0, input.request.limit);
    const accountActors = await projectSessionMessageAccountActors(tx, page);
    return SessionFollowSourceProjectionResponseV1Schema.parse({
        v: 1,
        source: {
            id: source.id,
            encryptionMode: source.encryptionMode,
            metadata: source.metadata,
            metadataLayoutVersion: source.metadataLayoutVersion,
            archivedAt: null,
            createdAt: source.createdAt.getTime(), updatedAt: source.updatedAt.getTime(),
            active: source.active, activeAt: source.lastActiveAt.getTime(),
            thinking: source.thinking, thinkingAt: source.thinkingAt?.getTime() ?? null,
            latestTurnStatus: source.latestTurnStatus,
            latestTurnStatusObservedAt: source.latestTurnStatusObservedAt === null ? null : Number(source.latestTurnStatusObservedAt),
            latestReadyEventSeq: source.latestReadyEventSeq,
            latestReadyEventAt: source.latestReadyEventAt?.getTime() ?? null,
            meaningfulActivityAt: source.meaningfulActivityAt?.getTime() ?? null,
            agentStateVersion: source.agentStateVersion,
            pendingReviewRuns: pendingReviewRuns.get(source.id) ?? 0,
            pendingPermissionRequestCount: source.pendingPermissionRequestCount,
            pendingUserActionRequestCount: source.pendingUserActionRequestCount,
            pendingRequestObservedAt: source.pendingRequestObservedAt?.getTime() ?? null,
            pendingCount: source.pendingCount, pendingBlockedCount: source.pendingBlockedCount,
            runtimeActivityState: source.runtimeActivityState,
            runtimeActivityActiveCount: source.runtimeActivityActiveCount,
        },
        messages: page.map((message, index) => ({
            seq: message.seq,
            content: message.content,
            ...(() => {
                const role = SessionMessageRoleSchema.safeParse(message.messageRole);
                return role.success ? { messageRole: role.data } : {};
            })(),
            createdAt: message.createdAt.getTime(),
            accountActor: accountActors[index] ?? null,
        })),
        hasMore,
    });
}

export type SessionFollowSourceFailure =
    | "invalid_parameters"
    | "session_not_found"
    | "account_inactive"
    | "session_archived"
    | "session_follow_same_session"
    | "session_follow_source_forbidden";

export type SessionFollowSourceResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: SessionFollowSourceFailure }>;

export type SessionFollowSourceKeyPreparationAdmission = Readonly<{
    destinationRuntimeAccountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    machineId: string;
}>;

type SessionRow = Readonly<{
    id: string;
    accountId: string;
    archivedAt: Date | null;
    publisherGeneration: bigint;
    seq: number;
    latestReadyEventSeq: number | null;
    agentStateVersion: number;
    latestTurnId: string | null;
    latestTurnStatus: string | null;
    active: boolean;
}>;

type EdgeRow = Readonly<{
    sourceSessionId: string;
    destinationSessionId: string;
    deliveredTranscriptSeq: number;
    deliveredReadyEventSeq: number;
    deliveredAgentStateVersion: number;
    deliveredTurnId: string | null;
    deliveredTurnStatus: string | null;
    mode: 'next_turn' | 'wake_on_human_change';
    edgeKind?: 'reports_to';
    attachedAt?: Date;
}>;

const REPORTS_TO_EDGE_SELECT = {
    sessionId: true, leadSessionId: true, attachedAt: true,
    deliveredTranscriptSeq: true, deliveredReadyEventSeq: true, deliveredAgentStateVersion: true,
    deliveredTurnId: true, deliveredTurnStatus: true,
} as const;

function asReportsToContextEdge(row: Readonly<{
    sessionId: string; leadSessionId: string; attachedAt: Date;
    deliveredTranscriptSeq: number; deliveredReadyEventSeq: number; deliveredAgentStateVersion: number;
    deliveredTurnId: string | null; deliveredTurnStatus: string | null;
}>): EdgeRow {
    return { ...row, sourceSessionId: row.sessionId, destinationSessionId: row.leadSessionId,
        mode: 'next_turn', edgeKind: 'reports_to', attachedAt: row.attachedAt };
}

function projectSource(edge: EdgeRow, source: SessionRow | null, dormant: boolean): SessionFollowSourceV1 {
    return {
        sourceSessionId: edge.sourceSessionId,
        destinationSessionId: edge.destinationSessionId,
        mode: edge.mode,
        deliveryState: dormant ? "paused_archived" : "eligible",
        hasPendingUpdates: source !== null && compareSessionFollowFrontierProgressV1(
            readStoredSessionFollowFrontier(edge),
            readCurrentSourceSessionFollowFrontier(source),
        ) === "ahead",
    };
}

async function loadSession(tx: Tx, sessionId: string): Promise<SessionRow | null> {
    return await tx.session.findUnique({ where: { id: sessionId }, select: SESSION_SELECT });
}

async function isActingAccountActive(tx: Tx, accountId: string): Promise<boolean> {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { status: true } });
    return account?.status === AccountStatus.active;
}

async function canReadSession(tx: Tx, accountId: string, sessionId: string, authentication: SessionAccessAuthentication): Promise<boolean> {
    return (await resolveEffectiveSessionAccess(tx, { accountId, sessionId, authentication }))?.capabilities.readTranscript === true;
}

async function canSubmitDestinationInput(tx: Tx, accountId: string, sessionId: string, authentication: SessionAccessAuthentication): Promise<boolean> {
    return (await resolveEffectiveSessionAccess(tx, { accountId, sessionId, authentication }))?.capabilities.submitAgentInput === true;
}

/** Publishes only the optional destination socket hint for a committed source projection change. */
export async function invalidateSessionFollowDestinationsForSourceChangeInTx(
    tx: Tx,
    input: Readonly<{ sourceSessionId: string }>,
): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { sourceSessionId: input.sourceSessionId },
        orderBy: { destinationSessionId: "asc" },
        select: { destinationSessionId: true },
    });
    for (const destinationSessionId of [...new Set(edges.map((edge) => edge.destinationSessionId))]) {
        const accountIds = await resolveCurrentSessionRecipientAccountIdsInTx(tx, {
            sessionId: destinationSessionId,
        });
        scheduleSessionFollowDestinationBroadcastAfterTx(tx, destinationSessionId, accountIds);
    }
}

/** Invalidates surviving destinations before the database cascades source-edge deletion. */
export async function invalidateSessionFollowDestinationsForSessionDeleteInTx(
    tx: Tx,
    input: Readonly<{ sessionId: string }>,
): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { sourceSessionId: input.sessionId },
        select: { destinationSessionId: true },
    });
    await invalidateSessionFollowDestinationsInTx(
        tx,
        edges.map(({ destinationSessionId }) => destinationSessionId),
    );
}

/**
 * Lists the destination's authored sources, filtered to the sources this
 * Account may currently read. An unreadable source is omitted rather than
 * disclosed, and the projection is content-free: display titles live in
 * end-to-end encrypted Session metadata that the Home cannot read.
 */
export async function listSessionFollowSources(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<readonly SessionFollowSourceV1[]>> {
    return await inTx(async (tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        const edges = await tx.sessionFollowEdge.findMany({
            where: { destinationSessionId: input.destinationSessionId },
            select: EDGE_SELECT,
            orderBy: { sourceSessionId: "asc" },
        });
        const visible: SessionFollowSourceV1[] = [];
        for (const edge of edges as readonly EdgeRow[]) {
            if (!await canReadSession(tx, input.accountId, edge.sourceSessionId, input.authentication)) continue;
            const source = await loadSession(tx, edge.sourceSessionId);
            const dormant = destination.archivedAt !== null || source === null || source.archivedAt !== null;
            visible.push(projectSource(edge, source, dormant));
        }
        return { ok: true, value: visible };
    }, { readOnly: true });
}

/**
 * Creates or confirms one source relation for a destination Session.
 *
 * Creation seeds every delivered component from the source's current frontier
 * inside the same transaction, so enabling Follow never emits historical
 * context. Key readiness and daemon reachability are deliberately not
 * preconditions: a valid authorized edge is persisted and waits.
 */
export async function setSessionFollowSource(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    mode?: 'next_turn' | 'wake_on_human_change';
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean; source: SessionFollowSourceV1 }>>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };

        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        const source = await loadSession(tx, input.sourceSessionId);
        if (!source || !await canReadSession(tx, input.accountId, input.sourceSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        if (!await canSubmitDestinationInput(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        if (destination.archivedAt !== null || source.archivedAt !== null) {
            return { ok: false, error: "session_archived" };
        }

        const decision = await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId,
            sourceSessionId: input.sourceSessionId,
            destinationSessionId: input.destinationSessionId,
            authentication: input.authentication,
        });
        if (!decision.ok) return { ok: false, error: "session_follow_source_forbidden" };

        const existing = await tx.sessionFollowEdge.findUnique({
            where: {
                destinationSessionId_sourceSessionId: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                },
            },
            select: EDGE_SELECT,
        }) as EdgeRow | null;

        const mode = input.mode ?? 'next_turn';
        if (existing) {
            if (existing.mode === mode) {
                return { ok: true, value: { changed: false, source: projectSource(existing, source, false) } };
            }
            const updated = await tx.sessionFollowEdge.update({
                where: { destinationSessionId_sourceSessionId: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                } },
                data: { mode },
                select: EDGE_SELECT,
            }) as EdgeRow;
            await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
            return { ok: true, value: { changed: true, source: projectSource(updated, source, false) } };
        }

        // Keep the resource idempotent under two concurrent first writers. The
        // preceding read preserves the ordinary `changed: false` response for
        // retries, while the upsert closes the unique-key race without a
        // catch-after-failed-transaction path (which PostgreSQL cannot use).
        const created = await tx.sessionFollowEdge.upsert({
            where: {
                destinationSessionId_sourceSessionId: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                },
            },
            create: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                mode,
                ...writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)),
            },
            update: {},
            select: EDGE_SELECT,
        }) as EdgeRow;
        await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
        return { ok: true, value: { changed: true, source: projectSource(created, source, false) } };
    });
}

/**
 * Removes one source relation. Removal is idempotent, requires only the
 * existing destination mutation authorization, and never grants source read;
 * following again later creates a fresh edge seeded to the then-current
 * frontier, so no historical content is disclosed by re-enabling.
 */
export async function removeSessionFollowSource(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean }>>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        if (!await canSubmitDestinationInput(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        const removed = await tx.sessionFollowEdge.deleteMany({
            where: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
            },
        });
        if (removed.count > 0) {
            await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
        }
        return { ok: true, value: { changed: removed.count > 0 } };
    });
}

/**
 * Content-free server admission for the encrypted exact-Machine source-key
 * carrier. The DEK never enters this service: it validates only the current
 * caller, current context relation, pairwise audience policy, ephemeral destination
 * Machine, and exact AccessKey binding used to select the receiver room.
 */
type SessionFollowSourceKeyPreparerInput = Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    authentication: SessionAccessAuthentication;
}>;

async function prepareSessionFollowSourceKeyPreparerInTx(
    tx: Tx,
    input: SessionFollowSourceKeyPreparerInput,
): Promise<SessionFollowSourceResult<Readonly<{ destinationRuntimeAccountId: string }>>> {
    if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
    const [source, destination, edge, reportsTo] = await Promise.all([
        loadSession(tx, input.sourceSessionId),
        loadSession(tx, input.destinationSessionId),
        tx.sessionFollowEdge.findUnique({
            where: { destinationSessionId_sourceSessionId: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
            } },
            select: EDGE_SELECT,
        }) as Promise<EdgeRow | null>,
        tx.sessionReportsTo.findUnique({
            where: { sessionId: input.sourceSessionId },
            select: { leadSessionId: true },
        }),
    ]);
    if (!source || !destination || (!edge && reportsTo?.leadSessionId !== input.destinationSessionId)) {
        return { ok: false, error: "session_not_found" };
    }
    if (source.archivedAt !== null || destination.archivedAt !== null) {
        return { ok: false, error: "session_archived" };
    }
    const decision = await mayInjectSessionContextInTx(tx, {
        configuringAccountId: input.accountId,
        sourceSessionId: input.sourceSessionId,
        destinationSessionId: input.destinationSessionId,
        authentication: input.authentication,
    });
    if (!decision.ok) {
        return { ok: false, error: "session_follow_source_forbidden" };
    }
    return { ok: true, value: { destinationRuntimeAccountId: decision.destinationRuntimeAccountId } };
}

/** Resolves the authorized destination room; exact Runner authority is still required at dispatch. */
export async function authorizeSessionFollowSourceKeyPreparer(
    input: SessionFollowSourceKeyPreparerInput,
): Promise<SessionFollowSourceResult<Readonly<{ destinationRuntimeAccountId: string }>>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => await prepareSessionFollowSourceKeyPreparerInTx(tx, input));
}

export async function authorizeSessionFollowSourceKeyPreparation(input: Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    principal: VerifiedEphemeralSessionRunnerPrincipal;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<SessionFollowSourceKeyPreparationAdmission>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        const prepared = await prepareSessionFollowSourceKeyPreparerInTx(tx, input);
        if (
            !prepared.ok
            || input.accountId !== prepared.value.destinationRuntimeAccountId
            || input.principal.accountId !== prepared.value.destinationRuntimeAccountId
            || input.principal.sessionId !== input.destinationSessionId
            || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
        ) return prepared.ok ? { ok: false, error: "session_follow_source_forbidden" } : prepared;

        const binding = await tx.accessKey.findUnique({
                where: { accountId_machineId_sessionId: {
                    accountId: prepared.value.destinationRuntimeAccountId,
                    machineId: input.principal.machineId,
                    sessionId: input.destinationSessionId,
                } },
                select: {
                    machine: { select: {
                        accountId: true,
                        dataEncryptionKey: true,
                        kind: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                        runnerContentKeyBinding: true,
                    } },
                },
            });
        if (
            !binding
            || binding.machine.accountId !== prepared.value.destinationRuntimeAccountId
            || binding.machine.dataEncryptionKey === null
            || isPlainMachineDataKeyMarker(binding.machine.dataEncryptionKey)
            || binding.machine.kind !== "ephemeral_session_runner"
            || binding.machine.revokedAt !== null
            || binding.machine.replacedByMachineId !== null
            || binding.machine.runnerContentKeyBinding === null
        ) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        return { ok: true, value: {
            destinationRuntimeAccountId: prepared.value.destinationRuntimeAccountId,
            destinationSessionId: input.destinationSessionId,
            sourceSessionId: input.sourceSessionId,
            machineId: input.principal.machineId,
        } };
    });
}

/**
 * One pending observation for a destination Session. It is content-free: the
 * daemon receives source identities and frontiers, then fetches and decrypts
 * source material under its own authority.
 */
export type PendingSessionFollowObservationV1 = Readonly<{
    sourceSessionId: string;
    destinationSessionId: string;
    delivered: SessionFollowFrontierV1;
    observed: SessionFollowFrontierV1;
    mode: 'next_turn' | 'wake_on_human_change';
    edgeKind?: 'reports_to';
    attachedAt?: number;
}>;

export type SessionFollowObservationResultV1 = Readonly<{
    currentSourceSessionIds: readonly string[];
    observations: readonly PendingSessionFollowObservationV1[];
}>;

/**
 * Returns authoritative current admitted source membership alongside the
 * subset whose frontier has advanced. Both projections are produced by the
 * same Lane 04 runtime source-read assertion pass, so pending delivery is never
 * misused as lifecycle membership. Archived, removed, or denied edges are
 * absent from both projections.
 */
export async function observePendingSessionFollowForDestinationInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    destinationSessionId: string;
    includeReportsTo?: boolean;
}>): Promise<SessionFollowObservationResultV1> {
    if (
        input.principal.kind === "ephemeral_session_runner"
        && !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
    ) return { currentSourceSessionIds: [], observations: [] };
    const destinationRuntimeAccountId = input.principal.kind === "destination_runtime"
        ? input.principal.destinationRuntimeAccountId
        : input.principal.accountId;
    const authentication = await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal);
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.archivedAt !== null) return { currentSourceSessionIds: [], observations: [] };
    // Only the verified destination runtime observes its own edges; custody is
    // re-derived from the transaction, never trusted from the request.
    if (destination.accountId !== destinationRuntimeAccountId) return { currentSourceSessionIds: [], observations: [] };
    if (!await isActingAccountActive(tx, destinationRuntimeAccountId)) return { currentSourceSessionIds: [], observations: [] };
    if (!await canSubmitDestinationInput(tx, destinationRuntimeAccountId, destination.id, authentication)) return { currentSourceSessionIds: [], observations: [] };
    const followEdges = await tx.sessionFollowEdge.findMany({
        where: { destinationSessionId: input.destinationSessionId },
        select: EDGE_SELECT,
        orderBy: { sourceSessionId: "asc" },
    }) as readonly EdgeRow[];
    const workerEdges = input.includeReportsTo ? (await tx.sessionReportsTo.findMany({
        where: { leadSessionId: input.destinationSessionId }, select: REPORTS_TO_EDGE_SELECT,
        orderBy: { sessionId: 'asc' },
    })).map(asReportsToContextEdge) : [];
    const edges = [...followEdges, ...workerEdges];

    const pending: PendingSessionFollowObservationV1[] = [];
    const currentSourceSessionIds: string[] = [];
    for (const edge of edges) {
        const source = await loadSession(tx, edge.sourceSessionId);
        if (!source || source.archivedAt !== null) continue;
        if (!(await assertSessionFollowSourceReadInTx(tx, {
            principal: input.principal,
            sourceSessionId: source.id,
            edge,
        })).ok) continue;
        currentSourceSessionIds.push(edge.sourceSessionId);
        const delivered = readStoredSessionFollowFrontier(edge);
        const observed = readCurrentSourceSessionFollowFrontier(source, edge.edgeKind === 'reports_to');
        if (compareSessionFollowFrontierProgressV1(delivered, observed) !== "ahead") continue;
        pending.push({
            sourceSessionId: edge.sourceSessionId,
            destinationSessionId: edge.destinationSessionId,
            delivered,
            observed,
            mode: edge.mode,
            ...(edge.edgeKind ? { edgeKind: edge.edgeKind, attachedAt: edge.attachedAt!.getTime() } : {}),
        });
    }
    return { currentSourceSessionIds: [...new Set(currentSourceSessionIds)], observations: pending };
}

export type SessionFollowAcknowledgeRejection =
    | "edge_not_found"
    | "session_archived"
    | "stale_publisher_generation"
    | "stale_expected_frontier"
    | "stale_terminal_turn"
    | "invalid_consumed_frontier"
    | "provider_acceptance_unverified"
    | "source_forbidden";

export type SessionFollowAcknowledgeResult =
    | Readonly<{ ok: true; delivered: SessionFollowFrontierV1 }>
    | Readonly<{ ok: false; rejection: SessionFollowAcknowledgeRejection }>;

/**
 * Advances one edge's delivered frontier after the canonical provider-input
 * outcome reported acceptance.
 *
 * This is consumption progress, not exactly-once delivery proof. The write is a
 * compare-and-set over the complete expected stored tuple and the
 * destination's exact publisher generation, so a reordered or
 * duplicated acknowledgment can never regress or overwrite newer progress. The
 * three numeric components must be monotone from the expected tuple and no
 * greater than either the exact observed tuple or the current canonical source
 * values; terminal turns are not
 * ordered, so the consumed turn must equal the source's current terminal turn
 * exactly or the whole acknowledgment is rejected and left pending.
 */
export async function acknowledgeSessionFollowFrontierInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    destinationSessionId: string;
    sourceSessionId: string;
    edgeKind?: 'reports_to';
    attachedAt?: number;
    expectedPublisherGeneration: bigint;
    expected: SessionFollowFrontierV1;
    observed: SessionFollowFrontierV1;
    consumed: SessionFollowFrontierV1;
    acceptance: SessionFollowAcknowledgeRequestV1['acceptance'];
}>): Promise<SessionFollowAcknowledgeResult> {
    if (
        input.principal.kind === "ephemeral_session_runner"
        && !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
    ) return { ok: false, rejection: "source_forbidden" };
    const destinationRuntimeAccountId = input.principal.kind === "destination_runtime"
        ? input.principal.destinationRuntimeAccountId
        : input.principal.accountId;
    const authentication = await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal);
    const acceptance = input.acceptance;
    if (!acceptance) {
        return { ok: false, rejection: "provider_acceptance_unverified" };
    }
    switch (acceptance.kind) {
        case "context_only_wake":
            if (typeof acceptance.eventLocalId !== "string" || acceptance.eventLocalId.trim().length === 0) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
            break;
        case "admitted_input":
            if (
                typeof acceptance.localInputId !== "string"
                || acceptance.localInputId.trim().length === 0
                || !(acceptance.userMessageSeq === null
                    || Number.isSafeInteger(acceptance.userMessageSeq) && acceptance.userMessageSeq >= 0)
            ) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
            break;
        default:
            return { ok: false, rejection: "provider_acceptance_unverified" };
    }
    const workerRow = input.edgeKind === 'reports_to' ? await tx.sessionReportsTo.findUnique({
        where: { sessionId: input.sourceSessionId }, select: REPORTS_TO_EDGE_SELECT,
    }) : null;
    const edge = input.edgeKind === 'reports_to'
        ? workerRow && workerRow.leadSessionId === input.destinationSessionId ? asReportsToContextEdge(workerRow) : null
        : await tx.sessionFollowEdge.findUnique({
        where: {
            destinationSessionId_sourceSessionId: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
            },
        },
        select: EDGE_SELECT,
    }) as EdgeRow | null;
    if (!edge) return { ok: false, rejection: "edge_not_found" };
    if (edge.edgeKind === 'reports_to' && edge.attachedAt!.getTime() !== input.attachedAt) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    const stored = readStoredSessionFollowFrontier(edge);
    if (!isSessionFollowFrontierEqualV1(stored, input.expected)) {
        return { ok: false, rejection: "stale_expected_frontier" };
    }

    const destination = await loadSession(tx, input.destinationSessionId);
    const source = await loadSession(tx, input.sourceSessionId);
    if (!destination || !source) return { ok: false, rejection: "edge_not_found" };
    if (destination.accountId !== destinationRuntimeAccountId
        || !await isActingAccountActive(tx, destinationRuntimeAccountId)
        || !await canSubmitDestinationInput(
            tx,
            destinationRuntimeAccountId,
            destination.id,
            authentication,
        )
        || !(await assertSessionFollowSourceReadInTx(tx, {
            principal: input.principal,
            sourceSessionId: input.sourceSessionId,
            edge,
        })).ok) return { ok: false, rejection: "source_forbidden" };
    if (destination.archivedAt !== null || source.archivedAt !== null) {
        return { ok: false, rejection: "session_archived" };
    }
    if (destination.publisherGeneration !== input.expectedPublisherGeneration) {
        return { ok: false, rejection: "stale_publisher_generation" };
    }

    if (acceptance.kind === "context_only_wake" && edge.edgeKind !== 'reports_to' && edge.mode !== "wake_on_human_change") {
        return { ok: false, rejection: "provider_acceptance_unverified" };
    }
    let hasCanonicalAcceptance: boolean;
    if (acceptance.kind === "context_only_wake") {
        let expectedEventLocalId: string;
        try {
            expectedEventLocalId = deriveSessionFollowWakeEventLocalIdV1({
                destinationSessionId: destination.id,
                publisherGeneration: destination.publisherGeneration.toString(),
                observations: acceptance.observations,
            });
        } catch {
            return { ok: false, rejection: "provider_acceptance_unverified" };
        }
        const acceptedObservation = acceptance.observations.find(
            (observation) => observation.sourceSessionId === input.sourceSessionId && observation.edgeKind === input.edgeKind,
        );
        if (
            expectedEventLocalId !== acceptance.eventLocalId
            || !acceptedObservation
            || acceptedObservation.attachedAt !== input.attachedAt
            || !isSessionFollowFrontierEqualV1(acceptedObservation.expected, input.expected)
            || !isSessionFollowFrontierEqualV1(acceptedObservation.consumed, input.consumed)
        ) {
            return { ok: false, rejection: "provider_acceptance_unverified" };
        }
        hasCanonicalAcceptance = await hasCanonicalFollowWakeEventAcceptanceInTx(tx, {
            destinationSessionId: input.destinationSessionId,
            eventLocalId: acceptance.eventLocalId,
        });
    } else {
        hasCanonicalAcceptance = await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
            destinationSessionId: input.destinationSessionId,
            localInputId: acceptance.localInputId,
            userMessageSeq: acceptance.userMessageSeq,
        });
    }
    if (!hasCanonicalAcceptance) {
        return { ok: false, rejection: "provider_acceptance_unverified" };
    }

    const current = readCurrentSourceSessionFollowFrontier(source, edge.edgeKind === 'reports_to');
    if (!isSessionFollowConsumptionWithinCurrentV1({
        expected: input.expected,
        observed: input.observed,
        consumed: input.consumed,
        current,
    })) {
        return { ok: false, rejection: "invalid_consumed_frontier" };
    }
    if (!isSessionFollowTurnEqualV1(current.turn, input.consumed.turn)) {
        return { ok: false, rejection: "stale_terminal_turn" };
    }

    const frontierWhere = writeSessionFollowFrontierColumns(input.expected);
    const written = edge.edgeKind === 'reports_to' ? await tx.sessionReportsTo.updateMany({
        where: { sessionId: input.sourceSessionId, leadSessionId: input.destinationSessionId,
            attachedAt: edge.attachedAt!, ...frontierWhere },
        data: writeSessionFollowFrontierColumns(input.consumed),
    }) : await tx.sessionFollowEdge.updateMany({
        where: { destinationSessionId: input.destinationSessionId, sourceSessionId: input.sourceSessionId, ...frontierWhere },
        data: writeSessionFollowFrontierColumns(input.consumed),
    });
    if (written.count === 0) return { ok: false, rejection: "stale_expected_frontier" };
    return { ok: true, delivered: input.consumed };
}

/**
 * Reseed adapter consumed by the canonical Session archive/restore owner.
 *
 * Archiving either endpoint keeps the edge and makes it derived-dormant, so
 * this performs no write. When a Session becomes unarchived and its partner is
 * also unarchived, every delivered component is reseeded to the source's
 * then-current frontier in the same transaction, so updates accumulated while
 * archived are intentionally skipped rather than replayed.
 */
export async function reseedRestoredSessionFollowEdgesInTx(tx: Tx, input: Readonly<{
    sessionId: string;
    archived: boolean;
}>): Promise<number> {
    if (input.archived) return 0;
    const edges = await tx.sessionFollowEdge.findMany({
        where: {
            OR: [{ sourceSessionId: input.sessionId }, { destinationSessionId: input.sessionId }],
        },
        select: { sourceSessionId: true, destinationSessionId: true },
    }) as readonly { sourceSessionId: string; destinationSessionId: string }[];

    let reseeded = 0;
    for (const edge of edges) {
        const source = await loadSession(tx, edge.sourceSessionId);
        const destination = await loadSession(tx, edge.destinationSessionId);
        if (!source || !destination) continue;
        if (source.archivedAt !== null || destination.archivedAt !== null) continue;
        await tx.sessionFollowEdge.update({
            where: {
                destinationSessionId_sourceSessionId: {
                    destinationSessionId: edge.destinationSessionId,
                    sourceSessionId: edge.sourceSessionId,
                },
            },
            data: writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)),
        });
        reseeded += 1;
    }
    return reseeded;
}

/**
 * Re-evaluates each Follow edge touching a Session whose effective audience or
 * access just changed. The complete current pair decision catches source-access
 * loss by any destination audience member as well as destination broadening;
 * it preserves an edge when the final post-mutation pair remains safe.
 * Restoring access does not
 * recreate the edge: the user follows again explicitly, seeded to current, so
 * content accumulated while unauthorized is never silently disclosed.
 */
export async function removeUnsafeSessionFollowEdgesForAccessChangeInTx(tx: Tx, input: Readonly<{
    sessionId: string;
}>): Promise<number> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: {
            OR: [
                { sourceSessionId: input.sessionId },
                { destinationSessionId: input.sessionId },
            ],
        },
        select: { sourceSessionId: true, destinationSessionId: true },
    }) as readonly { sourceSessionId: string; destinationSessionId: string }[];

    let removed = 0;
    const invalidatedDestinationSessionIds = new Set<string>();
    for (const edge of edges) {
        if ((await evaluateCurrentSessionContextPairInTx(tx, edge)).ok) continue;
        const deleted = await tx.sessionFollowEdge.deleteMany({
            where: {
                destinationSessionId: edge.destinationSessionId,
                sourceSessionId: edge.sourceSessionId,
            },
        });
        removed += deleted.count;
        if (deleted.count > 0) invalidatedDestinationSessionIds.add(edge.destinationSessionId);
    }
    await invalidateSessionFollowDestinationsInTx(tx, invalidatedDestinationSessionIds);
    return removed;
}
