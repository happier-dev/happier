import * as React from 'react';

import { existingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import type {
    SessionDraftValueByFieldId,
    SessionDraftValueFieldId,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * Subscribes to one semantic field of an existing Session's draft.
 *
 * The draft repository notifies every subscriber of a Session on every write, and the composer
 * writes the draft text on every keystroke. This returns the same value identity until the field
 * itself changes, so a composer owner reading a routing or mention field does not re-render for
 * text edits.
 */
export function useExistingSessionDraftSemanticValue<TFieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null,
    sessionId: string | null,
    fieldId: TFieldId,
): SessionDraftValueByFieldId[TFieldId] | undefined;
/** With `unsetValue`, an unset field reads as that value (e.g. an absent mention list as `[]`). */
export function useExistingSessionDraftSemanticValue<TFieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null,
    sessionId: string | null,
    fieldId: TFieldId,
    unsetValue: SessionDraftValueByFieldId[TFieldId],
): SessionDraftValueByFieldId[TFieldId];
export function useExistingSessionDraftSemanticValue<TFieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null,
    sessionId: string | null,
    fieldId: TFieldId,
    unsetValue?: SessionDraftValueByFieldId[TFieldId],
): SessionDraftValueByFieldId[TFieldId] | undefined {
    const lastReadRef = React.useRef<Readonly<{
        signature: string;
        value: SessionDraftValueByFieldId[TFieldId] | undefined;
    }> | null>(null);
    const subscribe = React.useCallback((listener: () => void) => (
        scope && sessionId
            ? existingSessionDraftSemanticValues.subscribe(scope, sessionId, listener)
            : () => undefined
    ), [scope, sessionId]);
    const read = React.useCallback(() => {
        const persisted = scope && sessionId
            ? existingSessionDraftSemanticValues.read(scope, sessionId, fieldId)
            : undefined;
        // Only an unset field takes the fallback; an explicit `null` (e.g. "no recipient") is a value.
        const value = typeof persisted === 'undefined' ? unsetValue : persisted;
        const signature = typeof value === 'undefined' ? 'unset' : JSON.stringify(value);
        const lastRead = lastReadRef.current;
        if (lastRead?.signature === signature) return lastRead.value;
        lastReadRef.current = { signature, value };
        return value;
    }, [fieldId, scope, sessionId, unsetValue]);
    return React.useSyncExternalStore(subscribe, read, read);
}
