import { storage } from '@/sync/domains/state/storage';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import {
    listPersistedVoiceBindingsFromState,
    pickNewerVoiceBinding,
    voiceSessionBindingStore,
} from './voiceConversationBindingStore';
import { readPreferredVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

type VoiceConversationBindingStoreLike = typeof voiceSessionBindingStore;

type ResolverState = Readonly<{
    sessions?: Record<string, any>;
}>;

export function createVoiceConversationBindingResolver(params?: Readonly<{
    getState?: () => ResolverState;
    store?: VoiceConversationBindingStoreLike;
}>) {
    const getState = params?.getState ?? (() => storage.getState() as ResolverState);
    const store = params?.store ?? voiceSessionBindingStore;

    const resolveByConversationSessionId = (input: Readonly<{
        conversationSessionId: string;
        sessionMetadata?: unknown;
    }>): VoiceSessionBinding | null => {
        const conversationSessionId = normalizeNonEmptyString(input.conversationSessionId);
        if (!conversationSessionId) return null;
        const state = getState();
        const storeBinding = store.getState().getByConversationSessionId(conversationSessionId);
        const preferredMetadata = resolveSessionListPreferredSessionMetadataFromState(state as any, conversationSessionId);
        // Single guarded read path: caller-supplied `sessionMetadata` is funneled
        // through the same `isVoiceConversationSystemSessionMetadata` guard as every
        // other persisted read (audit F2) instead of an unguarded fallback.
        const persistedBinding = readPreferredVoiceConversationBindingMetadata({
            conversationSessionId,
            preferredMetadata,
            directMetadata: input.sessionMetadata ?? state.sessions?.[conversationSessionId]?.metadata ?? null,
        });
        return pickNewerVoiceBinding(storeBinding, persistedBinding);
    };

    const resolveByControlSessionId = (input: Readonly<{
        controlSessionId: string;
        adapterId?: string | null;
    }>): VoiceSessionBinding | null => {
        const controlSessionId = normalizeNonEmptyString(input.controlSessionId);
        if (!controlSessionId) return null;
        const requestedAdapterId = normalizeNonEmptyString(input.adapterId);
        const state = getState();
        // Single read+merge algorithm (audit F1/F7): merge the store's runtime view with
        // persisted bindings derived from `getState()` through the SAME shared persisted
        // reader and the SAME `pickNewerVoiceBinding` tie-break the store uses. The store
        // merge already dedupes its own persisted layer, so this no longer applies a
        // divergent tie-break, and it still honors a getState snapshot the store has not
        // yet ingested.
        let resolved: VoiceSessionBinding | null = null;
        const candidates = [
            ...store.getState().list(),
            ...listPersistedVoiceBindingsFromState(state as any),
        ];
        for (const candidate of candidates) {
            if (candidate.controlSessionId !== controlSessionId) continue;
            if (requestedAdapterId && candidate.adapterId !== requestedAdapterId) continue;
            resolved = pickNewerVoiceBinding(resolved, candidate);
        }
        return resolved;
    };

    const resolveLatest = (input?: Readonly<{
        adapterId?: string | null;
        controlSessionIds?: ReadonlyArray<string | null | undefined>;
    }>): VoiceSessionBinding | null => {
        const requestedAdapterId = normalizeNonEmptyString(input?.adapterId);
        const requestedControlSessionIds = new Set(
            (input?.controlSessionIds ?? [])
                .map((value) => normalizeNonEmptyString(value))
                .filter((value): value is string => Boolean(value)),
        );
        let resolved: VoiceSessionBinding | null = null;
        const state = getState();
        const candidates = [
            ...store.getState().list(),
            ...listPersistedVoiceBindingsFromState(state as any),
        ];
        for (const candidate of candidates) {
            if (requestedAdapterId && candidate.adapterId !== requestedAdapterId) continue;
            if (requestedControlSessionIds.size > 0 && !requestedControlSessionIds.has(candidate.controlSessionId)) continue;
            resolved = pickNewerVoiceBinding(resolved, candidate);
        }
        return resolved;
    };

    const resolveComposerRouting = (input: Readonly<{
        conversationSessionId: string;
        sessionMetadata?: unknown;
    }>): { kind: 'adapter_text'; binding: VoiceSessionBinding } | null => {
        const binding = resolveByConversationSessionId(input);
        return binding ? { kind: 'adapter_text', binding } : null;
    };

    return {
        resolveByConversationSessionId,
        resolveByControlSessionId,
        resolveLatest,
        resolveComposerRouting,
    };
}

export const voiceConversationBindingResolver = createVoiceConversationBindingResolver();
