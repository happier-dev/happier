import {
    PluginUiArtifactDigestV1Schema,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
    type PluginUiPersistentArtifactFile,
    type PluginUiPersistentArtifactIdentity,
    type PluginUiPersistentArtifactRecord,
    type PluginUiPersistentArtifactStore,
} from './artifactByteCache';

const CACHE_NAME = 'happier-plugin-ui-artifacts-v1';
const CACHE_ORIGIN = 'https://plugin-ui-artifact-cache.happier.invalid/v1';

type BrowserArtifactManifestV1 = Readonly<{
    v: 1;
    identityKey: string;
    entryRelativePath?: string;
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

function recordFiles(record: PluginUiPersistentArtifactRecord): readonly PluginUiPersistentArtifactFile[] {
    if (record.files?.length) return record.files;
    return Object.freeze([{
        relativePath: record.entryRelativePath ?? '__entry__',
        digest: record.persistentIdentity.artifactDigest,
        byteSize: record.bytes.byteLength,
        bytes: record.bytes,
    }]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeManifest(value: unknown): BrowserArtifactManifestV1 | null {
    if (!isRecord(value)) return null;
    if (
        value.v !== 1
        || typeof value.identityKey !== 'string'
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
        ...(typeof value.entryRelativePath === 'string'
            ? { entryRelativePath: value.entryRelativePath }
            : {}),
        files: Object.freeze(files),
    });
}

/** Browser/RNW/desktop adapter for the canonical persistent artifact-byte store. */
export function createBrowserPluginUiPersistentArtifactStore(
    cacheStorage: CacheStorage = globalThis.caches,
): PluginUiPersistentArtifactStore {
    const open = () => cacheStorage.open(CACHE_NAME);
    return Object.freeze({
        read: async (identity) => {
            const cache = await open();
            const prefix = artifactUrlPrefix(identity);
            const discardIncompleteRecord = async (): Promise<null> => {
                await removeArtifactRecord(cache, prefix).catch(() => undefined);
                return null;
            };
            try {
                const manifestResponse = await cache.match(`${prefix}/manifest`);
                if (!manifestResponse) return await discardIncompleteRecord();
                const manifest = decodeManifest(await manifestResponse.json());
                if (!manifest || manifest.identityKey !== derivePluginUiPersistentArtifactKey(identity)) {
                    return await discardIncompleteRecord();
                }
                const files: PluginUiPersistentArtifactFile[] = [];
                for (let index = 0; index < manifest.files.length; index += 1) {
                    const declared = manifest.files[index];
                    const response = await cache.match(`${prefix}/file/${index}`);
                    if (!response) return await discardIncompleteRecord();
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    if (bytes.byteLength !== declared.byteSize) return await discardIncompleteRecord();
                    files.push(Object.freeze({ ...declared, bytes }));
                }
                const entryPath = manifest.entryRelativePath ?? '__entry__';
                const entry = files.find((file) => file.relativePath === entryPath);
                if (!entry) return await discardIncompleteRecord();
                return Object.freeze({
                    persistentIdentity: identity,
                    bytes: entry.bytes,
                    ...(manifest.entryRelativePath ? { entryRelativePath: manifest.entryRelativePath } : {}),
                    ...(manifest.entryRelativePath ? { files: Object.freeze(files) } : {}),
                });
            } catch {
                return await discardIncompleteRecord();
            }
        },
        write: async (record) => {
            const cache = await open();
            const prefix = artifactUrlPrefix(record.persistentIdentity);
            await cache.delete(`${prefix}/manifest`);
            const files = recordFiles(record);
            for (let index = 0; index < files.length; index += 1) {
                const body = new Uint8Array(files[index].bytes.byteLength);
                body.set(files[index].bytes);
                await cache.put(`${prefix}/file/${index}`, new Response(body.buffer));
            }
            const manifest: BrowserArtifactManifestV1 = Object.freeze({
                v: 1,
                identityKey: derivePluginUiPersistentArtifactKey(record.persistentIdentity),
                ...(record.entryRelativePath ? { entryRelativePath: record.entryRelativePath } : {}),
                files: Object.freeze(files.map((file) => Object.freeze({
                    relativePath: file.relativePath,
                    digest: file.digest,
                    byteSize: file.byteSize,
                }))),
            });
            await cache.put(`${prefix}/manifest`, new Response(JSON.stringify(manifest), {
                headers: { 'content-type': 'application/json' },
            }));
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
}
