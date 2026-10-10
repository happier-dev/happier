import {
    PluginUiArtifactDigestV1Schema,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { computePluginUiArtifactSha256Digest } from './artifactIntegrity';

import {
    createPluginUiPersistentArtifactAccessClock,
    createPluginUiPersistentArtifactOperationQueue,
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
    planPluginUiPersistentArtifactRetention,
    readPluginUiPersistentArtifactAccessStamp,
    PLUGIN_UI_PERSISTENT_ARTIFACT_WEB_BYTE_BUDGET,
    type PluginUiPersistentArtifactFile,
    type PluginUiPersistentArtifactIdentity,
    type PluginUiPersistentArtifactRetainedRecord,
    type PluginUiPersistentArtifactStore,
} from './artifactByteCache';

const CACHE_NAME = 'happier-plugin-ui-artifacts-v1';
const CACHE_ORIGIN = 'https://plugin-ui-artifact-cache.happier.invalid/v1';

type BrowserArtifactManifestV1 = Readonly<{
    v: 1;
    identityKey: string;
    entryRelativePath: string;
    /** Byte-LRU ordering only; it is never compared against the current time. */
    lastAccessedAt: number;
    files: readonly Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
    }>[];
}>;

function artifactUrlPrefix(identity: PluginUiPersistentArtifactIdentity): string {
    const account = encodeURIComponent(derivePluginUiPersistentArtifactAccountKey(identity.accountScope));
    const artifact = encodeURIComponent(derivePluginUiPersistentArtifactKey(identity));
    return `${CACHE_ORIGIN}/${account}/${artifact}`;
}

function accountUrlPrefix(scope: PluginUiPersistentArtifactIdentity['accountScope']): string {
    return `${CACHE_ORIGIN}/${encodeURIComponent(derivePluginUiPersistentArtifactAccountKey(scope))}/`;
}

/**
 * A manifest is the commit marker for one persistent Artifact record. Any
 * missing or malformed member under its exact prefix is a partial record, not
 * a cache miss that may survive indefinitely.
 */
async function removeArtifactRecord(cache: Cache, prefix: string): Promise<void> {
    const recordPrefix = `${prefix}/`;
    const requests = await cache.keys();
    await Promise.all(requests
        .filter((request) => request.url.startsWith(recordPrefix))
        .map((request) => cache.delete(request)));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeManifest(value: unknown): BrowserArtifactManifestV1 | null {
    if (!isRecord(value)) return null;
    if (
        value.v !== 1
        || typeof value.identityKey !== 'string'
        || typeof value.entryRelativePath !== 'string'
        || value.entryRelativePath.length === 0
        || !Array.isArray(value.files)
        || value.files.length === 0
    ) return null;
    const files: BrowserArtifactManifestV1['files'][number][] = [];
    for (const file of value.files) {
        if (
            !isRecord(file)
            || typeof file.relativePath !== 'string'
            || typeof file.byteSize !== 'number'
            || !Number.isSafeInteger(file.byteSize)
            || file.byteSize < 0
        ) return null;
        const digest = PluginUiArtifactDigestV1Schema.safeParse(file.digest);
        if (!digest.success) return null;
        files.push(Object.freeze({
            relativePath: file.relativePath,
            digest: digest.data,
            byteSize: file.byteSize,
        }));
    }
    return Object.freeze({
        v: 1,
        identityKey: value.identityKey,
        entryRelativePath: value.entryRelativePath,
        lastAccessedAt: readPluginUiPersistentArtifactAccessStamp(value.lastAccessedAt),
        files: Object.freeze(files),
    });
}

/**
 * The record address one manifest commits: `${CACHE_ORIGIN}/account/artifact`.
 * A member that does not sit under that exact layout belongs to no committable
 * record and is reclaimed rather than charged against the budget forever.
 */
function recordPrefixOf(url: string): string | null {
    if (!url.startsWith(`${CACHE_ORIGIN}/`)) return null;
    const segments = url.slice(CACHE_ORIGIN.length + 1).split('/');
    return segments.length >= 3 && segments[0] && segments[1]
        ? `${CACHE_ORIGIN}/${segments[0]}/${segments[1]}`
        : null;
}

type CommittedManifest = Readonly<{
    manifest: BrowserArtifactManifestV1;
    metadataByteSize: number;
}>;

async function readCommittedManifest(cache: Cache, prefix: string): Promise<CommittedManifest | null> {
    const response = await cache.match(`${prefix}/manifest`);
    if (!response) return null;
    const text = await response.text();
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    const manifest = decodeManifest(value);
    return manifest
        ? Object.freeze({
            manifest,
            metadataByteSize: new TextEncoder().encode(text).byteLength,
        })
        : null;
}

function chargedBytesOf(committed: CommittedManifest): number {
    return committed.manifest.files.reduce((total, file) => total + file.byteSize, 0)
        + committed.metadataByteSize;
}

function manifestResponse(text: string): Response {
    return new Response(text, { headers: { 'content-type': 'application/json' } });
}

/**
 * Enumerate every committed record across every Account and reclaim anything
 * that is not one. This is the only place the browser owner learns its total,
 * so partial-record cleanup and budget accounting stay one pass, not two.
 */
async function scanRetainedRecords(cache: Cache): Promise<readonly PluginUiPersistentArtifactRetainedRecord[]> {
    const prefixes = new Set<string>();
    for (const request of await cache.keys()) {
        const prefix = recordPrefixOf(request.url);
        if (prefix) prefixes.add(prefix);
        else await cache.delete(request).catch(() => undefined);
    }
    const retained: PluginUiPersistentArtifactRetainedRecord[] = [];
    for (const prefix of prefixes) {
        const committed = await readCommittedManifest(cache, prefix).catch(() => null);
        if (!committed) {
            await removeArtifactRecord(cache, prefix).catch(() => undefined);
            continue;
        }
        retained.push(Object.freeze({
            locationKey: prefix,
            chargedBytes: chargedBytesOf(committed),
            lastAccessedAt: committed.manifest.lastAccessedAt,
        }));
    }
    return Object.freeze(retained);
}

export type BrowserPluginUiPersistentArtifactStoreOptions = Readonly<{
    /**
     * The Artifact-owned budget this physical owner enforces. It exists so the
     * owner tests can prove the exact/+1 boundary without allocating 192 MiB;
     * the shipped value is always the canonical constant.
     */
    budgetBytes?: number;
}>;

/** Browser/RNW adapter for the canonical persistent artifact-byte store. */
export function createBrowserPluginUiPersistentArtifactStore(
    cacheStorage: CacheStorage = globalThis.caches,
    options: BrowserPluginUiPersistentArtifactStoreOptions = {},
): PluginUiPersistentArtifactStore {
    const open = () => cacheStorage.open(CACHE_NAME);
    const budgetBytes = options.budgetBytes ?? PLUGIN_UI_PERSISTENT_ARTIFACT_WEB_BYTE_BUDGET;
    const nextAccessStamp = createPluginUiPersistentArtifactAccessClock();
    const refreshAccessOrder = async (cache: Cache, prefix: string, manifest: BrowserArtifactManifestV1) => {
        // Ordering only: a failed refresh leaves the committed record intact and
        // costs at most one suboptimal eviction choice, so it must never be
        // mistaken for the corruption that discards a record.
        try {
            await cache.put(`${prefix}/manifest`, manifestResponse(JSON.stringify(Object.freeze({
                ...manifest,
                lastAccessedAt: nextAccessStamp(),
            }))));
        } catch {
            // Retained bytes stay readable at their previous ordering.
        }
    };
    const store: PluginUiPersistentArtifactStore = Object.freeze({
        read: async (identity) => {
            const cache = await open();
            const prefix = artifactUrlPrefix(identity);
            const discardIncompleteRecord = async (): Promise<null> => {
                await removeArtifactRecord(cache, prefix).catch(() => undefined);
                return null;
            };
            try {
                const committed = await readCommittedManifest(cache, prefix);
                if (!committed || committed.manifest.identityKey !== derivePluginUiPersistentArtifactKey(identity)) {
                    return await discardIncompleteRecord();
                }
                const manifest = committed.manifest;
                const files: PluginUiPersistentArtifactFile[] = [];
                for (let index = 0; index < manifest.files.length; index += 1) {
                    const declared = manifest.files[index];
                    const response = await cache.match(`${prefix}/file/${index}`);
                    if (!response) return await discardIncompleteRecord();
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    if (
                        bytes.byteLength !== declared.byteSize
                        || await computePluginUiArtifactSha256Digest(bytes) !== declared.digest
                    ) return await discardIncompleteRecord();
                    files.push(Object.freeze({ ...declared, bytes }));
                }
                const entry = files.find((file) => file.relativePath === manifest.entryRelativePath);
                if (!entry) return await discardIncompleteRecord();
                await refreshAccessOrder(cache, prefix, manifest);
                return Object.freeze({
                    persistentIdentity: identity,
                    bytes: entry.bytes,
                    entryRelativePath: manifest.entryRelativePath,
                    files: Object.freeze(files),
                });
            } catch {
                return await discardIncompleteRecord();
            }
        },
        write: async (record) => {
            const cache = await open();
            const prefix = artifactUrlPrefix(record.persistentIdentity);
            const files = record.files;
            const manifest: BrowserArtifactManifestV1 = Object.freeze({
                v: 1,
                identityKey: derivePluginUiPersistentArtifactKey(record.persistentIdentity),
                entryRelativePath: record.entryRelativePath,
                lastAccessedAt: nextAccessStamp(),
                files: Object.freeze(files.map((file) => Object.freeze({
                    relativePath: file.relativePath,
                    digest: file.digest,
                    byteSize: file.byteSize,
                }))),
            });
            const manifestText = JSON.stringify(manifest);
            const plan = planPluginUiPersistentArtifactRetention({
                budgetBytes,
                incomingLocationKey: prefix,
                incomingChargedBytes: files.reduce((total, file) => total + file.byteSize, 0)
                    + new TextEncoder().encode(manifestText).byteLength,
                retained: await scanRetainedRecords(cache),
            });
            for (const locationKey of plan.evictLocationKeys) {
                // A failed required eviction means the physical owner cannot
                // prove the incoming commit fits its byte budget. Keep storage
                // I/O failure distinct from the typed capacity disposition.
                await removeArtifactRecord(cache, locationKey);
            }
            // A verified artifact larger than the whole budget still served the
            // current load; it is simply never adopted into persistent storage.
            if (!plan.persist) {
                return plan.reason === 'oversize' ? 'notPersistedOversize' : 'notPersistedCapacity';
            }
            await removeArtifactRecord(cache, prefix);
            for (let index = 0; index < files.length; index += 1) {
                const body = new Uint8Array(files[index].bytes.byteLength);
                body.set(files[index].bytes);
                await cache.put(`${prefix}/file/${index}`, new Response(body.buffer));
            }
            await cache.put(`${prefix}/manifest`, manifestResponse(manifestText));
            return 'persisted';
        },
        remove: async (identity) => {
            const cache = await open();
            await removeArtifactRecord(cache, artifactUrlPrefix(identity));
        },
        removeAccount: async (scope) => {
            const cache = await open();
            const prefix = accountUrlPrefix(scope);
            const requests = await cache.keys();
            await Promise.all(requests
                .filter((request) => request.url.startsWith(prefix))
                .map((request) => cache.delete(request)));
        },
    });
    const runInProcessOrder = createPluginUiPersistentArtifactOperationQueue();
    const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
        const locks = globalThis.navigator?.locks;
        return locks
            ? locks.request(`${CACHE_NAME}:operations`, operation)
            : runInProcessOrder(operation);
    };
    return Object.freeze({
        read: (identity) => runExclusive(() => store.read(identity)),
        write: (record) => runExclusive(() => store.write(record)),
        remove: (identity) => runExclusive(() => store.remove(identity)),
        removeAccount: (scope) => runExclusive(() => store.removeAccount(scope)),
    });
}
