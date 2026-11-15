import type { SessionBrokerApplicationFailureEvidence } from '@/providers/broker/sessionBrokerApplicationEvidence';
import { createHash, randomUUID } from 'node:crypto';

import type { SessionTurnProgressV1 } from '@happier-dev/protocol/sessions/state/valueSchemas/turnProgress';
import { isForegroundTurnRuntimeTranscriptEvent } from '../events/runtimeTranscriptScope';
import type { AgentSessionRuntimeEvent, SessionRuntimeIssueV1, SessionTurnFactsV1 } from '@happier-dev/protocol';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { logger } from '@/ui/logger';

import type { RuntimeSessionTurnMutationV1 } from '@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import type { RuntimeRollbackBoundaryObservation } from '@/agent/runtime/turns/runtimeTurnOperations';

const DEFAULT_ACTIVE_TURN_TOUCH_INTERVAL_MS = 60_000;

export type SessionTurnLifecycleMutationPort = Readonly<{
    sessionId: string;
    readQuestionWaitTurnId?: () => string | null;
    enqueueSessionTurnMutation?: (
        mutation: RuntimeSessionTurnMutationV1,
    ) => void | Readonly<{ terminalStatusOverride: 'failed' }> | Promise<void | Readonly<{ terminalStatusOverride: 'failed' }>>;
}>;

type SessionTurnLifecycleParams = Readonly<{
    session: SessionTurnLifecycleMutationPort;
    agentId?: string;
    readTurnFacts?: () => SessionTurnFactsV1;
    /** Exact native start cause, not the mutable active input of a later steer. */
    readStartingInput?: (turnId: string) => Readonly<{ inputId: string; turnId: string }> | null;
    readTeamCredentialFailureEvidence?: (turnId: string) => Promise<SessionBrokerApplicationFailureEvidence | null>;
    onTurnFactsChanged?: (input: Readonly<{ turnId: string; facts: SessionTurnFactsV1 | null }>) => void;
    onTurnProgressChanged?: (input: Readonly<{ progress: SessionTurnProgressV1 | null; observedAt: number }>) => void;
    onAcceptedTurnFailure?: (event: Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>, issue: SessionRuntimeIssueV1) => Promise<void>;
    onAcceptedTurnLifecycle?: (input: Readonly<{
        event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
        turnId: string;
        terminalStatus?: 'completed' | 'failed';
    }>) => void | Promise<void>;
}>;

export type SessionTurnLifecycle = Readonly<{
    confirmSessionOpened(): Promise<void>;
    observeRuntimeEvent(event: AgentSessionRuntimeEvent): void;
    observeRollbackBoundary(input: RuntimeRollbackBoundaryObservation): void;
    failTurn(input: Readonly<{
        issue: SessionRuntimeIssueV1;
        occurredAt?: number;
        allocateWhenIdle?: boolean;
    }>): Promise<boolean>;
    hasActiveTurn(): boolean;
    dispose(): void;
    retireAcceptedLifecyclePublication(): void;
    drainAcceptedLifecycle(): Promise<void>;
}>;

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
    // Unknown until first observation: remove any fact retained from a prior runner.
    let turnProgress: SessionTurnProgressV1 | null | undefined;
    let acceptedLifecycleTail = Promise.resolve();
    let acceptedLifecyclePublicationRetired = false;
    const turnsWithoutAcceptedBegin = new Set<string>();

    function projectTurnProgress(progress: SessionTurnProgressV1 | null, observedAt: number): void {
        if (turnProgress === progress || (turnProgress && progress
            && turnProgress.turnId === progress.turnId && turnProgress.phase === progress.phase
            && turnProgress.attempt === progress.attempt && turnProgress.reason === progress.reason)) return;
        turnProgress = progress;
        try {
            params.onTurnProgressChanged?.({ progress, observedAt });
        } catch {
            // Presentation persistence cannot acquire or delay turn ownership.
            logger.debug('[session-turn] Progress projection unavailable');
        }
    }

    function recordPublicationFailure(
        mutation: RuntimeSessionTurnMutationV1,
        reason: 'mutation_failed' | 'marker_failed',
    ): void {
        if (!['begin', 'complete', 'fail', 'cancel', 'wait'].includes(mutation.action) || !('turnId' in mutation)) return;
        try {
            logger.infoFile('[provider-broker-application]', { stage: 'turn_publication',
                sessionId: params.session.sessionId, turnId: mutation.turnId, pid: process.pid,
                action: mutation.action, outcome: 'failed', reason });
        } catch { /* Diagnostics cannot change lifecycle custody. */ }
    }

    async function publishAcceptedBeginMarker(
        lifecycle: Readonly<{
            event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
            turnId: string;
            terminalStatus?: 'completed' | 'failed';
        }>,
        mutation: RuntimeSessionTurnMutationV1,
    ): Promise<boolean> {
        if (acceptedLifecyclePublicationRetired) return false;
        try {
            await params.onAcceptedTurnLifecycle?.(lifecycle);
            return true;
        } catch {
            recordPublicationFailure(mutation, 'marker_failed');
            return false;
        }
    }

    function publish(
        mutation: RuntimeSessionTurnMutationV1,
        acceptedLifecycle?: Readonly<{
            event: 'task_started' | 'assistant_message_end' | 'turn_cancelled';
            turnId: string;
            terminalStatus?: 'completed' | 'failed';
        }>,
        failedEvent?: Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>,
    ): void {
        const enqueue = params.session.enqueueSessionTurnMutation;
        if (!enqueue) return;
        const enqueueResolvedMutation = async () => {
            const recordEnrichment = (outcome: 'applied' | 'skipped', reason?: 'evidence_absent') => {
                if (!('turnId' in mutation)) return;
                try {
                    logger.infoFile('[provider-broker-application]', { stage: 'failure_enrichment',
                        sessionId: params.session.sessionId, turnId: mutation.turnId, pid: process.pid,
                        outcome, ...(reason ? { reason } : {}) });
                } catch { /* Diagnostics cannot suppress a terminal outcome. */ }
            };
            if (mutation.action === 'fail' && params.readTeamCredentialFailureEvidence) {
                try {
                    const evidence = await params.readTeamCredentialFailureEvidence(mutation.turnId);
                    const denial = evidence?.denial;
                    if (denial) mutation = { ...mutation, issue: classifyPrimarySessionRuntimeIssue({
                        provider: params.agentId, cause: 'session_error', error: failedEvent?.diagnostic,
                        occurredAt: mutation.issue.occurredAt, agentTurnId: mutation.issue.agentTurnId,
                        teamCredentialDenial: denial,
                    }) };
                    if (evidence?.carrierFailure) mutation = { ...mutation, issue: { ...mutation.issue,
                        failureCause: { phase: 'turn', failureReason: 'unknown', ...mutation.issue.failureCause,
                            carrierFailure: evidence.carrierFailure },
                    } };
                    const applied = !!denial || !!evidence?.carrierFailure;
                    recordEnrichment(applied ? 'applied' : 'skipped', applied ? undefined : 'evidence_absent');
                } catch {
                    // A failed evidence read cannot suppress the native terminal outcome.
                    logger.debug('[session-turn] Broker refusal evidence unavailable');
                    recordEnrichment('skipped', 'evidence_absent');
                }
            }
            return await enqueue.call(params.session, mutation);
        };

        if (!params.onAcceptedTurnLifecycle) {
            acceptedLifecycleTail = acceptedLifecycleTail.then(async () => {
                try {
                    // Construction has no daemon turn-marker callback, but its
                    // begin must still enter durable custody before its terminal.
                    await enqueueResolvedMutation();
                } catch {
                    recordPublicationFailure(mutation, 'mutation_failed');
                    // Mutation persistence is best-effort; runtime lifecycle observation must keep progressing.
                    return;
                }
                if (failedEvent && mutation.action === 'fail') await params.onAcceptedTurnFailure?.(failedEvent, mutation.issue);
            });
            return;
        }

        acceptedLifecycleTail = acceptedLifecycleTail.then(async () => {
            const mutationTurnId = 'turnId' in mutation ? mutation.turnId : null;
            if (acceptedLifecycle?.event === 'task_started') {
                turnsWithoutAcceptedBegin.add(acceptedLifecycle.turnId);
                const markerPublished = await publishAcceptedBeginMarker(acceptedLifecycle, mutation);
                if (!markerPublished) return;
                try {
                    await enqueueResolvedMutation();
                    turnsWithoutAcceptedBegin.delete(acceptedLifecycle.turnId);
                } catch {
                    recordPublicationFailure(mutation, 'mutation_failed');
                    // The durable marker remains exact exit authority. Do not allow later rows or
                    // terminal clear to erase that conservative evidence for this unaccepted begin.
                }
                return;
            }

            if (mutationTurnId && turnsWithoutAcceptedBegin.has(mutationTurnId)) {
                return;
            }
            let admission: void | Readonly<{ terminalStatusOverride: 'failed' }>;
            try {
                admission = await enqueueResolvedMutation();
            } catch {
                recordPublicationFailure(mutation, 'mutation_failed');
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
                recordPublicationFailure(mutation, 'marker_failed');
                // A failed terminal clear safely retains the exact marker. Observed exit
                // settlement can then close the stale turn idempotently.
            }
            if (failedEvent && mutation.action === 'fail') await params.onAcceptedTurnFailure?.(failedEvent, mutation.issue);
        });
    }

    const lifecycle: SessionTurnLifecycle = {
        observeRollbackBoundary({ event, startUserMessageSeq }) {
            publish({
                ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'mark_rollback_eligible', event }),
                action: 'mark_rollback_eligible',
                turnId: event.turnId,
                ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                ...(typeof event.agentRollbackOrdinal === 'number'
                    ? { agentRollbackOrdinal: event.agentRollbackOrdinal } : {}),
                transcriptAnchors: {
                    startUserMessageSeq,
                    ...(event.providerCheckpoint !== undefined
                        ? { providerCheckpoint: event.providerCheckpoint } : {}),
                },
            });
        },
        async confirmSessionOpened() {
            await acceptedLifecycleTail;
            // A provider may already have started a turn while opening the Session.
            if (activeTurnId === null) projectTurnProgress(null, Date.now());
            try {
                await params.session.enqueueSessionTurnMutation?.({
                    v: 1,
                    sessionId: params.session.sessionId,
                    mutationId: randomUUID(),
                    action: 'session_opened',
                    observedAt: Date.now(),
                    ...(params.agentId ? { agentId: params.agentId } : {}),
                });
            } catch {
                // As with turn publication, failed local custody must not tear
                // down an opened runtime. Accepted mutations retain outbox retry.
            }
        },
        dispose() {},
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
                        ...(input.issue.failureCause ? { failureCause: input.issue.failureCause } : {}),
                    },
                },
            });
            await lifecycle.drainAcceptedLifecycle();
            return true;
        },

        observeRuntimeEvent(event) {
            if (event.sessionId !== params.session.sessionId) return;

            if (event.kind === 'turn-start') {
                if (activeTurnId !== event.turnId) projectTurnProgress(null, event.emittedAtMs);
                activeTurnId = event.turnId;
                lastActiveTurnTouchAtMs = null;
                const facts = params.readTurnFacts?.();
                const startingInput = params.readStartingInput?.(event.turnId);
                if (facts) params.onTurnFactsChanged?.({ turnId: event.turnId, facts });
                publish(
                    {
                        ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'begin', event }),
                        action: 'begin',
                        turnId: event.turnId,
                        ...(startingInput?.turnId === event.turnId
                            ? { startingInputId: startingInput.inputId } : {}),
                        ...facts,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                    } satisfies RuntimeSessionTurnMutationV1,
                    { event: 'task_started', turnId: event.turnId },
                );
                return;
            }

            if (event.kind === 'turn-progress') {
                if (activeTurnId !== event.turnId) return;
                projectTurnProgress(event.retry
                    ? { turnId: event.turnId, phase: 'retrying', ...event.retry }
                    : null, event.emittedAtMs);
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

            if (isForegroundTurnRuntimeTranscriptEvent(event) && event.turnId === activeTurnId) {
                const hasContent = event.kind === 'message-delta'
                    ? event.text.length > 0
                    : event.kind === 'transcript-message-committed'
                        ? event.role !== 'user' && event.text.length > 0
                        : true;
                if (hasContent) projectTurnProgress(null, event.emittedAtMs);
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

            if ((event.kind === 'turn-complete' || event.kind === 'turn-cancelled')
                && activeTurnId === event.turnId && params.session.readQuestionWaitTurnId?.() === event.turnId) {
                publish({
                    ...buildMutationBase({ session: params.session, agentId: params.agentId, action: 'wait', event }),
                    action: 'wait',
                    turnId: event.turnId,
                    ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                } satisfies RuntimeSessionTurnMutationV1,
                // End exact daemon marker custody without claiming work completion or Stop.
                { event: 'assistant_message_end', turnId: event.turnId });
                params.onTurnFactsChanged?.({ turnId: event.turnId, facts: null });
                projectTurnProgress(null, event.emittedAtMs);
                activeTurnId = null;
                lastActiveTurnTouchAtMs = null;
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
                    projectTurnProgress(null, event.emittedAtMs);
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
                    event,
                );
                if (activeTurnId === event.turnId) {
                    projectTurnProgress(null, event.emittedAtMs);
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
                    projectTurnProgress(null, event.emittedAtMs);
                    params.onTurnFactsChanged?.({ turnId: event.turnId, facts: null });
                    activeTurnId = null;
                    lastActiveTurnTouchAtMs = null;
                }
                return;
            }

            if (event.kind === 'runtime-ended') {
                projectTurnProgress(null, event.emittedAtMs);
                if (!activeTurnId) return;
                lifecycle.observeRuntimeEvent({
                    kind: 'turn-failed',
                    sessionId: event.sessionId,
                    sequence: event.sequence,
                    emittedAtMs: event.emittedAtMs,
                    turnId: activeTurnId,
                    diagnostic: event.diagnostic ?? { code: 'provider_runtime_ended', severity: 'error' },
                });
            }
        },
    };
    return lifecycle;
}
