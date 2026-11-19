import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';
import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionExitSettlementEvidence } from '@/daemon/sessions/resolveTrackedSessionExitSettlementEvidence';
import { probeAdoptableSessionHolder, stopDetachedLocalSessionHolder, type SessionHeldAgentV1 } from '@/subprocess/supervision/sessionHolder';
import { logger } from '@/ui/logger';

/**
 * One runner exit's spare decision. The exit observation either hands the Agent
 * to the respawn owner (`handOff`, right before it asks for a respawn) or, on any
 * other way out of that observation (an early return, a thrown failure), the
 * spared tree is ended (`abandon`). No timer: the observation's own end settles it.
 */
/** Whose held Agent: a Session placed on a target (`managedTargetPlacement`) holds it there. */
export type HeldAgentOwner = Pick<TrackedSession, 'happySessionId' | 'spawnOptions'>;

export type SparedHeldAgentTransaction = Readonly<{
    held: SessionHeldAgentV1;
    /** The turn the Agent is still answering: the respawned runner completes it. */
    turnId: string | null;
    handOff(): void;
    abandon(): Promise<void>;
}>;

/**
 * Custody of a crashed runner's held primary Agent between the runner's exit
 * and its respawn. The exit observation spares the Agent's tree (`resolve`);
 * the respawn owner then either hands it to the new runner (`handOver`, which
 * adopts it) or ends it on every give-up (`end`: no restart, Stop, already
 * running, startup failure, respawn not attempted). An end never retires a live
 * owner of the Session, so a racing replacement keeps the Agent it adopted.
 */
export function createSparedHeldAgentCustody(input: Readonly<{
    ownerRemainder: Pick<OwnerRemainderPort, 'end'>;
    /**
     * Ends the crashed runner's turn the way its exit would have (the exit's
     * exact-turn end), once the spared Agent is ended instead of adopted.
     */
    endTurn: (tracked: Pick<TrackedSession, 'pid' | 'sessionRunnerPid' | 'happySessionId' | 'activeTurnId'>) => Promise<void>;
    probe?: (held: SessionHeldAgentV1) => Promise<boolean>;
    /**
     * A Session placed on a target (`managedTargetPlacement`): its holder and
     * Agent run there, so their pids are the target's. The probe and the end of
     * a spared Agent go through the target's custody; nothing on this Machine is
     * signalled for them.
     */
    target?: Readonly<{
        probe(owner: HeldAgentOwner, held: SessionHeldAgentV1): Promise<boolean>;
        end(tracked: TrackedSession, held: SessionHeldAgentV1): Promise<void>;
        /**
         * Serves a reattached runner's relay again at the address its placement names
         * (the previous daemon's relay ended with it); returns its release, or `null`
         * when the target could not be reached.
         */
        serveRelay?(tracked: TrackedSession, held: SessionHeldAgentV1): Promise<(() => void) | null>;
    }>;
}>) {
    type Spared = Pick<TrackedSession, 'pid' | 'sessionRunnerPid' | 'happySessionId' | 'activeTurnId'>
        & Readonly<{ held: SessionHeldAgentV1; placedOwner: TrackedSession | null }>;
    const spared = new Map<string, Spared>();
    /** Relays served again for runners this daemon reattached, by tracked Session: released when that runner exits. */
    const restoredRelays = new Map<TrackedSession, () => void>();
    const releaseRelay = (tracked: TrackedSession): boolean => {
        const release = restoredRelays.get(tracked);
        restoredRelays.delete(tracked);
        release?.();
        return release !== undefined;
    };
    const probe = input.probe ?? probeAdoptableSessionHolder;
    /**
     * The one answer to "is this held Agent alive?": its holder answers with the recorded holder and
     * Agent identity (PIDs alone are reused, quickly on Windows), through the target for a placed Session.
     */
    const isHeldAgentAlive = async (owner: HeldAgentOwner, held: SessionHeldAgentV1): Promise<boolean> =>
        owner.spawnOptions?.managedTargetPlacement !== undefined
            ? input.target !== undefined && await input.target.probe(owner, held)
            : await probe(held);
    const end = async (sessionId: string): Promise<void> => {
        const turn = spared.get(sessionId);
        if (!turn) return;
        spared.delete(sessionId);
        if (turn.placedOwner) await input.target?.end(turn.placedOwner, turn.held);
        else await stopDetachedLocalSessionHolder(turn.held);
        const result = await input.ownerRemainder.end({ kind: 'session', sessionId });
        logger.infoFile('[DAEMON RUN] Ended the held Agent of a crashed runner that is not respawned', { sessionId, status: result.status, target: Boolean(turn.placedOwner) });
        if (turn.activeTurnId) await input.endTurn(turn);
    };
    return Object.freeze({
        isHeldAgentAlive,
        /**
         * After a daemon restart: a reattached placed runner whose held primary Agent
         * names its relay gets that relay served again, so the runner reaches its target
         * (and stops its Agents through their holders) as before the restart.
         */
        async restoreRelays(trackedSessions: Iterable<TrackedSession>): Promise<void> {
            const serveRelay = input.target?.serveRelay;
            if (!serveRelay) return;
            await Promise.all([...trackedSessions].map(async tracked => {
                const held = tracked.heldAgentsV1?.find(agent => agent.role === 'primary');
                if (!held?.relaySocketPath || !tracked.reattachedFromDiskMarker || !tracked.spawnOptions?.managedTargetPlacement || restoredRelays.has(tracked)) return;
                const release = await serveRelay(tracked, held);
                if (release) restoredRelays.set(tracked, release);
                else logger.warn('[DAEMON RUN] Session target relay not restored for a reattached runner; its target Agent is ended at its exit', { sessionId: tracked.happySessionId });
            }));
        },
        async spare(tracked: TrackedSession): Promise<SparedHeldAgentTransaction | null> {
            // A crashed runner's restored relay ends with it; a respawn places the Session anew.
            releaseRelay(tracked);
            const held = tracked.heldAgentsV1?.find(agent => agent.role === 'primary');
            const sessionId = tracked.happySessionId?.trim();
            const placed = tracked.spawnOptions?.managedTargetPlacement !== undefined;
            if (!held || !sessionId || !await isHeldAgentAlive(tracked, held)) return null;
            const evidence = resolveTrackedSessionExitSettlementEvidence(tracked);
            spared.set(sessionId, { pid: evidence.pid, sessionRunnerPid: evidence.sessionRunnerPid,
                happySessionId: sessionId, activeTurnId: evidence.activeTurnId, held, placedOwner: placed ? tracked : null });
            logger.infoFile('[DAEMON RUN] Sparing the held Agent of a crashed runner for its respawn', { sessionId, pid: tracked.pid });
            let settled = false;
            return Object.freeze({
                held,
                turnId: evidence.activeTurnId ?? null,
                handOff: () => { settled = true; },
                abandon: async () => {
                    if (settled) return;
                    settled = true;
                    await end(sessionId);
                },
            });
        },
        handOver(sessionId: string): void {
            spared.delete(sessionId);
        },
        /**
         * A final runner exit with no spare releases any surviving local primary Agent.
         * A placed Session's runner that this daemon
         * reattached without restoring its relay ran without its placement (relay and authority
         * ended with the previous daemon), so it could not stop its target-held Agent through
         * its holder: that Agent is ended in its target. A runner this daemon placed, or whose
         * relay it restored, stopped its Agents itself (the restored relay is released).
         */
        async endStranded(tracked: TrackedSession): Promise<void> {
            if (releaseRelay(tracked)) return;
            const held = tracked.heldAgentsV1?.find(agent => agent.role === 'primary');
            if (!held) return;
            if (!tracked.spawnOptions?.managedTargetPlacement) {
                await stopDetachedLocalSessionHolder(held);
                return;
            }
            if (!tracked.reattachedFromDiskMarker || !input.target) return;
            await input.target.end(tracked, held);
            logger.infoFile('[DAEMON RUN] Ended the target-held Agent of a reattached runner that left without it', { sessionId: tracked.happySessionId });
        },
        end,
    });
}
