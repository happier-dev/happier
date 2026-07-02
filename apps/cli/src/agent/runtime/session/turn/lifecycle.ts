import { createHash } from 'node:crypto';

import {
    RuntimeEventV1Schema,
    type RuntimeEventV1,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';

export type SessionTurnLifecycleMutationPort = Readonly<{
    sessionId: string;
    enqueueSessionTurnMutation?: (mutation: SessionTurnMutationV1) => void | Promise<void>;
}>;

type SessionTurnLifecycleParams = Readonly<{
    session: SessionTurnLifecycleMutationPort;
    provider?: string;
}>;

export type SessionTurnLifecycle = Readonly<{
    observeRuntimeEvent(event: RuntimeEventV1): void;
    hasActiveTurn(): boolean;
}>;

function stableMutationId(params: Readonly<{
    sessionId: string;
    action: SessionTurnMutationV1['action'];
    event: RuntimeEventV1;
}>): string {
    const digest = createHash('sha256')
        .update(JSON.stringify({
            sessionId: params.sessionId,
            action: params.action,
            kind: params.event.kind,
            emittedAtMs: params.event.emittedAtMs,
            turnId: 'turnId' in params.event ? params.event.turnId : null,
            providerTurnId: 'providerTurnId' in params.event ? params.event.providerTurnId ?? null : null,
        }))
        .digest('hex')
        .slice(0, 32);
    return `session-turn-${digest}`;
}

function buildMutationBase(params: Readonly<{
    session: SessionTurnLifecycleMutationPort;
    provider?: string;
    action: SessionTurnMutationV1['action'];
    event: RuntimeEventV1;
}>): Pick<SessionTurnMutationV1, 'v' | 'sessionId' | 'mutationId' | 'observedAt' | 'provider'> {
    return {
        v: 1,
        sessionId: params.session.sessionId,
        mutationId: stableMutationId({
            sessionId: params.session.sessionId,
            action: params.action,
            event: params.event,
        }),
        observedAt: params.event.emittedAtMs,
        ...(params.provider ? { provider: params.provider } : {}),
    };
}

function publishMutation(params: Readonly<{
    session: SessionTurnLifecycleMutationPort;
    mutation: SessionTurnMutationV1;
}>): void {
    if (!params.session.enqueueSessionTurnMutation) return;
    void Promise.resolve(params.session.enqueueSessionTurnMutation(params.mutation)).catch(() => undefined);
}

export function createSessionTurnLifecycle(params: SessionTurnLifecycleParams): SessionTurnLifecycle {
    let activeTurnId: string | null = null;
    const knownTurnIds = new Set<string>();

    function hasKnownTurn(turnId: string): boolean {
        return activeTurnId === turnId || knownTurnIds.has(turnId);
    }

    return {
        hasActiveTurn() {
            return activeTurnId !== null;
        },

        observeRuntimeEvent(event) {
            if (event.sessionId !== params.session.sessionId) return;

            if (event.kind === 'turn-start') {
                activeTurnId = event.turnId;
                knownTurnIds.add(event.turnId);
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'begin', event }),
                        action: 'begin',
                        turnId: event.turnId,
                        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
                    } satisfies SessionTurnMutationV1,
                });
                return;
            }

            if (event.kind === 'turn-provider-id-observed') {
                if (!hasKnownTurn(event.turnId)) return;
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'attach_provider_turn_id', event }),
                        action: 'attach_provider_turn_id',
                        turnId: event.turnId,
                        providerTurnId: event.providerTurnId,
                    } satisfies SessionTurnMutationV1,
                });
                return;
            }

            if (event.kind === 'turn-input-appended') {
                if (!hasKnownTurn(event.turnId)) return;
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'append_transcript_anchors', event }),
                        action: 'append_transcript_anchors',
                        turnId: event.turnId,
                        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
                        transcriptAnchors: {
                            ...(typeof event.userMessageSeq === 'number' ? { userMessageSeqs: [event.userMessageSeq] } : {}),
                        },
                    } satisfies SessionTurnMutationV1,
                });
                return;
            }

            if (event.kind === 'turn-complete') {
                if (!hasKnownTurn(event.turnId)) return;
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'complete', event }),
                        action: 'complete',
                        turnId: event.turnId,
                        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
                    } satisfies SessionTurnMutationV1,
                });
                if (activeTurnId === event.turnId) activeTurnId = null;
                return;
            }

            if (event.kind === 'turn-failed') {
                if (!hasKnownTurn(event.turnId)) return;
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'fail', event }),
                        action: 'fail',
                        turnId: event.turnId,
                        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
                        issue: event.issue,
                    } satisfies SessionTurnMutationV1,
                });
                if (activeTurnId === event.turnId) activeTurnId = null;
                return;
            }

            if (event.kind === 'turn-cancelled') {
                if (!hasKnownTurn(event.turnId)) return;
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'cancel', event }),
                        action: 'cancel',
                        turnId: event.turnId,
                        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
                        ...(event.reason ? { reason: event.reason } : {}),
                    } satisfies SessionTurnMutationV1,
                });
                if (activeTurnId === event.turnId) activeTurnId = null;
                return;
            }

            if (event.kind === 'turn-rollback-boundary-observed') {
                if (!hasKnownTurn(event.turnId)) return;
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'mark_rollback_eligible', event }),
                        action: 'mark_rollback_eligible',
                        turnId: event.turnId,
                        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
                        ...(typeof event.providerRollbackOrdinal === 'number'
                            ? { providerRollbackOrdinal: event.providerRollbackOrdinal }
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
                        },
                    } satisfies SessionTurnMutationV1,
                });
                return;
            }

            if (event.kind === 'turn-rollback-applied') {
                if (!hasKnownTurn(event.turnId)) return;
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'mark_rolled_back', event }),
                        action: 'mark_rolled_back',
                        turnId: event.turnId,
                        restoredToTurnId: event.restoredToTurnId,
                        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
                        ...(typeof event.providerRollbackOrdinal === 'number'
                            ? { providerRollbackOrdinal: event.providerRollbackOrdinal }
                            : {}),
                    } satisfies SessionTurnMutationV1,
                });
                return;
            }

            if (event.kind === 'session-ended') {
                publishMutation({
                    session: params.session,
                    mutation: {
                        ...buildMutationBase({ session: params.session, provider: params.provider, action: 'end_session', event }),
                        action: 'end_session',
                        ...(activeTurnId ? { turnId: activeTurnId } : {}),
                    } satisfies SessionTurnMutationV1,
                });
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
