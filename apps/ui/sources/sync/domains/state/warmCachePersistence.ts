import { MMKV } from 'react-native-mmkv';
import {
    ExternalSessionsSourceSchema,
    normalizeLinkedExternalSessionMetadataV1,
    parseSessionRuntimeActivityProjectionFields,
    PluginAgentExternalSessionLinkDataSchema,
    PluginProjectionV2Schema,
    PrimaryTurnStatusV1Schema,
    RuntimeDescriptorV1Schema,
    SessionRuntimeActivityStateSchema,
    SessionRuntimeIssueV1Schema,
} from '@happier-dev/protocol';
import { PluginUiTargetedContributionsV1Schema } from '@happier-dev/protocol/plugins/ui';
import { z } from 'zod';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { prepareWarmCacheEncryptionKey, readResolvedWarmCacheEncryptionKey } from './warmCacheEncryptionKey';

/**
 * The same predicate the rest of this corridor uses (`state/persistence.ts`,
 * `warmCacheEncryptionKey.ts`): React Native defines `window` but never `document`, so a DOM
 * document is what actually separates the browser and Tauri desktop bundles from a native build.
 * Evaluated per call rather than once at import, so nothing here depends on when this module
 * happens to be first imported.
 */
function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

var warmCacheStorage: MMKV | null = null;
let warmCacheStorageUnopenable = false;
let legacyPlaintextWarmCachePurged = false;
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

/**
 * On a native build everything this module persists is decrypted session content — names,
 * summaries, filesystem paths, hostnames — so it lives in an encrypted MMKV instance of its own
 * rather than in the shared `default` one.
 *
 * The instance is separate for two reasons that both bite: an existing plaintext MMKV file cannot
 * be reopened with an encryption key, and `default` is shared with `state/persistence.ts` and
 * Sentry, so it is not this module's to re-key. A new id lets the cache repopulate on the next
 * refresh, which costs one cold boot and nothing else, because every byte here is derived state.
 */
export const WARM_CACHE_STORAGE_ID = 'warm-cache-v2';

/**
 * MMKV's no-argument instance is `mmkv.default`, not `default` (`react-native-mmkv/src/MMKV.ts`
 * defaults the whole configuration to `{ id: 'mmkv.default' }`). Naming it here keeps the shared
 * instance one expression, so the web store and the native purge cannot drift onto different bytes.
 */
const DEFAULT_MMKV_STORAGE_ID = 'mmkv.default';

function sharedDefaultStorageId(storageScope: string | null): string {
    return storageScope ? scopedStorageId('default', storageScope) : DEFAULT_MMKV_STORAGE_ID;
}

function warmCacheStorageScope(): string | null {
    return isWebRuntime() ? null : readStorageScopeFromEnv();
}

/**
 * The prefixes older native builds wrote into the shared unencrypted instance. Moving to a new id
 * would only orphan those bytes; the plaintext titles and paths would still be sitting in the old
 * memory-mapped file. First use deletes them by prefix — surgically, because the instance holds
 * unrelated state this module does not own.
 */
const LEGACY_PLAINTEXT_PURGE_COMPACTION_KEY = 'warm-cache-plaintext-purge-compaction-v1';
// MMKV starts at one page and `trim()` skips rewriting files that have not grown beyond their
// expected capacity. This deliberately exceeds that floor so the first trim must perform a full
// writeback after the sensitive keys have been deleted.
const LEGACY_PLAINTEXT_PURGE_COMPACTION_VALUE = '0'.repeat(16 * 1024);

function purgeLegacyPlaintextWarmCache(storageScope: string | null): void {
    if (legacyPlaintextWarmCachePurged) return;
    // Web has no legacy copy to retire, because it never moved: `resolveWarmCacheStoragePlacement`
    // still reads and writes these very keys. Purging them here would delete the live warm cache on
    // every page load — the same blank-then-refetch-then-re-decrypt boot the placement rule exists
    // to prevent, arriving by a second route.
    if (isWebRuntime()) return;
    legacyPlaintextWarmCachePurged = true;
    try {
        const legacyStorage = new MMKV({ id: sharedDefaultStorageId(storageScope) });
        let purgedAny = false;
        for (const key of legacyStorage.getAllKeys()) {
            if (LEGACY_PLAINTEXT_WARM_CACHE_PREFIXES.some((prefix) => key.startsWith(`${prefix}:`))) {
                legacyStorage.delete(key);
                purgedAny = true;
            }
        }
        // `delete` alone does not retire the plaintext. MMKV's file is append-only: a delete writes a
        // tombstone and the earlier value's bytes stay in the mmap until the file is rewritten. A bare
        // `trim()` is not sufficient either: MMKV returns early when the file has not grown beyond its
        // expected capacity. Temporarily writing an oversized non-sensitive value forces growth, so the
        // first trim performs a full writeback without the deleted cache entries. The second trim
        // removes the temporary value and returns the file to its normal size.
        //
        // This is the last point at which the application can act. Bytes already written may still
        // survive below it — filesystem journaling, copy-on-write snapshots, and flash wear levelling
        // all retain prior copies that no userspace call can reach. Compaction is the correct and
        // complete application-level action, not a guarantee about the physical medium.
        if (purgedAny) {
            legacyStorage.set(
                LEGACY_PLAINTEXT_PURGE_COMPACTION_KEY,
                LEGACY_PLAINTEXT_PURGE_COMPACTION_VALUE,
            );
            legacyStorage.trim();
            legacyStorage.delete(LEGACY_PLAINTEXT_PURGE_COMPACTION_KEY);
            legacyStorage.trim();
        }
    } catch {
        // Nothing to purge is indistinguishable from nothing readable, and neither is worth a boot
        // failure over derived state.
    }
}

/**
 * Boot's single entry point into this module's at-rest concerns: retire the plaintext bytes older
 * builds left behind, and settle the key the synchronous accessors below need.
 *
 * The purge runs here rather than lazily on first read because a signed-out or never-hydrated boot
 * never reaches a read, and that is exactly the boot where the old plaintext would otherwise sit on
 * disk indefinitely. Neither half can reject: both failures mean "cold boot", never "broken boot".
 */
export async function prepareWarmCacheStorage(): Promise<void> {
    purgeLegacyPlaintextWarmCache(warmCacheStorageScope());
    await prepareWarmCacheEncryptionKey();
}

/**
 * Where this runtime's warm cache lives and whether it is encrypted at rest — the single decision,
 * so there is no second per-platform storage path to keep in step.
 *
 * **Native is encrypted.** Credentials live in the OS keystore (`nativeSecureStoreWithDevFallback`)
 * and MMKV does not, so an unencrypted cache file would be the one place decrypted session names,
 * summaries, paths and hostnames sit readable without the keystore. That asymmetry is real and the
 * encryption closes it.
 *
 * **Web and the Tauri desktop shell are plaintext, deliberately.** `tokenStorage.ts` stores the auth
 * credential — the API token *and* the E2EE secret — in plain `localStorage` on web. Anyone who can
 * read this cache can already read the secret that decrypts the whole account and the token that
 * fetches it, so encrypting the cache adds no exposure class; it only removes the cache. And it
 * removes it entirely rather than partially: MMKV's web backend *throws* on `encryptionKey`
 * (`react-native-mmkv/src/createMMKV.web.ts`), which turns the store into a permanent miss, so every
 * page load paints an empty list, refetches, and re-decrypts every row.
 *
 * Revisit this together with web credential storage, not on its own: the day the token and secret
 * stop living in `localStorage`, the trade above stops holding and this cache becomes the weakest
 * thing in it.
 *
 * `null` is returned only when a store genuinely cannot be produced, and means exactly one thing to
 * every caller: treat the cache as a miss. On native that is a keystore that failed or was cleared,
 * and the window before boot has resolved the key. It is not latched while the key is still missing,
 * so a boot that raced ahead of the keystore starts persisting as soon as it lands.
 */
function resolveWarmCacheStoragePlacement(
    storageScope: string | null,
): Readonly<{ id: string; encryptionKey?: string }> | null {
    if (isWebRuntime()) return { id: sharedDefaultStorageId(storageScope) };
    const encryptionKey = readResolvedWarmCacheEncryptionKey();
    if (!encryptionKey) return null;
    return { id: scopedStorageId(WARM_CACHE_STORAGE_ID, storageScope), encryptionKey };
}

/**
 * The warm-cache store, or `null` when this runtime cannot produce one — see
 * `resolveWarmCacheStoragePlacement` for which runtimes those are and why.
 */
function getWarmCacheStorage(): MMKV | null {
    if (warmCacheStorage) return warmCacheStorage;
    if (warmCacheStorageUnopenable) return null;
    const storageScope = warmCacheStorageScope();
    purgeLegacyPlaintextWarmCache(storageScope);

    const placement = resolveWarmCacheStoragePlacement(storageScope);
    if (!placement) return null;

    try {
        warmCacheStorage = new MMKV(placement);
    } catch {
        // A store we cannot open stays unopened for this process: retrying per read would turn one
        // unusable cache into a throw on every session-list update.
        warmCacheStorageUnopenable = true;
        warmCacheStorage = null;
    }
    return warmCacheStorage;
}

const SESSION_LIST_WARM_CACHE_PREFIX = 'session-list-warm-cache-v1';
const MACHINE_DISPLAY_WARM_CACHE_PREFIX = 'machine-display-warm-cache-v1';
/**
 * The Account-qualified last-confirmed plugin UI admission snapshot, one entry
 * per described machine. It is deliberately absent from the legacy plaintext
 * purge list below: no shipped build ever wrote this family into the shared
 * unencrypted instance, so there is nothing there to retire.
 */
const PLUGIN_UI_PROJECTION_WARM_CACHE_PREFIX = 'plugin-ui-projection-warm-cache-v1';
/**
 * The prefixes older native builds wrote into the shared unencrypted instance. Moving to a new id
 * would only orphan those bytes; the plaintext titles and paths would still be sitting in the old
 * memory-mapped file. First use deletes them by prefix — surgically, because the instance holds
 * unrelated state this module does not own.
 */
const LEGACY_PLAINTEXT_WARM_CACHE_PREFIXES: readonly string[] = [
    SESSION_LIST_WARM_CACHE_PREFIX,
    MACHINE_DISPLAY_WARM_CACHE_PREFIX,
];
const EMPTY_WARM_CACHE_ENTRIES: Record<string, never> = {};
const EMPTY_SESSION_LIST_WARM_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, SessionListCacheEntryV1>;
const EMPTY_MACHINE_DISPLAY_WARM_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, MachineDisplayCacheEntryV1>;
const EMPTY_PLUGIN_UI_PROJECTION_WARM_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<
    string,
    PluginUiProjectionCacheEntryV1
>;

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
    externalSessionV1: z.preprocess(
        (value) => normalizeLinkedExternalSessionMetadataV1({ externalSessionV1: value })
            ?.externalSessionV1 ?? value,
        z.object({
            v: z.literal(1),
            agentId: z.string().min(1),
            machineId: z.string().min(1),
            remoteSessionId: z.string().min(1),
            source: ExternalSessionsSourceSchema,
            runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
            linkData: PluginAgentExternalSessionLinkDataSchema.optional(),
            codexBackendMode: z.never().optional(),
        }).passthrough(),
    ).nullable().optional(),
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
    replacedByMachineId: z.string().nullable().optional(),
    replacedAt: z.union([z.number(), z.string()]).nullable().optional(),
    replacementReason: z.string().nullable().optional(),
    replacementSource: z.string().nullable().optional(),
    replacementActorUserId: z.string().nullable().optional(),
    lockedReason: z.enum([
        'encryption_material_unavailable',
        'decryption_failed',
        'content_unreadable',
    ]).nullable().optional(),
    displayName: z.string().nullable().optional(),
    host: z.string().nullable().optional(),
    homeDir: z.string().nullable().optional(),
});

export type MachineDisplayCacheEntryV1 = z.infer<typeof MachineDisplayCacheEntryV1Schema>;

/**
 * One machine's last-confirmed plugin UI admission snapshot. The stored
 * `projection` is a strict subset of the canonical daemon projection built by
 * `plugins/ui/projectionWarmCache.ts`; it is validated here with the canonical
 * Protocol schema so a restored snapshot can never be a looser local shape.
 *
 * `targetedContributionsByPluginId` holds the last-confirmed target-scoped
 * admission that accompanied a successful describe for a plugin the same
 * `projection` still admits. It lives inside this one entry so the presentation
 * slice and the target admission that proves it are written and restored
 * together; a fresh offline process can therefore never hold one without the
 * other.
 */
export const PluginUiProjectionCacheEntryV1Schema = z.object({
    machineId: z.string().min(1),
    projection: PluginProjectionV2Schema,
    targetedContributionsByPluginId: z.record(
        z.string().min(1),
        PluginUiTargetedContributionsV1Schema,
    ).optional(),
});

export type PluginUiProjectionCacheEntryV1 = z.infer<typeof PluginUiProjectionCacheEntryV1Schema>;

const SessionListCacheEntriesSchema = z.record(z.string(), SessionListCacheEntryV1Schema);
const MachineDisplayCacheEntriesSchema = z.record(z.string(), MachineDisplayCacheEntryV1Schema);
const PluginUiProjectionCacheEntriesSchema = z.record(z.string(), PluginUiProjectionCacheEntryV1Schema);

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
    if (!storage) return null;
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
    if (!storage) return;
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

export function peekMachineDisplayWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, MachineDisplayCacheEntryV1> | null {
    const normalizedServerId = normalizeScopePart(serverId);
    const normalizedAccountId = normalizeScopePart(accountId);
    if (normalizedServerId && normalizedAccountId) {
        const scheduled = pendingMachineDisplayWarmCacheSaves.get(`${normalizedServerId}\u0000${normalizedAccountId}`);
        if (scheduled) return scheduled.entries;
    }
    return peekScopedRecord(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId));
}

export function saveMachineDisplayWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, MachineDisplayCacheEntryV1>,
): void {
    saveScopedRecord(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId), entries);
}

export function loadPluginUiProjectionWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): Record<string, PluginUiProjectionCacheEntryV1> {
    const loaded = loadScopedRecord(
        buildScopedKey(PLUGIN_UI_PROJECTION_WARM_CACHE_PREFIX, serverId, accountId),
        PluginUiProjectionCacheEntriesSchema,
    );
    if (!loaded) return EMPTY_PLUGIN_UI_PROJECTION_WARM_CACHE_ENTRIES;
    return normalizeEmptyWarmCacheRecord(loaded);
}

export function savePluginUiProjectionWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, PluginUiProjectionCacheEntryV1>,
): void {
    saveScopedRecord(buildScopedKey(PLUGIN_UI_PROJECTION_WARM_CACHE_PREFIX, serverId, accountId), entries);
}

type PendingMachineDisplayWarmCacheSave = Readonly<{
    serverId: string;
    accountId: string;
    entries: Record<string, MachineDisplayCacheEntryV1>;
}>;

const pendingMachineDisplayWarmCacheSaves = new Map<string, PendingMachineDisplayWarmCacheSave>();
let pendingMachineDisplayWarmCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Coalesces independent active/non-active server display snapshots by their
 * exact local cache scope. This is presentation persistence only; callers must
 * never infer live routing authority from a saved entry.
 */
export function scheduleMachineDisplayWarmCacheEntriesSave(
    serverIdRaw: string | null | undefined,
    accountIdRaw: string | null | undefined,
    entries: Record<string, MachineDisplayCacheEntryV1>,
): void {
    const serverId = normalizeScopePart(serverIdRaw);
    const accountId = normalizeScopePart(accountIdRaw);
    if (!serverId || !accountId) return;
    const key = `${serverId}\u0000${accountId}`;
    pendingMachineDisplayWarmCacheSaves.set(key, { serverId, accountId, entries });
    if (pendingMachineDisplayWarmCacheSaveTimer) return;
    pendingMachineDisplayWarmCacheSaveTimer = setTimeout(() => {
        pendingMachineDisplayWarmCacheSaveTimer = null;
        const pending = [...pendingMachineDisplayWarmCacheSaves.values()];
        pendingMachineDisplayWarmCacheSaves.clear();
        for (const save of pending) {
            saveMachineDisplayWarmCacheEntries(save.serverId, save.accountId, save.entries);
        }
    }, 0);
}
