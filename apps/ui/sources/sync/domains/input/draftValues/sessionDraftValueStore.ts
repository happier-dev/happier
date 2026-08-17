import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
    loadRawSessionDraftValues,
    saveRawSessionDraftValues,
    type RawSessionDraftValueEnvelope,
} from '@/sync/domains/state/sessionDraftValuesPersistence';

import {
    SESSION_DRAFT_VALUE_FIELD_CATALOG,
    shouldClearSessionDraftValueForReason,
    type SessionDraftValueClearReason,
} from './sessionDraftValueFieldCatalog';
import {
    SESSION_DRAFT_VALUE_SCHEMAS,
    type SessionDraftValueByFieldId,
    type SessionDraftValueEnvelope,
    type SessionDraftValueFieldId,
} from './sessionDraftValueTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

type StoredSessionDraftValueEnvelope = SessionDraftValueEnvelope<SessionDraftValueFieldId>;
type SessionDraftValueMap = Record<string, Partial<Record<SessionDraftValueFieldId, StoredSessionDraftValueEnvelope>>>;
type SessionDraftValueMutationRevisionMap = Record<string, Partial<Record<SessionDraftValueFieldId, number>>>;
type SessionComposerSemanticRevisionMap = Record<string, number>;

type SessionComposerSemanticRevisionBatch = {
    depth: number;
    changed: boolean;
};

type SessionComposerTextMutationTokenRecord = Readonly<{
    id: number;
    revision: number;
}>;

/**
 * A short-lived acknowledgement token joins the immediate visible text change
 * to the later debounced write through the incumbent Session draft owner. It
 * carries no text and is never persisted.
 */
export type SessionComposerTextMutationToken = Readonly<{
    scopeKey: string;
    sessionId: string;
    id: number;
    revision: number;
}>;

/**
 * A captured semantic-draft state for an asynchronous handoff. Both fields
 * come from this store: values preserve exact user intent while the ephemeral
 * revisions distinguish a newer write that happens to reproduce the same
 * value.
 */
export type SessionDraftValueCurrentnessSnapshot = Readonly<{
    values: Readonly<Partial<SessionDraftValueByFieldId>>;
    mutationRevisions: Readonly<Partial<Record<SessionDraftValueFieldId, number>>>;
}>;

type CacheEntry = {
    values: SessionDraftValueMap;
    /**
     * Ephemeral per-field currentness for live composer consumers. This never
     * reaches persistence: a clear remains an absent persisted field, while a
     * caller that intentionally clears an already-empty field can still fence
     * a stale pending-edit restore.
     */
    mutationRevisions: SessionDraftValueMutationRevisionMap;
    /**
     * The one process-local semantic revision projection for an existing
     * Session composer. Text remains owned by session-draft persistence; this
     * only joins that incumbent text owner with the two structured document
     * fields so exact mounted and unmounted adapters share one conflict fence.
     */
    composerSemanticRevisions: SessionComposerSemanticRevisionMap;
    composerSemanticListenersBySessionId: Map<string, Set<() => void>>;
    composerSemanticRevisionBatchesBySessionId: Map<string, SessionComposerSemanticRevisionBatch>;
    composerTextMutationTokensBySessionId: Map<string, SessionComposerTextMutationTokenRecord>;
    nextComposerTextMutationTokenId: number;
    dirty: boolean;
};

const cacheByScopeKey = new Map<string, CacheEntry>();

function scopeCacheKey(scope?: ServerAccountScope | null): string {
    return scope ? `scope:${serverAccountScopeKeySuffix(scope)}` : 'legacy';
}

function areJsonValuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function isSessionDraftValueFieldId(value: string): value is SessionDraftValueFieldId {
    return Object.prototype.hasOwnProperty.call(SESSION_DRAFT_VALUE_SCHEMAS, value);
}

function isFiniteTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseEnvelopeForField<FieldId extends SessionDraftValueFieldId>(
    fieldId: FieldId,
    rawEnvelope: RawSessionDraftValueEnvelope,
): SessionDraftValueEnvelope<FieldId> | null {
    if (rawEnvelope.v !== 1 || !isFiniteTimestamp(rawEnvelope.updatedAt)) return null;
    const parsed = SESSION_DRAFT_VALUE_SCHEMAS[fieldId].safeParse(rawEnvelope.value);
    if (!parsed.success) return null;
    const lastEditedAt = isFiniteTimestamp(rawEnvelope.lastEditedAt)
        ? rawEnvelope.lastEditedAt
        : rawEnvelope.updatedAt;
    return {
        v: 1,
        updatedAt: rawEnvelope.updatedAt,
        lastEditedAt,
        value: parsed.data as SessionDraftValueByFieldId[FieldId],
    };
}

function hydrateCache(scope?: ServerAccountScope | null): CacheEntry {
    const values: SessionDraftValueMap = {};
    let dirty = false;

    for (const [rawSessionId, rawFields] of Object.entries(loadRawSessionDraftValues(scope))) {
        const sessionId = rawSessionId.trim();
        if (!sessionId || !rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
            dirty = true;
            continue;
        }

        const fields: SessionDraftValueMap[string] = {};
        for (const [rawFieldId, rawEnvelope] of Object.entries(rawFields)) {
            if (!isSessionDraftValueFieldId(rawFieldId)) {
                dirty = true;
                continue;
            }
            if (!rawEnvelope || typeof rawEnvelope !== 'object' || Array.isArray(rawEnvelope)) {
                dirty = true;
                continue;
            }
            const parsed = parseEnvelopeForField(rawFieldId, rawEnvelope as RawSessionDraftValueEnvelope);
            if (!parsed) {
                dirty = true;
                continue;
            }
            fields[rawFieldId] = parsed as StoredSessionDraftValueEnvelope;
        }

        if (Object.keys(fields).length > 0) values[sessionId] = fields;
    }

    return {
        values,
        mutationRevisions: {},
        composerSemanticRevisions: {},
        composerSemanticListenersBySessionId: new Map(),
        composerSemanticRevisionBatchesBySessionId: new Map(),
        composerTextMutationTokensBySessionId: new Map(),
        nextComposerTextMutationTokenId: 0,
        dirty,
    };
}

function getCache(scope?: ServerAccountScope | null): CacheEntry {
    const key = scopeCacheKey(scope);
    const existing = cacheByScopeKey.get(key);
    if (existing) return existing;
    const cache = hydrateCache(scope);
    cacheByScopeKey.set(key, cache);
    return cache;
}

function setSessionFields(
    cache: CacheEntry,
    sessionId: string,
    updater: (fields: SessionDraftValueMap[string]) => void,
): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    const previousFields = cache.values[normalizedSessionId] ?? {};
    const fields = { ...(cache.values[normalizedSessionId] ?? {}) };
    updater(fields);
    if (areJsonValuesEqual(previousFields, fields)) {
        return;
    }
    if (Object.keys(fields).length > 0) {
        cache.values[normalizedSessionId] = fields;
    } else {
        delete cache.values[normalizedSessionId];
    }
    cache.dirty = true;
}

function normalizedSessionId(sessionId: string): string | null {
    const normalized = sessionId.trim();
    return normalized.length > 0 ? normalized : null;
}

function isSessionComposerSemanticField(fieldId: SessionDraftValueFieldId): boolean {
    return fieldId === 'structuredInput.mentions' || fieldId === 'structuredInput.composerAttachments';
}

function emitSessionComposerSemanticRevision(
    cache: CacheEntry,
    sessionId: string,
): void {
    for (const listener of cache.composerSemanticListenersBySessionId.get(sessionId) ?? []) {
        listener();
    }
}

function advanceSessionComposerSemanticRevisionInCache(
    cache: CacheEntry,
    sessionId: string,
): number {
    const current = cache.composerSemanticRevisions[sessionId] ?? 0;
    const batch = cache.composerSemanticRevisionBatchesBySessionId.get(sessionId);
    if (batch) {
        batch.changed = true;
        return current + 1;
    }
    const next = current + 1;
    cache.composerSemanticRevisions[sessionId] = next;
    emitSessionComposerSemanticRevision(cache, sessionId);
    return next;
}

/**
 * Reads the one process-local revision for all mutable semantic Session draft
 * fields. The persisted text remains in `session-drafts`; callers advance this
 * projection when that text owner changes so no second text store is created.
 */
export function readSessionComposerSemanticRevision(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
): number {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return 0;
    return getCache(scope).composerSemanticRevisions[normalized] ?? 0;
}

/**
 * Advances the existing Session composer's shared conflict fence after a text
 * mutation owned by session-draft persistence, or after a structured field
 * mutation routed below. This counter is never persisted independently.
 */
export function advanceSessionComposerSemanticRevision(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
): number {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return 0;
    return advanceSessionComposerSemanticRevisionInCache(getCache(scope), normalized);
}

/**
 * Records an immediate visible Session text mutation. The later debounce may
 * acknowledge this token through `updateSessionDraft` without incrementing
 * the same semantic revision a second time.
 */
export function createSessionComposerTextMutationToken(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
): SessionComposerTextMutationToken | null {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return null;
    const cache = getCache(scope);
    const id = cache.nextComposerTextMutationTokenId + 1;
    cache.nextComposerTextMutationTokenId = id;
    const expectedRevision = (cache.composerSemanticRevisions[normalized] ?? 0) + 1;
    cache.composerTextMutationTokensBySessionId.set(normalized, { id, revision: expectedRevision });
    const revision = advanceSessionComposerSemanticRevisionInCache(cache, normalized);
    if (revision !== expectedRevision) {
        cache.composerTextMutationTokensBySessionId.set(normalized, { id, revision });
    }
    return Object.freeze({
        scopeKey: scopeCacheKey(scope),
        sessionId: normalized,
        id,
        revision,
    });
}

/**
 * Lets a mounted visual adapter distinguish its own unsaved visible text
 * from an external persisted draft update without owning another text copy.
 */
export function hasSessionComposerTextMutationToken(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
): boolean {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return false;
    return getCache(scope).composerTextMutationTokensBySessionId.has(normalized);
}

/**
 * Consumes only the latest text token for this exact scope/session. Superseded
 * debounced saves fall back to an ordinary semantic advance instead of hiding
 * a real later persistence mutation.
 */
export function consumeSessionComposerTextMutationToken(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    token: SessionComposerTextMutationToken | null | undefined,
): boolean {
    const normalized = normalizedSessionId(sessionId);
    if (
        !normalized
        || !token
        || token.scopeKey !== scopeCacheKey(scope)
        || token.sessionId !== normalized
    ) {
        return false;
    }
    const cache = getCache(scope);
    const current = cache.composerTextMutationTokensBySessionId.get(normalized);
    if (!current || current.id !== token.id || current.revision !== token.revision) return false;
    cache.composerTextMutationTokensBySessionId.delete(normalized);
    return true;
}

/**
 * An external persisted text mutation supersedes any unsaved visible token for
 * this exact draft. If that older debounce later writes, it must advance the
 * semantic revision for its own overwrite rather than silently reusing the
 * revision that belonged to the now-replaced visible state.
 */
export function invalidateSessionComposerTextMutationToken(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
): void {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return;
    getCache(scope).composerTextMutationTokensBySessionId.delete(normalized);
}

/**
 * Coalesces one atomic document commit into one semantic revision/event even
 * when that commit touches text, references, and attachments together.
 */
export function batchSessionComposerSemanticRevision<T>(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    mutate: () => T,
): T {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return mutate();

    const cache = getCache(scope);
    const existing = cache.composerSemanticRevisionBatchesBySessionId.get(normalized);
    const batch = existing ?? { depth: 0, changed: false };
    if (!existing) cache.composerSemanticRevisionBatchesBySessionId.set(normalized, batch);
    batch.depth += 1;
    try {
        return mutate();
    } finally {
        batch.depth -= 1;
        if (batch.depth === 0) {
            cache.composerSemanticRevisionBatchesBySessionId.delete(normalized);
            if (batch.changed) {
                const next = (cache.composerSemanticRevisions[normalized] ?? 0) + 1;
                cache.composerSemanticRevisions[normalized] = next;
                emitSessionComposerSemanticRevision(cache, normalized);
            }
        }
    }
}

/**
 * Exact Session observation for the shared semantic revision. This is scoped
 * to one current-account draft and intentionally does not create a Composer
 * registry or cross-Session subscription.
 */
export function subscribeSessionComposerSemanticRevision(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    listener: () => void,
): () => void {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return () => undefined;
    const cache = getCache(scope);
    const listeners = cache.composerSemanticListenersBySessionId.get(normalized) ?? new Set<() => void>();
    listeners.add(listener);
    cache.composerSemanticListenersBySessionId.set(normalized, listeners);
    return () => {
        const current = cache.composerSemanticListenersBySessionId.get(normalized);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) cache.composerSemanticListenersBySessionId.delete(normalized);
    };
}

function bumpSessionDraftValueMutationRevision(
    cache: CacheEntry,
    sessionId: string,
    fieldId: SessionDraftValueFieldId,
): void {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return;
    const revisions = cache.mutationRevisions[normalized] ?? {};
    const previous = revisions[fieldId] ?? 0;
    cache.mutationRevisions[normalized] = {
        ...revisions,
        [fieldId]: previous + 1,
    };
}

/**
 * A process-local field revision for compare-and-restore UI flows. It is not
 * a persistence version and is reset with the scoped draft cache.
 */
export function readSessionDraftValueMutationRevision(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: SessionDraftValueFieldId,
): number {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return 0;
    return getCache(scope).mutationRevisions[normalized]?.[fieldId] ?? 0;
}

export function readSessionDraftValue<FieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: FieldId,
): SessionDraftValueByFieldId[FieldId] | undefined {
    const fields = getCache(scope).values[sessionId.trim()];
    return fields?.[fieldId]?.value as SessionDraftValueByFieldId[FieldId] | undefined;
}

export function writeSessionDraftValue<FieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: FieldId,
    value: SessionDraftValueByFieldId[FieldId],
    now: number = Date.now(),
): void {
    const parsed = SESSION_DRAFT_VALUE_SCHEMAS[fieldId].safeParse(value);
    if (!parsed.success) return;
    const timestamp = Number.isFinite(now) && now >= 0 ? Math.trunc(now) : Date.now();
    const cache = getCache(scope);
    let changed = false;
    setSessionFields(cache, sessionId, (fields) => {
        const previous = fields[fieldId];
        if (previous?.v === 1 && areJsonValuesEqual(previous.value, parsed.data)) {
            return;
        }
        changed = true;
        fields[fieldId] = {
            v: 1,
            updatedAt: timestamp,
            lastEditedAt: timestamp,
            value: parsed.data as SessionDraftValueByFieldId[FieldId],
        } as StoredSessionDraftValueEnvelope;
    });
    if (!changed) return;
    bumpSessionDraftValueMutationRevision(cache, sessionId, fieldId);
    if (isSessionComposerSemanticField(fieldId)) {
        advanceSessionComposerSemanticRevisionInCache(cache, sessionId.trim());
    }
}

export function clearSessionDraftValue(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: SessionDraftValueFieldId,
): void {
    const cache = getCache(scope);
    let changed = false;
    setSessionFields(cache, sessionId, (fields) => {
        if (typeof fields[fieldId] !== 'undefined') changed = true;
        delete fields[fieldId];
    });
    // An explicit clear of an already-empty field is still a live UI choice.
    // Preserve that fact locally without creating a persisted tombstone.
    bumpSessionDraftValueMutationRevision(cache, sessionId, fieldId);
    if (changed && isSessionComposerSemanticField(fieldId)) {
        advanceSessionComposerSemanticRevisionInCache(cache, sessionId.trim());
    }
}

export function clearSessionDraftValuesForSession(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    options: Readonly<{
        reason: SessionDraftValueClearReason;
        /**
         * When an outbound handoff races new draft edits, clear only fields
         * that still match this store-owned captured state.
         */
        snapshot?: SessionDraftValueCurrentnessSnapshot;
    }>,
): readonly SessionDraftValueFieldId[] {
    const cache = getCache(scope);
    const cleared: SessionDraftValueFieldId[] = [];
    setSessionFields(cache, sessionId, (fields) => {
        for (const fieldId of Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG) as SessionDraftValueFieldId[]) {
            if (!shouldClearSessionDraftValueForReason(fieldId, options.reason)) continue;

            if (options.snapshot) {
                const expectedValue = options.snapshot.values[fieldId];
                const expectedRevision = options.snapshot.mutationRevisions[fieldId];
                const currentValue = fields[fieldId]?.value;
                const currentRevision = cache.mutationRevisions[sessionId.trim()]?.[fieldId] ?? 0;
                if (
                    typeof expectedValue === 'undefined'
                    || typeof expectedRevision !== 'number'
                    || expectedRevision !== currentRevision
                    || !areJsonValuesEqual(currentValue, expectedValue)
                ) continue;
            }

            if (typeof fields[fieldId] === 'undefined') continue;
            delete fields[fieldId];
            bumpSessionDraftValueMutationRevision(cache, sessionId, fieldId);
            cleared.push(fieldId);
        }
    });
    if (cleared.some(isSessionComposerSemanticField)) {
        advanceSessionComposerSemanticRevisionInCache(cache, sessionId.trim());
    }
    return cleared;
}

export function garbageCollectSessionDraftValues(
    scope: ServerAccountScope | null | undefined,
    options: Readonly<{ now: number }>,
): void {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const cache = getCache(scope);
    for (const [sessionId, fields] of Object.entries(cache.values)) {
        let semanticChanged = false;
        setSessionFields(cache, sessionId, (nextFields) => {
            for (const fieldId of Object.keys(fields) as SessionDraftValueFieldId[]) {
                const ttlDays = SESSION_DRAFT_VALUE_FIELD_CATALOG[fieldId].lifecycle.ttlDays;
                if (!ttlDays) continue;
                const envelope = nextFields[fieldId];
                if (!envelope) continue;
                if (now - envelope.lastEditedAt > ttlDays * DAY_MS) {
                    delete nextFields[fieldId];
                    if (isSessionComposerSemanticField(fieldId)) semanticChanged = true;
                }
            }
        });
        if (semanticChanged) advanceSessionComposerSemanticRevisionInCache(cache, sessionId);
    }
}

export function flushSessionDraftValues(scope?: ServerAccountScope | null): void {
    const cache = getCache(scope);
    if (!cache.dirty) return;
    saveRawSessionDraftValues(cache.values as Record<string, Record<string, RawSessionDraftValueEnvelope>>, scope);
    cache.dirty = false;
}

export function invalidateSessionDraftValueCache(scope?: ServerAccountScope | null): void {
    cacheByScopeKey.delete(scopeCacheKey(scope));
}

export function resetSessionDraftValueCachesForTests(): void {
    cacheByScopeKey.clear();
}
