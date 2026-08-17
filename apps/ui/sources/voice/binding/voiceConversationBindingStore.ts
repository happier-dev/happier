import { createStore } from 'zustand/vanilla';

import type { SessionServerLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import { readPreferredVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

type BindingsByConversationSessionId = Record<string, VoiceSessionBinding>;

/**
 * Memory-only ownership for a direct-media runtime binding. It is deliberately
 * a private symbol rather than a timestamp or persisted field: a later
 * generation can reuse every visible binding field (including `updatedAt`) and
 * still must not be unbound by the retiring attempt.
 */
const runtimeAttemptBindingOwner = Symbol('voiceRuntimeAttemptBindingOwner');
type RuntimeAttemptOwnedBinding = VoiceSessionBinding & Readonly<{
    [runtimeAttemptBindingOwner]?: object;
}>;

function readRuntimeAttemptBindingOwner(binding: VoiceSessionBinding): object | null {
    return (binding as RuntimeAttemptOwnedBinding)[runtimeAttemptBindingOwner] ?? null;
}

function withRuntimeAttemptBindingOwner(
    binding: VoiceSessionBinding,
    owner: object,
): VoiceSessionBinding {
    const owned = { ...binding } as RuntimeAttemptOwnedBinding;
    // Enumerable symbols survive the store's object-copy normalization while
    // remaining absent from JSON and metadata serialization.
    Object.defineProperty(owned, runtimeAttemptBindingOwner, {
        configurable: false,
        enumerable: true,
        value: owner,
        writable: false,
    });
    return owned;
}

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
    const transcriptMode = binding.transcriptMode === 'native_session' || binding.transcriptMode === 'synthetic'
        ? binding.transcriptMode
        : null;
    if (!adapterId || !controlSessionId || !conversationSessionId || !transcriptMode) return null;

    const normalized: VoiceSessionBinding = {
        adapterId,
        controlSessionId,
        conversationSessionId,
        ...(binding.lifetime === 'runtime_attempt' ? { lifetime: 'runtime_attempt' as const } : {}),
        transcriptMode,
        targetSessionId: normalizeId(binding.targetSessionId),
        updatedAt: Number.isFinite(binding.updatedAt) ? Number(binding.updatedAt) : 0,
    };
    const owner = readRuntimeAttemptBindingOwner(binding);
    return owner ? withRuntimeAttemptBindingOwner(normalized, owner) : normalized;
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

/**
 * Canonical "which binding wins" comparator. Newest `updatedAt` wins; on an
 * equal-`updatedAt` tie the larger `conversationSessionId` wins. This is the
 * single tie-break used by both the store merge and the resolver so the two read
 * paths cannot diverge (see audit F1/F7).
 */
export function pickNewerVoiceBinding(
    current: VoiceSessionBinding | null,
    candidate: VoiceSessionBinding | null,
): VoiceSessionBinding | null {
    if (!candidate) return current;
    if (!current) return candidate;
    if (candidate.updatedAt !== current.updatedAt) {
        return candidate.updatedAt > current.updatedAt ? candidate : current;
    }
    if (candidate.conversationSessionId !== current.conversationSessionId) {
        return candidate.conversationSessionId > current.conversationSessionId ? candidate : current;
    }
    return candidate;
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

export function listPersistedVoiceBindingsFromState(
    state: SessionServerLookupStateLike,
): ReadonlyArray<VoiceSessionBinding> {
    return listPersistedBindingsFromState(state);
}

function listPersistedBindingsFromState(state: SessionServerLookupStateLike): ReadonlyArray<VoiceSessionBinding> {
    const bindings: VoiceSessionBinding[] = [];
    if (!state || typeof state !== 'object') {
        return bindings;
    }
    for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
        if (!session) continue;
        const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, sessionId);
        const binding = readPreferredVoiceConversationBindingMetadata({
            conversationSessionId: sessionId,
            preferredMetadata: ownerMetadata,
            directMetadata: null,
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
            let resolved: VoiceSessionBinding | null = null;
            for (const binding of Object.values(get().bindingsByConversationSessionId)) {
                if (binding.controlSessionId !== normalized) continue;
                resolved = pickNewerVoiceBinding(resolved, binding);
            }
            return resolved;
        },
        list: () => Object.values(get().bindingsByConversationSessionId),
    }));
}

export const voiceSessionBindingStore = createVoiceSessionBindingStore();

/** Creates a fresh opaque owner for one runtime-attempt binding lifetime. */
export function createVoiceRuntimeAttemptBindingOwner(): object {
    return Object.freeze({});
}

/**
 * Bind through the canonical store while retaining an in-memory exact-owner
 * marker. Callers receive no authority over any binding they did not create.
 */
export function bindVoiceRuntimeAttemptBinding(input: Readonly<{
    binding: VoiceSessionBinding;
    owner: object;
    store?: typeof voiceSessionBindingStore;
}>): void {
    const store = input.store ?? voiceSessionBindingStore;
    store.getState().bind(withRuntimeAttemptBindingOwner(input.binding, input.owner));
}

/**
 * Remove a runtime-attempt binding only when the exact owner still occupies
 * the carrier. Same ids, same fields, and same timestamps are not ownership.
 */
export function unbindVoiceRuntimeAttemptBindingIfOwned(input: Readonly<{
    conversationSessionId: string;
    owner: object;
    store?: typeof voiceSessionBindingStore;
}>): boolean {
    const store = input.store ?? voiceSessionBindingStore;
    const conversationSessionId = normalizeId(input.conversationSessionId);
    if (!conversationSessionId) return false;

    let removed = false;
    store.setState((state) => {
        const current = state.runtimeBindingsByConversationSessionId[conversationSessionId] ?? null;
        if (!current || readRuntimeAttemptBindingOwner(current) !== input.owner) return state;

        const runtimeBindingsByConversationSessionId = {
            ...state.runtimeBindingsByConversationSessionId,
        };
        delete runtimeBindingsByConversationSessionId[conversationSessionId];
        removed = true;
        return {
            ...state,
            runtimeBindingsByConversationSessionId,
            bindingsByConversationSessionId: buildMergedBindings(
                runtimeBindingsByConversationSessionId,
                state.persistedBindingsByConversationSessionId,
            ),
        };
    });
    return removed;
}

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
