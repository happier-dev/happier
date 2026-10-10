import { createHash, randomUUID } from 'node:crypto';

import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentSessionRuntimeEvent, SessionRuntimeIssueV1, SessionTurnFactsV1 } from '@happier-dev/protocol';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

import type { RuntimeSessionTurnMutationV1 } from '@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';

const DEFAULT_ACTIVE_TURN_TOUCH_INTERVAL_MS = 60_000;
const ACCEPTED_BEGIN_PUBLISH_RETRY_DELAY_MS = 50;

export type SessionTurnLifecycleMutationPort = Readonly<{
    sessionId: string;
    enqueueSessionTurnMutation?: (
        mutation: RuntimeSessionTurnMutationV1,
    ) => void | Readonly<{ terminalStatusOverride: 'failed' }> | Promise<void | Readonly<{ terminalStatusOverride: 'failed' }>>;
}>;

type SessionTurnLifecycleParams = Readonly<{
    session: SessionTurnLifecycleMutationPort;
    agentId?: string;
    readTurnFacts?: () => SessionTurnFactsV1;
    onTurnFactsChanged?: (input: Readonly<{ turnId: string; facts: SessionTurnFactsV1 | null }>) => void;
    onAcceptedTurnLifecycle?: (input: Readonly<{
        event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
        turnId: string;
        terminalStatus?: 'completed' | 'failed';
    }>) => void | Promise<void>;
}>;

export type SessionTurnLifecycle = Readonly<{
    observeRuntimeEvent(event: AgentSessionRuntimeEvent): void;
    failTurn(input: Readonly<{
        issue: SessionRuntimeIssueV1;
        occurredAt?: number;
        allocateWhenIdle?: boolean;
    }>): Promise<boolean>;
    hasActiveTurn(): boolean;
    retireAcceptedLifecyclePublication(): void;
    drainAcceptedLifecycle(): Promise<void>;
}>;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableMutationId(params: Readonly<{
    sessionId: string;
    action: RuntimeSessionTurnMutationV1['action'];
    event: AgentSessionRuntimeEvent;
}>): string {
    const digest = createHash('sha256')
        .update(JSON.stringify({
            sessionId: params.sessionId,
            action: params.action,
            kind: params.event.kind,
            emittedAtMs: params.event.emittedAtMs,
            turnId: 'turnId' in params.event ? params.event.turnId : null,
            agentTurnId: 'agentTurnId' in params.event ? params.event.agentTurnId ?? null : null,
        }))
        .digest('hex')
        .slice(0, 32);
    return `session-turn-${digest}`;
}

function buildMutationBase(params: Readonly<{
    session: SessionTurnLifecycleMutationPort;
    agentId?: string;
    action: RuntimeSessionTurnMutationV1['action'];
    event: AgentSessionRuntimeEvent;
}>): Pick<RuntimeSessionTurnMutationV1, 'v' | 'sessionId' | 'mutationId' | 'observedAt' | 'agentId'> {
    return {
        v: 1,
        sessionId: params.session.sessionId,
        mutationId: stableMutationId({
            sessionId: params.session.sessionId,
            action: params.action,
            event: params.event,
        }),
        observedAt: params.event.emittedAtMs,
        ...(params.agentId ? { agentId: params.agentId } : {}),
    };
}

export function createSessionTurnLifecycle(params: SessionTurnLifecycleParams): SessionTurnLifecycle {
    let activeTurnId: string | null = null;
    let lastActiveTurnTouchAtMs: number | null = null;
    let acceptedLifecycleTail = Promise.resolve();
    let acceptedLifecyclePublicationRetired = false;
    const turnsWithMarkerButNoAcceptedBegin = new Set<string>();

    async function publishAcceptedBeginMarker(
        lifecycle: Readonly<{
            event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
            turnId: string;
            terminalStatus?: 'completed' | 'failed';
        }>,
    ): Promise<boolean> {
        for (;;) {
            if (acceptedLifecyclePublicationRetired) return false;
            try {
                await params.onAcceptedTurnLifecycle?.(lifecycle);
                return true;
            } catch {
                // Accepted begin identity is marker custody. Retain and retry the serialized
                // obligation instead of allowing cleanup to race a runner exit with no exact id.
                await delay(ACCEPTED_BEGIN_PUBLISH_RETRY_DELAY_MS);
            }
        }
    }

    function publish(
        mutation: RuntimeSessionTurnMutationV1,
        acceptedLifecycle?: Readonly<{
            event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
            turnId: string;
            terminalStatus?: 'completed' | 'failed';
        }>,
    ): void {
        const enqueue = params.session.enqueueSessionTurnMutation;
        if (!enqueue) return;

        if (!params.onAcceptedTurnLifecycle) {
            try {
                const persistence = Promise.resolve(enqueue(mutation))
                    .then(() => undefined, () => undefined);
                acceptedLifecycleTail = Promise.all([acceptedLifecycleTail, persistence])
                    .then(() => undefined);
            } catch {
                // Mutation persistence is best-effort; runtime lifecycle observation must keep progressing.
            }
            return;
        }

        acceptedLifecycleTail = acceptedLifecycleTail.then(async () => {
            const mutationTurnId = 'turnId' in mutation ? mutation.turnId : null;
            if (acceptedLifecycle?.event === 'task_started') {
                const markerPublished = await publishAcceptedBeginMarker(acceptedLifecycle);
                if (!markerPublished) return;
                turnsWithMarkerButNoAcceptedBegin.add(acceptedLifecycle.turnId);
                try {
                    await enqueue(mutation);
                    turnsWithMarkerButNoAcceptedBegin.delete(acceptedLifecycle.turnId);
                } catch {
                    // The durable marker remains exact exit authority. Do not allow later rows or
                    // terminal clear to erase that conservative evidence for this unaccepted begin.
                }
                return;
            }

            if (mutationTurnId && turnsWithMarkerButNoAcceptedBegin.has(mutationTurnId)) {
                return;
            }
            let admission: void | Readonly<{ terminalStatusOverride: 'failed' }>;
            try {
                admission = await enqueue(mutation);
            } catch {
                return;
            }
            if (!acceptedLifecycle) return;
            const acceptedLifecycleAfterAdmission =
                admission?.terminalStatusOverride === 'failed'
                && acceptedLifecycle.event === 'assistant_message_end'
                    ? { ...acceptedLifecycle, terminalStatus: 'failed' as const }
                    : acceptedLifecycle;
            try {
                await params.onAcceptedTurnLifecycle?.(acceptedLifecycleAfterAdmission);
            } catch {
                // A failed terminal clear safely retains the exact marker. Observed exit
                // settlement can then close the stale turn idempotently.
            }
        });
    }

    const lifecycle: SessionTurnLifecycle = {
        retireAcceptedLifecyclePublication() {
            acceptedLifecyclePublicationRetired = true;
        },

        async drainAcceptedLifecycle() {
            await acceptedLifecycleTail;
        },

        hasActiveTurn() {
            return activeTurnId !== null;
        },

        async failTurn(input) {
            if (activeTurnId === null && input.allocateWhenIdle !== true) return false;
            const turnId = activeTurnId ?? `session-turn:${randomUUID()}`;
            const emittedAtMs = typeof input.occurredAt === 'number' && Number.isSafeInteger(input.occurredAt)
                ? input.occurredAt
                : Date.now();
            if (activeTurnId === null) {
                lifecycle.observeRuntimeEvent({
                    sequence: 0,
                    sessionId: params.session.sessionId,
                    emittedAtMs,
                    kind: 'turn-start',
                    turnId,
                    startedBy: 'host',
                });
            }
            lifecycle.observeRuntimeEvent({
                sequence: 1,
                sessionId: params.session.sessionId,
                emittedAtMs,
                kind: 'turn-failed',
                turnId,
                ...(input.issue.agentTurnId ? { agentTurnId: input.issue.agentTurnId } : {}),
                diagnostic: {
                    code: input.issue.code,
                    severity: 'error',
                    ...(input.issue.sanitizedPreview ? { message: input.issue.sanitizedPreview } : {}),
                    details: {
                        v: 1,
                        source: input.issue.source,
                        occurredAt: input.issue.occurredAt,
                        ...(input.issue.agentId ? { agentId: input.issue.agentId } : {}),
                        ...(input.issue.agentTurnId ? { agentTurnId: input.issue.agentTurnId } : {}),
                    },
                },
            });
            await lifecycle.drainAcceptedLifecycle();
            return true;
        },

        observeRuntimeEvent(event) {
            if (event.sessionId !== params.session.sessionId) return;

            if (event.kind === 'turn-start') {
                activeTurnId = event.turnId;
                lastActiveTurnTouchAtMs = null;
                const facts = params.readTurnFacts?.();
                if (facts) params.onTurnFactsChanged?.({ turnId: event.turnId, facts });
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'begin', event }),
                        action: 'begin',
                        turnId: event.turnId,
                        ...facts,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'task_started', turnId: event.turnId },
                );
                return;
            }

            if (event.kind === 'turn-progress') {
                if (activeTurnId !== event.turnId) return;
                if (
                    lastActiveTurnTouchAtMs !== null
                    && event.emittedAtMs - lastActiveTurnTouchAtMs < DEFAULT_ACTIVE_TURN_TOUCH_INTERVAL_MS
                ) {
                    return;
                }
                lastActiveTurnTouchAtMs = event.emittedAtMs;
                publish({
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'touch_active', event }),
                        action: 'touch_active',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                    } satisfies RuntimeSessionTurnMutationV1,
                );
                return;
            }

            if (event.kind === 'turn-agent-id-observed') {
                if (activeTurnId !== event.turnId) return;
                publish({
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'attach_agent_turn_id', event }),
                        action: 'attach_agent_turn_id',
                        turnId: event.turnId,
                        agentTurnId: event.agentTurnId,
                    } satisfies RuntimeSessionTurnMutationV1,
                );
                return;
            }

            if (event.kind === 'turn-complete') {
                if (activeTurnId !== event.turnId) return;
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'complete', event }),
                        action: 'complete',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'assistant_message_end', turnId: event.turnId, terminalStatus: 'completed' },
                );
                if (activeTurnId === event.turnId) {
                    params.onTurnFactsChanged?.({ turnId: event.turnId, facts: null });
                    activeTurnId = null;
                    lastActiveTurnTouchAtMs = null;
                }
                return;
            }

            if (event.kind === 'turn-failed') {
                if (activeTurnId !== event.turnId) return;
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'fail', event }),
                        action: 'fail',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        issue: classifyPrimarySessionRuntimeIssue({
                            provider: params.agentId,
                            cause: 'session_error',
                            error: event.diagnostic,
                            occurredAt: event.emittedAtMs,
                            ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        }),
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'assistant_message_end', turnId: event.turnId, terminalStatus: 'failed' },
                );
                if (activeTurnId === event.turnId) {
                    params.onTurnFactsChanged?.({ turnId: event.turnId, facts: null });
                    activeTurnId = null;
                    lastActiveTurnTouchAtMs = null;
                }
                return;
            }

            if (event.kind === 'turn-cancelled') {
                if (activeTurnId !== event.turnId) return;
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'cancel', event }),
                        action: 'cancel',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        reason: event.cause,
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'turn_cancelled', turnId: event.turnId },
                );
                if (activeTurnId === event.turnId) {
                    params.onTurnFactsChanged?.({ turnId: event.turnId, facts: null });
                    activeTurnId = null;
                    lastActiveTurnTouchAtMs = null;
                }
                return;
            }

            if (event.kind === 'runtime-ended') {
                if (!activeTurnId) return;
                params.onTurnFactsChanged?.({ turnId: activeTurnId, facts: null });
                activeTurnId = null;
            }
        },
    };
    return lifecycle;
}

export function observeRuntimeMessageForSessionTurnLifecycle(params: Readonly<{
    lifecycle: SessionTurnLifecycle;
    message: unknown;
}>): void {
    const parsed = AgentSessionRuntimeEventSchema.safeParse(params.message);
    if (!parsed.success) return;
    params.lifecycle.observeRuntimeEvent(parsed.data);
}
