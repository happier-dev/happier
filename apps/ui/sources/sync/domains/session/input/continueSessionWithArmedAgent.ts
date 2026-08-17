import type {
    ComposerAgentContinuationIntentV1,
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
     * never re-minted on retry — including a retry whose draft was edited
     * first, because this identifies the transition rather than the text. The
     * canonical admission owner, not this identity, is what stops a reused
     * identity from overwriting differing content.
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
 * What the composer and the picker must do about one transition outcome.
 *
 * The failure mode this replaces is the one the app actually shipped: telling a
 * reader the switch happened when it did not. So the rule is narrow and
 * absolute — `draft: 'clear'` is reachable from `accepted` and nothing else,
 * and every other arm carries a message.
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
    failureMessage: string | null;
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
 * Maps one result arm onto the only recovery that is safe at that depth.
 *
 * The depths are not interchangeable and must not be collapsed:
 *
 * - `rejected` — the source is untouched and still running. Keep editing and
 *   retry are both safe, and the armed row still means what it says.
 * - `partially_applied` / `source_stopped` — the source is confirmed stopped
 *   and nothing was committed. The Session is still the SOURCE Agent, so the
 *   arm survives and a retry is safe, but the copy must not imply the source is
 *   still running.
 * - `partially_applied` / `current_view_committed` — the Session IS the target.
 *   The switch already happened, so the arm is spent; the message did not go
 *   through, so the draft stays.
 * - `outcome_unknown` — nothing is established. Preserve everything and say so.
 */
export function resolveArmedAgentContinuationDisposition(
    result: SessionAgentTransitionResultV1,
    labels: ArmedAgentContinuationLabels,
): ArmedAgentContinuationDisposition {
    switch (result.type) {
        case 'accepted':
            return { draft: 'clear', arm: 'clear', failureMessage: null };
        case 'rejected':
            return {
                draft: 'preserve',
                // A Session that already runs the armed Agent makes the armed row
                // a promise about a switch that cannot happen.
                arm: result.code === 'same_target' ? 'clear' : 'keep',
                failureMessage: resolveRejectedMessage(result.code, labels),
            };
        case 'partially_applied':
            return result.applied === 'source_stopped'
                ? {
                    draft: 'preserve',
                    arm: 'keep',
                    failureMessage: t('session.agentContinuation.transition.sourceStopped', {
                        source: labels.sourceAgentLabel,
                        agent: labels.targetAgentLabel,
                    }),
                }
                : {
                    draft: 'preserve',
                    arm: 'clear',
                    failureMessage: t('session.agentContinuation.transition.switched', {
                        agent: labels.targetAgentLabel,
                    }),
                };
        case 'outcome_unknown':
            return {
                draft: 'preserve',
                arm: 'keep',
                failureMessage: t('session.agentContinuation.transition.unknown'),
            };
    }
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
            input: {
                text: submission.input.text,
                localId: submission.localId,
                meta: buildTransitionInputMeta(submission.input),
            },
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
