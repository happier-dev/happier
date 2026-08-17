import {
    SessionDraftValueFieldSchemas,
    type SessionDraftValueByFieldId,
    type SessionDraftValueClearLifecycle,
    type SessionDraftValueFieldId,
} from './sessionDraftValueTypes';

export type SessionDraftValueFieldDefinition<TFieldId extends SessionDraftValueFieldId> = Readonly<{
    id: TFieldId;
    version: number;
    schema: typeof SessionDraftValueFieldSchemas[TFieldId];
    clearOn: SessionDraftValueClearLifecycle;
}>;

function defineSessionDraftValueField<TFieldId extends SessionDraftValueFieldId>(
    definition: SessionDraftValueFieldDefinition<TFieldId>,
): SessionDraftValueFieldDefinition<TFieldId> {
    return definition;
}

export const SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS = 30;

export const SESSION_DRAFT_VALUE_FIELDS = {
    'routing.recipient': defineSessionDraftValueField({
        id: 'routing.recipient',
        version: 1,
        schema: SessionDraftValueFieldSchemas['routing.recipient'],
        clearOn: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    }),
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
    'routing.agentContinuation': defineSessionDraftValueField({
        id: 'routing.agentContinuation',
        version: 1,
        schema: SessionDraftValueFieldSchemas['routing.agentContinuation'],
        clearOn: {
            send: 'outboundHandoff',
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    }),
    'routing.executionRunDelivery': defineSessionDraftValueField({
        id: 'routing.executionRunDelivery',
        version: 1,
        schema: SessionDraftValueFieldSchemas['routing.executionRunDelivery'],
        clearOn: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    }),
    'structuredInput.mentions': defineSessionDraftValueField({
        id: 'structuredInput.mentions',
        version: 1,
        schema: SessionDraftValueFieldSchemas['structuredInput.mentions'],
        clearOn: {
            send: 'outboundHandoff',
            composerClear: true,
            sessionDelete: true,
            ttlDays: SESSION_DRAFT_VALUE_DEFAULT_TTL_DAYS,
        },
    }),
} satisfies {
    readonly [TFieldId in SessionDraftValueFieldId]: SessionDraftValueFieldDefinition<TFieldId>;
};

export const SESSION_DRAFT_VALUE_FIELD_IDS = Object.freeze(
    Object.keys(SESSION_DRAFT_VALUE_FIELDS) as SessionDraftValueFieldId[],
);

export function isSessionDraftValueFieldId(value: string): value is SessionDraftValueFieldId {
    return Object.prototype.hasOwnProperty.call(SESSION_DRAFT_VALUE_FIELDS, value);
}

export function getSessionDraftValueFieldDefinition<TFieldId extends SessionDraftValueFieldId>(
    fieldId: TFieldId,
): SessionDraftValueFieldDefinition<TFieldId> {
    return SESSION_DRAFT_VALUE_FIELDS[fieldId] as SessionDraftValueFieldDefinition<TFieldId>;
}

export type RegisteredSessionDraftValue = SessionDraftValueByFieldId[SessionDraftValueFieldId];
