import { getPersistenceStorage } from './persistenceStorage';
import {
    sessionViewportRecordStorageKey,
    sessionViewportRecordStoragePrefix,
    sessionViewportStorageKey,
} from './sessionLocalStateKeys';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * Durable per-session transcript viewport anchors (N2b.1, identity-first):
 * the durable unit is the anchor IDENTITY (messageId + seq + intra-item
 * offset); the raw bottom-distance (`offsetY`) survives only as degraded
 * fallback metadata for anchors that cannot be resolved at all.
 *
 * Records use independent server-account+session keys, so one tab cannot
 * overwrite another tab's unrelated session update. Absence of
 * a record means live-tail intent (live-tail DELETES the record — this is how
 * "live-tail beats stale anchor" survives app restarts).
 */

export const MAX_PERSISTED_SESSION_VIEWPORTS = 100;

export type PersistedSessionViewportAnchorKind = 'message' | 'toolGroup' | 'item';

export type PersistedSessionViewportAnchorV1 = Readonly<{
    kind: PersistedSessionViewportAnchorKind;
    messageId: string;
    seq: number | null;
    itemId: string;
    itemOffsetPx: number;
    capturedAtMs: number;
}>;

export type PersistedSessionViewportV1 = Readonly<{
    isPinned: boolean;
    anchor: PersistedSessionViewportAnchorV1 | null;
    /** Raw distance from the bottom in px — degraded fallback metadata only. */
    offsetY: number;
    lastUpdatedAt: number;
}>;

export type PersistedSessionViewportsBySessionId = Record<string, PersistedSessionViewportV1>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isAnchorKind(value: unknown): value is PersistedSessionViewportAnchorKind {
    return value === 'message' || value === 'toolGroup' || value === 'item';
}

function sanitizeAnchor(value: unknown): PersistedSessionViewportAnchorV1 | null {
    if (!isRecord(value)) return null;
    if (!isAnchorKind(value.kind)) return null;
    // Identity-first: an anchor without a message identity is not durable.
    const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : '';
    if (!messageId) return null;
    const itemId = typeof value.itemId === 'string' ? value.itemId.trim() : '';
    if (!itemId) return null;
    const itemOffsetPx = readFiniteNumber(value.itemOffsetPx);
    if (itemOffsetPx === null) return null;
    const capturedAtMs = readFiniteNumber(value.capturedAtMs);
    if (capturedAtMs === null || capturedAtMs < 0) return null;
    // An unknown seq degrades to null without dropping the identity anchor.
    const seq = readFiniteNumber(value.seq);
    return {
        kind: value.kind,
        messageId,
        seq,
        itemId,
        itemOffsetPx,
        capturedAtMs,
    };
}

function sanitizeViewport(value: unknown): PersistedSessionViewportV1 | null {
    if (!isRecord(value)) return null;
    if (typeof value.isPinned !== 'boolean') return null;
    const offsetY = readFiniteNumber(value.offsetY);
    if (offsetY === null) return null;
    const lastUpdatedAt = readFiniteNumber(value.lastUpdatedAt);
    if (lastUpdatedAt === null) return null;
    return {
        isPinned: value.isPinned,
        anchor: sanitizeAnchor(value.anchor),
        offsetY,
        lastUpdatedAt,
    };
}

function sanitizeViewports(input: unknown): PersistedSessionViewportsBySessionId {
    if (!isRecord(input)) return {};
    const output: PersistedSessionViewportsBySessionId = {};
    for (const [sessionId, rawViewport] of Object.entries(input)) {
        if (!sessionId.trim()) continue;
        const viewport = sanitizeViewport(rawViewport);
        if (viewport) {
            output[sessionId] = viewport;
        }
    }
    return output;
}

function capByRecency(viewports: PersistedSessionViewportsBySessionId): PersistedSessionViewportsBySessionId {
    const entries = Object.entries(viewports);
    if (entries.length <= MAX_PERSISTED_SESSION_VIEWPORTS) return viewports;
    entries.sort((a, b) => b[1].lastUpdatedAt - a[1].lastUpdatedAt);
    return Object.fromEntries(entries.slice(0, MAX_PERSISTED_SESSION_VIEWPORTS));
}

type StoredSessionViewportRecord =
    | Readonly<{ kind: 'deleted' }>
    | Readonly<{ kind: 'viewport'; viewport: PersistedSessionViewportV1 }>;

const DELETED_SESSION_VIEWPORT_RECORD = JSON.stringify({ deleted: true });

function parseStoredSessionViewportRecord(raw: string | undefined): StoredSessionViewportRecord | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed) && parsed.deleted === true) return { kind: 'deleted' };
        const viewport = sanitizeViewport(parsed);
        return viewport ? { kind: 'viewport', viewport } : null;
    } catch {
        return null;
    }
}

function loadLegacyPersistedSessionViewports(
    scope?: ServerAccountScope | null,
): PersistedSessionViewportsBySessionId {
    const raw = getPersistenceStorage().getString(sessionViewportStorageKey(scope));
    if (!raw) return {};
    try {
        return sanitizeViewports(JSON.parse(raw));
    } catch {
        return {};
    }
}

function readSessionIdFromRecordKey(key: string, prefix: string): string | null {
    if (!key.startsWith(prefix)) return null;
    try {
        const sessionId = decodeURIComponent(key.slice(prefix.length)).trim();
        return sessionId || null;
    } catch {
        return null;
    }
}

function listStoredSessionViewportRecords(
    scope?: ServerAccountScope | null,
): ReadonlyArray<Readonly<{
    key: string;
    record: StoredSessionViewportRecord;
    sessionId: string;
}>> {
    const storage = getPersistenceStorage();
    const prefix = sessionViewportRecordStoragePrefix(scope);
    const records: Array<Readonly<{
        key: string;
        record: StoredSessionViewportRecord;
        sessionId: string;
    }>> = [];
    for (const key of storage.getAllKeys()) {
        const sessionId = readSessionIdFromRecordKey(key, prefix);
        if (!sessionId) continue;
        const record = parseStoredSessionViewportRecord(storage.getString(key));
        if (record) records.push({ key, record, sessionId });
    }
    return records;
}

/**
 * Compatibility seam for the prospective remote predecessor whole-map writer
 * at e4847518615f2087eb7ace335942c3be1e157270. Active released stable
 * ui-web-v0.2.0 and preview ui-web-v0.2.2-preview.1775585938.1 contain no
 * persisted viewport reader, so they safely ignore v2 keys during
 * rollback/coexistence.
 *
 * Per-session records lazily shadow legacy entries. The legacy key can retire
 * once every legacy session has a viewport or deletion record; no dual writer
 * remains active.
 */
export function loadPersistedSessionViewports(
    scope?: ServerAccountScope | null,
): PersistedSessionViewportsBySessionId {
    const viewports = loadLegacyPersistedSessionViewports(scope);
    for (const { record, sessionId } of listStoredSessionViewportRecords(scope)) {
        if (record.kind === 'deleted') {
            delete viewports[sessionId];
        } else {
            viewports[sessionId] = record.viewport;
        }
    }
    return viewports;
}

function retireLegacyMapIfFullyShadowed(scope?: ServerAccountScope | null): void {
    const legacy = loadLegacyPersistedSessionViewports(scope);
    const legacySessionIds = Object.keys(legacy);
    if (legacySessionIds.length === 0) return;
    const records = listStoredSessionViewportRecords(scope);
    const shadowedSessionIds = new Set(records.map((record) => record.sessionId));
    if (legacySessionIds.every((sessionId) => shadowedSessionIds.has(sessionId))) {
        const storage = getPersistenceStorage();
        storage.delete(sessionViewportStorageKey(scope));
        // Deletion records exist only to shadow an entry while the legacy map
        // remains. Once that map retires, restore canonical absence=live-tail.
        for (const { key, record } of records) {
            if (record.kind === 'deleted') storage.delete(key);
        }
    }
}

function prunePersistedSessionViewportsByRecency(scope?: ServerAccountScope | null): void {
    const viewports = loadPersistedSessionViewports(scope);
    const retained = capByRecency(viewports);
    if (Object.keys(retained).length === Object.keys(viewports).length) return;

    const storage = getPersistenceStorage();
    const legacy = loadLegacyPersistedSessionViewports(scope);
    for (const [sessionId, candidate] of Object.entries(viewports)) {
        if (sessionId in retained) continue;
        const key = sessionViewportRecordStorageKey(sessionId, scope);
        const candidateRaw = storage.getString(key);
        const candidateRecord = parseStoredSessionViewportRecord(candidateRaw);
        if (
            candidateRecord?.kind === 'viewport' &&
            candidateRecord.viewport.lastUpdatedAt !== candidate.lastUpdatedAt
        ) {
            continue;
        }
        // Best-effort stale-recency guard: do not delete a record another tab
        // refreshed after this cleanup computed its candidate set.
        if (storage.getString(key) !== candidateRaw) continue;
        if (sessionId in legacy) {
            storage.set(key, DELETED_SESSION_VIEWPORT_RECORD);
        } else {
            storage.delete(key);
        }
    }
    retireLegacyMapIfFullyShadowed(scope);
}

export function readPersistedSessionViewport(
    sessionId: string,
    scope?: ServerAccountScope | null,
): PersistedSessionViewportV1 | null {
    if (!sessionId.trim()) return null;
    const record = parseStoredSessionViewportRecord(
        getPersistenceStorage().getString(sessionViewportRecordStorageKey(sessionId, scope)),
    );
    if (record?.kind === 'deleted') return null;
    if (record?.kind === 'viewport') return record.viewport;
    return loadLegacyPersistedSessionViewports(scope)[sessionId] ?? null;
}

export function upsertPersistedSessionViewport(
    sessionId: string,
    viewport: PersistedSessionViewportV1,
    scope?: ServerAccountScope | null,
): void {
    if (!sessionId.trim()) return;
    const sanitized = sanitizeViewport(viewport);
    if (!sanitized) return;
    const storage = getPersistenceStorage();
    const key = sessionViewportRecordStorageKey(sessionId, scope);
    const refreshesExistingRecord =
        parseStoredSessionViewportRecord(storage.getString(key))?.kind === 'viewport';
    storage.set(key, JSON.stringify(sanitized));
    // Scroll observations refresh the active session at frame cadence. The
    // record count cannot grow on that path, so global enumeration/sorting is
    // reserved for the first canonical write of a session.
    if (refreshesExistingRecord) return;
    prunePersistedSessionViewportsByRecency(scope);
    retireLegacyMapIfFullyShadowed(scope);
}

export function deletePersistedSessionViewport(
    sessionId: string,
    scope?: ServerAccountScope | null,
): void {
    if (!sessionId.trim()) return;
    const storage = getPersistenceStorage();
    const key = sessionViewportRecordStorageKey(sessionId, scope);
    const legacy = loadLegacyPersistedSessionViewports(scope);
    if (sessionId in legacy) {
        storage.set(key, DELETED_SESSION_VIEWPORT_RECORD);
    } else {
        storage.delete(key);
    }
    retireLegacyMapIfFullyShadowed(scope);
}

export function clearPersistedSessionViewports(scope?: ServerAccountScope | null): void {
    const storage = getPersistenceStorage();
    storage.delete(sessionViewportStorageKey(scope));
    const prefix = sessionViewportRecordStoragePrefix(scope);
    for (const key of storage.getAllKeys()) {
        if (key.startsWith(prefix)) storage.delete(key);
    }
}
