import type {
    AgentRuntimeFactory,
    AgentSessionDisposeReason,
    AgentSessionRuntime,
    AgentSessionRuntimeContext,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

type RuntimeEventInput = AgentSessionRuntimeEvent extends infer Event
    ? Event extends AgentSessionRuntimeEvent
        ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
        : never
    : never;

type ActiveTurn = Readonly<{
    turnId: string;
    controller: AbortController;
}>;

function diagnostic(code: string, message: string) {
    return {
        code,
        severity: 'error' as const,
        message,
    };
}

function cancellationCause(
    reason: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery',
): 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery' {
    return reason;
}

function disposalCause(
    reason: AgentSessionDisposeReason,
): 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery' {
    switch (reason) {
        case 'host_shutdown':
            return 'hostShutdown';
        case 'runtime_recovery':
            return 'runtimeRecovery';
        case 'plugin_deactivated':
        case 'session_closed':
            return 'sessionDispose';
    }
}

function createDeterministicSessionRuntime(
    context: AgentSessionRuntimeContext,
): AgentSessionRuntime {
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    let activeTurn: ActiveTurn | null = null;
    let disposed = false;

    const emit = (event: RuntimeEventInput): void => {
        const published = Object.freeze({
            ...event,
            sequence: ++sequence,
            sessionId: context.session.id,
            emittedAtMs: Date.now(),
        }) as AgentSessionRuntimeEvent;
        for (const listener of Array.from(listeners)) listener(published);
    };

    const cancelActiveTurn = (
        turn: ActiveTurn,
        cause: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery',
    ): void => {
        if (activeTurn !== turn) return;
        activeTurn = null;
        emit({
            kind: 'turn-cancelled',
            turnId: turn.turnId,
            cause,
        });
    };

    const executeTurn = async (turn: ActiveTurn, prompt: string): Promise<void> => {
        try {
            const outcome = await context.services.interactions.confirm({
                kind: 'confirmation',
                title: 'Run deterministic check?',
                message: `Run the deterministic check for: ${prompt}`,
            }, {
                signal: turn.controller.signal,
            });
            if (activeTurn !== turn) return;

            emit({
                kind: 'tool-result',
                turnId: turn.turnId,
                toolCallId: `${turn.turnId}:deterministic-check`,
                output: { status: outcome.status },
            });
            emit({
                kind: 'message-delta',
                turnId: turn.turnId,
                channel: 'assistant',
                text: `Deterministic check ${outcome.status}.`,
            });
            activeTurn = null;
            emit({ kind: 'turn-complete', turnId: turn.turnId });
        } catch {
            if (activeTurn !== turn) return;
            activeTurn = null;
            emit({
                kind: 'turn-failed',
                turnId: turn.turnId,
                diagnostic: diagnostic(
                    'deterministic_session_agent_interaction_failed',
                    'The host interaction could not complete.',
                ),
            });
        }
    };

    return {
        async send(request) {
            if (disposed) {
                return {
                    status: 'unavailable',
                    diagnostic: diagnostic(
                        'deterministic_session_agent_disposed',
                        'The deterministic Session Agent has been disposed.',
                    ),
                    retryable: false,
                };
            }
            if (request.delivery.kind !== 'newTurn') {
                const unsupported = diagnostic(
                    'deterministic_session_agent_delivery_unsupported',
                    'This example accepts only new-turn delivery.',
                );
                emit({
                    kind: 'input-rejected',
                    inputIds: request.inputIds,
                    diagnostic: unsupported,
                    retryable: false,
                });
                return { status: 'unsupported', diagnostic: unsupported, retryable: false };
            }
            if (activeTurn) {
                const busy = diagnostic(
                    'deterministic_session_agent_turn_active',
                    'The deterministic Session Agent is already handling a turn.',
                );
                emit({
                    kind: 'input-rejected',
                    inputIds: request.inputIds,
                    diagnostic: busy,
                    retryable: true,
                });
                return { status: 'rejected', diagnostic: busy, retryable: true };
            }

            const turn: ActiveTurn = {
                turnId: request.delivery.turnId,
                controller: new AbortController(),
            };
            activeTurn = turn;
            emit({
                kind: 'input-accepted',
                inputIds: request.inputIds,
                delivery: request.delivery,
            });
            emit({
                kind: 'turn-start',
                turnId: turn.turnId,
                startedBy: 'host',
            });
            emit({
                kind: 'message-delta',
                turnId: turn.turnId,
                channel: 'reasoning',
                text: 'Preparing the deterministic check.',
            });
            emit({
                kind: 'tool-call',
                turnId: turn.turnId,
                toolCallId: `${turn.turnId}:deterministic-check`,
                toolName: 'deterministic-check',
                input: { prompt: request.input.text },
            });
            void executeTurn(turn, request.input.text);
            return { status: 'admitted' };
        },
        async cancel(request) {
            if (disposed) {
                return {
                    status: 'unavailable',
                    diagnostic: diagnostic(
                        'deterministic_session_agent_disposed',
                        'The deterministic Session Agent has been disposed.',
                    ),
                };
            }
            const turn = activeTurn;
            if (!turn || turn.turnId !== request.turnId) return { status: 'notRunning' };

            turn.controller.abort(request.reason);
            cancelActiveTurn(turn, cancellationCause(request.reason));
            return { status: 'requested', turnId: turn.turnId };
        },
        watch(listener) {
            if (!disposed) listeners.add(listener);
            return {
                dispose() {
                    listeners.delete(listener);
                },
            };
        },
        async dispose(reason = 'session_closed') {
            if (disposed) return;
            disposed = true;
            const turn = activeTurn;
            if (turn) {
                turn.controller.abort(reason);
                cancelActiveTurn(turn, disposalCause(reason));
            }
            listeners.clear();
        },
    };
}

/**
 * The activation entry and the runner leaf export this same factory. It is
 * intentionally free of process-global state because the two can load in
 * different daemon realms.
 */
export const createDeterministicSessionAgentRuntime: AgentRuntimeFactory = () => ({
    sessions: {
        async open(_request, context) {
            return createDeterministicSessionRuntime(context);
        },
    },
});
