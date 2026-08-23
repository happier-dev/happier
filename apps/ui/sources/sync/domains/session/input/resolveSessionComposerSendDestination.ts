import type { ComposerAgentContinuationIntentV1 } from '@happier-dev/protocol';

/**
 * Where one true composer send goes (section 3.3).
 *
 * The composer has more than one destination, and picking the wrong one is
 * silent: the message is delivered, the draft clears, and the reader is never
 * told that the switch they armed did not happen. That is the exact defect this
 * program existed to remove, and it survived longest because the decision lived
 * inline in the Session screen where no test could reach it.
 *
 * So the decision is a value, not a branch. The screen still owns the routing
 * facts — whether this Session is talking to a voice adapter, whether the
 * composer is addressing an execution run — and hands the resolved route here;
 * this owner decides which destination actually gets the send.
 */

/**
 * The destination the send would reach if nothing were armed. Each is resolved
 * by its own existing owner (`resolveVoiceSessionComposerRouting`,
 * `resolveParticipantRoutedSend`); this module never re-derives them.
 */
export type SessionComposerSendRoute = 'sessionAgent' | 'voiceAdapter' | 'executionRun';

export type SessionComposerSendDestination =
    /** Proceed to the route's own destination, unchanged. */
    | Readonly<{ kind: SessionComposerSendRoute }>
    /** Send through `session.agentTransition` to the Agent the reader armed. */
    | Readonly<{
        kind: 'armedAgentContinuation';
        machineId: string;
        intent: ComposerAgentContinuationIntentV1;
        localId: string;
    }>
    /**
     * The send must not happen. `conflictingDestination` — the send would reach
     * something that is not this Session's Agent. `armedTargetUnreachable` —
     * there is no machine to run the transition on.
     * `unreconciledTransitionOutcome` — a previous transition may already have
     * admitted this input and nothing has established whether it did.
     */
    | Readonly<{
        kind: 'refused';
        reason: 'conflictingDestination' | 'armedTargetUnreachable' | 'unreconciledTransitionOutcome';
    }>;

/**
 * Whether a previous transition on this Session has settled.
 *
 * `unreconciled` is the `outcome_unknown` window only: the daemon could not say
 * whether the reader's input was admitted, and the composer disposition owner
 * has not yet read canonical facts that answer it.
 */
export type SessionComposerPendingTransitionOutcome = 'settled' | 'unreconciled';

export function resolveSessionComposerSendDestination(params: Readonly<{
    route: SessionComposerSendRoute;
    /** Non-null exactly when the in-session picker has armed another Agent. */
    armedContinuation: ComposerAgentContinuationIntentV1 | null;
    /**
     * The armed switch's identity, non-null whenever `armedContinuation` is.
     *
     * It identifies the TRANSITION, not the draft: the daemon derives the
     * departure divider's localId from it and correlates a repeated invocation
     * against that divider, so a retry of the same armed switch must carry the
     * same value even when the reader edited the text first. Content-addressing
     * it would break that correlation. The dispatch owner pairs this stable id
     * with the arm's nested first exact input, so newer draft edits remain local
     * until the original transition's custody is resolved.
     */
    armedContinuationLocalId: string | null;
    /** The machine hosting the Session. The transition only runs there. */
    machineId: string | null;
    /**
     * Whether an earlier transition's effect on this Session is established.
     * Owned by the composer disposition owner, which reconciles it from
     * canonical Session/message facts.
     */
    pendingTransitionOutcome: SessionComposerPendingTransitionOutcome;
}>): SessionComposerSendDestination {
    const { armedContinuation, armedContinuationLocalId, machineId, route } = params;

    // First, and for every route. An unestablished outcome may already have
    // admitted the reader's input; the retained localId dedupes a repeat of the
    // SAME armed switch, but nothing protects a submission that mints a fresh
    // identity — a disarmed composer, a voice route, an execution run. Refusing
    // for the length of the reconciliation is the only way this path cannot
    // duplicate what the reader already sent.
    if (params.pendingTransitionOutcome === 'unreconciled') {
        return { kind: 'refused', reason: 'unreconciledTransitionOutcome' };
    }

    if (armedContinuation === null) return { kind: route };

    // A voice adapter or an execution run is not this Session's Agent, so an
    // armed switch cannot ride along on a send addressed to one. Refusing is the
    // only honest answer: sending would keep the promise unkept and silent, and
    // dropping the arm would discard a choice the reader made deliberately.
    if (route !== 'sessionAgent') return { kind: 'refused', reason: 'conflictingDestination' };

    if (armedContinuationLocalId === null || machineId === null || machineId.length === 0) {
        return { kind: 'refused', reason: 'armedTargetUnreachable' };
    }

    return {
        kind: 'armedAgentContinuation',
        machineId,
        intent: armedContinuation,
        localId: armedContinuationLocalId,
    };
}
