import { createStore } from 'zustand/vanilla';

import {
    resolveSessionListPreferredSessionMetadataFromState,
    type SessionServerLookupStateLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import { readPreferredVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

type BindingsByConversationSessionId = Record<string, VoiceSessionBinding>;

type VoiceSessionBindingStoreState = Readonly<{
    bindingsByConversationSessionId: BindingsByConversationSessionId;
    runtimeBindingsByConversationSessionId: BindingsByConversationSessionId;
    persistedBindingsByConversationSessionId: BindingsByConversationSessionId;
    bind: (binding: VoiceSessionBinding) => void;
    unbind: (conversationSessionId: string) => void;
    replacePersistedBindings: (bindings: ReadonlyArray<VoiceSessionBinding>) => void;
    getByConversationSessionId: (conversationSessionId: string) => VoiceSessionBinding | null;
    getByControlSessionId: (controlSessionId: string) => VoiceSessionBinding | null;
    list: () => ReadonlyArray<VoiceSessionBinding>;
}>;

function normalizeId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeBinding(binding: VoiceSessionBinding): VoiceSessionBinding | null {
    const adapterId = normalizeId(binding.adapterId);
    const controlSessionId = normalizeId(binding.controlSessionId);
    const conversationSessionId = normalizeId(binding.conversationSessionId);
    const runId = normalizeId(binding.runId);
    const streamId = normalizeId(binding.streamId);
    const transcriptMode = binding.transcriptMode === 'native_session' || binding.transcriptMode === 'synthetic'
        ? binding.transcriptMode
        : null;
    if (!adapterId || !controlSessionId || !conversationSessionId || !transcriptMode) return null;

    return {
        adapterId,
        controlSessionId,
        conversationSessionId,
        ...(runId ? { runId } : {}),
        ...(streamId ? { streamId } : {}),
        transcriptMode,
        targetSessionId: normalizeId(binding.targetSessionId),
        updatedAt: Number.isFinite(binding.updatedAt) ? Number(binding.updatedAt) : 0,
    };
}

function upsertBindingRecord(
    currentBindings: BindingsByConversationSessionId,
    binding: VoiceSessionBinding,
): BindingsByConversationSessionId {
    return {
        ...Object.fromEntries(
            Object.entries(currentBindings).filter(
                ([conversationSessionId, existing]) =>
                    existing.controlSessionId !== binding.controlSessionId
                    || conversationSessionId === binding.conversationSessionId,
            ),
        ),
        [binding.conversationSessionId]: binding,
    };
}

function buildBindingsByConversationSessionId(
    bindings: ReadonlyArray<VoiceSessionBinding>,
): BindingsByConversationSessionId {
    let nextBindings: BindingsByConversationSessionId = {};
    for (const binding of bindings) {
        const normalized = normalizeBinding(binding);
        if (!normalized) continue;
        nextBindings = upsertBindingRecord(nextBindings, normalized);
    }
    return nextBindings;
}

function buildMergedBindings(
    runtimeBindingsByConversationSessionId: BindingsByConversationSessionId,
    persistedBindingsByConversationSessionId: BindingsByConversationSessionId,
): BindingsByConversationSessionId {
    const bindings = [
        ...Object.values(persistedBindingsByConversationSessionId),
        ...Object.values(runtimeBindingsByConversationSessionId),
    ].sort((left, right) => {
        if (left.updatedAt !== right.updatedAt) {
            return left.updatedAt - right.updatedAt;
        }
        return left.conversationSessionId.localeCompare(right.conversationSessionId);
    });

    return buildBindingsByConversationSessionId(bindings);
}

function listPersistedBindingsFromState(state: SessionServerLookupStateLike): ReadonlyArray<VoiceSessionBinding> {
    const bindings: VoiceSessionBinding[] = [];
    if (!state || typeof state !== 'object') {
        return bindings;
    }
    for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
        if (!session) continue;
        const preferredMetadata = resolveSessionListPreferredSessionMetadataFromState(state, sessionId);
        const binding = readPreferredVoiceConversationBindingMetadata({
            conversationSessionId: sessionId,
            preferredMetadata,
            directMetadata: session.metadata ?? null,
        });
        if (binding) {
            bindings.push(binding);
        }
    }
    return bindings;
}

export function createVoiceSessionBindingStore() {
    return createStore<VoiceSessionBindingStoreState>((set, get) => ({
        bindingsByConversationSessionId: {},
        runtimeBindingsByConversationSessionId: {},
        persistedBindingsByConversationSessionId: {},
        bind: (binding) =>
            set((state) => {
                const normalized = normalizeBinding(binding);
                if (!normalized) return state;
                const runtimeBindingsByConversationSessionId = upsertBindingRecord(
                    state.runtimeBindingsByConversationSessionId,
                    normalized,
                );
                return {
                    ...state,
                    runtimeBindingsByConversationSessionId,
                    bindingsByConversationSessionId: buildMergedBindings(
                        runtimeBindingsByConversationSessionId,
                        state.persistedBindingsByConversationSessionId,
                    ),
                };
            }),
        unbind: (conversationSessionId) =>
            set((state) => {
                const normalized = normalizeId(conversationSessionId);
                if (!normalized) return state;
                const runtimeBindingsByConversationSessionId = { ...state.runtimeBindingsByConversationSessionId };
                delete runtimeBindingsByConversationSessionId[normalized];
                return {
                    ...state,
                    runtimeBindingsByConversationSessionId,
                    bindingsByConversationSessionId: buildMergedBindings(
                        runtimeBindingsByConversationSessionId,
                        state.persistedBindingsByConversationSessionId,
                    ),
                };
            }),
        replacePersistedBindings: (bindings) =>
            set((state) => {
                const persistedBindingsByConversationSessionId = buildBindingsByConversationSessionId(bindings);
                return {
                    ...state,
                    persistedBindingsByConversationSessionId,
                    bindingsByConversationSessionId: buildMergedBindings(
                        state.runtimeBindingsByConversationSessionId,
                        persistedBindingsByConversationSessionId,
                    ),
                };
            }),
        getByConversationSessionId: (conversationSessionId) => {
            const normalized = normalizeId(conversationSessionId);
            if (!normalized) return null;
            return get().bindingsByConversationSessionId[normalized] ?? null;
        },
        getByControlSessionId: (controlSessionId) => {
            const normalized = normalizeId(controlSessionId);
            if (!normalized) return null;
            for (const binding of Object.values(get().bindingsByConversationSessionId)) {
                if (binding.controlSessionId === normalized) return binding;
            }
            return null;
        },
        list: () => Object.values(get().bindingsByConversationSessionId),
    }));
}

export const voiceSessionBindingStore = createVoiceSessionBindingStore();

export function syncPersistedVoiceConversationBindings(params?: Readonly<{
    state?: SessionServerLookupStateLike;
    store?: typeof voiceSessionBindingStore;
}>): void {
    const nextState =
        params?.state
        ?? readRegisteredStorageState()
        ?? { sessions: {} };
    const store = params?.store ?? voiceSessionBindingStore;
    store.getState().replacePersistedBindings(listPersistedBindingsFromState(nextState));
}

syncPersistedVoiceConversationBindings();

subscribeRegisteredStorageState((state) => {
    syncPersistedVoiceConversationBindings({
        state: state as Readonly<{ sessions?: Record<string, any> }>,
    });
});
