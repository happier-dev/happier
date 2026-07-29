import {
    DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    type DaemonPluginUiArtifactBytesReadResponse,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV1Schema,
    verifyPluginUiArtifactBytesIntegrityV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { decodeBase64 } from '@/encryption/base64';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import {
    derivePluginReactNativeBundleCacheKey,
    type PluginReactNativeBundleCacheIdentity,
} from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    createReactNativeInstalledArtifactDiskGc,
    type ReactNativeInstalledArtifactDiskGc,
} from './artifactFileMaterializer';
import {
    resolveNativeReactNativeHostRuntimeIdentity,
    resolveReactNativeWebLoaderCapability,
} from './hostRuntimeIdentity';

export type PluginReactNativeBundleArtifactFormat = 'plainJs' | 'hermesBytecode';

export type PluginReactNativeCachedArtifactFile = Readonly<{
    relativePath: string;
    digest: string;
    byteSize: number;
    bytes: Uint8Array;
}>;

export type PluginReactNativeCachedArtifact = Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    cacheKey: string;
    bytes: Uint8Array;
    format: PluginReactNativeBundleArtifactFormat;
    entryRelativePath?: string;
    files?: readonly PluginReactNativeCachedArtifactFile[];
}>;

export type PluginReactNativeBundleCachePutResult =
    | Readonly<{ ok: true; cacheKey: string }>
    | Readonly<{
        ok: false;
        code: 'artifact_cache_write_invalidated' | 'hermes_bytecode_unsupported';
        diagnostics: readonly string[];
    }>;

export type PluginReactNativeBundlePreloadResult =
    | Readonly<{ ok: true; cacheKey: string }>
    | Readonly<{
        ok: false;
        code:
            | 'artifact_fetch_failed'
            | 'artifact_unavailable'
            | 'artifact_identity_mismatch'
            | 'artifact_cache_write_invalidated'
            | 'invalid_response'
            | 'digest_mismatch'
            | 'unsupported_digest'
            | 'hermes_bytecode_unsupported';
        diagnostics: readonly string[];
    }>;

export type PluginReactNativeBundleArtifactByteFetcher = (
    input: Readonly<{ identity: PluginReactNativeBundleCacheIdentity }>,
) => Promise<DaemonPluginUiArtifactBytesReadResponse>;

type PluginReactNativeBundleCacheWriteFence = Readonly<{
    cacheKey: string;
    projectionInvalidationRevision: number;
    pluginInvalidationRevision: number;
}>;

export type PluginReactNativeBundleCache = Readonly<{
    captureWriteFence: (
        identity: PluginReactNativeBundleCacheIdentity,
    ) => PluginReactNativeBundleCacheWriteFence;
    putInstalledArtifact: (entry: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        bytes: Uint8Array;
        format: PluginReactNativeBundleArtifactFormat;
        entryRelativePath?: string;
        files?: readonly PluginReactNativeCachedArtifactFile[];
    }>, writeFence?: PluginReactNativeBundleCacheWriteFence) => PluginReactNativeBundleCachePutResult;
    readInstalledArtifact: (identity: PluginReactNativeBundleCacheIdentity) => PluginReactNativeCachedArtifact | null;
    evictForPluginUninstall: (pluginId: string) => void;
    evictForPluginDisable: (pluginId: string) => void;
    evictForProjectionGenerationReplacement: (generation: number | null) => void;
}>;

function cloneBytes(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(bytes);
}

function cloneCachedArtifactFiles(
    files: readonly PluginReactNativeCachedArtifactFile[] | undefined,
): readonly PluginReactNativeCachedArtifactFile[] | undefined {
    return files?.map((file) => Object.freeze({
        relativePath: file.relativePath,
        digest: file.digest,
        byteSize: file.byteSize,
        bytes: cloneBytes(file.bytes),
    }));
}

function preloadError(
    code: Extract<PluginReactNativeBundlePreloadResult, { ok: false }>['code'],
    diagnostics: readonly string[],
): PluginReactNativeBundlePreloadResult {
    return Object.freeze({
        ok: false,
        code,
        diagnostics: Object.freeze([...diagnostics]),
    });
}

function identityMatches(
    left: PluginReactNativeBundleCacheIdentity,
    right: PluginReactNativeBundleCacheIdentity,
): boolean {
    return left.pluginId === right.pluginId
        && left.contributionId === right.contributionId
        && left.artifactDigest === right.artifactDigest
        && left.hostAppVersion === right.hostAppVersion
        && left.hostUiApiVersion === right.hostUiApiVersion
        && left.reactVersion === right.reactVersion
        && left.reactNativeVersion === right.reactNativeVersion
        && (left.expoRuntimeVersion ?? '') === (right.expoRuntimeVersion ?? '')
        && (left.hermesVersion ?? '') === (right.hermesVersion ?? '')
        && left.platform === right.platform
        && left.channel === right.channel
        && left.nativeCapabilitiesDigest === right.nativeCapabilitiesDigest
        && left.projectionGeneration === right.projectionGeneration;
}

function decodeArtifactBytes(bytesBase64: string): Uint8Array | null {
    try {
        return decodeBase64(bytesBase64, 'base64');
    } catch {
        return null;
    }
}

function decodeReactNativeArtifactFiles(
    response: Extract<DaemonPluginUiArtifactBytesReadResponse, { ok: true; artifact: { artifactKind: 'reactNativeBundle' } }>,
): readonly PluginReactNativeCachedArtifactFile[] | null | undefined {
    if (!response.files?.length) {
        return undefined;
    }

    const files: PluginReactNativeCachedArtifactFile[] = [];
    for (const file of response.files) {
        const bytes = decodeArtifactBytes(file.bytesBase64);
        if (!bytes || bytes.byteLength !== file.byteSize) {
            return null;
        }
        const integrity = verifyPluginUiArtifactBytesIntegrityV1({
            bytes,
            integrity: {
                digest: file.digest,
                pluginId: response.artifact.pluginId,
                contributionId: response.artifact.contributionId,
                artifactKind: 'reactNativeBundle',
            },
        });
        if (!integrity.ok) {
            return null;
        }
        files.push(Object.freeze({
            relativePath: file.relativePath,
            digest: file.digest,
            byteSize: file.byteSize,
            bytes,
        }));
    }
    return Object.freeze(files);
}

function isReactNativeArtifactBytesResponse(
    response: DaemonPluginUiArtifactBytesReadResponse,
): response is Extract<DaemonPluginUiArtifactBytesReadResponse, { ok: true; artifact: { artifactKind: 'reactNativeBundle' } }> {
    return response.ok && response.artifact.artifactKind === 'reactNativeBundle';
}

export async function fetchReactNativeInstalledArtifactBytesViaMachineRpc(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    identity: PluginReactNativeBundleCacheIdentity;
}>): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    try {
        const reactNativeHostRuntimeIdentity = resolveNativeReactNativeHostRuntimeIdentity();
        const reactNativeWebLoaderCapability = resolveReactNativeWebLoaderCapability();
        const payload = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
            machineId: input.machineId,
            cacheIdentity: input.identity,
            ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
            ...(reactNativeWebLoaderCapability ? { reactNativeWebLoaderCapability } : {}),
        });
        const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return {
                ok: false,
                code: 'artifact_unavailable',
                diagnostics: ['react_native_artifact_bytes_rpc_unavailable'],
            };
        }
        const parsed = DaemonPluginUiArtifactBytesReadResponseSchema.safeParse(raw);
        if (!parsed.success) {
            return {
                ok: false,
                code: 'artifact_unavailable',
                diagnostics: ['react_native_artifact_bytes_response_invalid'],
            };
        }
        return parsed.data;
    } catch {
        return {
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['react_native_artifact_bytes_fetch_failed'],
        };
    }
}

export async function preloadReactNativeInstalledArtifactBytes(input: Readonly<{
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    artifactGraph?: PluginUiArtifactsManifestEntryV1;
    fetchArtifactBytes: PluginReactNativeBundleArtifactByteFetcher;
}>): Promise<PluginReactNativeBundlePreloadResult> {
    const writeFence = input.cache.captureWriteFence(input.identity);
    const response = await input.fetchArtifactBytes({ identity: input.identity });
    if (!response.ok) {
        return preloadError('artifact_unavailable', response.diagnostics);
    }
    if (!isReactNativeArtifactBytesResponse(response)) {
        return preloadError('artifact_identity_mismatch', ['react_native_artifact_kind_mismatch']);
    }
    const responseIdentity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(response.cacheIdentity);
    if (!responseIdentity.success || !identityMatches(responseIdentity.data, input.identity)) {
        return preloadError('artifact_identity_mismatch', ['react_native_cache_identity_mismatch']);
    }
    if (
        response.artifact.pluginId !== input.identity.pluginId
        || response.artifact.contributionId !== input.identity.contributionId
        || response.artifact.digest !== input.identity.artifactDigest
    ) {
        return preloadError('artifact_identity_mismatch', ['react_native_artifact_identity_mismatch']);
    }

    const bytes = decodeArtifactBytes(response.bytesBase64);
    if (!bytes) {
        return preloadError('invalid_response', ['react_native_artifact_bytes_invalid']);
    }
    const files = decodeReactNativeArtifactFiles(response);
    if (files === null) {
        return preloadError('digest_mismatch', ['react_native_artifact_file_integrity_mismatch']);
    }

    let installedBytes = bytes;
    let entryRelativePath: string | undefined;
    if (input.artifactGraph) {
        const parsedGraph = PluginUiArtifactsManifestEntryV1Schema.safeParse(input.artifactGraph);
        if (!parsedGraph.success) {
            return preloadError('artifact_identity_mismatch', ['react_native_artifact_graph_identity_mismatch']);
        }
        const graph = parsedGraph.data;
        const expectedBundler = graph.platform === 'web' ? 'vite' : 'repack';
        if (
            graph.tier !== 'reactNative'
            || graph.platform !== input.identity.platform
            || graph.digest !== input.identity.artifactDigest
            || graph.builtWith.bundler !== expectedBundler
        ) {
            return preloadError('artifact_identity_mismatch', ['react_native_artifact_graph_identity_mismatch']);
        }
        if (!files) {
            return preloadError('invalid_response', ['react_native_artifact_graph_files_missing']);
        }
        const declaredFilesByPath = new Map(graph.files.map((file) => [file.relativePath, file] as const));
        const declaredPaths = new Set(declaredFilesByPath.keys());
        const receivedPaths = new Set(files.map((file) => file.relativePath));
        if (
            declaredPaths.size !== graph.files.length
            || receivedPaths.size !== files.length
            || declaredPaths.size !== receivedPaths.size
            || !graph.files.every((file) => receivedPaths.has(file.relativePath))
            || !declaredPaths.has(graph.entry)
        ) {
            return preloadError('invalid_response', ['react_native_artifact_graph_file_set_mismatch']);
        }
        if (files.some((file) => {
            const declared = declaredFilesByPath.get(file.relativePath);
            return !declared || declared.digest !== file.digest || declared.byteSize !== file.byteSize;
        })) {
            return preloadError('digest_mismatch', ['react_native_artifact_file_manifest_mismatch']);
        }
        const graphIntegrity = verifyPluginUiArtifactFileSetIntegrityV1({
            files: files.map((file) => ({
                relativePath: file.relativePath,
                bytes: file.bytes,
            })),
            integrity: {
                digest: graph.digest,
                pluginId: input.identity.pluginId,
                contributionId: input.identity.contributionId,
                artifactKind: 'reactNativeBundle',
            },
        });
        if (!graphIntegrity.ok) {
            return preloadError(graphIntegrity.reasonCode, [graphIntegrity.reasonCode]);
        }
        const declaredEntry = files.find((file) => file.relativePath === graph.entry);
        if (
            !declaredEntry
            || declaredEntry.byteSize !== response.artifact.byteSize
            || declaredEntry.bytes.byteLength !== bytes.byteLength
            || declaredEntry.bytes.some((value, index) => value !== bytes[index])
        ) {
            return preloadError('invalid_response', ['react_native_artifact_entry_bytes_mismatch']);
        }
        installedBytes = declaredEntry.bytes;
        entryRelativePath = graph.entry;
    } else {
        const integrity = verifyPluginUiArtifactBytesIntegrityV1({
            bytes,
            integrity: {
                digest: input.identity.artifactDigest,
                pluginId: input.identity.pluginId,
                contributionId: input.identity.contributionId,
                artifactKind: 'reactNativeBundle',
            },
        });
        if (!integrity.ok) {
            return preloadError(integrity.reasonCode, [integrity.reasonCode]);
        }
    }

    const put = input.cache.putInstalledArtifact({
        identity: input.identity,
        bytes: installedBytes,
        format: response.artifact.format,
        ...(entryRelativePath ? { entryRelativePath } : {}),
        ...(files ? { files } : {}),
    }, writeFence);
    if (!put.ok) {
        return preloadError(put.code, put.diagnostics);
    }
    return put;
}

export type CreatePluginReactNativeBundleCacheOptions = Readonly<{
    // The default singleton wires disk GC so removed materialized executable
    // bytes are deleted from disk; tests may inject a fake.
    diskGc?: ReactNativeInstalledArtifactDiskGc;
}>;

export function createPluginReactNativeBundleCache(
    options: CreatePluginReactNativeBundleCacheOptions = {},
): PluginReactNativeBundleCache {
    const entries = new Map<string, PluginReactNativeCachedArtifact>();
    const diskGc = options.diskGc;
    const pluginInvalidationRevisions = new Map<string, number>();
    let projectionInvalidationRevision = 0;

    const readRevision = (revisions: ReadonlyMap<string, number>, key: string): number =>
        revisions.get(key) ?? 0;
    const advanceRevision = (revisions: Map<string, number>, key: string): void => {
        revisions.set(key, readRevision(revisions, key) + 1);
    };

    function scheduleDiskEviction(identities: readonly PluginReactNativeBundleCacheIdentity[]): void {
        if (!diskGc || identities.length === 0) {
            return;
        }
        void Promise.resolve(diskGc.evictForIdentities(identities)).catch(() => undefined);
    }

    function evictByPlugin(pluginId: string): void {
        advanceRevision(pluginInvalidationRevisions, pluginId);
        const evictedIdentities: PluginReactNativeBundleCacheIdentity[] = [];
        for (const [key, entry] of entries.entries()) {
            if (entry.identity.pluginId === pluginId) {
                evictedIdentities.push(entry.identity);
                entries.delete(key);
            }
        }
        scheduleDiskEviction(evictedIdentities);
    }

    return Object.freeze({
        captureWriteFence: (identity) => Object.freeze({
            cacheKey: derivePluginReactNativeBundleCacheKey(identity),
            projectionInvalidationRevision,
            pluginInvalidationRevision: readRevision(pluginInvalidationRevisions, identity.pluginId),
        }),
        putInstalledArtifact: (entry, writeFence) => {
            if (entry.format === 'hermesBytecode') {
                return Object.freeze({
                    ok: false,
                    code: 'hermes_bytecode_unsupported',
                    diagnostics: Object.freeze(['hermes_bytecode_unsupported']),
                });
            }
            const cacheKey = derivePluginReactNativeBundleCacheKey(entry.identity);
            if (writeFence) {
                const invalidated = (
                    writeFence.cacheKey !== cacheKey
                    || writeFence.projectionInvalidationRevision !== projectionInvalidationRevision
                    || writeFence.pluginInvalidationRevision
                        !== readRevision(pluginInvalidationRevisions, entry.identity.pluginId)
                );
                if (invalidated) {
                    return Object.freeze({
                        ok: false,
                        code: 'artifact_cache_write_invalidated',
                        diagnostics: Object.freeze(['react_native_artifact_cache_write_invalidated']),
                    });
                }
            }
            const replacedIdentities: PluginReactNativeBundleCacheIdentity[] = [];
            for (const [existingKey, existing] of entries.entries()) {
                if (
                    existingKey !== cacheKey
                    && existing.identity.pluginId === entry.identity.pluginId
                    && existing.identity.contributionId === entry.identity.contributionId
                ) {
                    entries.delete(existingKey);
                    replacedIdentities.push(existing.identity);
                }
            }
            scheduleDiskEviction(replacedIdentities);
            entries.set(cacheKey, Object.freeze({
                identity: entry.identity,
                cacheKey,
                bytes: cloneBytes(entry.bytes),
                format: entry.format,
                ...(entry.entryRelativePath ? { entryRelativePath: entry.entryRelativePath } : {}),
                ...(entry.files ? { files: cloneCachedArtifactFiles(entry.files) } : {}),
            }));
            return Object.freeze({ ok: true, cacheKey });
        },
        readInstalledArtifact: (identity) => {
            const entry = entries.get(derivePluginReactNativeBundleCacheKey(identity));
            return entry
                ? Object.freeze({
                    ...entry,
                    bytes: cloneBytes(entry.bytes),
                    ...(entry.files ? { files: cloneCachedArtifactFiles(entry.files) } : {}),
                })
                : null;
        },
        evictForPluginUninstall: evictByPlugin,
        evictForPluginDisable: evictByPlugin,
        evictForProjectionGenerationReplacement: (generation) => {
            projectionInvalidationRevision += 1;
            const evictedIdentities: PluginReactNativeBundleCacheIdentity[] = [];
            for (const [key, entry] of entries.entries()) {
                if (generation === null || entry.identity.projectionGeneration !== generation) {
                    evictedIdentities.push(entry.identity);
                    entries.delete(key);
                }
            }
            scheduleDiskEviction(evictedIdentities);
        },
    });
}

const installedPluginReactNativeBundleCache = createPluginReactNativeBundleCache({
    diskGc: createReactNativeInstalledArtifactDiskGc(),
});

export function getInstalledPluginReactNativeBundleCache(): PluginReactNativeBundleCache {
    return installedPluginReactNativeBundleCache;
}

export {
    derivePluginReactNativeBundleCacheKey,
    type PluginReactNativeBundleCacheIdentity,
};
