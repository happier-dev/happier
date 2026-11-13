import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';
import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionExitSettlementEvidence } from '@/daemon/sessions/resolveTrackedSessionExitSettlementEvidence';
import { probeAdoptableSessionHolder, type SessionHeldAgentV1 } from '@/subprocess/supervision/sessionHolder';
import { logger } from '@/ui/logger';

/**
 * One runner exit's spare decision. The exit observation either hands the Agent
 * to the respawn owner (`handOff`, right before it asks for a respawn) or, on any
 * other way out of that observation (an early return, a thrown failure), the
 * spared tree is ended (`abandon`). No timer: the observation's own end settles it.
 */
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
        probe(tracked: TrackedSession, held: SessionHeldAgentV1): Promise<boolean>;
        end(tracked: TrackedSession, held: SessionHeldAgentV1): Promise<void>;
    }>;
}>) {
    type Spared = Pick<TrackedSession, 'pid' | 'sessionRunnerPid' | 'happySessionId' | 'activeTurnId'>
        & Readonly<{ placed: Readonly<{ tracked: TrackedSession; held: SessionHeldAgentV1 }> | null }>;
    const spared = new Map<string, Spared>();
    const probe = input.probe ?? probeAdoptableSessionHolder;
    const end = async (sessionId: string): Promise<void> => {
        const turn = spared.get(sessionId);
        if (!turn) return;
        spared.delete(sessionId);
        if (turn.placed) await input.target?.end(turn.placed.tracked, turn.placed.held);
        const result = await input.ownerRemainder.end({ kind: 'session', sessionId });
        logger.infoFile('[DAEMON RUN] Ended the held Agent of a crashed runner that is not respawned', { sessionId, status: result.status, target: Boolean(turn.placed) });
        if (turn.activeTurnId) await input.endTurn(turn);
    };
    return Object.freeze({
        async spare(tracked: TrackedSession): Promise<SparedHeldAgentTransaction | null> {
            const held = tracked.heldAgentsV1?.find(agent => agent.role === 'primary');
            const sessionId = tracked.happySessionId?.trim();
            const placed = tracked.spawnOptions?.managedTargetPlacement !== undefined;
            if (!held || !sessionId) return null;
            if (placed ? !input.target || !await input.target.probe(tracked, held) : !await probe(held)) return null;
            const evidence = resolveTrackedSessionExitSettlementEvidence(tracked);
            spared.set(sessionId, { pid: evidence.pid, sessionRunnerPid: evidence.sessionRunnerPid,
                happySessionId: sessionId, activeTurnId: evidence.activeTurnId, placed: placed ? { tracked, held } : null });
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
        end,
    });
}
