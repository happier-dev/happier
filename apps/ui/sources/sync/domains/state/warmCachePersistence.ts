import { MMKV } from 'react-native-mmkv';
import {
    parseSessionRuntimeActivityProjectionFields,
    PrimaryTurnStatusV1Schema,
    SessionOrganizationSnapshotSchema,
    SessionRuntimeActivityStateSchema,
    SessionRuntimeIssueV1Schema,
    PendingActivationAuthorizationV1Schema,
    type SessionOrganizationSnapshot,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { prepareWarmCacheEncryptionKey, readResolvedWarmCacheEncryptionKey } from './warmCacheEncryptionKey';
import { selectMostRecentWarmCacheSessionIds } from './warmCacheAdapters';

/**
 * The same predicate the rest of this corridor uses (`state/persistence.ts`,
 * `warmCacheEncryptionKey.ts`, `utils/system/sentry.ts`): React Native defines `window` but never
 * `document`, so a DOM document is what actually separates the browser and Tauri desktop bundles
 * from a native build. Evaluated per call rather than once at import, so nothing here depends on
 * when this module happens to be first imported.
 */
function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

const SESSION_LIST_WARM_CACHE_PREFIX = 'session-list-warm-cache-v1';
const MACHINE_DISPLAY_WARM_CACHE_PREFIX = 'machine-display-warm-cache-v1';
const SESSION_ORGANIZATION_WARM_CACHE_PREFIX = 'session-organization-warm-cache-v1';
/**
 * Superseded by `SESSION_ORGANIZATION_WARM_CACHE_PREFIX`, which carries the pinned ids as part
 * of the whole organization snapshot. Only deleted here, never read; drop this constant once no
 * supported build can still have written the key.
 */
const LEGACY_SESSION_LIST_PINNED_IDS_WARM_CACHE_PREFIX = 'session-list-pinned-ids-warm-cache-v1';

/**
 * On a native build everything below is decrypted session content — names, summaries, filesystem
 * paths, hostnames — so it lives in an encrypted MMKV instance of its own rather than in the shared
 * `default` one.
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

/**
 * The prefixes older native builds wrote into the shared unencrypted instance. Moving to a new id
 * would only orphan those bytes; the plaintext titles and paths would still be sitting in the old
 * memory-mapped file. First use deletes them by prefix — surgically, because the instance holds
 * unrelated state this module does not own.
 */
const LEGACY_PLAINTEXT_WARM_CACHE_PREFIXES: readonly string[] = [
    SESSION_LIST_WARM_CACHE_PREFIX,
    MACHINE_DISPLAY_WARM_CACHE_PREFIX,
    SESSION_ORGANIZATION_WARM_CACHE_PREFIX,
    LEGACY_SESSION_LIST_PINNED_IDS_WARM_CACHE_PREFIX,
];

const LEGACY_PLAINTEXT_PURGE_COMPACTION_KEY = 'warm-cache-plaintext-purge-compaction-v1';
// MMKV starts at one page and `trim()` skips rewriting files that have not grown beyond their
// expected capacity. This deliberately exceeds that floor so the first trim must perform a full
// writeback after the sensitive keys have been deleted.
const LEGACY_PLAINTEXT_PURGE_COMPACTION_VALUE = '0'.repeat(16 * 1024);

var warmCacheStorage: MMKV | null = null;
let warmCacheStorageUnopenable = false;
let legacyPlaintextWarmCachePurged = false;
let warmCacheAccountScope: string | null = null;

function warmCacheStorageScope(): string | null {
    return isWebRuntime() ? null : readStorageScopeFromEnv();
}

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

export const SessionListCacheEntryV1Schema = z.object({
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative().optional(),
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
    pendingActivationAuthorization: PendingActivationAuthorizationV1Schema.nullable().optional(),
    latestTurnId: z.string().min(1).nullable().optional(),
    latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
    latestTurnStatusObservedAt: z.number().int().nonnegative().nullable().optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    runtimeActivityState: SessionRuntimeActivityStateSchema.nullable().optional(),
    runtimeActivityActiveCount: z.number().int().nonnegative().nullable().optional(),
    runtimeActivityObservedAt: z.number().int().nonnegative().nullable().optional(),
    runtimeActivitySourceClass: z.never().optional(),
    runtimeActivityRevision: z.number().int().nonnegative().safe().nullable().optional(),
    rollbackEligibleTurnStarts: z.array(z.number().int().nonnegative()).nullable().optional(),
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
    directSessionV1: z.object({
        v: z.literal(1),
        providerId: z.string().optional(),
    }).nullable().optional(),
    hiddenSystemSession: z.boolean().optional(),
    hasPendingPermissionRequests: z.boolean().optional(),
    hasPendingUserActionRequests: z.boolean().optional(),
    hasUnreadMessages: z.boolean().optional(),
    // The unread entry fact is durable read state, not activity: a cold boot that
    // dropped it would re-derive a per-boot ordering key for the attention lane
    // instead of restoring the one the server materialized.
    unreadSince: z.number().int().nonnegative().nullable().optional(),
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

function capSessionListCacheEntries(
    entries: Record<string, SessionListCacheEntryV1>,
): Record<string, SessionListCacheEntryV1> {
    const selectedIds = selectMostRecentWarmCacheSessionIds(entries);
    if (!selectedIds) return entries;
    const capped: Record<string, SessionListCacheEntryV1> = {};
    for (const sessionId of selectedIds) {
        capped[sessionId] = entries[sessionId];
    }
    return capped;
}

/**
 * What a warm-cache key currently holds, as the record object the app last read from or
 * wrote to it. Boot hydration reads these bytes and a store immediately projects them
 * back into cache entries; without a persisted baseline that projection looks like new
 * information and is re-serialized and rewritten before first paint. Owning "what is on
 * disk" here also removes the divergent reconstructions of "previous entries" that the
 * stores used to derive from their own renderables.
 *
 * One mechanism, one instance per cache: the session list and the machine displays hold
 * different entry shapes but share this baseline, so neither domain can drift into its
 * own answer for what the key already contains.
 */
function createPersistedWarmCacheBaseline<TEntry>(): Readonly<{
    read: (key: string | null) => Record<string, TEntry> | undefined;
    remember: (key: string, entries: Record<string, TEntry>) => void;
    forget: (key: string) => void;
}> {
    const entriesByKey = new Map<string, Record<string, TEntry>>();
    return {
        read: (key) => (key ? entriesByKey.get(key) : undefined),
        remember: (key, entries) => {
            entriesByKey.set(key, entries);
        },
        forget: (key) => {
            entriesByKey.delete(key);
        },
    };
}

const persistedSessionListBaseline = createPersistedWarmCacheBaseline<SessionListCacheEntryV1>();
const persistedMachineDisplayBaseline = createPersistedWarmCacheBaseline<MachineDisplayCacheEntryV1>();

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
    if (!storage) return null;
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
    if (!storage) return;
    if (Object.keys(value).length === 0) {
        storage.delete(key);
        return;
    }
    storage.set(key, JSON.stringify(value));
}

export function loadSessionListWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, SessionListCacheEntryV1> {
    const key = buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId);
    const loaded = loadScopedRecord(key, SessionListCacheEntriesSchema);
    if (!key) return loaded ?? {};
    if (!loaded) {
        persistedSessionListBaseline.forget(key);
        return {};
    }
    // The baseline is what the KEY holds, not what we hand back. When a pre-cap blob is
    // trimmed here, that difference is exactly what makes the next save rewrite the key
    // at its bounded size instead of leaving the oversized blob to be reparsed forever.
    persistedSessionListBaseline.remember(key, loaded);
    return capSessionListCacheEntries(loaded);
}

/**
 * The record the warm-cache key is currently known to hold, or `undefined` when this
 * scope has not been read or written in this process. Callers diff against it instead
 * of reconstructing a "previous entries" projection of their own.
 */
export function readPersistedSessionListWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): Record<string, SessionListCacheEntryV1> | undefined {
    return persistedSessionListBaseline.read(buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId));
}

export function saveSessionListWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, SessionListCacheEntryV1>,
): void {
    const key = buildScopedKey(SESSION_LIST_WARM_CACHE_PREFIX, serverId, accountId);
    if (!key) return;
    if (persistedSessionListBaseline.read(key) === entries) return;
    saveScopedRecord(key, entries);
    if (Object.keys(entries).length === 0) {
        persistedSessionListBaseline.forget(key);
        return;
    }
    persistedSessionListBaseline.remember(key, entries);
}

/**
 * The organization snapshot the session list last painted from, for one server and account.
 *
 * Pinned rows, folders, and manual order all come from organization state, and the store starts
 * every process empty. Without this key a boot must either hold the session-list request until
 * the organization round trip lands or paint a list it will immediately rearrange. Persisting
 * the snapshot itself — rather than a derived subset such as the pinned ids — keeps one answer
 * for "what organization did we last know", so the first paint is the organization the user
 * left behind and the refresh only has to reconcile what actually changed.
 *
 * The value is a single record rather than a keyed entry map, so it does not use the entry
 * baseline above; the serialized-bytes comparison is what keeps an unchanged refresh from
 * rewriting the key.
 */
export function loadSessionOrganizationWarmCacheSnapshot(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): SessionOrganizationSnapshot | null {
    // The superseded pinned-ids key only ever existed in the unencrypted instance, and
    // `purgeLegacyPlaintextWarmCache` deletes it there along with the rest of the plaintext bytes,
    // so there is no per-scope deletion to do here any more.
    return loadScopedRecord(
        buildScopedKey(SESSION_ORGANIZATION_WARM_CACHE_PREFIX, serverId, accountId),
        SessionOrganizationSnapshotSchema,
    );
}

export function saveSessionOrganizationWarmCacheSnapshot(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    snapshot: SessionOrganizationSnapshot,
): void {
    const key = buildScopedKey(SESSION_ORGANIZATION_WARM_CACHE_PREFIX, serverId, accountId);
    if (!key) return;
    const storage = getWarmCacheStorage();
    if (!storage) return;
    const serialized = JSON.stringify(snapshot);
    if (storage.getString(key) === serialized) return;
    storage.set(key, serialized);
}

export function loadMachineDisplayWarmCacheEntries(serverId: string | null | undefined, accountId: string | null | undefined): Record<string, MachineDisplayCacheEntryV1> {
    const key = buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId);
    const loaded = loadScopedRecord(key, MachineDisplayCacheEntriesSchema);
    if (!key) return loaded ?? {};
    if (!loaded) {
        persistedMachineDisplayBaseline.forget(key);
        return {};
    }
    persistedMachineDisplayBaseline.remember(key, loaded);
    return loaded;
}

/**
 * The record the machine-display warm-cache key is currently known to hold, or
 * `undefined` when this scope has not been read or written in this process.
 */
export function readPersistedMachineDisplayWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): Record<string, MachineDisplayCacheEntryV1> | undefined {
    return persistedMachineDisplayBaseline.read(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId));
}

export function saveMachineDisplayWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, MachineDisplayCacheEntryV1>,
): void {
    const key = buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, serverId, accountId);
    if (!key) return;
    if (persistedMachineDisplayBaseline.read(key) === entries) return;
    saveScopedRecord(key, entries);
    if (Object.keys(entries).length === 0) {
        persistedMachineDisplayBaseline.forget(key);
        return;
    }
    persistedMachineDisplayBaseline.remember(key, entries);
}
