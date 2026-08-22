import type { SessionDraftValueFieldId } from './sessionDraftValueTypes';

export const SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS = 30;

export type SessionDraftValueClearReason = 'send' | 'composerClear' | 'sessionDelete' | 'abort';

export type SessionDraftValueClearLifecycle = Readonly<{
    send?: 'outboundHandoff';
    composerClear?: boolean;
    sessionDelete?: boolean;
    abort?: boolean;
    ttlDays?: number;
}>;

export type SessionDraftValueFieldDefinition = Readonly<{
    lifecycle: SessionDraftValueClearLifecycle;
}>;

export const SESSION_DRAFT_VALUE_FIELD_CATALOG = {
    'routing.recipient': {
        lifecycle: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    },
    /**
     * The armed target Agent. It is the other half of the composer decision whose
     * first half is the draft text, so it lives and dies with that draft: it
     * survives a remount, it leaves with the message that consumed it, and it goes
     * with a deleted Session.
     *
     * `composerClear` is deliberately absent, unlike the sibling routing fields. A
     * composer action that consumes the draft does not disarm the live picker, and
     * a persisted half that cleared where the live half does not would put the one
     * choice back on two lifetimes — the exact defect this field exists to remove.
     * Cancelling is its own gesture: re-select the running Agent.
     *
     * The reasons an arm can stop being truthful — a closed gate, a changed running
     * Agent, a target that lost eligibility — are not lifecycle events this catalog
     * could observe. They are re-validated where the arm is restored.
     */
    'routing.agentContinuation': {
        lifecycle: {
            send: 'outboundHandoff',
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    },
    /**
     * The submitted switch whose effect is not established.
     *
     * Its lifetime is the live outcome's, and the Session screen owns both
     * halves and mirrors one onto the other. The catalog deliberately adds no
     * `send` or `composerClear` clear of its own: a persisted half that cleared
     * where the live half does not is the two-lifetimes defect the sibling
     * field above exists to remove.
     *
     * The TTL is a day rather than the shared default. An unsettled transition
     * no canonical fact ever answered stops being a live statement about this
     * composer long before a draft stops being a live message.
     */
    'routing.agentContinuationSubmission': {
        lifecycle: {
            sessionDelete: true,
            ttlDays: 1,
        },
    },
    'routing.executionRunDelivery': {
        lifecycle: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    },
    'structuredInput.composerAttachments': {
        lifecycle: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    },
    'structuredInput.mentions': {
        lifecycle: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    },
} satisfies Readonly<Record<SessionDraftValueFieldId, SessionDraftValueFieldDefinition>>;

export function shouldClearSessionDraftValueForReason(
    fieldId: SessionDraftValueFieldId,
    reason: SessionDraftValueClearReason,
): boolean {
    const lifecycle: SessionDraftValueClearLifecycle = SESSION_DRAFT_VALUE_FIELD_CATALOG[fieldId].lifecycle;
    if (reason === 'send') return lifecycle.send === 'outboundHandoff';
    return lifecycle[reason] === true;
}
