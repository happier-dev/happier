import { createHash } from 'node:crypto';

import {
    RuntimeEventV1Schema,
    type RuntimeEventV1,
} from '@happier-dev/protocol';

import type { RuntimeSessionTurnMutationV1 } from '@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';

const DEFAULT_ACTIVE_TURN_TOUCH_INTERVAL_MS = 60_000;
const ACCEPTED_BEGIN_PUBLISH_RETRY_DELAY_MS = 50;

export type SessionTurnLifecycleMutationPort = Readonly<{
    sessionId: string;
    enqueueSessionTurnMutation?: (mutation: RuntimeSessionTurnMutationV1) => void | Promise<void>;
}>;

type SessionTurnLifecycleParams = Readonly<{
    session: SessionTurnLifecycleMutationPort;
    agentId?: string;
    onAcceptedTurnLifecycle?: (input: Readonly<{
        event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
        turnId: string;
        terminalStatus?: 'completed' | 'failed';
    }>) => void | Promise<void>;
}>;

export type SessionTurnLifecycle = Readonly<{
    observeRuntimeEvent(event: RuntimeEventV1): void;
    hasActiveTurn(): boolean;
    drainAcceptedLifecycle(): Promise<void>;
}>;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableMutationId(params: Readonly<{
    sessionId: string;
    action: RuntimeSessionTurnMutationV1['action'];
    event: RuntimeEventV1;
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
    event: RuntimeEventV1;
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
    const knownTurnIds = new Set<string>();
    const terminalStatusByTurnId = new Map<string, 'completed' | 'ineligible'>();
    const pendingRollbackEligibilityByTurnId = new Map<string, RuntimeSessionTurnMutationV1>();
    let acceptedLifecycleTail = Promise.resolve();
    const turnsWithMarkerButNoAcceptedBegin = new Set<string>();

    function isFollowingMutationStillApplicable(mutation: RuntimeSessionTurnMutationV1): boolean {
        return mutation.action !== 'mark_rollback_eligible'
            || terminalStatusByTurnId.get(mutation.turnId) === 'completed';
    }

    async function publishAcceptedBeginMarker(
        lifecycle: Readonly<{
            event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
            turnId: string;
            terminalStatus?: 'completed' | 'failed';
        }>,
    ): Promise<void> {
        for (;;) {
            try {
                await params.onAcceptedTurnLifecycle?.(lifecycle);
                return;
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
        followingMutation?: RuntimeSessionTurnMutationV1,
    ): void {
        const enqueue = params.session.enqueueSessionTurnMutation;
        if (!enqueue) return;

        if (!params.onAcceptedTurnLifecycle) {
            try {
                void Promise.resolve(enqueue(mutation))
                    .then(async () => {
                        if (followingMutation && isFollowingMutationStillApplicable(followingMutation)) {
                            await enqueue(followingMutation);
                        }
                    })
                    .catch(() => undefined);
            } catch {
                // Mutation persistence is best-effort; runtime lifecycle observation must keep progressing.
            }
            return;
        }

        acceptedLifecycleTail = acceptedLifecycleTail.then(async () => {
            const mutationTurnId = 'turnId' in mutation ? mutation.turnId : null;
            if (acceptedLifecycle?.event === 'task_started') {
                await publishAcceptedBeginMarker(acceptedLifecycle);
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
            try {
                await enqueue(mutation);
            } catch {
                return;
            }
            if (!acceptedLifecycle) return;
            try {
                await params.onAcceptedTurnLifecycle?.(acceptedLifecycle);
            } catch {
                // A failed terminal clear safely retains the exact marker. Observed exit
                // settlement can then close the stale turn idempotently.
            }
            if (followingMutation && isFollowingMutationStillApplicable(followingMutation)) {
                try {
                    await enqueue(followingMutation);
                } catch {
                    // Rollback eligibility remains optional when its durable admission fails.
                }
            }
        });
    }

    function hasKnownTurn(turnId: string): boolean {
        return activeTurnId === turnId || knownTurnIds.has(turnId);
    }

    return {
        async drainAcceptedLifecycle() {
            await acceptedLifecycleTail;
        },

        hasActiveTurn() {
            return activeTurnId !== null;
        },

        observeRuntimeEvent(event) {
            if (event.sessionId !== params.session.sessionId) return;

            if (event.kind === 'turn-start') {
                activeTurnId = event.turnId;
                lastActiveTurnTouchAtMs = null;
                knownTurnIds.add(event.turnId);
                terminalStatusByTurnId.delete(event.turnId);
                pendingRollbackEligibilityByTurnId.delete(event.turnId);
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'begin', event }),
                        action: 'begin',
                        turnId: event.turnId,
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
                if (!hasKnownTurn(event.turnId)) return;
                publish({
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'attach_agent_turn_id', event }),
                        action: 'attach_agent_turn_id',
                        turnId: event.turnId,
                        agentTurnId: event.agentTurnId,
                    } satisfies RuntimeSessionTurnMutationV1,
                );
                return;
            }

            if (event.kind === 'turn-input-appended') {
                if (!hasKnownTurn(event.turnId)) return;
                publish({
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'append_transcript_anchors', event }),
                        action: 'append_transcript_anchors',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        transcriptAnchors: {
                            ...(typeof event.userMessageSeq === 'number' ? { userMessageSeqs: [event.userMessageSeq] } : {}),
                        },
                    } satisfies RuntimeSessionTurnMutationV1,
                );
                return;
            }

            if (event.kind === 'turn-complete') {
                if (!hasKnownTurn(event.turnId)) return;
                terminalStatusByTurnId.set(event.turnId, 'completed');
                const rollbackEligibility = pendingRollbackEligibilityByTurnId.get(event.turnId);
                pendingRollbackEligibilityByTurnId.delete(event.turnId);
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'complete', event }),
                        action: 'complete',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'assistant_message_end', turnId: event.turnId, terminalStatus: 'completed' },
                    rollbackEligibility,
                );
                if (activeTurnId === event.turnId) {
                    activeTurnId = null;
                    lastActiveTurnTouchAtMs = null;
                }
                return;
            }

            if (event.kind === 'turn-failed') {
                if (!hasKnownTurn(event.turnId)) return;
                terminalStatusByTurnId.set(event.turnId, 'ineligible');
                pendingRollbackEligibilityByTurnId.delete(event.turnId);
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'fail', event }),
                        action: 'fail',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        issue: event.issue,
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'assistant_message_end', turnId: event.turnId, terminalStatus: 'failed' },
                );
                if (activeTurnId === event.turnId) {
                    activeTurnId = null;
                    lastActiveTurnTouchAtMs = null;
                }
                return;
            }

            if (event.kind === 'turn-cancelled') {
                if (!hasKnownTurn(event.turnId)) return;
                terminalStatusByTurnId.set(event.turnId, 'ineligible');
                pendingRollbackEligibilityByTurnId.delete(event.turnId);
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'cancel', event }),
                        action: 'cancel',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        ...(event.reason ? { reason: event.reason } : {}),
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'turn_cancelled', turnId: event.turnId },
                );
                if (activeTurnId === event.turnId) {
                    activeTurnId = null;
                    lastActiveTurnTouchAtMs = null;
                }
                return;
            }

            if (event.kind === 'turn-rollback-boundary-observed') {
                if (!hasKnownTurn(event.turnId)) return;
                const mutation = {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'mark_rollback_eligible', event }),
                        action: 'mark_rollback_eligible',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        ...(typeof event.agentRollbackOrdinal === 'number'
                            ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
                            : {}),
                        transcriptAnchors: {
                            ...(typeof event.startUserMessageSeq === 'number'
                                ? { startUserMessageSeq: event.startUserMessageSeq }
                                : {}),
                            ...(typeof event.startSeqInclusive === 'number'
                                ? { startSeqInclusive: event.startSeqInclusive }
                                : {}),
                            ...(event.endSeqInclusive !== undefined
                                ? { endSeqInclusive: event.endSeqInclusive }
                                : {}),
                            ...(event.providerCheckpoint !== undefined
                                ? { providerCheckpoint: event.providerCheckpoint }
                                : {}),
                        },
                    } satisfies RuntimeSessionTurnMutationV1;
                const terminalStatus = terminalStatusByTurnId.get(event.turnId);
                if (terminalStatus === 'ineligible') return;
                if (terminalStatus === 'completed') {
                    publish(mutation);
                    return;
                }
                pendingRollbackEligibilityByTurnId.set(event.turnId, mutation);
                return;
            }

            if (event.kind === 'turn-rollback-applied') {
                terminalStatusByTurnId.set(event.turnId, 'ineligible');
                pendingRollbackEligibilityByTurnId.delete(event.turnId);
                publish({
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'mark_rolled_back', event }),
                        action: 'mark_rolled_back',
                        turnId: event.turnId,
                        restoredToTurnId: event.restoredToTurnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        ...(typeof event.agentRollbackOrdinal === 'number'
                            ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
                            : {}),
                    } satisfies RuntimeSessionTurnMutationV1,
                );
                return;
            }

            if (event.kind === 'session-ended') {
                if (!activeTurnId) return;
                terminalStatusByTurnId.set(activeTurnId, 'ineligible');
                pendingRollbackEligibilityByTurnId.delete(activeTurnId);
                activeTurnId = null;
            }
        },
    };
}

export function observeRuntimeMessageForSessionTurnLifecycle(params: Readonly<{
    lifecycle: SessionTurnLifecycle;
    message: unknown;
}>): void {
    const parsed = RuntimeEventV1Schema.safeParse(params.message);
    if (!parsed.success) return;
    params.lifecycle.observeRuntimeEvent(parsed.data);
}
