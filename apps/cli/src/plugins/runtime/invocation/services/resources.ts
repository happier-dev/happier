import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import { type PluginResourceDescriptor, type PluginResourceKind, type PluginResourcesService } from '@happier-dev/plugin-sdk/runtime';
import {
    createPluginContributionIdentity,
    PluginResourceKindV2Schema,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import {
    resolveContainedPluginResourcePath,
    resolvePluginResourcePath,
} from '@/plugins/projection/resources/package/resolve';
import {
    computePluginGenerationFileDigest,
    MAXIMUM_IMMUTABLE_GENERATION_FILES,
    type ImmutablePluginGenerationRecord,
} from '@/plugins/store/registry/generationStore';

export const MAX_PLUGIN_RESOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES = 64 * 1024 * 1024;
export const MAX_PLUGIN_RESOURCES_PER_GENERATION = 512;

type ResourceGeneration = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    rootPath: string;
    files: ImmutablePluginGenerationRecord['files'];
}>;

type BindPluginResources = Readonly<{
    pluginId: string;
    generation: string;
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
}>;

type AdmittedResource = Readonly<{
    descriptor: PluginResourceDescriptor;
    rootPath: string;
    relativePath: string;
    expectedSize: number;
    expectedDigest: string;
}>;

export type StablePluginResourcesOwner = Readonly<{
    hasPlugin(pluginId: string): boolean;
    bind(params: BindPluginResources): PluginResourcesService;
    retireGeneration(generation: string): void;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

async function withStableResourceErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof PluginError) throw error;
        throw new PluginError({ code: 'plugin_resource_io_failed', message: 'Resource operation failed' }, { cause: error });
    }
}

function ownData(value: unknown, key: string): unknown {
    if (typeof value !== 'object' || value === null) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return descriptor.value;
}

function boundedString(value: unknown, maxLength = 2_048): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maxLength) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return value;
}

function resourceKind(value: unknown): PluginResourceKind {
    const parsed = PluginResourceKindV2Schema.safeParse(value);
    if (!parsed.success) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return parsed.data;
}

function optionalDigest(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const digest = boundedString(value, 256);
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
    return digest;
}

function normalizeContribution(raw: ResolvedResourceContribution): Readonly<{
    pluginId: string;
    pluginRootPath: string;
    id: string;
    kind: PluginResourceKind;
    path: string;
    contentType: string;
    digest: string | null;
}> {
    try {
        const pluginId = boundedString(ownData(raw, 'pluginId'), 256);
        const pluginRootPath = boundedString(ownData(raw, 'pluginRootPath'), 4_096);
        boundedString(ownData(raw, 'manifestPath'), 4_096);
        boundedString(ownData(raw, 'manifestDigest'), 256);
        const provenance = ownData(raw, 'provenance');
        if (provenance !== 'first_party' && provenance !== 'external') {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const source = ownData(raw, 'source');
        const sourceKind = boundedString(ownData(source, 'kind'), 32);
        if (!['bundled', 'path', 'archive', 'marketplace', 'package'].includes(sourceKind)) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const sourceSpec = ownData(raw, 'sourceSpec');
        if (boundedString(ownData(sourceSpec, 'kind'), 32) !== sourceKind) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        boundedString(ownData(sourceSpec, 'locator'), 4_096);
        const trustPolicy = boundedString(ownData(sourceSpec, 'trustPolicy'), 32);
        const installPolicy = boundedString(ownData(sourceSpec, 'installPolicy'), 32);
        if (!['local_trusted', 'prompt', 'untrusted'].includes(trustPolicy)
            || !['link', 'copy', 'managed_install'].includes(installPolicy)) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const definition = ownData(raw, 'definition');
        if (ownData(definition, 'kindVersion') !== 1) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        const identity = createPluginContributionIdentity({
            pluginId,
            localId: boundedString(ownData(definition, 'id'), 256),
        });
        return Object.freeze({
            pluginId: identity.pluginId,
            pluginRootPath,
            id: identity.localId,
            kind: resourceKind(ownData(definition, 'type')),
            path: boundedString(ownData(definition, 'path'), 4_096),
            contentType: boundedString(ownData(definition, 'contentType'), 512),
            digest: optionalDigest(Object.getOwnPropertyDescriptor(definition, 'digest')?.value),
        });
    } catch (error) {
        if (error instanceof PluginError) throw error;
        return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
    }
}

function normalizeGeneration(raw: ResourceGeneration): Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    rootPath: string;
    filesByPath: ReadonlyMap<string, ImmutablePluginGenerationRecord['files'][number]>;
}> {
    try {
        const pluginId = boundedString(ownData(raw, 'pluginId'), 256);
        const immutableGenerationId = boundedString(ownData(raw, 'immutableGenerationId'), 160);
        const rootPath = boundedString(ownData(raw, 'rootPath'), 4_096);
        const files = ownData(raw, 'files');
        if (!Array.isArray(files) || files.length > MAXIMUM_IMMUTABLE_GENERATION_FILES) {
            return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
        }
        const filesByPath = new Map<string, ImmutablePluginGenerationRecord['files'][number]>();
        for (const rawFile of files) {
            const relativePath = boundedString(ownData(rawFile, 'relativePath'), 512);
            const byteLength = ownData(rawFile, 'byteLength');
            const digest = boundedString(ownData(rawFile, 'digest'), 256);
            if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0 || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
                return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
            }
            if (filesByPath.has(relativePath)) {
                return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
            }
            filesByPath.set(relativePath, Object.freeze({ relativePath, byteLength: byteLength as number, digest }));
        }
        return Object.freeze({ pluginId, immutableGenerationId, rootPath, filesByPath: Object.freeze(filesByPath) });
    } catch (error) {
        if (error instanceof PluginError) throw error;
        return fail('plugin_resource_generation_invalid', 'Resource generation is invalid');
    }
}

async function resolveAdmittedPath(rootPath: string, relativePath: string): Promise<string> {
    const lexical = resolvePluginResourcePath({ pluginRootPath: rootPath, resourcePath: relativePath });
    if (!lexical) return fail('plugin_resource_path_denied', 'Resource path is denied');
    const contained = await resolveContainedPluginResourcePath({ pluginRootPath: rootPath, resourcePath: relativePath });
    if (!contained) {
        try {
            const info = await lstat(lexical.absolutePath);
            if (info.isSymbolicLink()) return fail('plugin_resource_path_denied', 'Resource path is denied');
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                return fail('plugin_resource_missing', 'Resource bytes are missing');
            }
        }
        return fail('plugin_resource_path_denied', 'Resource path is denied');
    }
    const canonicalRoot = await realpath(resolve(rootPath)).catch(() => fail('plugin_resource_generation_invalid', 'Resource generation root is unavailable'));
    if (contained.absolutePath !== resolve(canonicalRoot, ...contained.relativePath.split('/'))) {
        return fail('plugin_resource_path_denied', 'Resource path is denied');
    }
    const info = await lstat(contained.absolutePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return fail('plugin_resource_missing', 'Resource bytes are missing');
        }
        throw error;
    });
    if (info.isSymbolicLink()) return fail('plugin_resource_path_denied', 'Resource path is denied');
    if (!info.isFile()) return fail('plugin_resource_unsupported_kind', 'Resource entry kind is unsupported');
    return contained.absolutePath;
}

async function verifyBytes(resource: AdmittedResource, maxBytes: number, guard: () => void): Promise<Uint8Array> {
    guard();
    const absolutePath = await resolveAdmittedPath(resource.rootPath, resource.relativePath);
    const handle = await open(absolutePath, 'r').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return fail('plugin_resource_missing', 'Resource bytes are missing');
        }
        throw error;
    });
    try {
        const info = await handle.stat();
        if (!info.isFile()) return fail('plugin_resource_unsupported_kind', 'Resource entry kind is unsupported');
        if (resource.expectedSize > maxBytes || info.size > maxBytes) {
            return fail('plugin_resource_too_large', 'Resource read exceeds its byte limit');
        }
        if (info.size !== resource.expectedSize) {
            return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted generation');
        }
        const bytes = new Uint8Array(await handle.readFile());
        guard();
        if (bytes.byteLength !== resource.expectedSize || computePluginGenerationFileDigest(bytes) !== resource.expectedDigest) {
            return fail('plugin_resource_integrity_mismatch', 'Resource bytes do not match the admitted generation');
        }
        return bytes;
    } finally {
        await handle.close();
    }
}

function readLimit(value: unknown): number {
    if (value === undefined) return MAX_PLUGIN_RESOURCE_BYTES;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_PLUGIN_RESOURCE_BYTES) {
        return fail('plugin_resource_limit_invalid', 'Resource byte limit is invalid');
    }
    return value;
}

function normalizeReadOptions(options: { maxBytes?: number; signal?: AbortSignal } | undefined): Readonly<{
    maxBytes: number;
    signal?: AbortSignal;
}> {
    if (options === undefined) return Object.freeze({ maxBytes: MAX_PLUGIN_RESOURCE_BYTES });
    try {
        if (typeof options !== 'object' || options === null) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        const prototype = Object.getPrototypeOf(options);
        if (prototype !== Object.prototype && prototype !== null) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        const maxBytesDescriptor = Object.getOwnPropertyDescriptor(options, 'maxBytes');
        const signalDescriptor = Object.getOwnPropertyDescriptor(options, 'signal');
        if (
            (maxBytesDescriptor && !('value' in maxBytesDescriptor))
            || (signalDescriptor && !('value' in signalDescriptor))
        ) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        const maxBytes = readLimit(maxBytesDescriptor?.value);
        const signal = signalDescriptor?.value;
        if (signal !== undefined && !(signal instanceof AbortSignal)) {
            return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
        }
        return Object.freeze({ maxBytes, ...(signal ? { signal } : {}) });
    } catch (error) {
        if (error instanceof PluginError) throw error;
        return fail('plugin_resource_options_invalid', 'Resource read options are invalid');
    }
}

export async function createStablePluginResourcesOwner(params: Readonly<{
    registry: Pick<ResolvedContributionRegistry, 'generationId' | 'resources'>;
    generations: ReadonlyMap<string, ResourceGeneration>;
    isCommittedGenerationCurrent?: () => boolean | Promise<boolean>;
}>): Promise<StablePluginResourcesOwner> {
    const generationId = params.registry.generationId;
    if (typeof generationId !== 'string' || generationId.length === 0 || generationId.trim() !== generationId) {
        return fail('plugin_resource_generation_invalid', 'Resource registry generation is invalid');
    }
    if (!Array.isArray(params.registry.resources) || params.registry.resources.length > MAX_PLUGIN_RESOURCES_PER_GENERATION) {
        return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its declaration bound');
    }

    const admittedByPlugin = new Map<string, Map<string, AdmittedResource>>();
    const admittedResources: AdmittedResource[] = [];
    let aggregateBytes = 0;
    for (const rawContribution of params.registry.resources) {
        const contribution = normalizeContribution(rawContribution);
        const generationRaw = params.generations.get(contribution.pluginId);
        if (!generationRaw) return fail('plugin_resource_generation_invalid', 'Resource generation is unavailable');
        const generation = normalizeGeneration(generationRaw);
        if (generation.pluginId !== contribution.pluginId) {
            return fail('plugin_resource_generation_invalid', 'Resource generation identity does not match its declaration');
        }
        if (resolve(generation.rootPath) !== resolve(contribution.pluginRootPath)) {
            return fail('plugin_resource_generation_invalid', 'Resource generation provenance does not match its declaration');
        }
        const lexical = resolvePluginResourcePath({ pluginRootPath: generation.rootPath, resourcePath: contribution.path });
        if (!lexical) return fail('plugin_resource_path_denied', 'Resource path is denied');
        const file = generation.filesByPath.get(lexical.relativePath);
        if (!file) {
            await resolveAdmittedPath(generation.rootPath, lexical.relativePath);
            return fail('plugin_resource_file_not_declared', 'Resource path is not part of the admitted generation');
        }
        if (file.byteLength > MAX_PLUGIN_RESOURCE_BYTES) {
            return fail('plugin_resource_capacity_exceeded', 'Resource exceeds its admitted byte bound');
        }
        aggregateBytes += file.byteLength;
        if (aggregateBytes > MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES) {
            return fail('plugin_resource_capacity_exceeded', 'Resource generation exceeds its aggregate byte bound');
        }
        if (contribution.digest && contribution.digest !== file.digest) {
            return fail('plugin_resource_integrity_mismatch', 'Resource digest does not match the admitted generation');
        }
        const descriptor = Object.freeze({
            id: contribution.id,
            kind: contribution.kind,
            contentType: contribution.contentType,
            digest: file.digest,
            size: file.byteLength,
        });
        const admitted = Object.freeze({
            descriptor,
            rootPath: generation.rootPath,
            relativePath: lexical.relativePath,
            expectedSize: file.byteLength,
            expectedDigest: file.digest,
        });
        admittedResources.push(admitted);
        const byId = admittedByPlugin.get(contribution.pluginId) ?? new Map<string, AdmittedResource>();
        if (byId.has(contribution.id)) {
            return fail('plugin_resource_declaration_invalid', 'Resource declaration is invalid');
        }
        byId.set(contribution.id, admitted);
        admittedByPlugin.set(contribution.pluginId, byId);
    }
    for (const admitted of admittedResources) {
        await withStableResourceErrors(() => verifyBytes(admitted, MAX_PLUGIN_RESOURCE_BYTES, () => undefined));
    }

    let retired = false;
    const admittedPluginIds = new Set(params.generations.keys());
    return Object.freeze({
        hasPlugin(pluginId: string): boolean {
            return !retired && admittedPluginIds.has(pluginId);
        },
        bind(bindParams): PluginResourcesService {
            if (bindParams.generation !== generationId) {
                return fail('plugin_generation_stale', 'Plugin generation is stale');
            }
            const resources = admittedByPlugin.get(bindParams.pluginId) ?? new Map<string, AdmittedResource>();
            function guard(signal?: AbortSignal): void {
                if (retired || !bindParams.isGenerationCurrent()) {
                    return fail('plugin_generation_stale', 'Plugin generation is stale');
                }
                if (bindParams.signal.aborted || signal?.aborted) {
                    return fail('plugin_resource_aborted', 'Resource operation was aborted');
                }
            }
            function find(id: string): AdmittedResource {
                guard();
                if (typeof id !== 'string' || id.length === 0 || id.trim() !== id || id.length > 256) {
                    return fail('plugin_resource_not_found', 'Resource is not declared for this plugin');
                }
                return resources.get(id) ?? fail('plugin_resource_not_found', 'Resource is not declared for this plugin');
            }
            async function guardCommittedGeneration(): Promise<void> {
                if (params.isCommittedGenerationCurrent && !await params.isCommittedGenerationCurrent()) {
                    return fail('plugin_generation_stale', 'Plugin generation is stale');
                }
            }
            return Object.freeze({
                describe(id: string) {
                    return find(id).descriptor;
                },
                async read(id: string, options?: { maxBytes?: number; signal?: AbortSignal }) {
                    const resource = find(id);
                    const normalizedOptions = normalizeReadOptions(options);
                    const bytes = await withStableResourceErrors(async () => {
                        await guardCommittedGeneration();
                        const verified = await verifyBytes(
                            resource,
                            normalizedOptions.maxBytes,
                            () => guard(normalizedOptions.signal),
                        );
                        await guardCommittedGeneration();
                        return verified;
                    });
                    return Object.freeze({
                        kind: resource.descriptor.kind,
                        contentType: resource.descriptor.contentType,
                        digest: resource.descriptor.digest,
                        bytes,
                    });
                },
                watch(id: string, _listener: (change: { digest: string }) => void) {
                    find(id);
                    return fail('plugin_resource_watch_unavailable', 'Resource watch is unavailable for this immutable generation');
                },
            });
        },
        retireGeneration(candidateGeneration) {
            if (candidateGeneration !== generationId) {
                return fail('plugin_resource_generation_invalid', 'Resource generation retirement does not match its owner');
            }
            retired = true;
        },
    });
}
