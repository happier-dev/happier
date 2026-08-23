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
     * survives a remount, and it leaves with the message, composer action, or
     * deleted Session that consumed that composer decision.
     *
     * The reasons an arm can stop being truthful — a closed gate, a changed running
     * Agent, a target that lost eligibility — are not lifecycle events this catalog
     * could observe. They are re-validated where the arm is restored.
     */
    'routing.agentContinuation': {
        lifecycle: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
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
