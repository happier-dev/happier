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
     * The armed promise cannot be kept by this send, and the send must not
     * happen anyway. `conflictingDestination` — the send would reach something
     * that is not this Session's Agent. `armedTargetUnreachable` — there is no
     * machine to run the transition on.
     */
    | Readonly<{ kind: 'refused'; reason: 'conflictingDestination' | 'armedTargetUnreachable' }>;

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
     * it would break that correlation — see the owner test for what it costs —
     * and it would buy nothing, because the canonical admission owner already
     * refuses a reused identity whose content differs, at both the pending row
     * and the committed transcript row.
     */
    armedContinuationLocalId: string | null;
    /** The machine hosting the Session. The transition only runs there. */
    machineId: string | null;
}>): SessionComposerSendDestination {
    const { armedContinuation, armedContinuationLocalId, machineId, route } = params;
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
