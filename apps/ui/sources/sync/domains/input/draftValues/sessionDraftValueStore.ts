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

type CacheEntry = {
    values: SessionDraftValueMap;
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

    return { values, dirty };
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
    setSessionFields(cache, sessionId, (fields) => {
        const previous = fields[fieldId];
        if (previous?.v === 1 && areJsonValuesEqual(previous.value, parsed.data)) {
            return;
        }
        fields[fieldId] = {
            v: 1,
            updatedAt: timestamp,
            lastEditedAt: timestamp,
            value: parsed.data as SessionDraftValueByFieldId[FieldId],
        } as StoredSessionDraftValueEnvelope;
    });
}

export function clearSessionDraftValue(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: SessionDraftValueFieldId,
): void {
    const cache = getCache(scope);
    setSessionFields(cache, sessionId, (fields) => {
        delete fields[fieldId];
    });
}

export function clearSessionDraftValuesForSession(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    options: Readonly<{ reason: SessionDraftValueClearReason }>,
): void {
    const cache = getCache(scope);
    setSessionFields(cache, sessionId, (fields) => {
        for (const fieldId of Object.keys(fields) as SessionDraftValueFieldId[]) {
            if (shouldClearSessionDraftValueForReason(fieldId, options.reason)) {
                delete fields[fieldId];
            }
        }
    });
}

export function garbageCollectSessionDraftValues(
    scope: ServerAccountScope | null | undefined,
    options: Readonly<{ now: number }>,
): void {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const cache = getCache(scope);
    for (const [sessionId, fields] of Object.entries(cache.values)) {
        setSessionFields(cache, sessionId, (nextFields) => {
            for (const fieldId of Object.keys(fields) as SessionDraftValueFieldId[]) {
                const ttlDays = SESSION_DRAFT_VALUE_FIELD_CATALOG[fieldId].lifecycle.ttlDays;
                if (!ttlDays) continue;
                const envelope = nextFields[fieldId];
                if (!envelope) continue;
                if (now - envelope.lastEditedAt > ttlDays * DAY_MS) {
                    delete nextFields[fieldId];
                }
            }
        });
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
