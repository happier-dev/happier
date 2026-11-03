import { SessionRuntimeActivitySnapshotSchema, type SessionRuntimeActivitySnapshot } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { SessionPublisherGenerationV1Schema } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { SessionInputMachineTargetV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { type SessionMetadataPublisherPreconditionV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { type PrimaryTurnStatusV1, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import {
    didSessionActivityBadgeSignalChange,
    type SessionActivityBadgeInputs,
} from "@/app/activity/accountActivityBadge";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import { readCurrentSessionInputMachineTargetInTx } from "@/app/session/messages/sessionInputAdmission";
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { getActivePrismaRuntime } from "@/storage/db";
import { markSessionProjectionRecipientsChanged, type SessionRecipientCursor } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { sessionRecipientPublicationResult, type SessionRecipientPublicationResult } from "@/app/session/changeTracking/sessionRecipientPublicationResult";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import {
    updateSessionRuntimeActivityProjection,
    writeSessionRuntimeActivityObserverLossInTx,
    writeSessionRuntimeActivityProjectionInTx,
    type SessionRuntimeActivityProjectionUpdate,
    type SessionRuntimeActivityProjectionInTxResult,
    applyLatestSessionTurnEndInTx,
} from "@/app/session/sessionWriteService";
import { readExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { inReadSnapshot, inTx, transactionResult } from "@/storage/inTx";
import { afterTx } from '@/storage/inTx';
import { isProjectedSessionStalledV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { resolveActivityStalledEventIdentityV1 } from '@happier-dev/protocol/activity/eventIdentity';
import { listSessionPersonalEventRecipientsInTx } from '@/app/session/personal/eventEligibility';
import { scheduleSessionPersonalEvent } from '@/app/session/personal/publishPersonalEvent';
import { scheduleSessionActivityRemoteAlerts } from '@/app/activity/remoteAlerts/submitSessionActivityRemoteAlerts';
import { isServerFeatureEnabledForHome } from '@/app/features/catalog/serverFeatureGate';
import type { InTxOptions, ResolvedTransactionResult, Tx } from "@/storage/inTx";
import { AsyncLock } from "@/utils/runtime/lock";
import { publishSessionProviderBrokerConsumersChangedInTx, readSessionProviderBrokerCustodianAccountIdsInTx } from '@/app/providers/brokerConsumerChanges';
import { recordWebLatencyPhase, timeWebLatencyPhase } from '@/utils/webLatencyTrace';
import { schedulePresenceDeadline } from './timeout';
import { publishPresenceDeadline } from './presenceRedisQueue';
import {
    mapPendingActivationAuthorization,
    type PendingActivationTarget,
} from "@/app/session/pending/pendingActivationAuthorization";
import {
    readMaterializedEphemeralRunnerBindingStateInTx,
    revokeMaterializedEphemeralRunnerBindingInTx,
} from "@/app/ephemeralRunner/materializedTeardown";

export interface SessionPublisherBinding {
    readonly accountId: string;
    readonly machineId: string;
    readonly sessionId: string;
}

type InstalledMachineTerminalCustody = Readonly<{ installationId: string }>;

/** Process-terminal facts follow committed placement, not the requester's current grant. */
async function hasInstalledMachineTerminalCustodyInTx(tx: Tx, params: Readonly<{
    binding: SessionPublisherBinding;
    installedMachineCustody: InstalledMachineTerminalCustody;
    session: Readonly<{ accountId: string; runtimeMachineTarget: unknown }>;
}>): Promise<boolean> {
    const target = createStoredReadSchema(SessionInputMachineTargetV1Schema).safeParse(params.session.runtimeMachineTarget);
    if (!target.success || target.data.accountId !== params.session.accountId
        || target.data.sessionId !== params.binding.sessionId || target.data.machineId !== params.binding.machineId
        || target.data.installationId !== params.installedMachineCustody.installationId
        || target.data.homeId !== await readCurrentServerIdentityId(process.env, tx)) return false;
    const admission = await resolveMachineAdmissionInTx(tx, {
        actorAccountId: params.binding.accountId, machineId: params.binding.machineId,
    });
    return admission.kind === 'admitted' && admission.custodianAccountId === params.binding.accountId
        && admission.installationId === params.installedMachineCustody.installationId;
}

export type RegisterSessionPublisherResult =
    | {
        status: "registered";
        committedFence: Date;
        publisherGeneration: bigint;
        activeAt: Date;
        activity: Extract<SessionRuntimeActivityProjectionInTxResult, { status: "applied" | "unchanged" }>;
        recipientCursors: readonly SessionRecipientCursor[];
        badgeAttentionChanged: boolean;
        pendingState?: Readonly<{
            pendingCount: number;
            pendingBlockedCount: number;
            pendingVersion: number;
        }>;
      }
    | { status: "rejected"; reason: "invalid-params" | "invalid_storage" | "not_found" | "unauthorized" | "archived" | "revision_overflow" | "contention" };

export type TouchSessionPublisherResult =
    | { status: "touched"; committedFence: Date; activeAt: Date; recipientCursors: readonly SessionRecipientCursor[]; badgeAttentionChanged: boolean }
    | { status: "unregistered" | "superseded" }
    | { status: "stale_observation" }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" };

export type CloseSessionPublisherResult =
    | {
        status: "closed";
        activeAt: Date;
        recipientCursors: readonly SessionRecipientCursor[];
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
    authority:
        | Readonly<{ kind: "generation"; publisherGeneration: bigint }>
        | Readonly<{ kind: "legacy-heartbeat"; committedFence: Date }>;
}>;
export type MachineSessionTerminalTarget = ExplicitMachineStopTarget;
export type CaptureExplicitMachineStopResult =
    | Readonly<{ status: "captured"; target: ExplicitMachineStopTarget }>
    | Readonly<{ status: "already_inactive" }>
    | Readonly<{ status: "rejected"; reason: "not_found" | "machine_control_unavailable" | "archived" }>;

type Registration = Readonly<{
    binding: SessionPublisherBinding;
    committedFence: Date;
    publisherGeneration: bigint;
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
    publisherGeneration: string;
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
    const publisherGeneration = SessionPublisherGenerationV1Schema.safeParse(candidate.publisherGeneration);
    if (
        candidate.v !== 1
        || !accountId
        || !machineId
        || !sessionId
        || typeof committedFenceMs !== "number"
        || !Number.isSafeInteger(committedFenceMs)
        || committedFenceMs < 0
        || !publisherGeneration.success
    ) {
        return null;
    }
    return {
        v: 1,
        accountId,
        machineId,
        sessionId,
        committedFenceMs,
        publisherGeneration: publisherGeneration.data,
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
        publisherGeneration: registration.publisherGeneration.toString(),
    } satisfies SessionPublisherAuthorityProjectionV1;
}

class RegistrationContentionError extends Error {}

const MAX_PUBLISHER_GENERATION = 9_223_372_036_854_775_807n;
type PresenceInTxResult<T> = T | SessionRecipientPublicationResult<T>;

const sessionActivityBadgeSelect = {
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    pendingCount: true,
    pendingBlockedCount: true,
    pendingVersion: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    latestTurnStatus: true,
    lastRuntimeIssue: true,
    active: true,
    archivedAt: true,
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
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
        recipientCursors: readonly SessionRecipientCursor[];
        badgeAttentionChanged: boolean;
        activationHint?: Readonly<{
            activationTarget: PendingActivationTarget;
            pendingCount: number;
            pendingBlockedCount: number;
            pendingVersion: number;
        }>;
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
    return await inTx(async (tx) => {
        await acquireSessionAccountCursorLocksInTx(tx, params.candidates.map(candidate => candidate.sessionId), [], {
            readAdditionalAccountIdsInTx: currentTx => readSessionProviderBrokerCustodianAccountIdsInTx(currentTx,
                params.candidates.map(candidate => candidate.sessionId)),
        });
        const results: PresenceInTxResult<ExpireSessionPublisherResult>[] = [];
        for (const candidate of params.candidates) {
            const session = await tx.session.findUnique({
                where: { id: candidate.sessionId },
                select: { ...sessionActivityBadgeSelect, lastActiveAt: true, latestTurnId: true, updatedAt: true },
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
                data: { active: false, updatedAt: session.updatedAt },
            });
            if (updated.count !== 1) {
                results.push({ status: "stale", sessionId: candidate.sessionId });
                continue;
            }

            await publishSessionProviderBrokerConsumersChangedInTx(tx, candidate.sessionId);
            const recipientCursors = await markSessionProjectionRecipientsChanged({ tx, sessionId: candidate.sessionId });
            // This successful existing CAS is custody of the original stalled
            // transition. Never append a synthetic Message or advance a Follow cursor.
            if (session.latestTurnId && isProjectedSessionStalledV1({ ...session, active: false })
                && await isServerFeatureEnabledForHome('sessions.following', { tx })) {
                const stalledOccurrence = { turnId: session.latestTurnId, publisherFence: candidate.observedFence.getTime() };
                const personal = { sessionId: candidate.sessionId, event: 'source_unavailable' as const,
                    followEvent: { kind: 'stalled' as const } };
                const recipients = await listSessionPersonalEventRecipientsInTx(tx, personal);
                for (const recipient of recipients) scheduleSessionPersonalEvent(tx, recipient.accountId, {
                    type: 'session-personal-event', sessionId: candidate.sessionId,
                    eventId: resolveActivityStalledEventIdentityV1(stalledOccurrence),
                    event: 'source_unavailable', stalledOccurrence,
                });
                afterTx(tx, () => scheduleSessionActivityRemoteAlerts({ ...personal, stalledOccurrence }));
            }
            const authorization = mapPendingActivationAuthorization(session);
            results.push(sessionRecipientPublicationResult({
                status: "expired",
                sessionId: candidate.sessionId,
                activeAt: candidate.observedFence,
                recipientCursors,
                badgeAttentionChanged: didSessionActivityBadgeSignalChange(
                    session satisfies SessionActivityBadgeInputs,
                    { ...session, active: false },
                ),
                ...(authorization?.status === "waiting"
                    ? {
                        activationHint: {
                            activationTarget: {
                                accountId: session.accountId,
                                requestId: authorization.requestId,
                            },
                            pendingCount: session.pendingCount,
                            pendingBlockedCount: session.pendingBlockedCount,
                            pendingVersion: session.pendingVersion,
                        },
                    }
                    : {}),
            }));
        }
        return transactionResult(() => results.map(result => "resolveResult" in result ? result.resolveResult() : result));
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
    const operationLocks = new WeakMap<object, AsyncLock>();

    const rememberRegistration = (socket: object, registration: Registration): void => {
        registrations.set(socket, registration);
        writeSessionPublisherAuthorityProjection(socket, registration);
    };

    const serialize = async <T>(
        socket: object,
        operation: () => Promise<T>,
        options: Readonly<{ deadlineAtMs?: number }> = {},
    ): Promise<T> => {
        let lock = operationLocks.get(socket);
        if (!lock) {
            lock = new AsyncLock();
            operationLocks.set(socket, lock);
        }
        if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return await lock.inLock(operation, options);
        const queuedAt = performance.now();
        return await lock.inLock(async () => {
            recordWebLatencyPhase('session.publisher.queue', performance.now() - queuedAt);
            return await timeWebLatencyPhase('session.publisher.operation', operation);
        }, options);
    };

    const registerOnce = async (
        binding: SessionPublisherBinding,
        snapshot: SessionRuntimeActivitySnapshot,
        observedAt?: Date,
    ): Promise<RegisterSessionPublisherResult> => await inTx(async (tx): Promise<PresenceInTxResult<RegisterSessionPublisherResult>> => {
        await acquireSessionAccountCursorLocksInTx(tx, [binding.sessionId]);
        const session = await tx.session.findUnique({
            where: { id: binding.sessionId },
            select: {
                ...sessionActivityBadgeSelect,
                accountId: true,
                lastActiveAt: true,
                publisherGeneration: true,
            },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...binding })) {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (session.publisherGeneration >= MAX_PUBLISHER_GENERATION) {
            return { status: "rejected", reason: "revision_overflow" };
        }

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
        // Only the retiring host's exact pre-dispatch proof permits reuse of
        // this input. A frozen claim or historical disposal reason is not proof.
        const undispatched = await tx.sessionPendingMessage.updateMany({
            where: {
                sessionId: binding.sessionId,
                targetExecutionRunId: null,
                status: "queued",
                deliveryState: "blocked",
                deliveryBlockedReason: "host_retired_before_dispatch",
            },
            data: { deliveryState: null, deliveryBlockedReason: null, providerAction: null },
        });
        let pendingState: Readonly<{
            pendingCount: number;
            pendingBlockedCount: number;
            pendingVersion: number;
        }> | undefined;
        if (inherited.count > 0 || undispatched.count > 0) {
            const [pendingCount, pendingBlockedCount] = await Promise.all([
                tx.sessionPendingMessage.count({ where: { sessionId: binding.sessionId, targetExecutionRunId: null, status: "queued" } }),
                tx.sessionPendingMessage.count({
                    where: { sessionId: binding.sessionId, targetExecutionRunId: null, status: "queued", deliveryState: "blocked" },
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

        const committedFence = new Date(Math.max((observedAt ?? now()).getTime(), session.lastActiveAt.getTime() + 1));
        const runtimeMachineTarget = await readCurrentSessionInputMachineTargetInTx(tx, binding);
        const publisherGeneration = session.publisherGeneration + 1n;
        const updated = await tx.session.updateMany({
            where: {
                id: binding.sessionId,
                archivedAt: null,
                lastActiveAt: session.lastActiveAt,
                publisherGeneration: session.publisherGeneration,
            },
            data: {
                active: true,
                lastActiveAt: committedFence,
                publisherGeneration,
                publisherGenerationLastActiveAt: committedFence,
                runtimeMachineTarget: runtimeMachineTarget ?? getActivePrismaRuntime().DbNull,
            },
        });
        if (updated.count !== 1) throw new RegistrationContentionError();
        afterTx(tx, () => {
            const observation = { kind: 'session' as const, accountId: binding.accountId,
                id: binding.sessionId, activeAt: committedFence.getTime() };
            schedulePresenceDeadline(observation);
            void publishPresenceDeadline(observation);
        });
        const recipientCursors = await markSessionProjectionRecipientsChanged({ tx, sessionId: binding.sessionId });
        return sessionRecipientPublicationResult({
            status: "registered",
            committedFence,
            publisherGeneration,
            activeAt: committedFence,
            activity,
            recipientCursors,
            badgeAttentionChanged: didSessionActivityBadgeSignalChange(
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
        });
    });

    const registerPublisher = async (params: Readonly<{
        socket: object;
        binding: SessionPublisherBinding;
        completeActivitySnapshot: unknown;
        observedAt?: Date;
    }>): Promise<RegisterSessionPublisherResult> => await serialize(params.socket, async () => {
        const snapshot = parseCompleteSnapshot(params.completeActivitySnapshot);
        if (!snapshot) return { status: "rejected", reason: "invalid-params" };
        const registration = registrations.get(params.socket);
        // A snapshot may have registered this socket after the heartbeat's unregistered touch.
        if (params.observedAt && registration && params.observedAt.getTime() <= registration.committedFence.getTime()) {
            return { status: "rejected", reason: "contention" };
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const result = await registerOnce(params.binding, snapshot, params.observedAt);
                if (result.status === "registered") {
                    rememberRegistration(params.socket, {
                        binding: { ...params.binding },
                        committedFence: new Date(result.committedFence.getTime()),
                        publisherGeneration: result.publisherGeneration,
                    });
                }
                return result;
            } catch (error) {
                if (!(error instanceof RegistrationContentionError)) throw error;
            }
        }
        return { status: "rejected", reason: "contention" };
    });

    const touchPublisher = async (params: Readonly<{ socket: object; observedAt?: Date }>): Promise<TouchSessionPublisherResult> => await serialize(
        params.socket,
        async (): Promise<TouchSessionPublisherResult> => {
            if (closeResults.has(params.socket)) return { status: "superseded" };
            const registration = registrations.get(params.socket);
            if (!registration) return { status: "unregistered" };
            if (params.observedAt && params.observedAt.getTime() <= registration.committedFence.getTime()) {
                return { status: "stale_observation" };
            }
            const result = await inTx(async (tx): Promise<PresenceInTxResult<TouchSessionPublisherResult>> => {
                await acquireSessionAccountCursorLocksInTx(tx, [registration.binding.sessionId]);
                const session = await tx.session.findUnique({
                    where: { id: registration.binding.sessionId },
                    select: {
                        ...sessionActivityBadgeSelect,
                        lastActiveAt: true,
                        publisherGeneration: true,
                        publisherGenerationLastActiveAt: true,
                        updatedAt: true,
                    },
                });
                if (!session) return { status: "rejected", reason: "not_found" };
                if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...registration.binding })) {
                    return { status: "rejected", reason: "unauthorized" };
                }
                if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
                if (
                    session.publisherGeneration !== registration.publisherGeneration
                    || session.lastActiveAt.getTime() !== registration.committedFence.getTime()
                    || session.publisherGenerationLastActiveAt?.getTime() !== registration.committedFence.getTime()
                ) {
                    return { status: "superseded" };
                }
                const committedFence = new Date(Math.max((params.observedAt ?? now()).getTime(), session.lastActiveAt.getTime() + 1));
                const updated = await tx.session.updateMany({
                    where: {
                        id: registration.binding.sessionId,
                        active: session.active,
                        archivedAt: null,
                        lastActiveAt: registration.committedFence,
                        publisherGeneration: registration.publisherGeneration,
                        publisherGenerationLastActiveAt: registration.committedFence,
                    },
                    data: {
                        active: true,
                        lastActiveAt: committedFence,
                        publisherGenerationLastActiveAt: committedFence,
                        updatedAt: session.updatedAt,
                    },
                });
                if (updated.count !== 1) return { status: "superseded" };
                afterTx(tx, () => {
                    const observation = { kind: 'session' as const, accountId: registration.binding.accountId,
                        id: registration.binding.sessionId, activeAt: committedFence.getTime() };
                    schedulePresenceDeadline(observation);
                    if (!session.active) void publishPresenceDeadline(observation);
                });
                const recipientCursors = await markSessionProjectionRecipientsChanged({
                    tx,
                    sessionId: registration.binding.sessionId,
                });
                return sessionRecipientPublicationResult({
                    status: "touched",
                    committedFence,
                    activeAt: committedFence,
                    recipientCursors,
                    badgeAttentionChanged: didSessionActivityBadgeSignalChange(
                        session satisfies SessionActivityBadgeInputs,
                        { ...session, active: true },
                    ),
                });
            });
            if (result.status === "touched") {
                rememberRegistration(params.socket, {
                    binding: registration.binding,
                    committedFence: result.committedFence,
                    publisherGeneration: registration.publisherGeneration,
                });
            }
            return result;
        },
    );

    type PublisherCloseAuthority =
        | Readonly<{ kind: "heartbeat"; committedFence: Date; publisherGeneration: bigint }>
        | Readonly<{ kind: "legacy-heartbeat"; committedFence: Date }>
        | Readonly<{ kind: "generation"; publisherGeneration: bigint }>;

    const closeBinding = async (params: Readonly<{
        binding: SessionPublisherBinding;
        authority: PublisherCloseAuthority;
        mutationId: string;
        settleLatestTurn?: boolean;
        installedMachineCustody?: InstalledMachineTerminalCustody;
    }>): Promise<CloseSessionPublisherResult> => await inTx(async (tx): Promise<PresenceInTxResult<CloseSessionPublisherResult>> => {
        await acquireSessionAccountCursorLocksInTx(tx, [params.binding.sessionId], [], {
            includeLifecyclePublications: params.settleLatestTurn !== false,
            ...(params.settleLatestTurn === false ? {
                readAdditionalAccountIdsInTx: (currentTx: Tx) => readSessionProviderBrokerCustodianAccountIdsInTx(currentTx, [params.binding.sessionId]),
            } : {}),
        });
        const session = await tx.session.findUnique({
            where: { id: params.binding.sessionId },
            select: {
                ...sessionActivityBadgeSelect,
                lastActiveAt: true,
                publisherGeneration: true,
                publisherGenerationLastActiveAt: true,
                runtimeMachineTarget: true,
            },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        const hasInstalledCustody = params.installedMachineCustody !== undefined
            && await hasInstalledMachineTerminalCustodyInTx(tx, {
                binding: params.binding, installedMachineCustody: params.installedMachineCustody, session,
            });
        if (!hasInstalledCustody && session.accountId !== params.binding.accountId) {
            return { status: "rejected", reason: "unauthorized" };
        }
        const hasCurrentBinding = hasInstalledCustody
            || await hasCurrentSessionScopedMachineAccessInTx({ tx, ...params.binding });
        const runnerBindingState = hasCurrentBinding
            ? await readMaterializedEphemeralRunnerBindingStateInTx(tx, params.binding)
            : session.active
                ? "not_runner"
                : await readMaterializedEphemeralRunnerBindingStateInTx(tx, params.binding);
        if (!hasCurrentBinding && runnerBindingState !== "revoked") {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (
            params.authority.kind !== "legacy-heartbeat"
            && session.publisherGeneration !== params.authority.publisherGeneration
        ) {
            return { status: "superseded" };
        }
        if (
            (
                params.authority.kind !== "legacy-heartbeat"
                && session.publisherGenerationLastActiveAt !== null
                && session.publisherGenerationLastActiveAt.getTime() !== session.lastActiveAt.getTime()
            )
            || (
                params.authority.kind !== "generation"
                && session.lastActiveAt.getTime() !== params.authority.committedFence.getTime()
            )
        ) {
            return { status: "superseded" };
        }
        if (!session.active) {
            if (
                params.authority.kind !== "legacy-heartbeat"
                && session.publisherGenerationLastActiveAt !== null
            ) {
                const terminalized = await tx.session.updateMany({
                    where: {
                        id: params.binding.sessionId,
                        active: false,
                        archivedAt: null,
                        lastActiveAt: session.lastActiveAt,
                        publisherGeneration: params.authority.publisherGeneration,
                        publisherGenerationLastActiveAt: session.lastActiveAt,
                    },
                    data: { publisherGenerationLastActiveAt: null },
                });
                if (terminalized.count !== 1) return { status: "superseded" };
            }
            if (runnerBindingState === "current") {
                await revokeMaterializedEphemeralRunnerBindingInTx(tx, params.binding);
            }
            return { status: "already_inactive" };
        }
        const updated = await tx.session.updateMany({
            where: {
                id: params.binding.sessionId,
                active: true,
                archivedAt: null,
                lastActiveAt: params.authority.kind === "generation"
                    ? session.lastActiveAt
                    : params.authority.committedFence,
                ...(params.authority.kind !== "legacy-heartbeat"
                    ? {
                        publisherGeneration: params.authority.publisherGeneration,
                        publisherGenerationLastActiveAt: session.lastActiveAt,
                    }
                    : {}),
            },
            data: {
                active: false,
                ...(params.authority.kind !== "legacy-heartbeat"
                    ? { publisherGenerationLastActiveAt: null }
                    : {}),
            },
        });
        if (updated.count !== 1) return { status: "superseded" };
        await publishSessionProviderBrokerConsumersChangedInTx(tx, params.binding.sessionId);
        if (runnerBindingState === "current") {
            await revokeMaterializedEphemeralRunnerBindingInTx(tx, params.binding);
        }
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
        const recipientCursors = await markSessionProjectionRecipientsChanged({
            tx,
            sessionId: params.binding.sessionId,
        });
        return sessionRecipientPublicationResult({
            status: "closed",
            activeAt: session.lastActiveAt,
            recipientCursors,
            badgeAttentionChanged: (turnResult?.ok === true && turnResult.badgeAttentionChanged)
                || didSessionActivityBadgeSignalChange(
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
        });
    });

    const captureMachineStop = async (params: Readonly<{
        binding: SessionPublisherBinding;
        installedMachineCustody?: InstalledMachineTerminalCustody;
    }>): Promise<CaptureExplicitMachineStopResult> => await inReadSnapshot(async (tx): Promise<CaptureExplicitMachineStopResult> => {
        const session = await tx.session.findUnique({
            where: { id: params.binding.sessionId },
            select: {
                active: true,
                archivedAt: true,
                lastActiveAt: true,
                publisherGeneration: true,
                publisherGenerationLastActiveAt: true,
                accountId: true,
                runtimeMachineTarget: true,
            },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        const hasInstalledCustody = params.installedMachineCustody !== undefined
            && await hasInstalledMachineTerminalCustodyInTx(tx, {
                binding: params.binding, installedMachineCustody: params.installedMachineCustody, session,
            });
        if (!hasInstalledCustody && !await hasCurrentSessionScopedMachineAccessInTx({ tx, ...params.binding })) {
            return { status: "rejected", reason: "machine_control_unavailable" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (
            !session.active
            && await readMaterializedEphemeralRunnerBindingStateInTx(tx, params.binding) !== "current"
        ) {
            return { status: "already_inactive" };
        }
        const authority = session.publisherGeneration > 0n
            && session.publisherGenerationLastActiveAt?.getTime() === session.lastActiveAt.getTime()
            ? {
                kind: "generation" as const,
                publisherGeneration: session.publisherGeneration,
            }
            : {
                kind: "legacy-heartbeat" as const,
                committedFence: new Date(session.lastActiveAt.getTime()),
            };
        return {
            status: "captured",
            target: {
                binding: { ...params.binding },
                authority,
            },
        };
    });

    const captureExplicitMachineStop = (params: Readonly<{ binding: SessionPublisherBinding }>) => captureMachineStop(params);
    const captureMachineSessionTerminal = captureMachineStop;

    const finalizeExplicitMachineStop = async (params: Readonly<{
        target: ExplicitMachineStopTarget;
    }>): Promise<CloseSessionPublisherResult> => await closeBinding({
        binding: params.target.binding,
        authority: params.target.authority,
        mutationId: params.target.authority.kind === "generation"
            ? `explicit-machine-stop:generation:${params.target.authority.publisherGeneration}`
            : `explicit-machine-stop:legacy-heartbeat:${params.target.authority.committedFence.getTime()}`,
    });

    const finalizeMachineSessionTerminal = async (params: Readonly<{
        target: MachineSessionTerminalTarget;
        installedMachineCustody?: InstalledMachineTerminalCustody;
    }>): Promise<CloseSessionPublisherResult> => await closeBinding({
        binding: params.target.binding,
        authority: params.target.authority,
        mutationId: params.target.authority.kind === "generation"
            ? `machine-session-terminal:generation:${params.target.authority.publisherGeneration}`
            : `machine-session-terminal:legacy-heartbeat:${params.target.authority.committedFence.getTime()}`,
        settleLatestTurn: false,
        installedMachineCustody: params.installedMachineCustody,
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
            return await closeBinding({
                binding: registration.binding,
                authority: {
                    kind: "heartbeat",
                    committedFence: registration.committedFence,
                    publisherGeneration: registration.publisherGeneration,
                },
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
                publisherGeneration: result.publisherGeneration,
            });
            return {
                ...result.activity,
                activeAt: result.activeAt,
                recipientCursors: result.recipientCursors,
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

    const runAsCurrentPublisherInTx = async <T>(params: Readonly<{
        socket: object;
        deadlineAtMs?: number;
        prepare?: InTxOptions['prepare'];
        operation: (authority: CurrentSessionPublisherAuthority, tx: Tx) => Promise<T>;
    }> & (
        | Readonly<{ authorityMode?: "serialized"; isolationLevel?: InTxOptions["isolationLevel"] }>
        /** Progress writes recheck publisher authority in this Serializable snapshot,
         * without joining heartbeat/publication writers on the socket lock. */
        | Readonly<{ authorityMode: "snapshot"; isolationLevel: "Serializable" }>
    )): Promise<ResolvedTransactionResult<T> | null> => {
        const operation = async () => {
            const registration = registrations.get(params.socket);
            if (!registration) return null;
            return await inTx(async (tx) => {
                // Snapshot operations do not hold the socket lock. A heartbeat
                // may commit while database admission waits; resolve this
                // registration's current fence inside the transaction rather
                // than treating that same-publisher heartbeat as replacement.
                const currentAuthority = params.authorityMode === 'snapshot'
                    ? await readExactCurrentPublisherAuthorityInTx(tx, {
                        ...registration.binding,
                        publisherGeneration: registration.publisherGeneration,
                    }, registration.binding.accountId, registration.binding.sessionId)
                    : null;
                // An unavailable registration keeps its captured precondition:
                // the consuming guard must retain its own typed refusal.
                return await params.operation(currentAuthority ?? {
                    ...registration.binding,
                    committedFence: new Date(registration.committedFence.getTime()),
                }, tx);
            }, {
                deadlineAtMs: params.deadlineAtMs,
                ...(params.prepare ? { prepare: params.prepare } : {}),
                ...(params.isolationLevel === undefined ? {} : { isolationLevel: params.isolationLevel }),
            });
        };
        return params.authorityMode === "snapshot"
            ? await operation()
            : await serialize(params.socket, operation, { deadlineAtMs: params.deadlineAtMs });
    };

    const readCurrentPublisherPrecondition = async (params: Readonly<{
        socket: object;
    }>): Promise<SessionMetadataPublisherPreconditionV1 | null> =>
      await serialize(params.socket, async () => {
        const registration = registrations.get(params.socket);
        if (!registration) return null;
        // This observation confers no mutation authority. Read access and the
        // exact publisher fence from one snapshot; each consuming mutation
        // independently fences its commit. Joining Account cursor writers here
        // needlessly serializes model publication and first-input readiness.
        const current = await inReadSnapshot(async (tx) =>
            await readExactCurrentPublisherAuthorityInTx(
                tx,
                {
                    ...registration.binding,
                    committedFence: new Date(
                        registration.committedFence.getTime(),
                    ),
                },
                registration.binding.accountId,
                registration.binding.sessionId,
            ));
        return current
          ? {
              machineId: registration.binding.machineId,
              committedFenceMs: registration.committedFence.getTime(),
              publisherGeneration: registration.publisherGeneration.toString(),
            }
          : null;
    });

    const checkCurrentPublisher = async (params: Readonly<{
        socket: object;
    }>): Promise<boolean> =>
      (await readCurrentPublisherPrecondition(params)) !== null;

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
        return await inReadSnapshot(async (tx) => await readExactCurrentPublisherAuthorityInTx(tx, {
            accountId: projection.accountId,
            machineId: projection.machineId,
            sessionId: projection.sessionId,
            publisherGeneration: BigInt(projection.publisherGeneration),
        }, params.expectedAccountId, params.expectedSessionId));
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
                    await acquireSessionAccountCursorLocksInTx(tx, [registration.binding.sessionId]);
                    const session = await tx.session.findUnique({
                        where: { id: registration.binding.sessionId },
                        select: {
                            archivedAt: true,
                            lastActiveAt: true,
                            publisherGeneration: true,
                            publisherGenerationLastActiveAt: true,
                        },
                    });
                    if (!session) return { status: "rejected", reason: "not_found" } as const;
                    if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...registration.binding })) {
                        return { status: "rejected", reason: "unauthorized" } as const;
                    }
                    if (session.archivedAt !== null) return { status: "rejected", reason: "archived" } as const;
                    if (
                        session.publisherGeneration !== registration.publisherGeneration
                        || session.lastActiveAt.getTime() !== registration.committedFence.getTime()
                        || session.publisherGenerationLastActiveAt?.getTime() !== registration.committedFence.getTime()
                    ) {
                        return { status: "rejected", reason: "superseded" } as const;
                    }
                    const activity = await writeSessionRuntimeActivityProjectionInTx({
                        tx,
                        sessionId: registration.binding.sessionId,
                        state: "unknown",
                        activeCount: 0,
                    });
                    if (activity.status === "rejected") return activity;
                    const recipientCursors = activity.status === "applied"
                        ? await markSessionProjectionRecipientsChanged({ tx, sessionId: registration.binding.sessionId })
                        : [];
                    return sessionRecipientPublicationResult({ ...activity, recipientCursors });
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
        runAsCurrentPublisherInTx,
        readCurrentPublisherPrecondition,
        checkCurrentPublisher,
        resolveProjectedCurrentPublisher,
        isCurrentPublisherProjection,
        runAsProjectedCurrentPublisher,
        forgetDisconnectedPublisher,
    };
}
