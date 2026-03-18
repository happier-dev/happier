import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { readVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import { isVoiceConversationSystemSessionMetadata } from './voiceConversationSystemSessionLookup';
import { voiceSessionBindingStore } from './voiceSessionBindingStore';
import type { VoiceSessionBinding } from './voiceSessionBindingTypes';

type VoiceSessionBindingStoreLike = typeof voiceSessionBindingStore;

function sameBinding(left: VoiceSessionBinding | null, right: VoiceSessionBinding | null): boolean {
    if (!left || !right) return left === right;
    return (
        left.adapterId === right.adapterId
        && left.controlSessionId === right.controlSessionId
        && left.conversationSessionId === right.conversationSessionId
        && left.transcriptMode === right.transcriptMode
        && left.targetSessionId === right.targetSessionId
        && left.updatedAt === right.updatedAt
    );
}

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

function hydrateResolvedBinding(store: VoiceSessionBindingStoreLike, binding: VoiceSessionBinding | null): VoiceSessionBinding | null {
    if (!binding) return null;
    const current =
        store.getState().getByConversationSessionId(binding.conversationSessionId)
        ?? store.getState().getByControlSessionId(binding.controlSessionId)
        ?? null;
    if (!sameBinding(current, binding)) {
        store.getState().bind(binding);
    }
    return binding;
}

function listPersistedBindings(
    state: any,
): ReadonlyArray<VoiceSessionBinding> {
    const out: VoiceSessionBinding[] = [];
    for (const session of Object.values(state?.sessions ?? {}) as any[]) {
        if (!session || typeof session?.id !== 'string') continue;
        if (!isVoiceConversationSystemSessionMetadata(session?.metadata ?? null)) continue;
        const binding = readVoiceConversationBindingMetadata(session.id, session.metadata ?? null);
        if (!binding) continue;
        out.push(binding);
    }
    return out;
}

function readState(state: any | undefined): any {
    return state ?? storage.getState();
}

export function resolveVoiceSessionBindingByConversationSessionId(params: Readonly<{
    conversationSessionId: string;
    sessionMetadata?: unknown;
    state?: any;
    store?: VoiceSessionBindingStoreLike;
}>): VoiceSessionBinding | null {
    const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
    if (!conversationSessionId) return null;

    const store = params.store ?? voiceSessionBindingStore;
    const state = readState(params.state);
    const storeBinding = store.getState().getByConversationSessionId(conversationSessionId);
    const persistedBinding =
        readVoiceConversationBindingMetadata(conversationSessionId, params.sessionMetadata)
        ?? readVoiceConversationBindingMetadata(
            conversationSessionId,
            state?.sessions?.[conversationSessionId]?.metadata ?? null,
        );

    return hydrateResolvedBinding(store, pickNewerBinding(storeBinding, persistedBinding));
}

export function resolveVoiceSessionBindingByControlSessionId(params: Readonly<{
    controlSessionId: string;
    adapterId?: string | null;
    state?: any;
    store?: VoiceSessionBindingStoreLike;
}>): VoiceSessionBinding | null {
    const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
    if (!controlSessionId) return null;

    const store = params.store ?? voiceSessionBindingStore;
    const state = readState(params.state);
    const requestedAdapterId = normalizeNonEmptyString(params.adapterId);
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

    return hydrateResolvedBinding(store, resolved);
}

export function resolveLatestVoiceSessionBinding(params?: Readonly<{
    adapterId?: string | null;
    controlSessionIds?: ReadonlyArray<string | null | undefined>;
    state?: any;
    store?: VoiceSessionBindingStoreLike;
}>): VoiceSessionBinding | null {
    const store = params?.store ?? voiceSessionBindingStore;
    const state = readState(params?.state);
    const requestedAdapterId = normalizeNonEmptyString(params?.adapterId);
    const requestedControlSessionIds = new Set(
        (params?.controlSessionIds ?? [])
            .map((value) => normalizeNonEmptyString(value))
            .filter((value): value is string => Boolean(value)),
    );

    let resolved: VoiceSessionBinding | null = null;
    const candidates: VoiceSessionBinding[] = [
        ...store.getState().list(),
        ...listPersistedBindings(state),
    ];

    for (const candidate of candidates) {
        if (requestedAdapterId && candidate.adapterId !== requestedAdapterId) continue;
        if (requestedControlSessionIds.size > 0 && !requestedControlSessionIds.has(candidate.controlSessionId)) continue;
        resolved = pickNewerBinding(resolved, candidate);
    }

    return hydrateResolvedBinding(store, resolved);
}
