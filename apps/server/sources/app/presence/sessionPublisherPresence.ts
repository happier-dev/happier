import {
    SessionRuntimeActivitySnapshotSchema,
    type PrimaryTurnStatusV1,
    type SessionRuntimeActivitySnapshot,
    type SessionRuntimeIssueV1,
} from "@happier-dev/protocol";

import {
    didSessionActivityBadgeContributionChange,
    type SessionActivityBadgeInputs,
} from "@/app/activity/accountActivityBadge";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import {
    updateSessionRuntimeActivityProjection,
    writeSessionRuntimeActivityObserverLossInTx,
    writeSessionRuntimeActivityProjectionInTx,
    type SessionRuntimeActivityProjectionUpdate,
    type SessionRuntimeActivityProjectionInTxResult,
    applyLatestSessionTurnEndInTx,
} from "@/app/session/sessionWriteService";
import { hasExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { inTx } from "@/storage/inTx";

export interface SessionPublisherBinding {
    readonly accountId: string;
    readonly machineId: string;
    readonly sessionId: string;
}

export type RegisterSessionPublisherResult =
    | {
        status: "registered";
        committedFence: Date;
        activeAt: Date;
        activity: Extract<SessionRuntimeActivityProjectionInTxResult, { status: "applied" | "unchanged" }>;
        participantCursors: readonly SessionParticipantCursor[];
        badgeAttentionChanged: boolean;
        pendingState?: Readonly<{
            pendingCount: number;
            pendingBlockedCount: number;
            pendingVersion: number;
        }>;
      }
    | { status: "rejected"; reason: "invalid-params" | "invalid_storage" | "not_found" | "unauthorized" | "archived" | "revision_overflow" | "contention" };

export type TouchSessionPublisherResult =
    | { status: "touched"; committedFence: Date; activeAt: Date; participantCursors: readonly SessionParticipantCursor[]; badgeAttentionChanged: boolean }
    | { status: "unregistered" | "superseded" }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" };

export type CloseSessionPublisherResult =
    | {
        status: "closed";
        activeAt: Date;
        participantCursors: readonly SessionParticipantCursor[];
        badgeAttentionChanged: boolean;
        projection?: SessionRuntimeActivityProjectionUpdate;
        turnProjection?: Readonly<{
            latestTurnId: string | null;
            latestTurnStatus: PrimaryTurnStatusV1 | null;
            latestTurnStatusObservedAt: number | null;
            lastRuntimeIssue: SessionRuntimeIssueV1 | null;
        }>;
      }
    | { status: "closed_replay"; activeAt: Date }
    | { status: "already_inactive" | "superseded" }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" };
export type ExplicitMachineStopTarget = Readonly<{
    binding: SessionPublisherBinding;
    committedFence: Date;
}>;
export type MachineSessionTerminalTarget = ExplicitMachineStopTarget;
export type CaptureExplicitMachineStopResult =
    | Readonly<{ status: "captured"; target: ExplicitMachineStopTarget }>
    | Readonly<{ status: "already_inactive" }>
    | Readonly<{ status: "rejected"; reason: "not_found" | "unauthorized" | "archived" }>;

type Registration = Readonly<{
    binding: SessionPublisherBinding;
    committedFence: Date;
}>;

export type CurrentSessionPublisherAuthority = Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
    committedFence: Date;
}>;

export const SESSION_PUBLISHER_AUTHORITY_SOCKET_DATA_KEY = "sessionPublisherAuthority";

export type SessionPublisherAuthorityProjectionV1 = Readonly<{
    v: 1;
    accountId: string;
    machineId: string;
    sessionId: string;
    committedFenceMs: number;
}>;

export type RunAsProjectedCurrentPublisherResult<T> =
    | Readonly<{ status: "current"; value: T }>
    | Readonly<{ status: "unavailable" }>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseSessionPublisherAuthorityProjection(
    value: unknown,
): SessionPublisherAuthorityProjectionV1 | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const accountId = normalizeNonEmptyString(candidate.accountId);
    const machineId = normalizeNonEmptyString(candidate.machineId);
    const sessionId = normalizeNonEmptyString(candidate.sessionId);
    const committedFenceMs = candidate.committedFenceMs;
    if (
        candidate.v !== 1
        || !accountId
        || !machineId
        || !sessionId
        || typeof committedFenceMs !== "number"
        || !Number.isSafeInteger(committedFenceMs)
        || committedFenceMs < 0
    ) {
        return null;
    }
    return {
        v: 1,
        accountId,
        machineId,
        sessionId,
        committedFenceMs,
    };
}

export function readSessionPublisherAuthorityProjection(
    socketData: unknown,
): SessionPublisherAuthorityProjectionV1 | null {
    if (!socketData || typeof socketData !== "object" || Array.isArray(socketData)) return null;
    return parseSessionPublisherAuthorityProjection(
        (socketData as Record<string, unknown>)[SESSION_PUBLISHER_AUTHORITY_SOCKET_DATA_KEY],
    );
}

function writeSessionPublisherAuthorityProjection(
    socket: object,
    registration: Registration | null,
): void {
    const carrier = socket as { data?: unknown };
    if (!carrier.data || typeof carrier.data !== "object" || Array.isArray(carrier.data)) return;
    const data = carrier.data as Record<string, unknown>;
    if (!registration) {
        delete data[SESSION_PUBLISHER_AUTHORITY_SOCKET_DATA_KEY];
        return;
    }
    data[SESSION_PUBLISHER_AUTHORITY_SOCKET_DATA_KEY] = {
        v: 1,
        ...registration.binding,
        committedFenceMs: registration.committedFence.getTime(),
    } satisfies SessionPublisherAuthorityProjectionV1;
}

class RegistrationContentionError extends Error {}

const sessionActivityBadgeSelect = {
    seq: true,
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    pendingCount: true,
    pendingBlockedCount: true,
    lastViewedSessionSeq: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    latestTurnStatus: true,
    lastRuntimeIssue: true,
    active: true,
    archivedAt: true,
} as const;

export type ExpireSessionPublisherCandidate = Readonly<{
    sessionId: string;
    observedFence: Date;
}>;

export type ExpireSessionPublisherResult =
    | Readonly<{
        status: "expired";
        sessionId: string;
        activeAt: Date;
        participantCursors: readonly SessionParticipantCursor[];
        badgeAttentionChanged: boolean;
      }>
    | Readonly<{ status: "stale"; sessionId: string }>;

/**
 * Owns timeout's exact-fence reachability transition. Activity is deliberately not
 * selected or written: timeout only discovers and disseminates a committed close.
 */
export async function expireSessionPublisherCandidates(params: Readonly<{
    candidates: readonly ExpireSessionPublisherCandidate[];
}>): Promise<readonly ExpireSessionPublisherResult[]> {
    if (params.candidates.length === 0) return [];
    return await inTx(async (tx): Promise<readonly ExpireSessionPublisherResult[]> => {
        const results: ExpireSessionPublisherResult[] = [];
        for (const candidate of params.candidates) {
            const session = await tx.session.findUnique({
                where: { id: candidate.sessionId },
                select: { ...sessionActivityBadgeSelect, lastActiveAt: true },
            });
            if (
                !session
                || session.active !== true
                || session.archivedAt !== null
                || session.lastActiveAt.getTime() !== candidate.observedFence.getTime()
            ) {
                results.push({ status: "stale", sessionId: candidate.sessionId });
                continue;
            }

            const updated = await tx.session.updateMany({
                where: {
                    id: candidate.sessionId,
                    active: true,
                    archivedAt: null,
                    lastActiveAt: candidate.observedFence,
                },
                data: { active: false },
            });
            if (updated.count !== 1) {
                results.push({ status: "stale", sessionId: candidate.sessionId });
                continue;
            }

            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId: candidate.sessionId });
            results.push({
                status: "expired",
                sessionId: candidate.sessionId,
                activeAt: candidate.observedFence,
                participantCursors,
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                    session satisfies SessionActivityBadgeInputs,
                    { ...session, active: false },
                ),
            });
        }
        return results;
    });
}

function parseCompleteSnapshot(value: unknown): SessionRuntimeActivitySnapshot | null {
    const parsed = SessionRuntimeActivitySnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function sameBinding(a: SessionPublisherBinding, b: SessionPublisherBinding): boolean {
    return a.accountId === b.accountId && a.machineId === b.machineId && a.sessionId === b.sessionId;
}

/** Owns the exact socket registration, monotonic reachability fence, touch, close, and Activity publication contract. */
export function createSessionPublisherPresence(options: Readonly<{ now?: () => Date }> = {}) {
    const now = options.now ?? (() => new Date());
    const registrations = new WeakMap<object, Registration>();
    const closeResults = new WeakMap<object, Promise<CloseSessionPublisherResult>>();
    const operationTails = new WeakMap<object, Promise<void>>();

    const rememberRegistration = (socket: object, registration: Registration): void => {
        registrations.set(socket, registration);
        writeSessionPublisherAuthorityProjection(socket, registration);
    };

    const serialize = async <T>(socket: object, operation: () => Promise<T>): Promise<T> => {
        const prior = operationTails.get(socket) ?? Promise.resolve();
        const result = prior.catch(() => {}).then(operation);
        operationTails.set(socket, result.then(() => {}, () => {}));
        return await result;
    };

    const registerOnce = async (
        binding: SessionPublisherBinding,
        snapshot: SessionRuntimeActivitySnapshot,
    ): Promise<RegisterSessionPublisherResult> => await inTx(async (tx): Promise<RegisterSessionPublisherResult> => {
        const session = await tx.session.findUnique({
            where: { id: binding.sessionId },
            select: { ...sessionActivityBadgeSelect, lastActiveAt: true },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...binding })) {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };

        const inherited = await tx.sessionPendingMessage.updateMany({
            where: {
                sessionId: binding.sessionId,
                status: "queued",
                deliveryState: "delivering",
            },
            data: {
                deliveryState: "blocked",
                deliveryBlockedReason: "delivery_outcome_uncertain",
            },
        });
        let pendingState: Readonly<{
            pendingCount: number;
            pendingBlockedCount: number;
            pendingVersion: number;
        }> | undefined;
        if (inherited.count > 0) {
            const [pendingCount, pendingBlockedCount] = await Promise.all([
                tx.sessionPendingMessage.count({ where: { sessionId: binding.sessionId, status: "queued" } }),
                tx.sessionPendingMessage.count({
                    where: { sessionId: binding.sessionId, status: "queued", deliveryState: "blocked" },
                }),
            ]);
            pendingState = await tx.session.update({
                where: { id: binding.sessionId },
                data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
        }

        const activity = await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: binding.sessionId,
            state: snapshot.state,
            activeCount: snapshot.activeCount,
        });
        if (activity.status === "rejected") return activity;

        const committedFence = new Date(Math.max(now().getTime(), session.lastActiveAt.getTime() + 1));
        const updated = await tx.session.updateMany({
            where: { id: binding.sessionId, archivedAt: null, lastActiveAt: session.lastActiveAt },
            data: { active: true, lastActiveAt: committedFence },
        });
        if (updated.count !== 1) throw new RegistrationContentionError();
        const participantCursors = await markSessionParticipantsChanged({ tx, sessionId: binding.sessionId });
        return {
            status: "registered",
            committedFence,
            activeAt: committedFence,
            activity,
            participantCursors,
            badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                session satisfies SessionActivityBadgeInputs,
                {
                    ...session,
                    active: true,
                    ...(pendingState
                        ? {
                            pendingCount: pendingState.pendingCount,
                            pendingBlockedCount: pendingState.pendingBlockedCount,
                        }
                        : {}),
                },
            ),
            ...(pendingState ? { pendingState } : {}),
        };
    });

    const registerPublisher = async (params: Readonly<{
        socket: object;
        binding: SessionPublisherBinding;
        completeActivitySnapshot: unknown;
    }>): Promise<RegisterSessionPublisherResult> => await serialize(params.socket, async () => {
        const snapshot = parseCompleteSnapshot(params.completeActivitySnapshot);
        if (!snapshot) return { status: "rejected", reason: "invalid-params" };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const result = await registerOnce(params.binding, snapshot);
                if (result.status === "registered") {
                    rememberRegistration(params.socket, {
                        binding: { ...params.binding },
                        committedFence: new Date(result.committedFence.getTime()),
                    });
                }
                return result;
            } catch (error) {
                if (!(error instanceof RegistrationContentionError)) throw error;
            }
        }
        return { status: "rejected", reason: "contention" };
    });

    const touchPublisher = async (params: Readonly<{ socket: object }>): Promise<TouchSessionPublisherResult> => await serialize(
        params.socket,
        async (): Promise<TouchSessionPublisherResult> => {
            if (closeResults.has(params.socket)) return { status: "superseded" };
            const registration = registrations.get(params.socket);
            if (!registration) return { status: "unregistered" };
            const result = await inTx(async (tx): Promise<TouchSessionPublisherResult> => {
                const session = await tx.session.findUnique({
                    where: { id: registration.binding.sessionId },
                    select: { ...sessionActivityBadgeSelect, lastActiveAt: true },
                });
                if (!session) return { status: "rejected", reason: "not_found" };
                if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...registration.binding })) {
                    return { status: "rejected", reason: "unauthorized" };
                }
                if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
                if (session.lastActiveAt.getTime() !== registration.committedFence.getTime()) {
                    return { status: "superseded" };
                }
                const committedFence = new Date(Math.max(now().getTime(), session.lastActiveAt.getTime() + 1));
                const updated = await tx.session.updateMany({
                    where: {
                        id: registration.binding.sessionId,
                        active: session.active,
                        archivedAt: null,
                        lastActiveAt: registration.committedFence,
                    },
                    data: { active: true, lastActiveAt: committedFence },
                });
                if (updated.count !== 1) return { status: "superseded" };
                const participantCursors = await markSessionParticipantsChanged({
                    tx,
                    sessionId: registration.binding.sessionId,
                });
                return {
                    status: "touched",
                    committedFence,
                    activeAt: committedFence,
                    participantCursors,
                    badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                        session satisfies SessionActivityBadgeInputs,
                        { ...session, active: true },
                    ),
                };
            });
            if (result.status === "touched") {
                rememberRegistration(params.socket, {
                    binding: registration.binding,
                    committedFence: result.committedFence,
                });
            }
            return result;
        },
    );

    const closeBindingAtFence = async (params: Readonly<{
        binding: SessionPublisherBinding;
        committedFence: Date;
        mutationId: string;
        settleLatestTurn?: boolean;
    }>): Promise<CloseSessionPublisherResult> => await inTx(async (tx): Promise<CloseSessionPublisherResult> => {
        const session = await tx.session.findUnique({
            where: { id: params.binding.sessionId },
            select: { ...sessionActivityBadgeSelect, lastActiveAt: true },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...params.binding })) {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (session.lastActiveAt.getTime() !== params.committedFence.getTime()) {
            return { status: "superseded" };
        }
        if (!session.active) return { status: "already_inactive" };
        const turnResult = params.settleLatestTurn === false
            ? null
            : await applyLatestSessionTurnEndInTx({
                tx,
                actorUserId: params.binding.accountId,
                sessionId: params.binding.sessionId,
                mutationId: params.mutationId,
                observedAt: now().getTime(),
            });
        if (turnResult && !turnResult.ok) {
            throw new Error(`Failed to settle publisher-close turn: ${turnResult.error}`);
        }
        const activity = await writeSessionRuntimeActivityObserverLossInTx({
            tx,
            sessionId: params.binding.sessionId,
        });
        if (activity.status === "rejected") {
            throw new Error(`Failed to record Runtime Activity observer loss: ${activity.reason}`);
        }
        if (session.active) {
            const updated = await tx.session.updateMany({
                where: {
                    id: params.binding.sessionId,
                    active: true,
                    archivedAt: null,
                    lastActiveAt: params.committedFence,
                },
                data: { active: false },
            });
            if (updated.count !== 1) return { status: "superseded" };
        }
        const participantCursors = await markSessionParticipantsChanged({
            tx,
            sessionId: params.binding.sessionId,
        });
        return {
            status: "closed",
            activeAt: session.lastActiveAt,
            participantCursors,
            badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                session satisfies SessionActivityBadgeInputs,
                { ...session, active: false },
            ),
            ...(activity.status === "applied" ? { projection: activity.projection } : {}),
            ...(turnResult?.ok && turnResult.didApply
                ? {
                    turnProjection: {
                        latestTurnId: turnResult.latestTurnId,
                        latestTurnStatus: turnResult.latestTurnStatus,
                        latestTurnStatusObservedAt: turnResult.latestTurnStatusObservedAt,
                        lastRuntimeIssue: turnResult.lastRuntimeIssue,
                    },
                }
                : {}),
        };
    });

    const captureExplicitMachineStop = async (params: Readonly<{
        binding: SessionPublisherBinding;
    }>): Promise<CaptureExplicitMachineStopResult> => await inTx(async (tx): Promise<CaptureExplicitMachineStopResult> => {
        const session = await tx.session.findUnique({
            where: { id: params.binding.sessionId },
            select: { active: true, archivedAt: true, lastActiveAt: true },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...params.binding })) {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (!session.active) return { status: "already_inactive" };
        return {
            status: "captured",
            target: {
                binding: { ...params.binding },
                committedFence: new Date(session.lastActiveAt.getTime()),
            },
        };
    });

    const captureMachineSessionTerminal = captureExplicitMachineStop;

    const finalizeExplicitMachineStop = async (params: Readonly<{
        target: ExplicitMachineStopTarget;
    }>): Promise<CloseSessionPublisherResult> => await closeBindingAtFence({
        binding: params.target.binding,
        committedFence: params.target.committedFence,
        mutationId: `explicit-machine-stop:${params.target.committedFence.getTime()}`,
    });

    const finalizeMachineSessionTerminal = async (params: Readonly<{
        target: MachineSessionTerminalTarget;
    }>): Promise<CloseSessionPublisherResult> => await closeBindingAtFence({
        binding: params.target.binding,
        committedFence: params.target.committedFence,
        mutationId: `machine-session-terminal:${params.target.committedFence.getTime()}`,
        settleLatestTurn: false,
    });

    const closePublisher = (params: Readonly<{ socket: object }>): Promise<CloseSessionPublisherResult> => {
        const existing = closeResults.get(params.socket);
        if (existing) {
            return existing.then((settled): CloseSessionPublisherResult => settled.status === "closed"
                ? { status: "closed_replay", activeAt: new Date(settled.activeAt.getTime()) }
                : settled);
        }
        const result = serialize(params.socket, async (): Promise<CloseSessionPublisherResult> => {
            const registration = registrations.get(params.socket);
            if (!registration) return { status: "superseded" };
            return await closeBindingAtFence({
                binding: registration.binding,
                committedFence: registration.committedFence,
                mutationId: `publisher-close:${registration.committedFence.getTime()}`,
            });
        });
        closeResults.set(params.socket, result);
        void result.then((settled) => {
            if (settled.status !== "closed" && closeResults.get(params.socket) === result) {
                closeResults.delete(params.socket);
            }
        }, () => {
            if (closeResults.get(params.socket) === result) closeResults.delete(params.socket);
        });
        return result;
    };

    const publishSnapshot = async (params: Readonly<{
        socket: object;
        binding: SessionPublisherBinding;
        completeSnapshot: unknown;
    }>) => await serialize(params.socket, async () => {
        const snapshot = parseCompleteSnapshot(params.completeSnapshot);
        if (!snapshot) return { status: "rejected", reason: "invalid-params" } as const;
        const registration = registrations.get(params.socket);
        if (!registration) {
            const result = await registerOnce(params.binding, snapshot);
            if (result.status !== "registered") return result;
            rememberRegistration(params.socket, {
                binding: { ...params.binding },
                committedFence: new Date(result.committedFence.getTime()),
            });
            return {
                ...result.activity,
                activeAt: result.activeAt,
                participantCursors: result.participantCursors,
                badgeAttentionChanged: result.badgeAttentionChanged,
            };
        }
        if (!sameBinding(registration.binding, params.binding)) {
            return { status: "rejected", reason: "superseded" } as const;
        }
        return await updateSessionRuntimeActivityProjection({
            ...registration.binding,
            boundCommittedFence: registration.committedFence,
            state: snapshot.state,
            activeCount: snapshot.activeCount,
        });
    });

    const runAsCurrentPublisher = async <T>(params: Readonly<{
        socket: object;
        operation: (authority: CurrentSessionPublisherAuthority) => Promise<T>;
    }>): Promise<T | null> => await serialize(params.socket, async () => {
        const registration = registrations.get(params.socket);
        if (!registration) return null;
        return await params.operation({
            ...registration.binding,
            committedFence: new Date(registration.committedFence.getTime()),
        });
    });

    const resolveProjectedCurrentPublisher = async (params: Readonly<{
        expectedAccountId: string;
        expectedSessionId: string;
        projection: unknown;
    }>): Promise<CurrentSessionPublisherAuthority | null> => {
        const projection = parseSessionPublisherAuthorityProjection(params.projection);
        if (
            !projection
            || projection.accountId !== params.expectedAccountId
            || projection.sessionId !== params.expectedSessionId
        ) {
            return null;
        }
        const authority: CurrentSessionPublisherAuthority = {
            accountId: projection.accountId,
            machineId: projection.machineId,
            sessionId: projection.sessionId,
            committedFence: new Date(projection.committedFenceMs),
        };
        const current = await inTx(async (tx) => await hasExactCurrentPublisherAuthorityInTx(
            tx,
            authority,
            params.expectedAccountId,
            params.expectedSessionId,
        ));
        return current ? authority : null;
    };

    const isCurrentPublisherProjection = async (params: Readonly<{
        expectedAccountId: string;
        expectedSessionId: string;
        projection: unknown;
    }>): Promise<boolean> => (
        await resolveProjectedCurrentPublisher(params)
    ) !== null;

    const runAsProjectedCurrentPublisher = async <T>(params: Readonly<{
        expectedAccountId: string;
        expectedSessionId: string;
        initialProjection: unknown;
        readLatestProjection: () => Promise<unknown>;
        operation: (authority: CurrentSessionPublisherAuthority) => Promise<T>;
    }>): Promise<RunAsProjectedCurrentPublisherResult<T>> => {
        const initialAuthority = await resolveProjectedCurrentPublisher({
            expectedAccountId: params.expectedAccountId,
            expectedSessionId: params.expectedSessionId,
            projection: params.initialProjection,
        });
        if (!initialAuthority) return { status: "unavailable" };

        const value = await params.operation(initialAuthority);
        const latestProjection = await params.readLatestProjection();
        const latestAuthority = await resolveProjectedCurrentPublisher({
            expectedAccountId: params.expectedAccountId,
            expectedSessionId: params.expectedSessionId,
            projection: latestProjection,
        });
        if (!latestAuthority || !sameBinding(initialAuthority, latestAuthority)) {
            return { status: "unavailable" };
        }
        return { status: "current", value };
    };

    const forgetDisconnectedPublisher = async (params: Readonly<{ socket: object }>) => await serialize(
        params.socket,
        async () => {
            try {
                const registration = registrations.get(params.socket);
                if (!registration) return { status: "unregistered" } as const;
                if (closeResults.has(params.socket)) return { status: "closed" } as const;
                return await inTx(async (tx) => {
                    const session = await tx.session.findUnique({
                        where: { id: registration.binding.sessionId },
                        select: { archivedAt: true, lastActiveAt: true },
                    });
                    if (!session) return { status: "rejected", reason: "not_found" } as const;
                    if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...registration.binding })) {
                        return { status: "rejected", reason: "unauthorized" } as const;
                    }
                    if (session.archivedAt !== null) return { status: "rejected", reason: "archived" } as const;
                    if (session.lastActiveAt.getTime() !== registration.committedFence.getTime()) {
                        return { status: "rejected", reason: "superseded" } as const;
                    }
                    const activity = await writeSessionRuntimeActivityProjectionInTx({
                        tx,
                        sessionId: registration.binding.sessionId,
                        state: "unknown",
                        activeCount: 0,
                    });
                    if (activity.status === "rejected") return activity;
                    const participantCursors = activity.status === "applied"
                        ? await markSessionParticipantsChanged({ tx, sessionId: registration.binding.sessionId })
                        : [];
                    return { ...activity, participantCursors };
                });
            } finally {
                registrations.delete(params.socket);
                closeResults.delete(params.socket);
                writeSessionPublisherAuthorityProjection(params.socket, null);
            }
        },
    );

    return {
        registerPublisher,
        touchPublisher,
        closePublisher,
        captureExplicitMachineStop,
        finalizeExplicitMachineStop,
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal,
        publishSnapshot,
        runAsCurrentPublisher,
        isCurrentPublisherProjection,
        runAsProjectedCurrentPublisher,
        forgetDisconnectedPublisher,
    };
}
