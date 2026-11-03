import { isPersistentMachine, type MachineKind } from '@happier-dev/protocol/machines/machineKind';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

import { db } from "@/storage/db";
import { shutdownSignal } from "@/utils/process/shutdown";
import {
    buildMachineActivityEphemeral,
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { warn } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { refreshTrackedSessionAccountBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { expireSessionPublisherCandidates } from "./sessionPublisherPresence";
import { emitPendingActivationHint } from "@/app/session/pending/publishPendingMutation";
import { submitMachineRemoteAlerts } from '@/app/activity/remoteAlerts/submitMachineRemoteAlerts';
import { lockMachinePresenceInTx, markMachinePresenceInactive } from './persistMachinePresence';
import { inTx } from '@/storage/inTx';
import { resolveCurrentMachineRecipientAccountIdsInTx } from '@/app/machines/machineAccess';
import type { PresenceDeadlineNotification } from './presenceDeadlineNotification';
import { retainMachinePresenceTransitionInTx } from './machinePresenceTransitions';
import { withWebLatencyProducerTrace } from '@/utils/webLatencyTrace';

export interface PresenceTimeoutConfig {
    sessionTimeoutMs: number;
    machineTimeoutMs: number;
    tickMs: number;
}

export function resolvePresenceTimeoutConfig(env: NodeJS.ProcessEnv = process.env): PresenceTimeoutConfig {
    return {
        sessionTimeoutMs: readServerConfig(env, SERVER_CONFIG.HAPPIER_PRESENCE_SESSION_TIMEOUT_MS),
        machineTimeoutMs: readServerConfig(env, SERVER_CONFIG.HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS),
        tickMs: readServerConfig(env, SERVER_CONFIG.HAPPIER_PRESENCE_TIMEOUT_TICK_MS),
    };
}

export function isSessionPresenceFresh(input: Readonly<{
    active: boolean | null | undefined;
    lastActiveAt: Date | null | undefined;
    nowMs: number;
    timeoutMs?: number;
}>): boolean {
    const timeoutMs = input.timeoutMs ?? resolvePresenceTimeoutConfig().sessionTimeoutMs;
    return input.active === true
        && input.lastActiveAt instanceof Date
        && Number.isFinite(input.lastActiveAt.getTime())
        && input.lastActiveAt.getTime() + timeoutMs > input.nowMs;
}

type TimedOutPresenceCandidate = {
    id: string;
    accountId: string;
    lastActiveAt: Date;
    kind?: MachineKind;
};
type MachinePresenceObservation = Readonly<{ accountId: string; machineId: string; lastActiveAt: Date }>;

async function publishInactiveMachines(machines: Array<TimedOutPresenceCandidate & { recipientAccountIds: string[] }>): Promise<void> {
    for (const machine of machines) {
        // Runner presence belongs to its Session, not broad Machine inventory.
        if (!isPersistentMachine(machine)) continue;
        for (const accountId of machine.recipientAccountIds) eventRouter.emitEphemeral({
            userId: accountId,
            payload: buildMachineActivityEphemeral(machine.id, false, machine.lastActiveAt.getTime()),
            recipientFilter: { type: 'user-scoped-only' },
        });
    }
    await submitMachineRemoteAlerts({ machines: machines.map(machine => ({ machineId: machine.id, accountId: machine.accountId })), phase: 'offline' });
}

/** One real deadline per observed Machine; peer renewals are read at expiry. */
export function createMachinePresenceDeadlineOwner(timeoutMs = resolvePresenceTimeoutConfig().machineTimeoutMs) {
    const timers = new Map<string, { deadline: number; timer: NodeJS.Timeout }>();
    const inFlight = new Set<Promise<void>>();
    let stopped = false;
    const schedule = (observation: MachinePresenceObservation, retryAtMs?: number, committed = false): void => {
        if (stopped) return;
        const timestamp = observation.lastActiveAt.getTime();
        const deadline = retryAtMs ?? timestamp + timeoutMs;
        const current = timers.get(observation.machineId);
        // A local committed observation supplies its next real deadline.
        // Bootstrap and peer enrollment may describe a retired row, so those
        // hints can only bring validation forward, never postpone it.
        if (current && (committed ? current.deadline === deadline : current.deadline <= deadline)) return;
        if (current) clearTimeout(current.timer);
        const timer = setTimeout(() => {
            timers.delete(observation.machineId);
            let databaseSettled = false;
            const expiry = withWebLatencyProducerTrace('producer.machine-presence-deadline', async () => {
                // Bootstrap and peer timers do not receive every committed beat.
                // A renewed observation needs one read, without taking a writer
                // lock or opening an expiry transaction. Actual expiry still
                // reads under the same row lock as the canonical presence writer.
                const observed = await db.machine.findUnique({ where: { id: observation.machineId },
                    select: { id: true, accountId: true, active: true, lastActiveAt: true,
                        revokedAt: true, replacedByMachineId: true } });
                if (!observed || !observed.active || observed.revokedAt || observed.replacedByMachineId) return null;
                if (observed.lastActiveAt.getTime() + timeoutMs > Date.now()) return { kind: 'renewed' as const, machine: observed };
                return inTx(async tx => {
                    const machine = await lockMachinePresenceInTx(tx, observation.machineId);
                    if (!machine || !machine.active
                        || machine.revokedAt || machine.replacedByMachineId) return null;
                    if (machine.lastActiveAt.getTime() + timeoutMs > Date.now()) return { kind: 'renewed' as const, machine };
                    if (await markMachinePresenceInactive(tx, { accountId: machine.accountId, machineId: machine.id,
                        lastActiveAt: machine.lastActiveAt }) !== 1) return null;
                    const recipientAccountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, machine.id);
                    await retainMachinePresenceTransitionInTx(tx, { machineId: machine.id, active: false,
                        occurredAt: Date.now(), recipientAccountIds });
                    return { kind: 'expired' as const, machine: { ...machine,
                        recipientAccountIds } };
                });
            }).then(async result => {
                // A publication failure after commit is deliberately not
                // replayed. Only an uncommitted SQL deadline retains custody.
                databaseSettled = true;
                if (result?.kind === 'renewed') schedule({ accountId: result.machine.accountId,
                    machineId: result.machine.id, lastActiveAt: result.machine.lastActiveAt });
                else if (result?.kind === 'expired') await publishInactiveMachines([result.machine]);
            });
            inFlight.add(expiry);
            void expiry.catch(error => {
                warn({ module: 'presence-timeout', error }, 'Machine deadline failed');
                if (!databaseSettled) schedule(observation, Date.now() + resolvePresenceTimeoutConfig().tickMs);
            })
                .finally(() => { inFlight.delete(expiry); });
            return expiry;
        // Node's native timer range; a longer stored future observation is re-read at the next wake.
        }, Math.max(0, Math.min(2_147_483_647, deadline - Date.now())));
        timer.unref?.();
        timers.set(observation.machineId, { deadline, timer });
    };
    return {
        schedule(observation: MachinePresenceObservation): void { schedule(observation); },
        renew(observation: MachinePresenceObservation): void { schedule(observation, undefined, true); },
        async start(): Promise<void> {
            const machines = await db.machine.findMany({ where: { active: true, revokedAt: null, replacedByMachineId: null },
                select: { id: true, accountId: true, lastActiveAt: true } });
            for (const machine of machines) schedule({ ...machine, machineId: machine.id });
        },
        async stop(): Promise<void> {
            stopped = true;
            for (const { timer } of timers.values()) clearTimeout(timer);
            timers.clear();
            await Promise.allSettled([...inFlight]);
        },
    };
}

let localMachineDeadlineOwner: ReturnType<typeof createMachinePresenceDeadlineOwner> | null = null;
export function scheduleLocalMachinePresenceDeadline(observation: MachinePresenceObservation): void {
    if (shutdownSignal.aborted) return;
    localMachineDeadlineOwner ??= createMachinePresenceDeadlineOwner();
    localMachineDeadlineOwner.schedule(observation);
}
/** Only the canonical presence writer calls this after its observation commits. */
export function renewLocalMachinePresenceDeadline(observation: MachinePresenceObservation): void {
    if (shutdownSignal.aborted) return;
    localMachineDeadlineOwner ??= createMachinePresenceDeadlineOwner();
    localMachineDeadlineOwner.renew(observation);
}
export async function startLocalMachinePresenceTimeout(): Promise<{ stop(): Promise<void> }> {
    const owner = localMachineDeadlineOwner ??= createMachinePresenceDeadlineOwner();
    await owner.start();
    return { stop: stopLocalMachinePresenceTimeout };
}
export async function stopLocalMachinePresenceTimeout(): Promise<void> {
    const owner = localMachineDeadlineOwner;
    if (!owner) return;
    await owner.stop();
    if (localMachineDeadlineOwner === owner) localMachineDeadlineOwner = null;
}

/** Session batching retains the publisher's lifecycle effects; Machines never scan. */
export async function runPresenceTimeoutTick(timeoutConfig: PresenceTimeoutConfig): Promise<void> {
    try {
        const sessions = await db.session.findMany({
            where: {
                active: true,
                archivedAt: null,
                lastActiveAt: {
                    lte: new Date(Date.now() - timeoutConfig.sessionTimeoutMs)
                }
            },
            select: { id: true, accountId: true, lastActiveAt: true },
        });
        const candidateBySessionId = new Map(sessions.map((session) => [session.id, session]));
        const expiryResults = await expireSessionPublisherCandidates({
            candidates: sessions.map((session) => ({
                sessionId: session.id,
                observedFence: session.lastActiveAt,
            })),
        });
        for (const result of expiryResults) {
            if (result.status !== "expired") continue;
            const session = await loadSessionTranscriptPublicationRecipientProjection(result.sessionId);
            if (session) {
                for (const { accountId, cursor } of result.recipientCursors) {
                    const projection = projectSessionTranscriptPublicationRealtimeProjection(
                        { active: false, activeAt: result.activeAt.getTime() },
                        session,
                        accountId,
                    );
                    if (projection.kind === "suppress") continue;
                    eventRouter.emitUpdate({
                        userId: accountId,
                        payload: buildUpdateSessionUpdate(
                            result.sessionId,
                            cursor,
                            randomKeyNaked(12),
                            undefined,
                            undefined,
                            projection.value,
                        ),
                        recipientFilter: { type: "all-interested-in-session", sessionId: result.sessionId },
                    });
                }
            }
            await refreshTrackedSessionAccountBadgePushes({
                badgeAttentionChanged: result.badgeAttentionChanged,
                sessionId: result.sessionId,
            });
            if (result.activationHint) {
                await emitPendingActivationHint({
                    sessionId: result.sessionId,
                    changedByAccountId: result.activationHint.activationTarget.accountId,
                    pendingCount: result.activationHint.pendingCount,
                    pendingBlockedCount: result.activationHint.pendingBlockedCount,
                    pendingVersion: result.activationHint.pendingVersion,
                    recipientCursors: [...result.recipientCursors],
                    activationTarget: result.activationHint.activationTarget,
                });
            }
            const candidate = candidateBySessionId.get(result.sessionId);
            if (!candidate) continue;
            eventRouter.emitEphemeral({
                userId: candidate.accountId,
                payload: buildSessionActivityEphemeral(result.sessionId, false, result.activeAt.getTime(), false),
                recipientFilter: { type: 'user-scoped-only' }
            });
        }
    } catch (error) {
        if (!isRetryableSqliteWriteError(error)) throw error;
        warn({ module: "presence-timeout", error }, "Transient DB error while timing out sessions");
        throw error;
    }

}

/** One next-due Session wake, parked when empty, not a periodic census. */
export function createSessionPresenceDeadlineOwner(config = resolvePresenceTimeoutConfig()) {
    let timer: NodeJS.Timeout | null = null;
    let deadline = Number.POSITIVE_INFINITY;
    let stopped = false;
    const inFlight = new Set<Promise<void>>();
    const scheduleAt = (next: number): void => {
        if (stopped || timer && deadline <= next) return;
        if (timer) clearTimeout(timer);
        deadline = next;
        timer = setTimeout(() => {
            timer = null;
            deadline = Number.POSITIVE_INFINITY;
            const expiry = runPresenceTimeoutTick(config).then(seed).catch(error => {
                warn({ module: 'presence-timeout', error }, 'Session deadline failed');
                scheduleAt(Date.now() + config.tickMs);
            }).finally(() => { inFlight.delete(expiry); });
            inFlight.add(expiry);
            return expiry;
        }, Math.max(0, Math.min(2_147_483_647, next - Date.now())));
        timer.unref?.();
    };
    const seed = async (): Promise<void> => {
        if (stopped) return;
        const next = await db.session.findFirst({ where: { active: true, archivedAt: null },
            orderBy: { lastActiveAt: 'asc' }, select: { lastActiveAt: true } });
        if (next) scheduleAt(next.lastActiveAt.getTime() + config.sessionTimeoutMs);
    };
    return {
        schedule(lastActiveAt: Date): void { scheduleAt(lastActiveAt.getTime() + config.sessionTimeoutMs); },
        start: seed,
        async stop(): Promise<void> {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            await Promise.allSettled([...inFlight]);
        },
    };
}

let sessionDeadlineOwner: ReturnType<typeof createSessionPresenceDeadlineOwner> | null = null;

/** Notifications enroll deadlines only; locked persisted rows decide expiry. */
export function schedulePresenceDeadline(observation: PresenceDeadlineNotification): void {
    if (shutdownSignal.aborted) return;
    const lastActiveAt = new Date(observation.activeAt);
    if (observation.kind === 'machine') scheduleLocalMachinePresenceDeadline({
        accountId: observation.accountId, machineId: observation.id, lastActiveAt,
    });
    else sessionDeadlineOwner?.schedule(lastActiveAt);
}

/** Prepare before listening; seed only after the realtime transport is ready. */
export function preparePresenceTimeouts(): { start(): Promise<void>; stop(): Promise<void> } {
    const machines = localMachineDeadlineOwner ??= createMachinePresenceDeadlineOwner();
    const sessions = sessionDeadlineOwner ??= createSessionPresenceDeadlineOwner();
    return {
        async start() { await Promise.all([machines.start(), sessions.start()]); },
        async stop() {
            await Promise.all([stopLocalMachinePresenceTimeout(), sessions.stop()]);
            if (sessionDeadlineOwner === sessions) sessionDeadlineOwner = null;
        },
    };
}
