import {
    SessionDraftRecipientValueV1Schema,
    StrictJsonValueSchema,
    type StrictJsonValue,
} from '@happier-dev/protocol';

import {
    flushSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
    type SessionDraftRepository,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    SessionDraftValueFieldSchemas,
    type SessionDraftValueByFieldId,
    type SessionDraftValueFieldId,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

type SupportedSemanticFieldId = SessionDraftValueFieldId;

type ExistingSessionDraftSemanticRepository = Pick<
    SessionDraftRepository,
    'getSessionDraftSnapshot' | 'subscribeSessionDraft' | 'writeExistingSessionDraft' | 'flushSessionDraft'
>;

const singletonRepository: ExistingSessionDraftSemanticRepository = {
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
    flushSessionDraft,
};

function rawValue(
    repository: ExistingSessionDraftSemanticRepository,
    scope: ServerAccountScope,
    sessionId: string,
    fieldId: SupportedSemanticFieldId,
): StrictJsonValue | undefined {
    const document = repository.getSessionDraftSnapshot(scope, { kind: 'session', sessionId })?.document;
    if (!document) return undefined;
    if (fieldId === 'structuredInput.mentions') return document.composer.mentions.value;
    if (document.target.kind !== 'session') return undefined;
    if (fieldId === 'routing.recipient') return document.target.routing.recipient.value;
    if (fieldId === 'routing.agentContinuation') {
        return document.target.routing.agentContinuation.value ?? undefined;
    }
    return document.target.routing.executionRunDelivery.value ?? undefined;
}

export type ExistingSessionDraftSemanticValues = Readonly<{
    read<TFieldId extends SupportedSemanticFieldId>(
        scope: ServerAccountScope,
        sessionId: string,
        fieldId: TFieldId,
    ): SessionDraftValueByFieldId[TFieldId] | undefined;
    write<TFieldId extends SupportedSemanticFieldId>(
        scope: ServerAccountScope,
        sessionId: string,
        fieldId: TFieldId,
        value: SessionDraftValueByFieldId[TFieldId],
    ): void;
    clear(scope: ServerAccountScope, sessionId: string, fieldId: SupportedSemanticFieldId): void;
    flush(scope: ServerAccountScope, sessionId: string): Promise<unknown>;
    subscribe(scope: ServerAccountScope, sessionId: string, listener: () => void): () => void;
}>;

/**
 * Typed projection from the incumbent 0.2 semantic field ids into the canonical
 * existing-session document. It owns no bytes or lifecycle: every operation is
 * delegated directly to the single SessionDraftRepository.
 */
export function createExistingSessionDraftSemanticValues(
    repository: ExistingSessionDraftSemanticRepository,
): ExistingSessionDraftSemanticValues {
    return {
        read(scope, sessionId, fieldId) {
            const value = rawValue(repository, scope, sessionId, fieldId);
            if (typeof value === 'undefined') return undefined;
            if (fieldId === 'routing.recipient') {
                const parsedRecipient = SessionDraftRecipientValueV1Schema.safeParse(value);
                return parsedRecipient.success && parsedRecipient.data !== null
                    ? parsedRecipient.data.recipient as SessionDraftValueByFieldId[typeof fieldId]
                    : undefined;
            }
            const parsed = SessionDraftValueFieldSchemas[fieldId].safeParse(value);
            return parsed.success
                ? parsed.data as SessionDraftValueByFieldId[typeof fieldId]
                : undefined;
        },
        write(scope, sessionId, fieldId, value) {
            const parsed = SessionDraftValueFieldSchemas[fieldId].safeParse(value);
            if (!parsed.success) return;
            if (fieldId === 'routing.recipient') {
                const recipientValue = StrictJsonValueSchema.safeParse({
                    mode: 'manual',
                    recipient: parsed.data,
                });
                if (!recipientValue.success) return;
                repository.writeExistingSessionDraft({
                    scope,
                    sessionId,
                    patch: { routing: { recipient: recipientValue.data } },
                });
                return;
            }
            const strictValue = StrictJsonValueSchema.safeParse(parsed.data);
            if (!strictValue.success) return;
            if (fieldId === 'structuredInput.mentions') {
                if (!Array.isArray(strictValue.data)) return;
                repository.writeExistingSessionDraft({
                    scope,
                    sessionId,
                    patch: { mentions: strictValue.data },
                });
                return;
            }
            repository.writeExistingSessionDraft({
                scope,
                sessionId,
                patch: {
                    routing: fieldId === 'routing.agentContinuation'
                        ? { agentContinuation: strictValue.data }
                        : { executionRunDelivery: strictValue.data },
                },
            });
        },
        clear(scope, sessionId, fieldId) {
            if (fieldId === 'structuredInput.mentions') {
                repository.writeExistingSessionDraft({ scope, sessionId, patch: { mentions: [] } });
                return;
            }
            repository.writeExistingSessionDraft({
                scope,
                sessionId,
                patch: {
                    routing: fieldId === 'routing.recipient'
                        ? { recipient: null }
                        : fieldId === 'routing.agentContinuation'
                        ? { agentContinuation: null }
                        : { executionRunDelivery: null },
                },
            });
        },
        flush: (scope, sessionId) => repository.flushSessionDraft({
            scope,
            address: { kind: 'session', sessionId },
        }),
        subscribe: (scope, sessionId, listener) => repository.subscribeSessionDraft(
            scope,
            { kind: 'session', sessionId },
            listener,
        ),
    };
}

export const existingSessionDraftSemanticValues = createExistingSessionDraftSemanticValues(singletonRepository);
