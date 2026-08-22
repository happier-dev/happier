import {
    AgentSessionRuntimeEventSchema,
    type AgentSessionRuntimeEvent,
} from '@happier-dev/protocol/runtime';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';

type AgentSessionTurnInvariantDiagnosticCode =
    | 'agent_runtime_event_invalid'
    | 'agent_runtime_event_session_mismatch'
    | 'agent_runtime_event_sequence_stale'
    | 'agent_runtime_event_after_runtime_end'
    | 'agent_runtime_provider_session_conflict'
    | 'agent_runtime_turn_reused'
    | 'agent_runtime_turn_start_without_acceptance'
    | 'agent_runtime_turn_already_active'
    | 'agent_runtime_turn_unknown'
    | 'agent_runtime_turn_not_active'
    | 'agent_runtime_agent_turn_conflict'
    | 'agent_runtime_successor_predecessor_not_terminal'
    | 'agent_runtime_duplicate_terminal'
    | 'agent_runtime_rollback_boundary_terminal_conflict'
    | 'agent_runtime_delivery_turn_conflict'
    | 'agent_runtime_ended_with_active_turn'
    | 'agent_runtime_ended_with_pending_delivery';

export type AgentSessionTurnInvariantDiagnostic = PluginDiagnosticData & Readonly<{
    code: AgentSessionTurnInvariantDiagnosticCode;
    severity: 'error';
    details: Readonly<{
        eventKind: string;
        sequence: number | null;
        turnId?: string;
    }>;
}>;

export type AgentSessionTurnInvariantObservation =
    | Readonly<{ status: 'accepted'; event: AgentSessionRuntimeEvent }>
    | Readonly<{ status: 'ignored'; event: AgentSessionRuntimeEvent }>
    | Readonly<{ status: 'rejected'; diagnostic: AgentSessionTurnInvariantDiagnostic }>;

export type AgentSessionTurnInvariantSnapshot = Readonly<{
    activeTurnId: string | null;
    providerSessionId: string | null;
    runtimeEnded: boolean;
    knownTurnCount: number;
    pendingAcceptedTurnCount: number;
    lastAcceptedSequence: number | null;
}>;

export type AgentSessionTurnInvariant = Readonly<{
    observe(event: unknown): AgentSessionTurnInvariantObservation;
    fence(): void;
    read(): AgentSessionTurnInvariantSnapshot;
}>;

type KnownTurn = {
    agentTurnId: string | null;
    rollbackBoundaryObserved: boolean;
};

function diagnostic(
    code: AgentSessionTurnInvariantDiagnosticCode,
    event: Readonly<{ kind?: unknown; sequence?: unknown; turnId?: unknown }> | null,
): AgentSessionTurnInvariantDiagnostic {
    return Object.freeze({
        code,
        severity: 'error',
        details: Object.freeze({
            eventKind: typeof event?.kind === 'string' ? event.kind : 'invalid',
            sequence: typeof event?.sequence === 'number' ? event.sequence : null,
            ...(typeof event?.turnId === 'string' ? { turnId: event.turnId } : {}),
        }),
    });
}

function isTerminalEvent(event: AgentSessionRuntimeEvent): event is Extract<AgentSessionRuntimeEvent, {
    kind: 'turn-complete' | 'turn-failed' | 'turn-cancelled';
}> {
    return event.kind === 'turn-complete'
        || event.kind === 'turn-failed'
        || event.kind === 'turn-cancelled';
}

function readTurnId(event: AgentSessionRuntimeEvent): string | null {
    return 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : null;
}

function readAgentTurnId(event: AgentSessionRuntimeEvent): string | null {
    return 'agentTurnId' in event && typeof event.agentTurnId === 'string'
        ? event.agentTurnId
        : null;
}

function isTurnScopedEvent(event: AgentSessionRuntimeEvent): boolean {
    if (event.kind === 'transcript-message-committed'
        || event.kind === 'usage-observed'
        || event.kind === 'context-compaction') {
        return readTurnId(event) !== null;
    }
    return event.kind === 'turn-progress'
        || event.kind === 'turn-agent-id-observed'
        || event.kind === 'message-delta'
        || event.kind === 'tool-call'
        || event.kind === 'tool-progress'
        || event.kind === 'tool-result'
        || event.kind === 'file-edit'
        || event.kind === 'turn-rollback-boundary';
}

export function createAgentSessionTurnInvariant(params: Readonly<{
    sessionId: string;
    expectedProviderSessionId?: string;
}>): AgentSessionTurnInvariant {
    const turns = new Map<string, KnownTurn>();
    const pendingAcceptedTurns = new Set<string>();
    let activeTurnId: string | null = null;
    let lastTerminalTurn: Readonly<{
        turnId: string;
        state: KnownTurn;
        completed: boolean;
    }> | null = null;
    let providerSessionId: string | null = null;
    /**
     * The id is only half of what the runtime publishes. It knows its provider
     * session id as soon as the session opens and the path of that session's log
     * only once the conversation materializes, so the path can arrive only as a
     * SAME-ID republish. Deduping on the id alone suppressed exactly that event,
     * and the pair-aware metadata subscriber downstream never saw it.
     */
    let providerSessionNativeLogPath: string | null = null;
    let lastAcceptedSequence: number | null = null;
    let runtimeEnded = false;

    const reject = (
        code: AgentSessionTurnInvariantDiagnosticCode,
        event: AgentSessionRuntimeEvent,
    ): AgentSessionTurnInvariantObservation => ({ status: 'rejected', diagnostic: diagnostic(code, event) });

    const accept = (event: AgentSessionRuntimeEvent): AgentSessionTurnInvariantObservation => {
        lastAcceptedSequence = event.sequence;
        return { status: 'accepted', event };
    };

    const ignore = (event: AgentSessionRuntimeEvent): AgentSessionTurnInvariantObservation => {
        lastAcceptedSequence = event.sequence;
        return { status: 'ignored', event };
    };

    const validateAgentTurnId = (
        turn: KnownTurn,
        event: AgentSessionRuntimeEvent,
    ): AgentSessionTurnInvariantObservation | null => {
        const observed = readAgentTurnId(event);
        if (!observed) return null;
        if (turn.agentTurnId && turn.agentTurnId !== observed) {
            return reject('agent_runtime_agent_turn_conflict', event);
        }
        return null;
    };

    return Object.freeze({
        observe(input): AgentSessionTurnInvariantObservation {
            const parsed = AgentSessionRuntimeEventSchema.safeParse(input);
            if (!parsed.success) {
                const candidate = input && typeof input === 'object'
                    ? input as Readonly<{ kind?: unknown; sequence?: unknown; turnId?: unknown }>
                    : null;
                return { status: 'rejected', diagnostic: diagnostic('agent_runtime_event_invalid', candidate) };
            }
            const event = parsed.data as AgentSessionRuntimeEvent;
            if (event.sessionId !== params.sessionId) {
                return reject('agent_runtime_event_session_mismatch', event);
            }
            if (runtimeEnded) {
                return reject('agent_runtime_event_after_runtime_end', event);
            }
            if (lastAcceptedSequence !== null && event.sequence <= lastAcceptedSequence) {
                return reject('agent_runtime_event_sequence_stale', event);
            }

            if (event.kind === 'provider-session-id') {
                const expected = params.expectedProviderSessionId;
                if ((expected && event.providerSessionId !== expected)
                    || (providerSessionId && event.providerSessionId !== providerSessionId)) {
                    return reject('agent_runtime_provider_session_conflict', event);
                }
                // Dedupe on the matched PAIR, exactly as the metadata
                // subscriber downstream does. Same id AND same log path is a
                // genuine redundant republish; same id with a NEW path is the
                // one event that gives a successor Agent somewhere to read.
                const nativeSessionLogPath = event.nativeSessionLogPath ?? null;
                if (
                    providerSessionId === event.providerSessionId
                    && providerSessionNativeLogPath === nativeSessionLogPath
                ) {
                    return ignore(event);
                }
                providerSessionId = event.providerSessionId;
                providerSessionNativeLogPath = nativeSessionLogPath;
                return accept(event);
            }

            if (event.kind === 'input-accepted') {
                const turnId = event.delivery.turnId;
                if (event.delivery.kind === 'steer') {
                    if (activeTurnId !== turnId) {
                        return reject('agent_runtime_delivery_turn_conflict', event);
                    }
                    return accept(event);
                }
                if (
                    turns.has(turnId)
                    || pendingAcceptedTurns.has(turnId)
                    || lastTerminalTurn?.turnId === turnId
                ) {
                    return reject('agent_runtime_turn_reused', event);
                }
                pendingAcceptedTurns.add(turnId);
                return accept(event);
            }

            if (event.kind === 'input-delivery-failed') {
                const turnId = event.delivery.turnId;
                pendingAcceptedTurns.delete(turnId);
                return accept(event);
            }

            if (event.kind === 'turn-start') {
                if (activeTurnId !== null) {
                    return reject('agent_runtime_turn_already_active', event);
                }
                if (turns.has(event.turnId) || lastTerminalTurn?.turnId === event.turnId) {
                    return reject('agent_runtime_turn_reused', event);
                }
                if (event.startedBy === 'host' && !pendingAcceptedTurns.has(event.turnId)) {
                    return reject('agent_runtime_turn_start_without_acceptance', event);
                }
                if (event.startedBy === 'provider' && pendingAcceptedTurns.has(event.turnId)) {
                    return reject('agent_runtime_delivery_turn_conflict', event);
                }
                if (event.causedByTurnId) {
                    if (event.causedByTurnId !== lastTerminalTurn?.turnId) {
                        return reject('agent_runtime_successor_predecessor_not_terminal', event);
                    }
                }
                pendingAcceptedTurns.delete(event.turnId);
                turns.set(event.turnId, {
                    agentTurnId: readAgentTurnId(event),
                    rollbackBoundaryObserved: false,
                });
                activeTurnId = event.turnId;
                return accept(event);
            }

            if (isTerminalEvent(event)) {
                const turn = turns.get(event.turnId);
                if (!turn) {
                    return reject(
                        lastTerminalTurn?.turnId === event.turnId
                            ? 'agent_runtime_duplicate_terminal'
                            : 'agent_runtime_turn_unknown',
                        event,
                    );
                }
                if (activeTurnId !== event.turnId) return reject('agent_runtime_turn_not_active', event);
                const identityFailure = validateAgentTurnId(turn, event);
                if (identityFailure) return identityFailure;
                if (turn.rollbackBoundaryObserved && event.kind !== 'turn-complete') {
                    return reject('agent_runtime_rollback_boundary_terminal_conflict', event);
                }
                const observedAgentTurnId = readAgentTurnId(event);
                if (!turn.agentTurnId && observedAgentTurnId) turn.agentTurnId = observedAgentTurnId;
                turns.delete(event.turnId);
                lastTerminalTurn = Object.freeze({
                    turnId: event.turnId,
                    state: turn,
                    completed: event.kind === 'turn-complete',
                });
                activeTurnId = null;
                return accept(event);
            }

            if (event.kind === 'runtime-ended') {
                if (activeTurnId !== null) {
                    return reject('agent_runtime_ended_with_active_turn', event);
                }
                if (pendingAcceptedTurns.size > 0) {
                    return reject('agent_runtime_ended_with_pending_delivery', event);
                }
                runtimeEnded = true;
                return accept(event);
            }

            if (isTurnScopedEvent(event)) {
                const turnId = readTurnId(event);
                if (!turnId) return reject('agent_runtime_turn_unknown', event);
                if (lastTerminalTurn?.turnId === turnId) {
                    if (event.kind !== 'turn-rollback-boundary') {
                        return reject('agent_runtime_turn_not_active', event);
                    }
                    if (!lastTerminalTurn.completed) {
                        return reject('agent_runtime_rollback_boundary_terminal_conflict', event);
                    }
                    const identityFailure = validateAgentTurnId(lastTerminalTurn.state, event);
                    if (identityFailure) return identityFailure;
                    if (lastTerminalTurn.state.rollbackBoundaryObserved) {
                        return reject('agent_runtime_turn_reused', event);
                    }
                    const observedAgentTurnId = readAgentTurnId(event);
                    if (!lastTerminalTurn.state.agentTurnId && observedAgentTurnId) {
                        lastTerminalTurn.state.agentTurnId = observedAgentTurnId;
                    }
                    lastTerminalTurn.state.rollbackBoundaryObserved = true;
                    return accept(event);
                }
                const turn = turns.get(turnId);
                if (!turn) return reject('agent_runtime_turn_unknown', event);
                if (activeTurnId !== turnId) return reject('agent_runtime_turn_not_active', event);
                const identityFailure = validateAgentTurnId(turn, event);
                if (identityFailure) return identityFailure;
                const observedAgentTurnId = readAgentTurnId(event);
                if (!turn.agentTurnId && observedAgentTurnId) turn.agentTurnId = observedAgentTurnId;
                if (event.kind === 'turn-rollback-boundary') {
                    if (turn.rollbackBoundaryObserved) {
                        return reject('agent_runtime_turn_reused', event);
                    }
                    turn.rollbackBoundaryObserved = true;
                }
                return accept(event);
            }

            return accept(event);
        },

        fence() {
            runtimeEnded = true;
            activeTurnId = null;
            turns.clear();
            pendingAcceptedTurns.clear();
        },

        read() {
            return Object.freeze({
                activeTurnId,
                providerSessionId,
                runtimeEnded,
                knownTurnCount: turns.size,
                pendingAcceptedTurnCount: pendingAcceptedTurns.size,
                lastAcceptedSequence,
            });
        },
    });
}
