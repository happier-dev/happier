import type {
    ComposerAgentContinuationIntentV1,
    SessionAgentTransitionInputV1,
    SessionAgentTransitionRejectedCodeV1,
    SessionAgentTransitionResultV1,
} from '@happier-dev/protocol';

import { runSessionAgentTransitionOnMachine } from '@/sync/ops/sessionAgentTransition';
import { t } from '@/text';

/**
 * The second destination of a true composer send.
 *
 * An ordinary send goes to `submitSessionUserMessage`, the canonical message
 * owner, and the Session keeps running the Agent it already has. When the
 * in-session Agent picker has armed another Agent, the same submission goes
 * here instead: one `session.agentTransition` invocation that stops the source
 * runtime, commits the target, and admits this exact input through that same
 * message owner on the far side of the cutover.
 *
 * The two destinations are alternatives, never both. This one owns no queue, no
 * retry loop and no progress phases; every fact it reports comes from the
 * daemon's single closed result union.
 */

export type ArmedAgentContinuationLabels = Readonly<{
    /** The Agent running the Session right now. */
    sourceAgentLabel: string;
    /** The Agent the reader armed. */
    targetAgentLabel: string;
}>;

export type ArmedAgentContinuationSubmission = ArmedAgentContinuationLabels & Readonly<{
    /** The machine hosting the Session; the transition only runs there. */
    machineId: string;
    serverId: string | null;
    sessionId: string;
    /**
     * The dedupe identity, divider correlation key, and the only key the
     * composer may compare-clear against. It is minted before the call and
     * never re-minted on retry. The arm retains the first exact wire input and
     * retries dispatch that snapshot even if the composer was later edited;
     * localId alone is not a content-integrity guarantee.
     */
    localId: string;
    intent: ComposerAgentContinuationIntentV1;
    /** The exact input the composer submitted, already normalized by its owner. */
    input: Readonly<{
        text: string;
        /**
         * The short text the transcript reads back when `text` is an expanded
         * prompt — review comments, an attachments block, a structured send.
         * Carried in `meta`, which is where the canonical message owner keeps it.
         */
        displayText?: string;
        meta?: Record<string, unknown>;
    }>;
}>;

/**
 * `displayText` is a canonical `MessageMeta` field, so the frozen transition wire
 * already carries it inside `input.meta` and needs no new field. An explicit
 * override still wins, matching the ordinary path's `buildSendMessageMeta`
 * ordering, and a blank value is dropped rather than stored: the transcript
 * renders `displayText ?? text`, so an empty string would blank the row.
 */
function buildTransitionInputMeta(
    input: ArmedAgentContinuationSubmission['input'],
): Record<string, unknown> {
    const displayText = input.displayText;
    return {
        ...(typeof displayText === 'string' && displayText.trim().length > 0 ? { displayText } : {}),
        ...(input.meta ?? {}),
    };
}

/**
 * Builds the one wire-ready request shared by draft persistence and transition
 * dispatch. Keeping this projection here means a remount never compares a
 * hand-copied approximation of the request the RPC actually received.
 */
export function buildArmedAgentContinuationTransitionInput(
    submission: Pick<ArmedAgentContinuationSubmission, 'localId' | 'input'>,
): SessionAgentTransitionInputV1 {
    return {
        text: submission.input.text,
        localId: submission.localId,
        meta: buildTransitionInputMeta(submission.input),
    };
}

/**
 * How far the switch actually got.
 *
 * The wire codes explain *why* an outcome happened; this says what is now TRUE
 * of the Session, and that is the only thing a recovery may be offered against.
 * Keeping the two apart is what lets the same owner decide a daemon-reported arm
 * and a client-reconciled one without ever fabricating a code the daemon never
 * sent.
 */
type ArmedAgentContinuationEffectDepth =
    /** The switch completed and this exact input reached canonical admission. */
    | 'accepted'
    /** Nothing was touched. The Session still runs the source Agent. */
    | 'no_effect'
    /** The source is confirmed stopped and nothing was committed. */
    | 'source_stopped'
    /** The Session IS the target now, and the input did not land. */
    | 'current_view_committed'
    /** Nothing at all is established. */
    | 'unknown';

/**
 * The only recovery that is factually safe at one depth.
 *
 * There is deliberately no "check status" and no separate resume-source /
 * resume-target pair. Where the ordinary composer send is already the safe
 * retry, the banner offers nothing and the composer IS the affordance; where the
 * Session simply has no live runtime, the action delegates to the Session's
 * existing resume owner rather than becoming a second way to start an Agent.
 */
export type ArmedAgentContinuationRecovery = 'none' | 'resumeSession';

/**
 * What the composer banner says about one outcome. Presentation consumes this;
 * it never re-derives which depth was reached or what is safe from here.
 */
export type ArmedAgentContinuationNotice = Readonly<{
    tone: 'warning' | 'neutral';
    /** One already-translated sentence, rendered verbatim. */
    message: string;
    recovery: ArmedAgentContinuationRecovery;
}>;

/**
 * What the composer and the picker must do about one transition outcome.
 *
 * The failure mode this replaces is the one the app actually shipped: telling a
 * reader the switch happened when it did not. So the rule is narrow and
 * absolute — `draft: 'clear'` is reachable from a completed send and nothing
 * else, and every other arm carries a notice.
 */
export type ArmedAgentContinuationDisposition = Readonly<{
    /** Only canonical admission of this exact localId may clear the draft. */
    draft: 'clear' | 'preserve';
    /**
     * Whether the armed row is still a truthful promise about the next message.
     * It stops being one once the Session already IS the target — the switch is
     * spent, and section 7.5 forbids repeating it.
     */
    arm: 'keep' | 'clear';
    /** Null only when the switch completed and the message was admitted. */
    notice: ArmedAgentContinuationNotice | null;
    /**
     * Whether the composer may submit again right now.
     *
     * `block` exists for exactly one situation: an outcome that may already have
     * admitted this input, before canonical facts have been read. A second
     * submission is the only way this path can duplicate the reader's message,
     * and the dedupe identity cannot cover one that mints a fresh localId.
     */
    send: 'allow' | 'block';
    /**
     * Present only where the input reached canonical custody but no runtime has
     * taken it yet.
     *
     * This is the transition's form of the ordinary send's `wake_pending` /
     * `wake_failed`, and it is deliberately not a notice: the Session already
     * owns that state and presents it through its queued-message banner. Naming
     * the fact here lets that one owner present it instead of growing a second
     * banner that says the same thing beside it.
     */
    awaitingRuntime?: true;
}>;

/**
 * Where the exact submitted localId has got to, canonically.
 *
 * One value rather than two booleans, because "admitted" and "still waiting to
 * be carried" are the same question asked at two depths, and a pair of flags
 * can encode a state that cannot exist. `delivered` is the discriminator that
 * keeps a queued-input signal from outliving the message it describes.
 */
export type ArmedAgentContinuationInputCustody =
    /** No canonical record of this localId anywhere. */
    | 'absent'
    /** In the Session's pending queue; no runtime has taken it. */
    | 'queued'
    /** In the transcript: a runtime took it. */
    | 'delivered';

/**
 * The canonical Session/message facts the reconciliation reads. Nothing here is
 * asked for over the wire by this module: they are the ordinary synced truth the
 * Session screen already holds.
 */
export type ArmedAgentContinuationCanonicalFacts = Readonly<{
    /** The Agent the Session canonically runs right now. */
    currentAgentId: string | null;
    /** Whether the Session has a live runtime. */
    sessionActive: boolean;
    /** How far the exact submitted localId has got. */
    input: ArmedAgentContinuationInputCustody;
}>;

function resolveRejectedMessage(
    code: SessionAgentTransitionRejectedCodeV1,
    labels: ArmedAgentContinuationLabels,
): string {
    switch (code) {
        case 'unsupported_operation':
            return t('session.agentContinuation.transition.rejected.unsupportedOperation');
        case 'forbidden':
            return t('session.agentContinuation.transition.rejected.forbidden');
        case 'same_target':
            return t('session.agentContinuation.transition.rejected.sameTarget', {
                agent: labels.targetAgentLabel,
            });
        case 'stale_selection':
            return t('session.agentContinuation.transition.rejected.staleSelection');
        case 'target_unavailable':
            return t('session.agentContinuation.transition.rejected.targetUnavailable', {
                agent: labels.targetAgentLabel,
            });
        case 'source_not_idle':
            return t('session.agentContinuation.transition.rejected.sourceNotIdle', {
                agent: labels.sourceAgentLabel,
            });
        case 'source_stop_failed':
            return t('session.agentContinuation.transition.rejected.sourceStopFailed', {
                agent: labels.sourceAgentLabel,
            });
    }
}

/**
 * The single mapping from "what is true of the Session" to "what the reader is
 * told and offered". Both the immediate daemon answer and the later
 * reconciliation come through here, so the two can never drift into competing
 * recovery decisions.
 */
function buildDisposition(params: Readonly<{
    depth: ArmedAgentContinuationEffectDepth;
    message: string;
    /**
     * Set only where the depth alone does not decide it: a `same_target`
     * rejection leaves the Session untouched, yet the armed row is already a
     * promise about a switch that cannot happen.
     */
    armSpent?: boolean;
    /** Canonical facts have been read since the call returned. */
    reconciled?: boolean;
    /** The Session has no live runtime, so starting one is a real recovery. */
    canResume?: boolean;
    /** The admitted input is still waiting for a runtime to carry it. */
    awaitingRuntime?: boolean;
}>): ArmedAgentContinuationDisposition {
    const { depth, message } = params;
    if (depth === 'accepted') {
        return {
            draft: 'clear',
            arm: 'clear',
            notice: null,
            send: 'allow',
            ...(params.awaitingRuntime === true ? { awaitingRuntime: true } as const : {}),
        };
    }
    const armSpent = params.armSpent ?? depth === 'current_view_committed';
    const arm = armSpent ? 'clear' : 'keep';
    if (depth === 'unknown') {
        return {
            draft: 'preserve',
            arm,
            // Not a failure — an absence of knowledge. A warning would name a
            // problem this owner cannot prove, and an action would be a blind
            // retry against an effect that may already have happened.
            notice: { tone: 'neutral', message, recovery: 'none' },
            send: params.reconciled === true ? 'allow' : 'block',
        };
    }
    return {
        draft: 'preserve',
        arm,
        notice: {
            tone: 'warning',
            message,
            // Everywhere the Session is still the source, the ordinary composer
            // send already retries the same switch under the same identity, so a
            // banner action would only duplicate an affordance the reader has.
            recovery: depth === 'current_view_committed' && params.canResume === true
                ? 'resumeSession'
                : 'none',
        },
        send: 'allow',
    };
}

/**
 * Whether the daemon's own answer PROVES this exact input reached canonical
 * admission AND that no runtime took it, even though the arm it rides is a
 * partial one.
 *
 * `target_start_failed` is the single such code. The transition coordinator
 * takes input custody first and only then activates the target
 * (`admitInputAndActivateTarget` returns `input_admission_failed` /
 * `input_rejected` before any activation is attempted), so reaching it means
 * admission already succeeded and only the runtime failed to come up. Treating
 * it as "your message wasn't sent" is therefore false at the source, not merely
 * unlucky timing — and acting on that sentence duplicates the message, because
 * the arm is spent and the retry mints a fresh identity.
 */
function resultProvesInputQueuedBehindNoRuntime(result: SessionAgentTransitionResultV1): boolean {
    return result.type === 'partially_applied'
        && result.applied === 'current_view_committed'
        && result.code === 'target_start_failed';
}

/**
 * The one rule for "the reader's message is in the queue and nothing is running
 * to take it" — the state the Session's queued-message banner exists to state.
 *
 * It is deliberately evidence-ranked rather than arm-ranked. `target_start_failed`
 * carries the daemon's own proof that activation failed, so it stands without any
 * client fact and yields only to seeing the message actually carried. Every other
 * arm that ends with the input admitted — including plain `accepted` — proves
 * NOTHING about the runtime: activation is fire-and-forget, with no readiness
 * wait, so `accepted` means "spawn acknowledged", and a target that dies after it
 * leaves the message queued behind a Session with no runtime. There the fact has
 * to be read, and re-read: the death that exposed this arrived 94 seconds after a
 * switch that reported success.
 */
function resolveAwaitingRuntime(
    result: SessionAgentTransitionResultV1,
    facts: ArmedAgentContinuationCanonicalFacts | null,
): boolean {
    if (resultProvesInputQueuedBehindNoRuntime(result)) return facts?.input !== 'delivered';
    return facts !== null && facts.sessionActive === false && facts.input === 'queued';
}

/**
 * Maps one daemon answer onto the only recovery that is safe at that depth.
 *
 * The depths are not interchangeable and must not be collapsed:
 *
 * - `rejected` — the source is untouched and still running. Keeping the draft
 *   and the armed row means the ordinary send IS the retry.
 * - `partially_applied` / `source_stopped` — the source is confirmed stopped
 *   and nothing was committed. The Session is still the SOURCE Agent, so the
 *   arm survives and a retry is safe, but the copy must not imply the source is
 *   still running.
 * - `partially_applied` / `current_view_committed` — the Session IS the target.
 *   The switch already happened, so the arm is spent. Whether the draft stays
 *   depends on the input: `target_start_failed` proves it was admitted before
 *   activation was even attempted, so it becomes `accepted` with the runtime
 *   still to come; every other code at this depth leaves the message unsent and
 *   the draft in place.
 * - `outcome_unknown` — nothing is established. Preserve everything, say so, and
 *   hold the composer until reconciliation has read canonical facts.
 *
 * This is the fact-free form used at send time, where draft and arm must be
 * decided synchronously. `reconcileArmedAgentContinuationDisposition` is the
 * same owner re-deciding once canonical facts exist.
 */
export function resolveArmedAgentContinuationDisposition(
    result: SessionAgentTransitionResultV1,
    labels: ArmedAgentContinuationLabels,
): ArmedAgentContinuationDisposition {
    return reconcileArmedAgentContinuationDisposition({
        result,
        labels,
        targetAgentId: null,
        facts: null,
    });
}

/**
 * The same disposition, re-decided against canonical Session/message facts.
 *
 * Only an indeterminate outcome is reconciled. Every other arm is a fact the
 * daemon established at the point of the effect; a client-side view of the
 * Session is later, weaker evidence and must never be allowed to promote a
 * no-effect rejection into a committed cutover.
 */
export function reconcileArmedAgentContinuationDisposition(params: Readonly<{
    result: SessionAgentTransitionResultV1;
    labels: ArmedAgentContinuationLabels;
    /** The Agent the reader armed; the Session running it proves the cutover. */
    targetAgentId: string | null;
    /** Null until canonical state has actually been read since the call. */
    facts: ArmedAgentContinuationCanonicalFacts | null;
}>): ArmedAgentContinuationDisposition {
    const { facts, labels, result, targetAgentId } = params;
    const canResume = facts !== null && facts.sessionActive === false;
    switch (result.type) {
        case 'accepted':
            // `accepted` is the narrowest claim in the union: the cutover and
            // divider committed and this localId was admitted. It does NOT say
            // the target came up, so it cannot be treated as the end of the
            // story — before this, a target that died left total silence.
            return buildDisposition({
                depth: 'accepted',
                message: '',
                awaitingRuntime: resolveAwaitingRuntime(result, facts),
            });
        case 'rejected':
            return buildDisposition({
                depth: 'no_effect',
                message: resolveRejectedMessage(result.code, labels),
                // A Session that already runs the armed Agent makes the armed row
                // a promise about a switch that cannot happen.
                armSpent: result.code === 'same_target',
            });
        case 'partially_applied':
            if (result.applied === 'source_stopped') {
                return buildDisposition({
                    depth: 'source_stopped',
                    message: t('session.agentContinuation.transition.sourceStopped', {
                        source: labels.sourceAgentLabel,
                        agent: labels.targetAgentLabel,
                    }),
                });
            }
            // The Session IS the target; the only open question at this depth is
            // whether the input landed. The daemon's own code answers it for
            // `target_start_failed`, and canonical custody of the exact localId
            // answers it for the rest. Either way the message is the reader's to
            // wait on, so the draft goes and no sentence claims otherwise.
            return resultProvesInputQueuedBehindNoRuntime(result) || (facts !== null && facts.input !== 'absent')
                ? buildDisposition({
                    depth: 'accepted',
                    message: '',
                    awaitingRuntime: resolveAwaitingRuntime(result, facts),
                })
                : buildDisposition({
                    depth: 'current_view_committed',
                    message: t('session.agentContinuation.transition.switched', {
                        agent: labels.targetAgentLabel,
                    }),
                    canResume,
                });
        case 'outcome_unknown':
            break;
    }

    // The reader's message is in the transcript. Anything else this could say
    // now would contradict an effect that is already established.
    if (facts !== null && facts.input !== 'absent') {
        return buildDisposition({
            depth: 'accepted',
            message: '',
            awaitingRuntime: resolveAwaitingRuntime(result, facts),
        });
    }
    // The Session canonically runs the Agent the reader armed, and this exact
    // input did not land: that is the committed-but-incomplete depth, reached
    // from facts rather than from a code the daemon could not determine.
    if (facts !== null && targetAgentId !== null && facts.currentAgentId === targetAgentId) {
        return buildDisposition({
            depth: 'current_view_committed',
            message: t('session.agentContinuation.transition.switched', {
                agent: labels.targetAgentLabel,
            }),
            canResume,
        });
    }
    // Still indeterminate. Once canonical state has been read and still proves
    // nothing, holding the composer would be a worse lie than the notice itself:
    // the reconciliation attempt IS the window, not an unbounded wait.
    return buildDisposition({
        depth: 'unknown',
        message: t('session.agentContinuation.transition.unknown'),
        reconciled: facts !== null,
    });
}

export type ArmedAgentContinuationOutcome = Readonly<{
    result: SessionAgentTransitionResultV1;
    disposition: ArmedAgentContinuationDisposition;
}>;

export async function continueSessionWithArmedAgent(
    submission: ArmedAgentContinuationSubmission,
): Promise<ArmedAgentContinuationOutcome> {
    const result = await runSessionAgentTransitionOnMachine({
        machineId: submission.machineId,
        serverId: submission.serverId,
        request: {
            v: 1,
            sessionId: submission.sessionId,
            expectedCurrentAgentId: submission.intent.sourceAgentId,
            selection: submission.intent.selection,
            input: buildArmedAgentContinuationTransitionInput(submission),
        },
    });
    return {
        result,
        disposition: resolveArmedAgentContinuationDisposition(result, {
            sourceAgentLabel: submission.sourceAgentLabel,
            targetAgentLabel: submission.targetAgentLabel,
        }),
    };
}
