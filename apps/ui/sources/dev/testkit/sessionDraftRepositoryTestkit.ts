import {
    SessionDraftRecipientValueV1Schema,
    StrictJsonValueSchema,
    type StrictJsonValue,
} from '@happier-dev/protocol';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type {
    SessionDraftValueByFieldId,
    SessionDraftValueFieldId,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import {
    deleteSessionDraft,
    getSessionDraftSnapshot,
    resetSessionDraftRepositoryForTests,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const LEGACY_TEST_SCOPE: ServerAccountScope = { serverId: 'legacy-test', accountId: 'legacy-test' };

function scopeOrLegacy(scope: ServerAccountScope | null | undefined): ServerAccountScope {
    return scope ?? LEGACY_TEST_SCOPE;
}

function readField(scope: ServerAccountScope, sessionId: string, fieldId: SessionDraftValueFieldId): StrictJsonValue | undefined {
    const document = getSessionDraftSnapshot(scope, { kind: 'session', sessionId })?.document;
    if (!document || document.target.kind !== 'session') return undefined;
    if (fieldId === 'structuredInput.mentions') return document.composer.mentions.value;
    if (fieldId === 'structuredInput.composerAttachments') return document.composer.attachments.value;
    if (fieldId === 'routing.recipient') {
        const parsed = SessionDraftRecipientValueV1Schema.safeParse(document.target.routing.recipient.value);
        return parsed.success && parsed.data !== null
            ? parsed.data.recipient as StrictJsonValue
            : undefined;
    }
    if (fieldId === 'routing.agentContinuation') return document.target.routing.agentContinuation.value;
    return document.target.routing.executionRunDelivery.value;
}

export function readSessionDraftValue<FieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: FieldId,
): SessionDraftValueByFieldId[FieldId] | undefined {
    return readField(scopeOrLegacy(scope), sessionId, fieldId) as SessionDraftValueByFieldId[FieldId] | undefined;
}

export function writeSessionDraftValue<FieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: FieldId,
    value: SessionDraftValueByFieldId[FieldId],
    _now?: number,
): void {
    const patch = fieldId === 'structuredInput.mentions'
        ? { mentions: value as readonly StrictJsonValue[] }
        : fieldId === 'structuredInput.composerAttachments'
            ? { attachments: value as readonly StrictJsonValue[] }
            : { routing: fieldId === 'routing.recipient'
                ? { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: value }) }
                : fieldId === 'routing.agentContinuation'
                    ? { agentContinuation: value as StrictJsonValue }
                    : { executionRunDelivery: value as StrictJsonValue } };
    writeExistingSessionDraft({ scope: scopeOrLegacy(scope), sessionId, patch });
}

export function clearSessionDraftValuesForSession(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    _options?: Readonly<{ reason?: string }>,
): readonly SessionDraftValueFieldId[] {
    const existing = getSessionDraftSnapshot(scopeOrLegacy(scope), { kind: 'session', sessionId });
    if (!existing) return [];
    deleteSessionDraft({ scope: scopeOrLegacy(scope), address: { kind: 'session', sessionId } });
    return [
        'routing.recipient',
        'routing.agentContinuation',
        'routing.executionRunDelivery',
        'structuredInput.composerAttachments',
        'structuredInput.mentions',
    ];
}

export function flushSessionDraftValues(scope?: ServerAccountScope | null): void {
    // Repository writes are persisted immediately. This compatibility hook
    // only retired the legacy test store's deferred cache and has no remote
    // address to flush.
    void scope;
}

export function readSessionComposerSemanticRevision(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
): number {
    return getSessionDraftSnapshot(scopeOrLegacy(scope), { kind: 'session', sessionId })?.revision ?? 0;
}

export const readSessionDraftValueMutationRevision = readSessionComposerSemanticRevision;
export { resetSessionDraftRepositoryForTests as resetSessionDraftValueCachesForTests };
export function invalidateSessionDraftValueCache(_scope?: ServerAccountScope | null): void {
    resetSessionDraftRepositoryForTests();
}
