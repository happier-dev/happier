import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol';
import {
    PluginUiArtifactDigestV1Schema,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
    type PluginUiPersistentArtifactIdentity,
    type PluginUiPersistentArtifactNativeResourceDescriptor,
    type PluginUiPersistentArtifactNativeResourceStore,
    type PluginUiPersistentArtifactRecord,
} from './artifactByteCache';

export type TauriArtifactCacheInvoke = <T>(
    command: string,
    args?: Record<string, unknown>,
) => Promise<T>;

const CACHE_NAMESPACE = 'happier-plugin-ui-artifacts-v1' as const;
const STORED_FILE_NAME_PATTERN = /^[a-f0-9]{64}\.bin$/u;

type TauriCacheLocator = Readonly<{
    namespace: typeof CACHE_NAMESPACE;
    accountKeyHash: string;
    artifactKeyHash: string;
}>;

type TauriCacheFile = Readonly<{
    relativePath: string;
    digest: PluginUiArtifactDigestV1;
    byteSize: number;
    bytesBase64: string;
}>;

function sha256Hex(value: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function locatorFor(identity: PluginUiPersistentArtifactIdentity): TauriCacheLocator {
    return Object.freeze({
        namespace: CACHE_NAMESPACE,
        accountKeyHash: sha256Hex(derivePluginUiPersistentArtifactAccountKey(identity.accountScope)),
        artifactKeyHash: sha256Hex(derivePluginUiPersistentArtifactKey(identity)),
    });
}

function recordKeyHashFor(identity: PluginUiPersistentArtifactIdentity): string {
    return locatorFor(identity).artifactKeyHash;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function readFile(value: unknown): TauriCacheFile | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        'relativePath',
        'digest',
        'byteSize',
        'bytesBase64',
    ])) return null;
    const digest = PluginUiArtifactDigestV1Schema.safeParse(value.digest);
    if (
        !digest.success
        || typeof value.relativePath !== 'string'
        || value.relativePath.length === 0
        || typeof value.byteSize !== 'number'
        || !Number.isSafeInteger(value.byteSize)
        || value.byteSize < 0
        || typeof value.bytesBase64 !== 'string'
    ) return null;
    let bytes: Uint8Array;
    try {
        bytes = decodeBase64(value.bytesBase64, 'base64');
    } catch {
        return null;
    }
    if (bytes.byteLength !== value.byteSize) return null;
    return Object.freeze({
        relativePath: value.relativePath,
        digest: digest.data,
        byteSize: value.byteSize,
        bytesBase64: value.bytesBase64,
    });
}

function readNativeRecord(
    value: unknown,
    identity: PluginUiPersistentArtifactIdentity,
): PluginUiPersistentArtifactRecord | null {
    if (!isRecord(value)) return null;
    if (!hasExactKeys(value, ['identityKeyHash', 'entryRelativePath', 'files'])) return null;
    if (
        typeof value.identityKeyHash !== 'string'
        || value.identityKeyHash !== recordKeyHashFor(identity)
        || typeof value.entryRelativePath !== 'string'
        || value.entryRelativePath.length === 0
        || !Array.isArray(value.files)
        || value.files.length === 0
    ) return null;
    const files = value.files.map(readFile);
    if (files.some((file): file is null => file === null)) return null;
    const decodedFiles = files as TauriCacheFile[];
    if (new Set(decodedFiles.map((file) => file.relativePath)).size !== decodedFiles.length) return null;
    const entryRelativePath = value.entryRelativePath;
    const entry = decodedFiles.find((file) => file.relativePath === entryRelativePath);
    if (!entry) return null;
    let entryBytes: Uint8Array;
    try {
        entryBytes = decodeBase64(entry.bytesBase64, 'base64');
    } catch {
        return null;
    }
    return Object.freeze({
        persistentIdentity: identity,
        bytes: new Uint8Array(entryBytes),
        entryRelativePath,
        files: Object.freeze(decodedFiles.map((file) => Object.freeze({
            relativePath: file.relativePath,
            digest: file.digest,
            byteSize: file.byteSize,
            bytes: decodeBase64(file.bytesBase64, 'base64'),
        }))),
    });
}

function readNativeDescriptor(input: Readonly<{
    value: unknown;
    locator: TauriCacheLocator;
    files: readonly Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
    }>[];
}>): PluginUiPersistentArtifactNativeResourceDescriptor | null {
    if (!isRecord(input.value) || !hasExactKeys(input.value, ['locator', 'resources'])) return null;
    if (!isRecord(input.value.locator) || !hasExactKeys(input.value.locator, [
        'namespace',
        'accountKeyHash',
        'artifactKeyHash',
    ])) return null;
    const locator = input.value.locator;
    if (
        locator.namespace !== input.locator.namespace
        || locator.accountKeyHash !== input.locator.accountKeyHash
        || locator.artifactKeyHash !== input.locator.artifactKeyHash
        || !Array.isArray(input.value.resources)
        || input.value.resources.length !== input.files.length
    ) return null;
    const resources: PluginUiPersistentArtifactNativeResourceDescriptor['resources'][number][] = [];
    for (const [index, resource] of input.value.resources.entries()) {
        if (!isRecord(resource) || !hasExactKeys(resource, ['storedFileName', 'digest', 'byteSize'])) return null;
        const digest = PluginUiArtifactDigestV1Schema.safeParse(resource.digest);
        const expected = input.files[index];
        if (
            !digest.success
            || !expected
            || typeof resource.storedFileName !== 'string'
            || !STORED_FILE_NAME_PATTERN.test(resource.storedFileName)
            || typeof resource.byteSize !== 'number'
            || !Number.isSafeInteger(resource.byteSize)
            || resource.byteSize < 0
            || digest.data !== expected.digest
            || resource.byteSize !== expected.byteSize
        ) return null;
        resources.push(Object.freeze({
            storedFileName: resource.storedFileName,
            digest: digest.data,
            byteSize: resource.byteSize,
        }));
    }
    if (new Set(resources.map((resource) => resource.storedFileName)).size !== resources.length) return null;
    return Object.freeze({
        locator: input.locator,
        resources: Object.freeze(resources),
    });
}

/**
 * Desktop's app-private filesystem adapter for the existing verified Artifact
 * byte store. It passes only the same hashed locator that native resource
 * registration already consumes; no raw Account/plugin coordinates, paths, or
 * bytes ever become a Wry frame configuration.
 */
export function createTauriPluginUiPersistentArtifactStore(input: Readonly<{
    invoke?: TauriArtifactCacheInvoke;
}> = {}): PluginUiPersistentArtifactNativeResourceStore {
    let invoke = input.invoke;
    let loadingInvoke: Promise<TauriArtifactCacheInvoke> | null = null;
    const resolveInvoke = async (): Promise<TauriArtifactCacheInvoke> => {
        if (invoke) return invoke;
        loadingInvoke ??= import('@tauri-apps/api/core').then((module) => module.invoke);
        invoke = await loadingInvoke;
        return invoke;
    };

    return Object.freeze({
        read: async (identity) => {
            const locator = locatorFor(identity);
            try {
                const dispatch = await resolveInvoke();
                const value = await dispatch<unknown>('desktop_hosted_artifact_cache_read', {
                    input: {
                        locator,
                        identityKeyHash: recordKeyHashFor(identity),
                    },
                });
                return value === null ? null : readNativeRecord(value, identity);
            } catch {
                return null;
            }
        },
        write: async (record) => {
            const dispatch = await resolveInvoke();
            await dispatch('desktop_hosted_artifact_cache_write', {
                input: {
                    locator: locatorFor(record.persistentIdentity),
                    identityKeyHash: recordKeyHashFor(record.persistentIdentity),
                    entryRelativePath: record.entryRelativePath,
                    files: record.files.map((file) => Object.freeze({
                        relativePath: file.relativePath,
                        digest: file.digest,
                        byteSize: file.byteSize,
                        bytesBase64: encodeBase64(file.bytes, 'base64'),
                    })),
                },
            });
        },
        describeNativeResource: async ({ identity, files }) => {
            const locator = locatorFor(identity);
            try {
                const dispatch = await resolveInvoke();
                const value = await dispatch<unknown>('desktop_hosted_artifact_cache_describe', {
                    input: {
                        locator,
                        identityKeyHash: recordKeyHashFor(identity),
                        files,
                    },
                });
                return value === null ? null : readNativeDescriptor({ value, locator, files });
            } catch {
                return null;
            }
        },
        remove: async (identity) => {
            const dispatch = await resolveInvoke();
            await dispatch('desktop_hosted_artifact_cache_remove', {
                input: { locator: locatorFor(identity) },
            });
        },
        removeAccount: async (scope) => {
            const dispatch = await resolveInvoke();
            await dispatch('desktop_hosted_artifact_cache_remove_account', {
                input: {
                    namespace: CACHE_NAMESPACE,
                    accountKeyHash: sha256Hex(derivePluginUiPersistentArtifactAccountKey(scope)),
                },
            });
        },
    });
}
