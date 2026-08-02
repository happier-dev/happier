import type {
    PrimaryTurnStatusV1,
    SessionRuntimeActivityProjection,
    SessionRuntimeActivitySnapshot,
    SessionRuntimeIssueV1,
} from "@happier-dev/protocol";

import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import {
    parseSessionRuntimeActivitySnapshot,
    readStoredSessionRuntimeActivityProjectionResult,
    type StoredSessionRuntimeActivityProjectionResult,
} from "@/app/session/runtimeActivity/projection";
import { writeAuthorizedSessionRuntimeActivityProjection } from "@/app/session/runtimeActivity/writeAuthorizedProjection";
import type { ActivityInTxResult } from "@/app/session/runtimeActivity/writeProjection";
import {
    writeSessionRuntimeActivityObserverLossInTx,
    writeSessionRuntimeActivityProjectionInTx,
} from "@/app/session/runtimeActivity/writeProjection";
import { inTx, type Tx } from "@/storage/inTx";
import { blockInheritedProviderDeliveryClaims } from "@/app/session/pending/providerDeliveryClaimStaleness";
import { applyLatestSessionTurnEndInTx } from "@/app/session/sessionWriteService";

export interface PublisherBinding {
    readonly accountId: string;
    readonly machineId: string;
    readonly sessionId: string;
}

export type RegisterPublisherResult =
    | { status: "registered"; committedFence: Date; activeAt: Date; activity: Extract<ActivityInTxResult, { status: "applied" | "unchanged" }>; participantCursors: readonly SessionParticipantCursor[] }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" | "revision_overflow" | "contention" };
export type TouchPublisherResult =
    | { status: "touched"; committedFence: Date; activeAt: Date; participantCursors: readonly SessionParticipantCursor[] }
    | { status: "unregistered" }
    | { status: "superseded" }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" };
export type ClosePublisherResult =
    | {
        status: "closed";
        activeAt: Date;
        participantCursors: readonly SessionParticipantCursor[];
        projection?: SessionRuntimeActivityProjection;
        turnProjection?: Readonly<{
            latestTurnId: string | null;
            latestTurnStatus: PrimaryTurnStatusV1 | null;
            latestTurnStatusObservedAt: number | null;
            lastRuntimeIssue: SessionRuntimeIssueV1 | null;
            badgeAttentionChanged: boolean;
        }>;
      }
    | { status: "already_inactive" }
    | { status: "superseded" }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" };
export interface ExplicitMachineStopTarget {
    readonly binding: PublisherBinding;
    readonly committedFence: Date;
}
export type CaptureExplicitMachineStopResult =
    | { status: "captured"; target: ExplicitMachineStopTarget }
    | { status: "already_inactive" }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" };
export type CurrentPublisherResult =
    | {
        status: "current";
        runtimeActivityProjectionRead: StoredSessionRuntimeActivityProjectionResult;
        committedFence: Date;
        sessionUpdatedAt: Date;
      }
    | { status: "unregistered" }
    | { status: "superseded" }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" };

interface Registration {
    binding: PublisherBinding;
    committedFence: Date;
}

interface RegistrationAttempt {
    readonly intentKey: string;
    readonly promise: Promise<RegisterPublisherResult>;
}

function publisherIntentKey(binding: PublisherBinding, snapshot: SessionRuntimeActivitySnapshot): string {
    return JSON.stringify({
        accountId: binding.accountId,
        machineId: binding.machineId,
        sessionId: binding.sessionId,
        state: snapshot.state,
        activeCount: snapshot.activeCount,
    });
}

class RegistrationContentionError extends Error {}

/**
 * How long an explicit stop request stays able to explain a publisher disconnect.
 * Comfortably longer than a stop round trip, far shorter than the presence timeout
 * fence so a stale intent can never close an unrelated later publisher.
 */
const EXPLICIT_STOP_REQUEST_TTL_MS = 2 * 60 * 1000;

/**
 * Read-and-clear the durable stop intent for the disconnect that is being handled.
 * Clearing is unconditional: an intent older than the window no longer explains a
 * disconnect, and leaving it behind would let a much later incidental drop end a
 * session whose runner is alive.
 */
async function consumeExplicitStopRequestInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    stopRequestedAt: Date | null;
    at: Date;
}>): Promise<boolean> {
    if (params.stopRequestedAt === null) return false;
    await params.tx.session.updateMany({
        where: { id: params.sessionId, stopRequestedAt: params.stopRequestedAt },
        data: { stopRequestedAt: null },
    });
    return params.at.getTime() - params.stopRequestedAt.getTime() <= EXPLICIT_STOP_REQUEST_TTL_MS;
}

export function createSessionPublisherPresence(options: Readonly<{ now?: () => Date }> = {}) {
    const now = options.now ?? (() => new Date());
    const registrations = new WeakMap<object, Registration>();
    const registrationAttempts = new WeakMap<object, RegistrationAttempt>();
    const closeResults = new WeakMap<object, Promise<ClosePublisherResult>>();
    const operationTails = new WeakMap<object, Promise<void>>();

    // A stop that never proves physical termination reaches the server only as a publisher
    // disconnect, and with a Redis RPC registry that disconnect can land on a different
    // instance than the accepting call. The intent lives on the session row so it survives
    // the hop from stop request to disconnect.
    const markExplicitStopRequested = async (params: Readonly<{ sessionId: string }>): Promise<void> => {
        const at = now();
        await inTx(async (tx) => {
            await tx.session.updateMany({
                where: { id: params.sessionId },
                data: { stopRequestedAt: at },
            });
        });
    };

    const serialize = async <T>(socket: object, operation: () => Promise<T>): Promise<T> => {
        const prior = operationTails.get(socket) ?? Promise.resolve();
        const result = prior.catch(() => {}).then(operation);
        operationTails.set(socket, result.then(() => {}, () => {}));
        return await result;
    };

    const registerOnce = async (binding: PublisherBinding, completeSnapshot: SessionRuntimeActivitySnapshot): Promise<RegisterPublisherResult> => {
        return await inTx(async (tx): Promise<RegisterPublisherResult> => {
            const session = await tx.session.findUnique({
                where: { id: binding.sessionId },
                select: { archivedAt: true, lastActiveAt: true },
            });
            if (!session) return { status: "rejected", reason: "not_found" };
            if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...binding })) {
                return { status: "rejected", reason: "unauthorized" };
            }
            if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };

            await blockInheritedProviderDeliveryClaims({ tx, sessionId: binding.sessionId });

            const activity = await writeSessionRuntimeActivityProjectionInTx({
                tx,
                sessionId: binding.sessionId,
                completeSnapshot,
            });
            if (activity.status === "rejected") return activity;

            const committedFence = new Date(Math.max(now().getTime(), session.lastActiveAt.getTime() + 1));
            const updated = await tx.session.updateMany({
                where: {
                    id: binding.sessionId,
                    archivedAt: null,
                    lastActiveAt: session.lastActiveAt,
                },
                data: { active: true, lastActiveAt: committedFence },
            });
            if (updated.count === 0) throw new RegistrationContentionError();
            const participantCursors = await markSessionParticipantsChanged({ tx, sessionId: binding.sessionId });
            return { status: "registered", committedFence, activeAt: committedFence, activity, participantCursors };
        });
    };

    const registerWithRetry = async (binding: PublisherBinding, completeSnapshot: SessionRuntimeActivitySnapshot): Promise<RegisterPublisherResult> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await registerOnce(binding, completeSnapshot);
            } catch (error) {
                if (!(error instanceof RegistrationContentionError)) throw error;
            }
        }
        return { status: "rejected", reason: "contention" };
    };

    const registerAndRememberPublisher = async (params: Readonly<{
        socket: object;
        binding: PublisherBinding;
        completeSnapshot: SessionRuntimeActivitySnapshot;
    }>): Promise<RegisterPublisherResult> => {
        const result = await registerWithRetry(params.binding, params.completeSnapshot);
        if (result.status === "registered") {
            registrations.set(params.socket, {
                binding: { ...params.binding },
                committedFence: new Date(result.committedFence.getTime()),
            });
        }
        return result;
    };

    const registerPublisher = async (params: Readonly<{ socket: object; binding: PublisherBinding; completeActivitySnapshot: SessionRuntimeActivitySnapshot | unknown }>): Promise<RegisterPublisherResult> => {
        const completeSnapshot = parseSessionRuntimeActivitySnapshot(params.completeActivitySnapshot);
        const intentKey = publisherIntentKey(params.binding, completeSnapshot);
        const existing = registrationAttempts.get(params.socket);
        if (existing?.intentKey === intentKey) return await existing.promise;
        const attempt = serialize(params.socket, async () => await registerAndRememberPublisher({
            socket: params.socket,
            binding: params.binding,
            completeSnapshot,
        }));
        const registrationAttempt = { intentKey, promise: attempt } satisfies RegistrationAttempt;
        registrationAttempts.set(params.socket, registrationAttempt);
        try {
            const result = await attempt;
            if (result.status === "rejected" && registrationAttempts.get(params.socket) === registrationAttempt) {
                registrationAttempts.delete(params.socket);
            }
            return result;
        } catch (error) {
            if (registrationAttempts.get(params.socket) === registrationAttempt) {
                registrationAttempts.delete(params.socket);
            }
            throw error;
        }
    };

    const closeBindingAtFenceInTx = async (params: Readonly<{
        tx: Tx;
        binding: PublisherBinding;
        committedFence: Date;
        mutationId: string;
    }>): Promise<ClosePublisherResult> => {
        const tx = params.tx;
        const session = await tx.session.findUnique({
            where: { id: params.binding.sessionId },
            select: { active: true, archivedAt: true, lastActiveAt: true },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...params.binding })) {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (session.lastActiveAt.getTime() !== params.committedFence.getTime()) return { status: "superseded" };
        const turnResult = await applyLatestSessionTurnEndInTx({
            tx,
            sessionId: params.binding.sessionId,
            mutationId: params.mutationId,
            observedAt: now().getTime(),
        });
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
            if (updated.count === 0) return { status: "superseded" };
        }
        const participantCursors = await markSessionParticipantsChanged({
            tx,
            sessionId: params.binding.sessionId,
        });
        return {
            status: "closed",
            activeAt: session.lastActiveAt,
            participantCursors,
            ...(activity.status === "applied" ? { projection: activity.projection } : {}),
            ...(turnResult?.didApply
                ? {
                    turnProjection: {
                        latestTurnId: turnResult.latestTurnId,
                        latestTurnStatus: turnResult.latestTurnStatus,
                        latestTurnStatusObservedAt: turnResult.latestTurnStatusObservedAt,
                        lastRuntimeIssue: turnResult.lastRuntimeIssue,
                        badgeAttentionChanged: turnResult.badgeAttentionChanged,
                    },
                }
                : {}),
        };
    };

    const closeBindingAtFence = async (params: Readonly<{
        binding: PublisherBinding;
        committedFence: Date;
        mutationId: string;
    }>): Promise<ClosePublisherResult> => await inTx(
        async (tx) => await closeBindingAtFenceInTx({ tx, ...params }),
    );

    const captureExplicitMachineStop = async (params: Readonly<{
        binding: PublisherBinding;
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

    const finalizeExplicitMachineStop = async (params: Readonly<{
        target: ExplicitMachineStopTarget;
    }>): Promise<ClosePublisherResult> => await closeBindingAtFence({
        binding: params.target.binding,
        committedFence: params.target.committedFence,
        mutationId: `explicit-machine-stop:${params.target.committedFence.getTime()}`,
    });

    const closePublisher = (params: Readonly<{ socket: object }>): Promise<ClosePublisherResult> => {
        const existing = closeResults.get(params.socket);
        if (existing) return existing;
        const result = serialize(params.socket, async (): Promise<ClosePublisherResult> => {
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

    const touchPublisher = async (params: Readonly<{ socket: object }>): Promise<TouchPublisherResult> => {
        return await serialize(params.socket, async (): Promise<TouchPublisherResult> => {
            if (closeResults.has(params.socket)) return { status: "superseded" };
            const registration = registrations.get(params.socket);
            if (!registration) return { status: "unregistered" };
            const result = await inTx(async (tx): Promise<TouchPublisherResult> => {
                const session = await tx.session.findUnique({
                    where: { id: registration.binding.sessionId },
                    select: { active: true, archivedAt: true, lastActiveAt: true },
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
                if (updated.count === 0) return { status: "superseded" };
                const participantCursors = await markSessionParticipantsChanged({
                    tx,
                    sessionId: registration.binding.sessionId,
                });
                return {
                    status: "touched",
                    committedFence,
                    activeAt: committedFence,
                    participantCursors,
                };
            });
            if (result.status === "touched") {
                registrations.set(params.socket, {
                    binding: registration.binding,
                    committedFence: new Date(result.committedFence.getTime()),
                });
            }
            return result;
        });
    };

    const resolveCurrentPublisherOnce = async (params: Readonly<{
        socket: object;
        binding: PublisherBinding;
    }>): Promise<CurrentPublisherResult> => {
        const registration = registrations.get(params.socket);
        if (!registration) return { status: "unregistered" };
        if (
            registration.binding.accountId !== params.binding.accountId
            || registration.binding.machineId !== params.binding.machineId
            || registration.binding.sessionId !== params.binding.sessionId
        ) {
            return { status: "superseded" };
        }
        return await inTx(async (tx): Promise<CurrentPublisherResult> => {
            const session = await tx.session.findUnique({
                where: { id: registration.binding.sessionId },
                select: {
                    active: true,
                    archivedAt: true,
                    lastActiveAt: true,
                    runtimeActivityState: true,
                    runtimeActivityActiveCount: true,
                    runtimeActivityObservedAt: true,
                    runtimeActivityRevision: true,
                    updatedAt: true,
                },
            });
            if (!session) return { status: "rejected", reason: "not_found" };
            if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...registration.binding })) {
                return { status: "rejected", reason: "unauthorized" };
            }
            if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
            if (!session.active || session.lastActiveAt.getTime() !== registration.committedFence.getTime()) {
                return { status: "superseded" };
            }
            return {
                status: "current",
                runtimeActivityProjectionRead: readStoredSessionRuntimeActivityProjectionResult(session),
                committedFence: new Date(registration.committedFence.getTime()),
                sessionUpdatedAt: session.updatedAt,
            };
        });
    };

    const resolveCurrentPublisher = async (params: Readonly<{
        socket: object;
        binding: PublisherBinding;
    }>): Promise<CurrentPublisherResult> => await serialize(
        params.socket,
        async () => await resolveCurrentPublisherOnce(params),
    );

    const runAsCurrentPublisher = async <T>(params: Readonly<{
        socket: object;
        binding: PublisherBinding;
        action: (publisher: Extract<CurrentPublisherResult, { status: "current" }>) => Promise<T>;
    }>): Promise<Exclude<CurrentPublisherResult, { status: "current" }> | { status: "current"; value: T }> => {
        return await serialize(params.socket, async () => {
            const publisher = await resolveCurrentPublisherOnce(params);
            if (publisher.status !== "current") return publisher;
            return { status: "current", value: await params.action(publisher) };
        });
    };

    const publishSnapshotOnce = async (params: Readonly<{
        socket: object;
        binding: PublisherBinding;
        completeSnapshot: SessionRuntimeActivitySnapshot;
    }>) => await serialize(params.socket, async () => {
        const registration = registrations.get(params.socket);
        if (registration) {
            if (registration.binding.sessionId !== params.binding.sessionId) {
                return { status: "rejected", reason: "superseded" } as const;
            }
            return await writeAuthorizedSessionRuntimeActivityProjection({
                ...registration.binding,
                boundCommittedFence: registration.committedFence,
                completeSnapshot: params.completeSnapshot,
            });
        }

        const result = await registerAndRememberPublisher(params);
        if (result.status === "rejected") return result;
        return {
            ...result.activity,
            activeAt: result.activeAt,
            participantCursors: result.participantCursors,
        };
    });
    type SnapshotPublicationResult = Awaited<ReturnType<typeof publishSnapshotOnce>>;
    const snapshotPublicationAttempts = new WeakMap<object, Readonly<{
        intentKey: string;
        promise: Promise<SnapshotPublicationResult>;
    }>>();

    const publishSnapshot = async (params: Readonly<{
        socket: object;
        binding: PublisherBinding;
        completeSnapshot: SessionRuntimeActivitySnapshot | unknown;
    }>): Promise<SnapshotPublicationResult> => {
        const completeSnapshot = parseSessionRuntimeActivitySnapshot(params.completeSnapshot);
        const intentKey = publisherIntentKey(params.binding, completeSnapshot);
        const existing = snapshotPublicationAttempts.get(params.socket);
        if (existing?.intentKey === intentKey) return await existing.promise;

        const promise = publishSnapshotOnce({ ...params, completeSnapshot });
        const attempt = { intentKey, promise } as const;
        snapshotPublicationAttempts.set(params.socket, attempt);
        try {
            return await promise;
        } finally {
            if (snapshotPublicationAttempts.get(params.socket) === attempt) {
                snapshotPublicationAttempts.delete(params.socket);
            }
        }
    };

    return {
        registerPublisher,
        touchPublisher,
        closePublisher,
        captureExplicitMachineStop,
        finalizeExplicitMachineStop,
        resolveCurrentPublisher,
        runAsCurrentPublisher,
        publishSnapshot,
        markExplicitStopRequested,
        forgetDisconnectedPublisher: async (params: Readonly<{ socket: object }>) => await serialize(params.socket, async () => {
            try {
                const registration = registrations.get(params.socket);
                if (!registration) return { status: "unregistered" } as const;
                if (closeResults.has(params.socket)) return { status: "closed" } as const;
                return await inTx(async (tx) => {
                    const session = await tx.session.findUnique({
                        where: { id: registration.binding.sessionId },
                        select: { active: true, archivedAt: true, lastActiveAt: true, stopRequestedAt: true },
                    });
                    if (!session) return { status: "rejected", reason: "not_found" } as const;
                    if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...registration.binding })) {
                        return { status: "rejected", reason: "unauthorized" } as const;
                    }
                    if (session.archivedAt !== null) return { status: "rejected", reason: "archived" } as const;
                    // An explicit stop is an intentional termination, so the disconnect it
                    // produces ends the session now. Without this the row stays active until
                    // the presence timeout fence expires, which blocks archive for that whole
                    // window. A superseded fence means a successor publisher owns the session,
                    // so fall through and only record observer loss.
                    const explicitStopRequested = await consumeExplicitStopRequestInTx({
                        tx,
                        sessionId: registration.binding.sessionId,
                        stopRequestedAt: session.stopRequestedAt,
                        at: now(),
                    });
                    if (explicitStopRequested) {
                        const closed = await closeBindingAtFenceInTx({
                            tx,
                            binding: registration.binding,
                            committedFence: registration.committedFence,
                            mutationId: `explicit-stop-disconnect:${registration.committedFence.getTime()}`,
                        });
                        if (closed.status === "closed") return closed;
                    }
                    if (session.lastActiveAt.getTime() !== registration.committedFence.getTime()) {
                        return { status: "rejected", reason: "superseded" } as const;
                    }
                    const activity = await writeSessionRuntimeActivityProjectionInTx({
                        tx,
                        sessionId: registration.binding.sessionId,
                        completeSnapshot: { state: "unknown", activeCount: 0 },
                    });
                    if (activity.status === "rejected") return activity;
                    const participantCursors = activity.status === "applied"
                        ? await markSessionParticipantsChanged({ tx, sessionId: registration.binding.sessionId })
                        : [];
                    return { ...activity, participantCursors };
                });
            } finally {
                registrations.delete(params.socket);
                registrationAttempts.delete(params.socket);
                closeResults.delete(params.socket);
            }
        }),
    };
}
