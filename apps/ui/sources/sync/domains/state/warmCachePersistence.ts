import { MMKV } from 'react-native-mmkv';
import { ArtifactCoarseKindV1Schema } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { MachineKindFromLegacyProjectionSchema } from '@happier-dev/protocol/machines/machineKind';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { normalizeLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { parseSessionRuntimeActivityProjectionFields, SessionRuntimeActivityStateSchema } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { PluginAgentExternalSessionLinkDataSchema } from '@happier-dev/protocol/plugins/contributions/agentExternalSessions';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PrimaryTurnStatusV1Schema, SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { SessionAccessAccountSummaryV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessPrincipalV1';
import { SessionEffectiveAccessV1Schema } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionViewerProjectionV1Schema } from '@happier-dev/protocol/sessions/personal/viewer';
import { SessionWorkspaceLocationV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { SessionOwnerCompatibilityViewV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionAgentActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { SessionWorkflowActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import { SessionWorkDisplayV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';
import { SessionGuardNoticeStateV1Schema } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { SessionTerminalControlServiceabilityV1Schema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { ExternalAgentObservationSnapshotV1Schema } from '@happier-dev/protocol/sessions/external/externalAgentObservationV1';
import { SessionUsageLimitRecoveryDisplayV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { SessionOwnerDisplayV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionDisplaySchemasV1';
import { PendingActivationAuthorizationV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { PluginUiTargetedContributionsV1Schema, type PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { z } from 'zod/mini';
import * as zMini from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { MachinePublishedAgentInventoryV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { DaemonMcpServersDetectResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { prepareWarmCacheEncryptionKey, readResolvedWarmCacheEncryptionKey } from './warmCacheEncryptionKey';
import { SESSION_CONTENT_AVAILABILITIES } from '@/sync/domains/session/encryptedContentAvailability';
import { MachineLockedReasonSchema } from './storageTypes';
import { isServerProfilePersistenceSuspendedForDemo } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { normalizePluginUiProjection, resolvePluginUiProjectionPlatform, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { preparePluginUiProjectionOrigins } from '@/sync/domains/plugins/ui/projectionOrigins';
import type { PluginUiPlatformV1 } from '@happier-dev/protocol/plugins/ui';

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
    /** null means storage has not accepted this process's latest value. */
    raw: string | null;
    value: Record<string, unknown>;
}>;

const warmCacheSavedValueByKey = new Map<string, WarmCacheSavedValue>();

type WarmCacheStorageFailure = Readonly<{
    operation: 'open' | 'read' | 'write' | 'delete' | 'enumerate' | 'serialize';
    reason: 'quota_exceeded' | 'storage_error';
}>;
let warmCacheStorageFailureReported = false;

function attemptWarmCacheStorage<T>(
    operation: WarmCacheStorageFailure['operation'],
    action: () => T,
): Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: WarmCacheStorageFailure }> {
    try {
        return { ok: true, value: action() };
    } catch (error) {
        const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
        const failure: WarmCacheStorageFailure = {
            operation,
            reason: name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
                ? 'quota_exceeded'
                : 'storage_error',
        };
        if (!warmCacheStorageFailureReported) {
            warmCacheStorageFailureReported = true;
            // One diagnostic per process, without Account ids, cache contents or storage error prose.
            console.warn('[warm-cache] Persistence failed; keeping the in-memory projection.', failure);
        }
        return { ok: false, failure };
    }
}

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
    if (isEmbedWindowContext()) return null;
    if (warmCacheStorage) return warmCacheStorage;
    if (warmCacheStorageUnopenable) return null;
    const storageScope = warmCacheStorageScope();
    purgeLegacyPlaintextWarmCache(storageScope);

    const placement = resolveWarmCacheStoragePlacement(storageScope);
    if (!placement) return null;

    const opened = attemptWarmCacheStorage('open', () => new MMKV(placement));
    if (opened.ok) {
        warmCacheStorage = opened.value;
    } else {
        // A store we cannot open stays unopened for this process: retrying per read would turn one
        // unusable cache into a throw on every session-list update.
        warmCacheStorageUnopenable = true;
        warmCacheStorage = null;
    }
    return warmCacheStorage;
}

const SESSION_LIST_WARM_CACHE_PREFIX = 'session-list-warm-cache-v1';
/**
 * The Home/Account-qualified last-known strict-query memberships: Session ids per corpus
 * (`buildSessionListQueryKey`), never rows. Rows stay owned by the session-list family above, so
 * an id whose row this device no longer holds renders nothing. A restored membership is last-known
 * and never a complete answer. Like the plugin UI family, no build ever wrote it into the legacy
 * shared plaintext instance, so it is absent from the purge list.
 */
const SESSION_LIST_QUERY_WARM_CACHE_PREFIX = 'session-list-query-warm-cache-v1';
const MACHINE_DISPLAY_WARM_CACHE_PREFIX = 'machine-display-warm-cache-v1';
/**
 * The Account-qualified last-confirmed plugin UI admission snapshot, one entry
 * per described machine. It is deliberately absent from the legacy plaintext
 * purge list below: no shipped build ever wrote this family into the shared
 * unencrypted instance, so there is nothing there to retire.
 */
const PLUGIN_UI_PROJECTION_WARM_CACHE_PREFIX = 'plugin-ui-projection-warm-cache-v1';
const ARTIFACT_INVENTORY_WARM_CACHE_PREFIX = 'artifact-inventory-warm-cache-v1';

// Header-only projection: never persist content keys, key envelopes, bodies or
// private revision provenance. Storage placement remains the warm-cache owner's.
const ArtifactInventoryWarmCacheSchema = z.object({
    binding: z.string(),
    cursor: z.string().check(z.regex(/^\d+$/)),
    artifacts: z.array(z.object({
        id: z.string().check(z.minLength(1)),
        kind: z.optional(z.nullable(ArtifactCoarseKindV1Schema)),
        kindHint: z.optional(z.nullable(z.string())),
        rawHeader: z.nullable(z.record(z.string(), z.unknown())),
        isDecrypted: z.boolean(),
        lockedReason: z.optional(z.enum(['encryption_material_unavailable', 'decryption_failed', 'invalid_stored_content'])),
        storageMode: z.enum(['plain', 'e2ee']),
        access: z.optional(z.enum(['owner', 'view', 'edit', 'admin'])),
        ownerAccountId: z.optional(z.string()),
        headerVersion: z.number().check(z.int(), z.nonnegative()),
        bodyVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
        seq: z.number(), createdAt: z.number(), updatedAt: z.number(),
    })),
});
export type ArtifactInventoryWarmCache = z.infer<typeof ArtifactInventoryWarmCacheSchema>;

export function loadArtifactInventoryWarmCache(serverId: string, accountId: string, binding: string): ArtifactInventoryWarmCache | null {
    const key = buildScopedKey(ARTIFACT_INVENTORY_WARM_CACHE_PREFIX, serverId, accountId);
    const entry = loadScopedRecord(key, ArtifactInventoryWarmCacheSchema);
    if (entry?.binding === binding) return entry;
    if (entry && key) forgetScopedRecord(key);
    return null;
}

export function saveArtifactInventoryWarmCache(serverId: string, accountId: string, entry: ArtifactInventoryWarmCache): void {
    const key = buildScopedKey(ARTIFACT_INVENTORY_WARM_CACHE_PREFIX, serverId, accountId);
    // The inventory producer can return this owner's already-admitted checkpoint.
    // New carriers still cross schema admission; a failed write still reaches persistence to retry.
    const admitted = peekScopedRecord<ArtifactInventoryWarmCache>(key);
    saveScopedRecord(key, entry === admitted ? entry : ArtifactInventoryWarmCacheSchema.parse(entry));
}

subscribeHomeCredentialMutations(event => {
    if (event.kind !== 'credentials_removed') return;
    const prefix = `${ARTIFACT_INVENTORY_WARM_CACHE_PREFIX}:${event.serverId}:`;
    const storage = getWarmCacheStorage();
    const storedKeys = attemptWarmCacheStorage('enumerate', () => storage?.getAllKeys() ?? []);
    const keys = new Set([...warmCacheSavedValueByKey.keys(), ...(storedKeys.ok ? storedKeys.value : [])]);
    for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        forgetScopedRecord(key);
    }
});
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
    sessionId: z.string().check(z.minLength(1)),
    // Optional for retained caches: only a freshly admitted compact row can match this
    // nonsecret display derivation. It never restores full Session/document readiness.
    displayProof: z.optional(z.object({
        admissionFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
        metadataVersion: z.number().check(z.int(), z.nonnegative()),
    })),
    ownerAccountId: z.optional(z.string()),
    seq: z.optional(z.number().check(z.int(), z.nonnegative())),
    metadataLayoutVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    metadataVersion: z.number().check(z.int(), z.nonnegative()),
    agentStateVersion: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number(),
    meaningfulActivityAt: z.optional(z.nullable(z.number())),
    createdAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    archivedAt: z.nullable(z.number()),
    lastViewedSessionSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    viewer: zMini.optional(SessionViewerProjectionV1Schema),
    pendingCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    pendingBlockedCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    pendingVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    pendingActivationAuthorization: zMini.optional(zMini.nullable(PendingActivationAuthorizationV1Schema)),
    latestTurnStatus: zMini.optional(zMini.nullable(PrimaryTurnStatusV1Schema)),
    latestTurnStatusObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    lastRuntimeIssue: zMini.optional(zMini.nullable(SessionRuntimeIssueV1Schema)),
    runtimeActivityActiveCount: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    runtimeActivityState: zMini.optional(zMini.nullable(SessionRuntimeActivityStateSchema)),
    runtimeActivityObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    runtimeActivityRevision: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    runtimeActivitySourceClass: z.optional(z.never()),
    rollbackEligibleTurnStarts: z.optional(z.array(z.number().check(z.int(), z.nonnegative()))),
    latestReadyEventSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    latestReadyEventAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    pendingRequestObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    // The row's settled content fact, so a cold restore does not read an own readable Session as
    // locked. Absent (older entries, or unsettled when written) restores as unsettled.
    encryptionMode: z.optional(z.enum(['e2ee', 'plain'])),
    encryptedContentAvailability: z.optional(z.enum(SESSION_CONTENT_AVAILABILITIES)),
    // Additive current authority. Absence keeps old cache bytes readable and
    // permits only the released flattened fallback; null preserves malformed
    // current ingress as unavailable across a restart.
    effectiveAccess: zMini.optional(zMini.nullable(SessionEffectiveAccessV1Schema)),
    accessLevel: z.optional(z.enum(['view', 'edit', 'admin'])),
    canApprovePermissions: z.optional(z.boolean()),
    responsibleAccountId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    responsibleAccount: zMini.optional(zMini.nullable(SessionAccessAccountSummaryV1Schema)),
    name: z.optional(z.string()),
    summaryText: z.optional(z.nullable(z.string())),
    agentActivityHeadline: zMini.optional(zMini.nullable(SessionAgentActivityHeadlineV1Schema)),
    workDisplay: zMini.optional(zMini.nullable(SessionWorkDisplayV1Schema)),
    workflowHeadline: zMini.optional(zMini.nullable(SessionWorkflowActivityHeadlineV1Schema)),
    guardState: zMini.optional(zMini.nullable(SessionGuardNoticeStateV1Schema)),
    forkV1: SessionOwnerDisplayV1Schema.shape.forkV1,
    lifecycleState: z.optional(z.string()),
    sessionUsageLimitRecoveryV1: zMini.optional(zMini.nullable(SessionUsageLimitRecoveryDisplayV1Schema)),
    externalAgentObservationV1: zMini.optional(zMini.nullable(ExternalAgentObservationSnapshotV1Schema)),
    readStateV1: zMini.optional(zMini.nullable(SessionOwnerCompatibilityViewV1Schema.shape.readStateV1)),
    terminalControlServiceabilityV1: zMini.optional(zMini.nullable(SessionTerminalControlServiceabilityV1Schema)),
    path: z.string(),
    branch: z.optional(z.nullable(z.string())),
    projectId: z.optional(z.nullable(z.string())),
    workspaceId: z.optional(z.nullable(z.string())),
    sessionWorkspaceLocationV1: zMini.optional(zMini.nullable(SessionWorkspaceLocationV1Schema)),
    homeDir: z.optional(z.nullable(z.string())),
    host: z.optional(z.nullable(z.string())),
    machineId: z.optional(z.nullable(z.string())),
    flavor: z.optional(z.nullable(z.string())),
    externalSessionV1: z.optional(z.nullable((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => normalizeLinkedExternalSessionMetadataV1({ externalSessionV1: value }, 'stored')
            ?.externalSessionV1 ?? value), z.looseObject({
            v: z.literal(1),
            agentId: z.string().check(z.minLength(1)),
            machineId: z.string().check(z.minLength(1)),
            remoteSessionId: z.string().check(z.minLength(1)),
            source: ExternalSessionsSourceSchema,
            runtimeDescriptorV1: zMini.optional(RuntimeDescriptorV1Schema),
            linkData: zMini.optional(PluginAgentExternalSessionLinkDataSchema),
            codexBackendMode: z.optional(z.never()),
        })))),
    hiddenSystemSession: z.optional(z.boolean()),
    // The Bot marker (`metadata.bot`), flattened like the fields above. Without it a cold-restored
    // Bot reads as an ordinary Session until its metadata changes, so the Bots roster loses it.
    bot: z.optional(z.boolean()),
    // The no-folder marker (`sessionDirectoryV1.kind === 'managed'`), flattened like the fields above.
    // Without it a cold-restored row reads its private folder as a workspace to show.
    managedSessionDirectory: z.optional(z.boolean()),
    keepVisibleWhenInactive: z.optional(z.boolean()),
    hasPendingPermissionRequests: z.optional(z.boolean()),
    hasPendingUserActionRequests: z.optional(z.boolean()),
    hasUnreadMessages: z.optional(z.boolean()),
}).check(z.superRefine((entry, context) => {
    if (parseSessionRuntimeActivityProjectionFields(entry).kind === 'invalid') {
        context.addIssue({
            code: 'custom',
            message: 'Runtime Activity must be absent or a complete validated tuple',
        });
    }
    const hasId = Object.prototype.hasOwnProperty.call(entry, 'responsibleAccountId');
    const hasSummary = Object.prototype.hasOwnProperty.call(entry, 'responsibleAccount');
    if (hasId !== hasSummary) {
        context.addIssue({ code: 'custom', message: 'Responsibility id and summary must be projected together' });
    } else if (entry.responsibleAccountId === null && entry.responsibleAccount !== null) {
        context.addIssue({ code: 'custom', message: 'Unassigned responsibility cannot carry an Account summary' });
    } else if (typeof entry.responsibleAccountId === 'string' && entry.responsibleAccount?.accountId !== entry.responsibleAccountId) {
        context.addIssue({ code: 'custom', message: 'Responsible Account summary must match its id' });
    }
}));

export type SessionListCacheEntryV1 = z.infer<typeof SessionListCacheEntryV1Schema>;

export const MachineDisplayCacheEntryV1Schema = z.object({
    agentInventory: zMini.catch(zMini.optional(createStoredReadSchema(MachinePublishedAgentInventoryV1Schema)), undefined),
    machineId: z.string().check(z.minLength(1)),
    kind: zMini.optional(MachineKindFromLegacyProjectionSchema),
    metadataVersion: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    revokedAt: z.nullable(z.number()),
    replacedByMachineId: z.optional(z.nullable(z.string())),
    replacedAt: z.optional(z.nullable(z.union([z.number(), z.string()]))),
    replacementReason: z.optional(z.nullable(z.string())),
    replacementSource: z.optional(z.nullable(z.string())),
    replacementActorUserId: z.optional(z.nullable(z.string())),
    lockedReason: z.optional(z.nullable(MachineLockedReasonSchema)),
    displayName: z.optional(z.nullable(z.string())),
    host: z.optional(z.nullable(z.string())),
    homeDir: z.optional(z.nullable(z.string())),
    platform: z.optional(z.nullable(z.string())),
    arch: z.optional(z.nullable(z.string())),
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
/** Process-only presentation published with the retained bytes; symbols never serialize. */
export const PLUGIN_UI_PROJECTION_PRESENTATION = Symbol('pluginUiProjectionPresentation');
export type PluginUiProjectionCacheEntryV1 = {
    machineId: string;
    projection: PluginProjectionV2;
    targetedContributionsByPluginId?: Record<string, PluginUiTargetedContributionsV1>;
    [PLUGIN_UI_PROJECTION_PRESENTATION]?: Readonly<{
        projection: PluginProjectionV2;
        platform: PluginUiPlatformV1;
        model: PluginUiProjectionModel | null;
    }>;
};

export const PluginUiProjectionCacheEntryV1Schema: z.ZodMiniType<PluginUiProjectionCacheEntryV1> = z.object({
    machineId: z.string().check(z.minLength(1)),
    projection: PluginProjectionV2Schema,
    targetedContributionsByPluginId: z.optional(z.record(
        z.string().check(z.minLength(1)),
        PluginUiTargetedContributionsV1Schema,
    )),
});

/**
 * The last usage summary this device saw for the Account (connected accounts' quota windows), with
 * the time it was read, so hubs show last-known usage and its "as of" on a cold start.
 */
export const UsageSummaryCacheV1Schema = z.object({
    v: z.literal(1),
    entries: z.array(z.object({
        key: z.string().check(z.minLength(1)),
        /** Unknown when the producer has no reading time; never inferred from another account. */
        fetchedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
        serviceLabel: z.string(),
        /** Added with per-provider grouping; absent in values saved before it (still readable). */
        serviceGroupKey: z.optional(z.string().check(z.minLength(1))),
        legacyServiceId: z.optional(z.nullable(z.string())),
        accountLabel: z.optional(z.string()),
        /** Added with "Hide account emails and IDs": the raw identity the one presenter formats. */
        accountEmail: z.optional(z.nullable(z.string())),
        accountId: z.optional(z.nullable(z.string())),
        profileLabel: z.nullable(z.string()),
        planLabel: z.nullable(z.string()),
        meters: z.array(z.object({
            meterId: z.string().check(z.minLength(1)),
            label: z.string(),
            remainingPct: z.nullable(z.number()),
            resetsAt: z.nullable(z.number()),
        })),
    })),
});

export type UsageSummaryCacheV1 = z.infer<typeof UsageSummaryCacheV1Schema>;

/** Kind-keyed Found metadata, never bytes or reachability authority. */
export const FoundCacheEntryV1Schema = z.discriminatedUnion('kind', [z.strictObject({
    kind: z.literal('skill'), machineId: z.string().check(z.minLength(1)), observedAt: z.number().check(z.int(), z.nonnegative()),
    result: SkillFoundListResultV1Schema,
}), z.strictObject({
    kind: z.literal('mcp_server'), machineId: z.string().check(z.minLength(1)), observedAt: z.number().check(z.int(), z.nonnegative()),
    result: DaemonMcpServersDetectResponseSchema,
})]);
export type FoundCacheEntryV1 = z.infer<typeof FoundCacheEntryV1Schema>;
const foundCacheListeners = new Map<string | null, Set<() => void>>();
function foundCacheKey(serverId: string | null | undefined, accountId: string | null | undefined,
    kind: FoundCacheEntryV1['kind'], machineId: string) {
    return buildScopedKey(`found-warm-cache-v1:${kind}:${encodeURIComponent(machineId)}`, serverId, accountId);
}
export function loadFoundWarmCacheEntry(serverId: string | null | undefined, accountId: string | null | undefined,
    kind: FoundCacheEntryV1['kind'], machineId: string): FoundCacheEntryV1 | null {
    const entry = loadScopedRecord(foundCacheKey(serverId, accountId, kind, machineId), FoundCacheEntryV1Schema);
    return entry?.kind === kind && entry.machineId === machineId ? entry : null;
}
export function saveFoundWarmCacheEntry(serverId: string | null | undefined, accountId: string | null | undefined,
    value: FoundCacheEntryV1): void {
    const parsed = FoundCacheEntryV1Schema.parse(value), key = foundCacheKey(serverId, accountId, parsed.kind, parsed.machineId);
    const previous = loadScopedRecord(key, FoundCacheEntryV1Schema);
    if (sameStrictJsonValue(previous, parsed)) return;
    saveScopedRecord(key, parsed);
    for (const listener of foundCacheListeners.get(key) ?? []) listener();
}
export function subscribeFoundWarmCacheEntry(serverId: string | null | undefined, accountId: string | null | undefined,
    kind: FoundCacheEntryV1['kind'], machineId: string, listener: () => void): () => void {
    const key = foundCacheKey(serverId, accountId, kind, machineId);
    const listeners = foundCacheListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    foundCacheListeners.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) foundCacheListeners.delete(key);
    };
}

/** Held detection count for navigation; updates inspect only the changed Machine's cache entry. */
export function createFoundMcpServersCountReader(serverId: string, accountId: string, machineIds: readonly string[]) {
    const ids = [...new Set(machineIds)];
    const counts = new Map<string, number | null>();
    let total = 0;
    let known = 0;
    let snapshot: number | null = null;
    const listeners = new Set<() => void>();
    let disposers: Array<() => void> = [];
    const update = (id: string) => {
        const entry = loadFoundWarmCacheEntry(serverId, accountId, 'mcp_server', id);
        const count = entry?.kind === 'mcp_server' && entry.result.ok ? entry.result.servers.length : null;
        const previous = counts.get(id);
        if (previous === count) return;
        if (previous != null) { total -= previous; known--; }
        counts.set(id, count);
        if (count !== null) { total += count; known++; }
    };
    const publish = () => {
        const next = known > 0 ? total : null;
        if (next === snapshot) return;
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const refresh = () => { for (const id of ids) update(id); publish(); };
    refresh();
    return {
        getSnapshot: () => { if (listeners.size === 0) refresh(); return snapshot; },
        subscribe: (listener: () => void) => {
            if (listeners.size === 0) {
                disposers = ids.map(id => subscribeFoundWarmCacheEntry(serverId, accountId, 'mcp_server', id, () => { update(id); publish(); }));
                refresh();
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) { for (const off of disposers) off(); disposers = []; }
            };
        },
    };
}

const USAGE_SUMMARY_WARM_CACHE_PREFIX = 'usage-summary-warm-cache-v1';

export function loadUsageSummaryWarmCache(serverId: string | null | undefined, accountId: string | null | undefined): UsageSummaryCacheV1 | null {
    return loadScopedRecord(buildScopedKey(USAGE_SUMMARY_WARM_CACHE_PREFIX, serverId, accountId), UsageSummaryCacheV1Schema);
}

export function saveUsageSummaryWarmCache(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    value: UsageSummaryCacheV1,
): void {
    saveScopedRecord(buildScopedKey(USAGE_SUMMARY_WARM_CACHE_PREFIX, serverId, accountId), value);
}

export const SessionListQueryMembershipCacheEntryV1Schema = z.object({
    /** The exact Home identifier the corpus was read under (the query key embeds the same one). */
    serverId: z.string().check(z.minLength(1)),
    sessionIds: z.array(z.string().check(z.minLength(1))),
});

export type SessionListQueryMembershipCacheEntryV1 = z.infer<typeof SessionListQueryMembershipCacheEntryV1Schema>;

const SessionListCacheEntriesSchema = z.record(z.string(), SessionListCacheEntryV1Schema);
const SessionListQueryMembershipCacheEntriesSchema = z.record(z.string().check(z.minLength(1)), SessionListQueryMembershipCacheEntryV1Schema);
const EMPTY_SESSION_LIST_QUERY_MEMBERSHIP_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<
    string,
    SessionListQueryMembershipCacheEntryV1
>;
const MachineDisplayCacheEntriesSchema = z.record(z.string(), MachineDisplayCacheEntryV1Schema);
const PluginUiProjectionCacheEntriesSchema = z.record(z.string(), PluginUiProjectionCacheEntryV1Schema);

// Presentation is Machine-qualified, but translation bytes commonly repeat verbatim across
// Machines. Pool those bytes only in the storage encoding; callers still read the canonical
// complete projection. Rebuild the pool on every replacement so retired revisions cannot accumulate.
const CompactPluginUiProjectionCacheSchema = z.object({
    v: z.literal(2),
    // This is the storage envelope, not a complete projection until pooled translations
    // are restored. loadScopedRecord admits the reconstructed entries once, below.
    entries: z.record(z.string(), z.unknown()),
    translationBundles: z.array(z.record(z.string(), z.unknown())),
    translationBundleRefs: z.record(z.string(), z.record(z.string(), z.number().check(z.int(), z.nonnegative()))),
});

// Encoding only receives this owner's immutable entry snapshots. A generation
// replacement can keep the exact bundle; its pooling key is content, not freshness.
const pluginUiTranslationBundleKeys = new WeakMap<object, string>();

function serializePluginUiProjectionCache(entries: Record<string, PluginUiProjectionCacheEntryV1>): string {
    const translationBundles: Record<string, unknown>[] = [];
    const bundleIndexByRaw = new Map<string, number>();
    const translationBundleRefs: Record<string, Record<string, number>> = {};
    let shared = false;
    const compactEntries = Object.fromEntries(Object.entries(entries).map(([key, entry]) => {
        const pluginUi = entry.projection.familiesById.pluginUi;
        if (!pluginUi) return [key, entry];
        const refs: Record<string, number> = {};
        const entriesById = Object.fromEntries(Object.entries(pluginUi.entriesById).map(([id, row]) => {
            if (row.contributionKind !== 'translations') return [id, row];
            const bundles = row.bundles;
            if (!bundles || typeof bundles !== 'object' || Array.isArray(bundles)) return [id, row];
            let raw = pluginUiTranslationBundleKeys.get(bundles);
            if (raw === undefined) {
                raw = JSON.stringify(bundles);
                pluginUiTranslationBundleKeys.set(bundles, raw);
            }
            let index = bundleIndexByRaw.get(raw);
            if (index === undefined) {
                index = translationBundles.length;
                bundleIndexByRaw.set(raw, index);
                translationBundles.push(bundles as Record<string, unknown>);
            } else {
                shared = true;
            }
            refs[id] = index;
            return [id, { ...row, bundles: {} }];
        }));
        translationBundleRefs[key] = refs;
        return [key, { ...entry, projection: { ...entry.projection,
            familiesById: { ...entry.projection.familiesById, pluginUi: { ...pluginUi, entriesById } },
        } }];
    }));
    return JSON.stringify(shared
        ? { v: 2, entries: compactEntries, translationBundles, translationBundleRefs }
        : entries);
}

function readCompactCacheObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid_plugin_ui_warm_cache_reference');
    }
    return value as Record<string, unknown>;
}

function deserializePluginUiProjectionCache(raw: string): unknown {
    const value: unknown = JSON.parse(raw);
    // Existing flat V1 records remain readable. This is a device-local cache encoding, not a wire ABI.
    if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 2) return value;
    const compact = createStoredReadSchema(CompactPluginUiProjectionCacheSchema).parse(value);
    for (const [key, refs] of Object.entries(compact.translationBundleRefs)) {
        const entry = readCompactCacheObject(compact.entries[key]);
        const projection = readCompactCacheObject(entry.projection);
        const familiesById = readCompactCacheObject(projection.familiesById);
        const pluginUi = readCompactCacheObject(familiesById.pluginUi);
        const entriesById = { ...readCompactCacheObject(pluginUi.entriesById) };
        for (const [id, index] of Object.entries(refs)) {
            const row = readCompactCacheObject(entriesById[id]);
            const bundles = compact.translationBundles[index];
            if (row.contributionKind !== 'translations' || !bundles) throw new Error('invalid_plugin_ui_warm_cache_reference');
            entriesById[id] = { ...row, bundles };
        }
        compact.entries[key] = { ...entry, projection: { ...projection,
            familiesById: { ...familiesById, pluginUi: { ...pluginUi, entriesById } },
        } };
    }
    return compact.entries;
}

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
    schema: z.ZodMiniType<T>,
    deserialize: (raw: string) => unknown = JSON.parse,
): T | null {
    if (!key || isEmbedWindowContext()) return null;
    const cachedValue = warmCacheSavedValueByKey.get(key);
    // A rejected write must not let an older disk value replace the live projection.
    if (cachedValue?.raw === null) return hasAnyOwnEntries(cachedValue.value) ? cachedValue.value as T : null;
    const storage = getWarmCacheStorage();
    if (!storage) return (cachedValue?.value as T | undefined) ?? null;
    const read = attemptWarmCacheStorage('read', () => storage.getString(key));
    if (!read.ok) return (cachedValue?.value as T | undefined) ?? null;
    const raw = read.value;
    if (!raw) {
        warmCacheSavedValueByKey.delete(key);
        return null;
    }

    if (cachedValue?.raw === raw) {
        return cachedValue.value as T;
    }

    try {
        const parsedJson = deserialize(raw);
        const parsed = createStoredReadSchema(schema).safeParse(parsedJson);
        if (!parsed.success) {
            forgetScopedRecord(key);
            return null;
        }
        warmCacheSavedValueByKey.set(key, { raw, value: parsed.data as Record<string, unknown> });
        return parsed.data;
    } catch {
        forgetScopedRecord(key);
        return null;
    }
}

function forgetScopedRecord(key: string): void {
    // Keep a memory-only empty value until deletion succeeds, so failed removals cannot resurrect bytes.
    warmCacheSavedValueByKey.set(key, { raw: null, value: EMPTY_WARM_CACHE_ENTRIES });
    const storage = getWarmCacheStorage();
    if (!storage) return;
    const removed = attemptWarmCacheStorage('delete', () => {
        if (storage.getString(key) !== undefined) storage.delete(key);
    });
    if (removed.ok) warmCacheSavedValueByKey.delete(key);
}

function saveScopedRecord<T extends Record<string, unknown>>(key: string | null, value: T, serialize?: (value: T) => string): void {
    if (isServerProfilePersistenceSuspendedForDemo()) return;
    persistScopedRecord(key, value, serialize);
}

function persistScopedRecord<T extends Record<string, unknown>>(key: string | null, value: T, serialize?: (value: T) => string): void {
    if (!key || isEmbedWindowContext()) return;
    const storage = getWarmCacheStorage();
    // A pending native keystore (or an embed) never admitted a cache lifetime. Preserve its
    // existing cold-boot behavior; memory fallback is for storage that actually failed to open/write.
    if (!storage && !warmCacheStorageUnopenable) return;
    if (!hasAnyOwnEntries(value)) {
        forgetScopedRecord(key);
        return;
    }
    const cachedValue = warmCacheSavedValueByKey.get(key);
    // This producer owns the durable scope snapshot. A newly decoded/assembled equal
    // value is not a new persistent fact; retain its already-admitted value and bytes.
    // raw=null still retries a failed write, even when the latest value is unchanged.
    if (cachedValue && cachedValue.raw !== null && sameStrictJsonValue(cachedValue.value, value)) {
        return;
    }
    warmCacheSavedValueByKey.set(key, { raw: null, value });
    const encoded = attemptWarmCacheStorage('serialize', () => serialize ? serialize(value) : JSON.stringify(value));
    if (!encoded.ok) return;
    if (!storage) return;
    const written = attemptWarmCacheStorage('write', () => {
        if (storage.getString(key) !== encoded.value) storage.set(key, encoded.value);
    });
    if (written.ok) {
        warmCacheSavedValueByKey.set(key, { raw: encoded.value, value });
    } else if (written.failure.reason === 'quota_exceeded') {
        // An atomic rejected replacement leaves the older (potentially origin-filling) cache on
        // disk. Release only this derived record so it cannot crowd out settings, drafts or cursors.
        // The complete latest projection remains in memory above; no size/count cap or retry is needed.
        attemptWarmCacheStorage('delete', () => storage.delete(key));
    }
}

function peekScopedRecord<T extends Record<string, unknown>>(key: string | null): T | null {
    if (!key || isEmbedWindowContext()) return null;
    const value = warmCacheSavedValueByKey.get(key)?.value;
    return value && hasAnyOwnEntries(value) ? value as T : null;
}

function normalizeEmptyWarmCacheRecord<T extends Record<string, unknown>>(value: T): T {
    return hasAnyOwnEntries(value) ? value : (EMPTY_WARM_CACHE_ENTRIES as T);
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

export function loadSessionListQueryMembershipWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
): Record<string, SessionListQueryMembershipCacheEntryV1> {
    const loaded = loadScopedRecord(
        buildScopedKey(SESSION_LIST_QUERY_WARM_CACHE_PREFIX, serverId, accountId),
        SessionListQueryMembershipCacheEntriesSchema,
    );
    if (!loaded) return EMPTY_SESSION_LIST_QUERY_MEMBERSHIP_CACHE_ENTRIES;
    return normalizeEmptyWarmCacheRecord(loaded);
}

export function saveSessionListQueryMembershipWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, SessionListQueryMembershipCacheEntryV1>,
): void {
    saveScopedRecord(buildScopedKey(SESSION_LIST_QUERY_WARM_CACHE_PREFIX, serverId, accountId), entries);
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
        deserializePluginUiProjectionCache,
    );
    if (!loaded) return EMPTY_PLUGIN_UI_PROJECTION_WARM_CACHE_ENTRIES;
    return normalizeEmptyWarmCacheRecord(loaded);
}

// Only this owner's copied, frozen entries prove that *all* retained fields
// are immutable. The exported presentation symbol alone is not admission.
const publishedPluginUiProjectionEntries = new WeakSet<PluginUiProjectionCacheEntryV1>();

function publishPluginUiProjectionPresentations(
    entries: Record<string, PluginUiProjectionCacheEntryV1>,
    previous?: Record<string, PluginUiProjectionCacheEntryV1> | null,
): Record<string, PluginUiProjectionCacheEntryV1> {
    const platform = resolvePluginUiProjectionPlatform();
    let samePrevious = previous !== null && previous !== undefined
        && Object.keys(previous).length === Object.keys(entries).length;
    const published = Object.fromEntries(Object.entries(entries).map(([key, entry]) => {
        const existing = entry[PLUGIN_UI_PROJECTION_PRESENTATION];
        if (publishedPluginUiProjectionEntries.has(entry) && existing?.platform === platform) {
            if (previous?.[key] !== entry) samePrevious = false;
            return [key, entry];
        }
        const priorEntry = previous?.[key];
        const prior = priorEntry?.[PLUGIN_UI_PROJECTION_PRESENTATION];
        // Retained bytes keep the same wire shape, while this owner's ready
        // presentation cannot retain mutable aliases supplied to save/hydrate,
        // including target admissions. Symbols are process-only, not JSON.
        const { [PLUGIN_UI_PROJECTION_PRESENTATION]: _presentation, ...wireEntry } = entry;
        const entrySnapshot: unknown = projectNativeJsonValueForTransport(wireEntry);
        const snapshot = entrySnapshot as PluginUiProjectionCacheEntryV1;
        if (priorEntry && publishedPluginUiProjectionEntries.has(priorEntry)
            && prior?.platform === platform && sameStrictJsonValue(snapshot, priorEntry)) {
            return [key, priorEntry];
        }
        samePrevious = false;
        const projection = snapshot.projection;
        const normalized = preparePluginUiProjectionOrigins(normalizePluginUiProjection(projection, platform,
            prior?.platform === platform ? prior.model ?? undefined : undefined));
        const model = Object.values(normalized).some(value => value !== null && typeof value === 'object' && Object.keys(value).length > 0)
            ? normalized : null;
        const publication = Object.freeze({ ...snapshot, [PLUGIN_UI_PROJECTION_PRESENTATION]: Object.freeze({ projection, platform, model }) });
        publishedPluginUiProjectionEntries.add(publication);
        return [key, publication];
    }));
    if (samePrevious && previous) return previous;
    return Object.freeze(published);
}

/** Exact-scope hydration runs before the credential/Sync owner publishes consumers. */
export function preparePluginUiProjectionWarmCacheEntries(serverId: string, accountId: string): void {
    const key = buildScopedKey(PLUGIN_UI_PROJECTION_WARM_CACHE_PREFIX, serverId, accountId);
    const entries = loadPluginUiProjectionWarmCacheEntries(serverId, accountId);
    const published = publishPluginUiProjectionPresentations(entries, entries);
    const cached = key ? warmCacheSavedValueByKey.get(key) : undefined;
    if (key && cached && published !== entries) warmCacheSavedValueByKey.set(key, { raw: cached.raw, value: published });
}

export function savePluginUiProjectionWarmCacheEntries(
    serverId: string | null | undefined,
    accountId: string | null | undefined,
    entries: Record<string, PluginUiProjectionCacheEntryV1>,
): void {
    const key = buildScopedKey(PLUGIN_UI_PROJECTION_WARM_CACHE_PREFIX, serverId, accountId);
    if (!key || isEmbedWindowContext() || isServerProfilePersistenceSuspendedForDemo()) return;
    // A pending/unavailable keystore has not admitted retained custody. Do not
    // derive a presentation that the existing persistence owner cannot publish.
    if (!getWarmCacheStorage() && !warmCacheStorageUnopenable) return;
    const previous = peekScopedRecord<Record<string, PluginUiProjectionCacheEntryV1>>(key);
    saveScopedRecord(key, publishPluginUiProjectionPresentations(entries, previous), serializePluginUiProjectionCache);
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
    if (isServerProfilePersistenceSuspendedForDemo()) return;
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
            // These snapshots were admitted before suspension; demo snapshots never enter this queue.
            persistScopedRecord(buildScopedKey(MACHINE_DISPLAY_WARM_CACHE_PREFIX, save.serverId, save.accountId), save.entries);
        }
    }, 0);
}
