import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { buildTriageEntryAttachmentPresentation } from '../composer/mutationPlan.js';
import { planTriageActionDeliveryV1 } from './actionDelivery.js';
import type { TriageEntrySessionLinkDisplayV1 } from './entrySessionLinks.js';
import type { TriageSessionActionInvokerV1 } from './entrySessionOpen.js';

/**
 * Delivering a `send` action's structured input, INSIDE the start and before
 * the open (`PLAN.md` §0a A4a).
 *
 * The order the amendment approves is `resolve -> spawn/rejoin -> link -> send
 * structured input -> open`, and the reason the send comes before the open is
 * not aesthetics. Delivery used to run in the mounted Triage surface after the
 * orchestrator had already navigated, so the host retiring that mount — which
 * opening a Session is exactly the thing that does — skipped the delivery
 * entirely and the reader arrived at a Session with nothing in it. Here there
 * is no mount to retire: the send is a phase of the start, so it either happens
 * or is reported as its own outcome.
 *
 * It owns no plan of its own. `actionDelivery.ts` decides WHAT a delivery
 * places, `composer/mutationPlan.ts` builds the one entry attachment draft, and
 * the canonical Session-input Action admits it. This module is the phase.
 */

type SessionMessageSendInput = Extract<
    PluginActionInputById['session.message.send'],
    Readonly<{ message: string }>
>;

export type TriagePlannedEntrySessionInputV1 =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'input';
        text: string;
        attachments: NonNullable<SessionMessageSendInput['attachments']>;
    }>;

/**
 * What a start was asked to deliver once the Session exists.
 *
 * The attachment's two remaining halves travel here because the start already
 * carries the other two: `entryRef` supplies the source, and the link display
 * supplies the scope label and the observed routing hint. Nothing about the
 * entry's prose rides along — the attachment's own `resolveForDispatch` reads
 * authoritative facts at dispatch, which is fresher than anything a start could
 * have embedded.
 */
export type TriageEntrySessionDeliveryRequestV1 = Readonly<{
    /** The body the pressed action's Prompt Library invocation resolved to. */
    text?: string;
    /** Every selected entry carried by this one initial structured input. */
    attachments: readonly Readonly<{
        entryRef: TriageEntryRefV1;
        display: TriageEntrySessionLinkDisplayV1;
        sourceInstanceId: string;
        title: string;
    }>[];
    /**
     * This press's one delivery identity.
     *
     * It is NOT the Session id. A Session-scoped key would make every action
     * ever pressed on one Session the same durable input, so a second, different
     * action's prompt would be deduped away as a repeat of the first. A retry of
     * THIS press re-sends this key unchanged and rejoins its own input.
     */
    idempotencyKey: string;
}>;

/**
 * The canonical Session-input admission answer, carried out unchanged, plus the
 * two arms that mean the send never reached admission.
 *
 * `accepted | alreadyAccepted | rejected | outcomeUnknown` is the real union
 * (`packages/protocol/src/sessions/messages/sessionInputAdmission.ts`). The
 * previous surface awaited the call, discarded its value and reported every
 * resolved promise as sent — so a refusal and an unknown outcome both arrived
 * at the reader as success. Reporting work that did not happen is worse than
 * reporting a failure, and this union exists so it cannot be said again.
 */
export type TriageEntrySessionDeliveryOutcomeV1 =
    /** The start carried no delivery at all. */
    | 'notRequested'
    /** A delivery was requested and had neither text nor a placeable attachment. */
    | 'none'
    | 'accepted'
    | 'alreadyAccepted'
    | 'rejected'
    | 'outcomeUnknown';

/** Builds the one structured input shared by creation and existing-Session delivery. */
export function planEntrySessionInput(
    delivery: TriageEntrySessionDeliveryRequestV1,
): TriagePlannedEntrySessionInputV1 {
    const plan = planTriageActionDeliveryV1({
        delivery: 'send',
        promptText: delivery.text ?? null,
        entries: delivery.attachments.map((entry) => ({
            entryRef: entry.entryRef,
            sourceInstance: {
                source: entry.entryRef.source,
                sourceInstanceId: entry.sourceInstanceId,
            },
            presentation: buildTriageEntryAttachmentPresentation({
                title: entry.title,
                scopeLabel: entry.display.scopeLabel,
            }),
            lastKnownLocator: entry.display.locator,
        })),
    });
    if (plan.kind !== 'send') return { kind: 'none' };
    // The planner exposes an immutable projection. The generated Action input
    // owns its transport array, so take that ownership at this boundary rather
    // than weakening either public contract.
    return { kind: 'input', text: plan.text, attachments: [...plan.attachments] };
}

export async function deliverEntrySessionInput(input: Readonly<{
    execute: TriageSessionActionInvokerV1;
    sessionId: SessionId;
    delivery: TriageEntrySessionDeliveryRequestV1;
    signal?: AbortSignal;
}>): Promise<TriageEntrySessionDeliveryOutcomeV1> {
    const plan = planEntrySessionInput(input.delivery);
    // Nothing to say. The Session still exists, is linked and will open — that
    // is the press's real outcome, and a blank Message announcing it would be a
    // Message the reader never wrote.
    if (plan.kind === 'none') return 'none';

    try {
        const result = await input.execute(
            'session.message.send',
            {
                sessionId: input.sessionId,
                message: plan.text,
                idempotencyKey: input.delivery.idempotencyKey,
                ...(plan.attachments.length === 0 ? {} : { attachments: plan.attachments }),
            } as SessionMessageSendInput,
            input.signal ? { signal: input.signal } : undefined,
        );
        // The admission owner's own verdict, carried out unchanged. Collapsing
        // `rejected` into success is the defect this whole phase exists to fix,
        // so there is deliberately no default arm to collapse it into.
        return result.status;
    } catch {
        // The call crossed the host boundary and never answered, so whether the
        // input was admitted is genuinely unknown. Saying so is the honest
        // answer, and the retained idempotency key is what makes pressing again
        // safe: a resend rejoins the same durable input rather than queueing a
        // second Message.
        return 'outcomeUnknown';
    }
}
