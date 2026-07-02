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
    'routing.executionRunDelivery': {
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
