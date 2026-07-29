import { MMKV } from 'react-native-mmkv';
import {
    ExternalSessionsSourceSchema,
    parseSessionRuntimeActivityProjectionFields,
    PrimaryTurnStatusV1Schema,
    SessionRuntimeActivityStateSchema,
    SessionRuntimeIssueV1Schema,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

var warmCacheStorage: MMKV | null = null;
let warmCacheAccountScope: string | null = null;
type WarmCacheSavedValue = Readonly<{
    raw: string;
    value: Record<string, unknown>;
}>;
type WarmCacheBootHydrationSchedule = Readonly<{
    cancel: () => void;
    done: Promise<void>;
}>;
type RequestIdleCallbackHandle = ReturnType<NonNullable<typeof globalThis.requestIdleCallback>>;

const warmCacheSavedValueByKey = new Map<string, WarmCacheSavedValue>();

function getWarmCacheStorage(): MMKV {
    if (warmCacheStorage) return warmCacheStorage;
    const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
    warmCacheStorage = storageScope ? new MMKV({ id: scopedStorageId('default', storageScope) }) : new MMKV();
    return warmCacheStorage;
}

const SESSION_LIST_WARM_CACHE_PREFIX = 'session-list-warm-cache-v1';
const MACHINE_DISPLAY_WARM_CACHE_PREFIX = 'machine-display-warm-cache-v1';
const EMPTY_WARM_CACHE_ENTRIES: Record<string, never> = {};
const EMPTY_SESSION_LIST_WARM_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, SessionListCacheEntryV1>;
const EMPTY_MACHINE_DISPLAY_WARM_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, MachineDisplayCacheEntryV1>;

export const SessionListCacheEntryV1Schema = z.object({
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative().optional(),
    metadataLayoutVersion: z.number().int().nonnegative().optional(),
    metadataVersion: z.number().int().nonnegative(),
    agentStateVersion: z.number().int().nonnegative(),
    updatedAt: z.number(),
    meaningfulActivityAt: z.number().nullable().optional(),
    createdAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    archivedAt: z.number().nullable(),
    lastViewedSessionSeq: z.number().int().nonnegative().nullable().optional(),
    pendingCount: z.number().int().nonnegative().optional(),
    pendingBlockedCount: z.number().int().nonnegative().optional(),
    pendingVersion: z.number().int().nonnegative().optional(),
    latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
    latestTurnStatusObservedAt: z.number().int().nonnegative().nullable().optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    runtimeActivityActiveCount: z.number().int().nonnegative().nullable().optional(),
    runtimeActivityState: SessionRuntimeActivityStateSchema.nullable().optional(),
    runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
    runtimeActivityRevision: z.number().int().nonnegative().nullable().optional(),
    runtimeActivitySourceClass: z.never().optional(),
    rollbackEligibleTurnStarts: z.array(z.number().int().nonnegative()).optional(),
    latestReadyEventSeq: z.number().int().nonnegative().nullable().optional(),
    latestReadyEventAt: z.number().int().nonnegative().nullable().optional(),
    pendingRequestObservedAt: z.number().int().nonnegative().nullable().optional(),
    accessLevel: z.enum(['view', 'edit', 'admin']).optional(),
    canApprovePermissions: z.boolean().optional(),
    name: z.string().optional(),
    summaryText: z.string().nullable().optional(),
    path: z.string(),
    homeDir: z.string().nullable().optional(),
    host: z.string().nullable().optional(),
    machineId: z.string().nullable().optional(),
    flavor: z.string().nullable().optional(),
    externalSessionV1: z.object({
        v: z.literal(1),
        agentId: z.string().min(1),
        machineId: z.string().min(1),
        remoteSessionId: z.string().min(1),
        source: ExternalSessionsSourceSchema,
        codexBackendMode: z.string().optional(),
    }).passthrough().nullable().optional(),
    hiddenSystemSession: z.boolean().optional(),
    keepVisibleWhenInactive: z.boolean().optional(),
    hasPendingPermissionRequests: z.boolean().optional(),
    hasPendingUserActionRequests: z.boolean().optional(),
    hasUnreadMessages: z.boolean().optional(),
}).superRefine((entry, context) => {
    if (parseSessionRuntimeActivityProjectionFields(entry).kind === 'invalid') {
        context.addIssue({
            code: 'custom',
            message: 'Runtime Activity must be absent or a complete validated tuple',
        });
    }
});

export type SessionListCacheEntryV1 = z.infer<typeof SessionListCacheEntryV1Schema>;

export const MachineDisplayCacheEntryV1Schema = z.object({
    machineId: z.string().min(1),
    metadataVersion: z.number().int().nonnegative(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    revokedAt: z.number().nullable(),
    displayName: z.string().nullable().optional(),
    host: z.string().nullable().optional(),
    homeDir: z.string().nullable().optional(),
});

export type MachineDisplayCacheEntryV1 = z.infer<typeof MachineDisplayCacheEntryV1Schema>;

const SessionListCacheEntriesSchema = z.record(z.string(), SessionListCacheEntryV1Schema);
const MachineDisplayCacheEntriesSchema = z.record(z.string(), MachineDisplayCacheEntryV1Schema);

function normalizeScopePart(value: string | null | undefined): string {
    const normalized = String(value ?? '').trim();
    return normalized;
}

function hasAnyOwnEntries(record: Readonly<Record<string, unknown>> | null | undefined): boolean {
    const source = record ?? {};
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            return true;
        }
    }
    return false;
}

export function setWarmCacheAccountScope(accountId: string | null | undefined): void {
    warmCacheAccountScope = normalizeScopePart(accountId) || null;
}

export function clearWarmCacheAccountScope(): void {
    warmCacheAccountScope = null;
}

export function resolveWarmCacheAccountScope(accountId: string | null | undefined): string | null {
    return warmCacheAccountScope ?? (normalizeScopePart(accountId) || null);
}

function buildScopedKey(prefix: string, serverId: string | null | undefined, accountId: string | null | undefined): string | null {
    const normalizedServerId = normalizeScopePart(serverId);
    const normalizedAccountId = normalizeScopePart(accountId);
    if (!normalizedServerId || !normalizedAccountId) return null;
    return `${prefix}:${normalizedServerId}:${normalizedAccountId}`;
}

function loadScopedRecord<T>(
    key: string | null,
    schema: z.ZodType<T>,
): T | null {
    if (!key) return null;
    const storage = getWarmCacheStorage();
    const raw = storage.getString(key);
    if (!raw) {
        warmCacheSavedValueByKey.delete(key);
        return null;
    }

    const cachedValue = warmCacheSavedValueByKey.get(key);
    if (cachedValue?.raw === raw) {
        return cachedValue.value as T;
    }

    try {
        const parsedJson = JSON.parse(raw);
        const parsed = schema.safeParse(parsedJson);
        if (!parsed.success) {
            storage.delete(key);
            warmCacheSavedValueByKey.delete(key);
            return null;
        }
        warmCacheSavedValueByKey.set(key, { raw, value: parsed.data as Record<string, unknown> });
        return parsed.data;
    } catch {
        storage.delete(key);
        warmCacheSavedValueByKey.delete(key);
        return null;
    }
}

function saveScopedRecord<T extends Record<string, unknown>>(key: string | null, value: T): void {
    if (!key) return;
    const storage = getWarmCacheStorage();
    if (!hasAnyOwnEntries(value)) {
        if (storage.getString(key) !== undefined) {
            storage.delete(key);
        }
        warmCacheSavedValueByKey.delete(key);
        return;
    }
    const cachedValue = warmCacheSavedValueByKey.get(key);
    if (cachedValue?.value === value) {
        return;
    }
    const nextRaw = JSON.stringify(value);
    if (storage.getString(key) === nextRaw) {
        warmCacheSavedValueByKey.set(key, { raw: nextRaw, value });
        return;
    }
    storage.set(key, nextRaw);
    warmCacheSavedValueByKey.set(key, { raw: nextRaw, value });
}

function peekScopedRecord<T extends Record<string, unknown>>(key: string | null): T | null {
    if (!key) return null;
    return (warmCacheSavedValueByKey.get(key)?.value as T | undefined) ?? null;
}

function normalizeEmptyWarmCacheRecord<T extends Record<string, unknown>>(value: T): T {
    return hasAnyOwnEntries(value) ? value : (EMPTY_WARM_CACHE_ENTRIES as T);
}

export function scheduleWarmCacheBootHydration(
    task: () => void,
    options?: Readonly<{ fallbackDelayMs?: number }>,
): WarmCacheBootHydrationSchedule {
    const fallbackDelayMs = typeof options?.fallbackDelayMs === 'number' && Number.isFinite(options.fallbackDelayMs)
        ? Math.max(0, Math.trunc(options.fallbackDelayMs))
        : 100;
    const requestIdleCallback = globalThis.requestIdleCallback;
    const cancelIdleCallback = globalThis.cancelIdleCallback;
    let idleHandle: RequestIdleCallbackHandle | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });

    const clearPending = (): void => {
        if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }
        if (idleHandle !== null && typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(idleHandle);
            idleHandle = null;
        }
    };
    const run = (): void => {
        if (settled) return;
        settled = true;
        clearPending();
        try {
            task();
        } finally {
            resolveDone();
        }
    };

    if (typeof requestIdleCallback === 'function') {
        idleHandle = requestIdleCallback(run, { timeout: fallbackDelayMs });
    }
    fallbackTimer = setTimeout(run, fallbackDelayMs);

    return {
        cancel: () => {
            if (settled) return;
            settled = true;
            clearPending();
            resolveDone();
        },
        done,
    };
}

export function loadSessionListWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, SessionListCacheEntryV1> {
    const loaded = loadScopedRecord(buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId), SessionListCacheEntriesSchema);
    if (!loaded) return EMPTY_SESSION_LIST_WARM_CACHE_ENTRIES;
    return normalizeEmptyWarmCacheRecord(loaded);
}

export function peekSessionListWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, SessionListCacheEntryV1> | null {
    return peekScopedRecord(buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId));
}

export function saveSessionListWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, SessionListCacheEntryV1>,
): void {
    saveScopedRecord(buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId), entries);
}

export function loadMachineDisplayWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, MachineDisplayCacheEntryV1> {
    const loaded = loadScopedRecord(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId), MachineDisplayCacheEntriesSchema);
    if (!loaded) return EMPTY_MACHINE_DISPLAY_WARM_CACHE_ENTRIES;
    return hasAnyOwnEntries(loaded) ? loaded : (EMPTY_MACHINE_DISPLAY_WARM_CACHE_ENTRIES as Record<string, MachineDisplayCacheEntryV1>);
}

export function saveMachineDisplayWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, MachineDisplayCacheEntryV1>,
): void {
    saveScopedRecord(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId), entries);
}
