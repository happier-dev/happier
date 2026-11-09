import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import {
    mergeVoiceConversationBindings,
    isVoiceSessionBindingAvailableInState as isBindingAvailableInState,
    pickNewerVoiceBinding,
    voiceSessionBindingStore,
} from './voiceConversationBindingStore';
import { readPreferredVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { getVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

type VoiceConversationBindingStoreLike = typeof voiceSessionBindingStore;

type ResolverState = Readonly<{
    sessions?: Record<string, any>;
}>;

function isSyncedBindingForLiveControl(binding: VoiceSessionBinding, snapshot: VoiceSessionSnapshot): boolean {
    return snapshot.canStop && snapshot.sessionId === binding.controlSessionId;
}

export function createVoiceConversationBindingResolver(params?: Readonly<{
    getState?: () => ResolverState;
    store?: VoiceConversationBindingStoreLike;
}>) {
    const getState = params?.getState ?? (() => storage.getState() as ResolverState);
    const store = params?.store ?? voiceSessionBindingStore;

    const readAvailableBindings = (state: ResolverState) => {
        const snapshot = getVoiceSessionSnapshot();
        return Object.values(mergeVoiceConversationBindings(
            Object.fromEntries(Object.entries(store.getState().runtimeBindingsByConversationSessionId)
                .filter(([, binding]) => isBindingAvailableInState(binding, state))),
            Object.fromEntries([
                ...Object.values(store.getState().persistedBindingsByConversationSessionId),
                ...store.getState().readPersistedBindings(state),
            ].filter(binding => isBindingAvailableInState(binding, state) && !isSyncedBindingForLiveControl(binding, snapshot))
                .map(binding => [binding.conversationSessionId, binding])),
        ));
    };

    const resolveByConversationSessionId = (input: Readonly<{
        conversationSessionId: string;
        sessionMetadata?: unknown;
    }>): VoiceSessionBinding | null => {
        const conversationSessionId = normalizeNonEmptyString(input.conversationSessionId);
        if (!conversationSessionId) return null;
        const state = getState();
        const storeBinding = store.getState().getByConversationSessionId(conversationSessionId);
        const localBinding = store.getState().runtimeBindingsByConversationSessionId[conversationSessionId] ?? null;
        if (isBindingAvailableInState(localBinding, state)) return localBinding;
        const canonicalSession = state.sessions?.[conversationSessionId] ?? null;
        const sourceServerId = normalizeNonEmptyString(canonicalSession?.serverId)
            ?? normalizeNonEmptyString(getActiveServerSnapshot().serverId);
        const conversationAddress = normalizeSessionAddress(sourceServerId, conversationSessionId);
        const ownerMetadata = conversationAddress
            ? readVoiceSessionOwnerMetadataFromState(state as any, conversationAddress)
            : null;
        // Exact-address reads stay narrow even before the inventory projection is demanded.
        // Both paths use the same metadata admission and system-session guard.
        const persistedBinding = readPreferredVoiceConversationBindingMetadata({
            conversationSessionId,
            preferredMetadata: ownerMetadata,
            directMetadata: canonicalSession ? null : input.sessionMetadata ?? null,
            sourceServerId,
        });
        const snapshot = getVoiceSessionSnapshot();
        return pickNewerVoiceBinding(
            isBindingAvailableInState(storeBinding, state) && !isSyncedBindingForLiveControl(storeBinding, snapshot) ? storeBinding : null,
            isBindingAvailableInState(persistedBinding, state) && !isSyncedBindingForLiveControl(persistedBinding, snapshot) ? persistedBinding : null,
        );
    };

    const resolveByControlSessionId = (input: Readonly<{
        controlSessionId: string;
        adapterId?: string | null;
    }>): VoiceSessionBinding | null => {
        const controlSessionId = normalizeNonEmptyString(input.controlSessionId);
        if (!controlSessionId) return null;
        const requestedAdapterId = normalizeNonEmptyString(input.adapterId);
        const state = getState();
        // The store's merge owns local admission versus synced discovery here too,
        // including current metadata the store has not ingested yet.
        let resolved: VoiceSessionBinding | null = null;
        for (const candidate of readAvailableBindings(state)) {
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
        for (const candidate of readAvailableBindings(state)) {
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
