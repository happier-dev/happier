import { MMKV } from 'react-native-mmkv';
import { z } from 'zod';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

var warmCacheStorage: MMKV | null = null;
let warmCacheAccountScope: string | null = null;

function getWarmCacheStorage(): MMKV {
    if (warmCacheStorage) return warmCacheStorage;
    const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
    warmCacheStorage = storageScope ? new MMKV({ id: scopedStorageId('default', storageScope) }) : new MMKV();
    return warmCacheStorage;
}

const SESSION_LIST_WARM_CACHE_PREFIX = 'session-list-warm-cache-v1';
const MACHINE_DISPLAY_WARM_CACHE_PREFIX = 'machine-display-warm-cache-v1';

export const SessionListCacheEntryV1Schema = z.object({
    sessionId: z.string().min(1),
    metadataVersion: z.number().int().nonnegative(),
    agentStateVersion: z.number().int().nonnegative(),
    updatedAt: z.number(),
    createdAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    archivedAt: z.number().nullable(),
    pendingCount: z.number().int().nonnegative().optional(),
    pendingVersion: z.number().int().nonnegative().optional(),
    accessLevel: z.enum(['view', 'edit', 'admin']).optional(),
    canApprovePermissions: z.boolean().optional(),
    name: z.string().optional(),
    summaryText: z.string().nullable().optional(),
    path: z.string(),
    homeDir: z.string().nullable().optional(),
    host: z.string().nullable().optional(),
    machineId: z.string().nullable().optional(),
    flavor: z.string().nullable().optional(),
    directSessionV1: z.object({
        v: z.literal(1),
        providerId: z.string().optional(),
    }).nullable().optional(),
    hiddenSystemSession: z.boolean().optional(),
    hasPendingPermissionRequests: z.boolean().optional(),
    hasPendingUserActionRequests: z.boolean().optional(),
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
    if (!raw) return null;

    try {
        const parsedJson = JSON.parse(raw);
        const parsed = schema.safeParse(parsedJson);
        if (!parsed.success) {
            storage.delete(key);
            return null;
        }
        return parsed.data;
    } catch {
        storage.delete(key);
        return null;
    }
}

function saveScopedRecord<T extends Record<string, unknown>>(key: string | null, value: T): void {
    if (!key) return;
    const storage = getWarmCacheStorage();
    if (Object.keys(value).length === 0) {
        storage.delete(key);
        return;
    }
    storage.set(key, JSON.stringify(value));
}

export function loadSessionListWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, SessionListCacheEntryV1> {
    return loadScopedRecord(buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId), SessionListCacheEntriesSchema) ?? {};
}

export function saveSessionListWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, SessionListCacheEntryV1>,
): void {
    saveScopedRecord(buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId), entries);
}

export function loadMachineDisplayWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, MachineDisplayCacheEntryV1> {
    return loadScopedRecord(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId), MachineDisplayCacheEntriesSchema) ?? {};
}

export function saveMachineDisplayWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, MachineDisplayCacheEntryV1>,
): void {
    saveScopedRecord(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId), entries);
}
