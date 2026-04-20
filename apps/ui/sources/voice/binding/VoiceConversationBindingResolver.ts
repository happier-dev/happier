import { storage } from '@/sync/domains/state/storage';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { voiceSessionBindingStore } from './voiceConversationBindingStore';
import { readPreferredVoiceConversationBindingMetadata, readVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

type VoiceConversationBindingStoreLike = typeof voiceSessionBindingStore;

type ResolverState = Readonly<{
    sessions?: Record<string, any>;
}>;

function pickNewerBinding(
    current: VoiceSessionBinding | null,
    candidate: VoiceSessionBinding | null,
): VoiceSessionBinding | null {
    if (!candidate) return current;
    if (!current) return candidate;
    if (candidate.updatedAt !== current.updatedAt) {
        return candidate.updatedAt > current.updatedAt ? candidate : current;
    }
    if (candidate.conversationSessionId !== current.conversationSessionId) {
        return candidate.conversationSessionId < current.conversationSessionId ? candidate : current;
    }
    return current;
}

function listPersistedBindings(state: ResolverState): ReadonlyArray<VoiceSessionBinding> {
    const bindings: VoiceSessionBinding[] = [];
    for (const session of Object.values(state.sessions ?? {})) {
        if (!session || typeof session?.id !== 'string') continue;
        const preferredMetadata = resolveSessionListPreferredSessionMetadataFromState(state as any, session.id);
        const binding = readPreferredVoiceConversationBindingMetadata({
            conversationSessionId: session.id,
            preferredMetadata,
            directMetadata: session.metadata ?? null,
        });
        if (binding) {
            bindings.push(binding);
        }
    }
    return bindings;
}

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
        const persistedBinding =
            readPreferredVoiceConversationBindingMetadata({
                conversationSessionId,
                preferredMetadata,
                directMetadata: state.sessions?.[conversationSessionId]?.metadata ?? null,
            })
            ?? readVoiceConversationBindingMetadata(conversationSessionId, input.sessionMetadata)
            ?? readVoiceConversationBindingMetadata(conversationSessionId, state.sessions?.[conversationSessionId]?.metadata ?? null);
        return pickNewerBinding(storeBinding, persistedBinding);
    };

    const resolveByControlSessionId = (input: Readonly<{
        controlSessionId: string;
        adapterId?: string | null;
    }>): VoiceSessionBinding | null => {
        const controlSessionId = normalizeNonEmptyString(input.controlSessionId);
        if (!controlSessionId) return null;
        const requestedAdapterId = normalizeNonEmptyString(input.adapterId);
        const state = getState();
        const storeBinding = store.getState().getByControlSessionId(controlSessionId);
        let resolved =
            !requestedAdapterId || storeBinding?.adapterId === requestedAdapterId
                ? storeBinding
                : null;

        for (const persistedBinding of listPersistedBindings(state)) {
            if (persistedBinding.controlSessionId !== controlSessionId) continue;
            if (requestedAdapterId && persistedBinding.adapterId !== requestedAdapterId) continue;
            resolved = pickNewerBinding(resolved, persistedBinding);
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
            ...listPersistedBindings(state),
        ];
        for (const candidate of candidates) {
            if (requestedAdapterId && candidate.adapterId !== requestedAdapterId) continue;
            if (requestedControlSessionIds.size > 0 && !requestedControlSessionIds.has(candidate.controlSessionId)) continue;
            resolved = pickNewerBinding(resolved, candidate);
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
