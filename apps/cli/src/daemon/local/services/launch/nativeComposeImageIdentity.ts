import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { list as listTar } from 'tar';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentExecEnvPortV1 } from '@happier-dev/plugin-sdk/exec';
import { createFileTransferPayloadSource, resolveTransferPayloadManifestHash } from '@/machines/transfer/transferPayloadSource';
import type { MachineNativeEffectContext } from './machineNativeEffectAdmission';
import { MachineNativeEffectAdmissionError } from './machineNativeEffectAdmission';

/** Host-only custody from the containing native admission, never receipt data. */
export type NativeComposeEffectAuthority = Readonly<{
    context: MachineNativeEffectContext;
}>;

export type NativeComposeImageArchive = Readonly<{
    image: DeploymentImageV1;
    path: string;
    sizeBytes: number;
    /** Raw file SHA-256, matching the existing prepared filesystem-copy owner. */
    sha256: string;
}>;

export async function readNativeComposeArchiveTransportIdentity(path: string): Promise<Readonly<{ sizeBytes: number; sha256: string }>> {
    const sizeBytes = (await stat(path)).size;
    const manifestHash = await resolveTransferPayloadManifestHash(createFileTransferPayloadSource({ filePath: path, sizeBytes }));
    return { sizeBytes, sha256: manifestHash.slice('sha256:'.length) };
}

export type NativeComposeRegistryAcquisition = Readonly<{
    access: 'pull' | 'pushPull';
    origin: string;
    bindingIdentity: string;
    envPort: DeploymentExecEnvPortV1;
    /** Build-only exact pushPull authority; runtime acquisition keeps pull-only custody. */
    publicationEnvPort?: DeploymentExecEnvPortV1;
}>;
export type NativeComposeImageAcquisition = Readonly<{
    operation: 'deploy' | 'rollback';
    registries?: readonly NativeComposeRegistryAcquisition[];
    /** Explicit anonymous registry IO uses private empty config, never Docker HOME. */
    publicRegistryEnvPort?: DeploymentExecEnvPortV1;
    archives?: readonly Readonly<{
        image: DeploymentImageV1;
        sizeBytes: number;
        sha256: string;
        /** The receiver retains transfer/load custody outside native scratch. */
        acquire(): Promise<Readonly<{ path: string; sizeBytes: number; sha256: string }>>;
    }>[];
}>;

export function resolveNativeComposeRegistryForReference<T extends Pick<NativeComposeRegistryAcquisition, 'origin' | 'access'>>(
    reference: string, registries: readonly T[] | undefined) {
    const repository = reference.includes('@') ? reference.slice(0, reference.lastIndexOf('@')) : reference;
    const first = repository.split('/')[0];
    const registryHost = repository.includes('/') && first && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io';
    const matching = (registries ?? []).filter(candidate => {
        const host = new URL(candidate.origin).host;
        return (host === 'index.docker.io' ? 'docker.io' : host) === registryHost;
    });
    return matching.find(candidate => candidate.access === 'pushPull') ?? matching[0];
}

/** Deploy/rollback distribution uses only the recorded immutable reference and
 * its matching pushPull binding. Pull-only bindings remain source-pull custody. */
export function resolveNativeComposeImageDistributionRegistry<T extends Pick<NativeComposeRegistryAcquisition, 'origin' | 'access'>>(
    image: Pick<DeploymentImageV1, 'registryReference' | 'manifestDigest'>, registries: readonly T[] | undefined) {
    if (!image.registryReference?.endsWith(`@${image.manifestDigest}`)) return undefined;
    const registry = resolveNativeComposeRegistryForReference(image.registryReference, registries);
    return registry?.access === 'pushPull' ? registry : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Docker/Buildx uses containerd platform normalization. This folds native
 * aliases/default variants, never infers an absent OS or host architecture.
 * https://github.com/containerd/platforms/blob/v0.2.1/database.go */
export function normalizeNativeComposePlatform(platform: string): string {
    const parts = platform.toLowerCase().split('/');
    if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) return platform;
    let [os, architecture, variant = ''] = parts;
    if (os === 'macos') os = 'darwin';
    switch (architecture) {
        case 'i386': architecture = '386'; variant = ''; break;
        case 'x86_64': case 'x86-64': case 'amd64':
            architecture = 'amd64'; if (variant === 'v1') variant = ''; break;
        case 'aarch64': case 'arm64':
            architecture = 'arm64'; if (variant === '8' || variant === 'v8') variant = ''; break;
        case 'armhf': architecture = 'arm'; variant = 'v7'; break;
        case 'armel': architecture = 'arm'; variant = 'v6'; break;
        case 'arm':
            if (!variant || variant === '7') variant = 'v7';
            else if (variant === '5' || variant === '6' || variant === '8') variant = `v${variant}`;
    }
    return [os, architecture, ...(variant ? [variant] : [])].join('/');
}

function refuse(reason: string): never {
    throw new PluginError({ code: 'native_failed', message: 'Native Compose operation could not be completed', details: { reason } });
}

/** Invalid native JSON is an unavailable observation, not positive identity. */
function readNativeImageJson(text: string): unknown {
    try { return JSON.parse(text); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return refuse('deployment_image_identity_unavailable');
    }
}

async function readArchiveEntries(file: string, paths: ReadonlySet<string>) {
    const found = new Map<string, Buffer>();
    const pending: Promise<void>[] = [];
    await listTar({ file, onReadEntry(entry) {
        const path = entry.path.replace(/^\.\//u, '');
        if (!paths.has(path)) { entry.resume(); return; }
        pending.push(new Promise<void>((resolveEntry, rejectEntry) => {
            const chunks: Buffer[] = [];
            entry.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            entry.on('error', rejectEntry);
            entry.on('end', () => { found.set(path, Buffer.concat(chunks)); resolveEntry(); });
        }));
    } });
    await Promise.all(pending);
    return found;
}

/** Shared CONFIG parser. Local tagless images need no invented registry or
 * receipt manifest identity; the same archive bytes still prove their CONFIG. */
async function readNativeComposeImageArchiveConfig(file: string, image: Readonly<{ manifestDigest?: string; configDigest?: string }>) {
    let configDigest = image.configDigest;
    if (!configDigest) {
        const manifestPath = image.manifestDigest ? `blobs/sha256/${image.manifestDigest.slice('sha256:'.length)}` : undefined;
        const metadata = await readArchiveEntries(file, new Set(['manifest.json', ...(manifestPath ? [manifestPath] : [])]));
        const ociBytes = manifestPath ? metadata.get(manifestPath) : undefined;
        if (ociBytes) {
            const manifest = readNativeImageJson(ociBytes.toString('utf8'));
            if (`sha256:${createHash('sha256').update(ociBytes).digest('hex')}` !== image.manifestDigest
                || !record(manifest) || !record(manifest.config) || typeof manifest.config.digest !== 'string'
                || !/^sha256:[a-f0-9]{64}$/u.test(manifest.config.digest)) return refuse('deployment_image_identity_mismatch');
            configDigest = manifest.config.digest;
        } else {
            const classicBytes = metadata.get('manifest.json');
            const manifest = classicBytes ? readNativeImageJson(classicBytes.toString('utf8')) : undefined;
            if (!Array.isArray(manifest) || manifest.length !== 1 || !record(manifest[0]) || typeof manifest[0].Config !== 'string') return refuse('deployment_image_identity_mismatch');
            const match = /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:\.json)?$/u.exec(manifest[0].Config);
            if (!match) return refuse('deployment_image_identity_mismatch');
            configDigest = `sha256:${match[1]}`;
        }
    }
    const digest = configDigest.slice('sha256:'.length);
    const candidates = new Set([`${digest}.json`, `blobs/sha256/${digest}`]);
    let config: Record<string, unknown> | undefined;
    let configPath: string | undefined;
    let manifest: unknown;
    let manifestMatches = false;
    const manifestPath = image.manifestDigest ? `blobs/sha256/${image.manifestDigest.slice('sha256:'.length)}` : undefined;
    const entries = await readArchiveEntries(file, new Set([...candidates, 'manifest.json', ...(manifestPath ? [manifestPath] : [])]));
    for (const [path, bytes] of entries) {
        const parsed = readNativeImageJson(bytes.toString('utf8'));
        if (path === 'manifest.json') manifest = parsed;
        else if (path === manifestPath && record(parsed) && record(parsed.config) && parsed.config.digest === configDigest
            && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === image.manifestDigest) manifestMatches = true;
        else if (record(parsed) && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === configDigest) {
            config = parsed;
            configPath = path;
        }
    }
    // Every producer exports one exact image/platform. Loading a classic archive
    // with additional entries would also import aliases outside that receipt.
    const classicMatches = Array.isArray(manifest) && manifest.length === 1
        && record(manifest[0]) && manifest[0].Config === configPath;
    // Containerd Docker exports carry both formats. Matching OCI metadata must
    // not conceal additional images that the classic importer would also load.
    if (!config || entries.has('manifest.json') && !classicMatches
        || !manifestMatches && !classicMatches) return refuse('deployment_image_identity_mismatch');
    return { config, configDigest, manifestMatches };
}

function nativeArchivePlatform(config: Record<string, unknown>): string {
    if (typeof config.os !== 'string' || !config.os || typeof config.architecture !== 'string' || !config.architecture
        || config.variant !== undefined && typeof config.variant !== 'string') return refuse('deployment_image_platform_mismatch');
    return normalizeNativeComposePlatform([config.os, config.architecture,
        ...(typeof config.variant === 'string' && config.variant ? [config.variant] : [])].join('/'));
}

/** Discovery, local prune observation and retained-image verification share
 * one CONFIG parser; expected receipt platform checks stay unchanged. */
export async function verifyNativeComposeImageArchive(file: string, image: Pick<DeploymentImageV1, 'manifestDigest' | 'platform'> & Readonly<{ configDigest?: string }>) {
    const saved = await readNativeComposeImageArchiveConfig(file, image);
    const platform = [saved.config.os, saved.config.architecture, saved.config.variant]
        .filter(value => typeof value === 'string' && value.length > 0).join('/');
    if (normalizeNativeComposePlatform(platform) !== normalizeNativeComposePlatform(image.platform)) return refuse('deployment_image_platform_mismatch');
    return saved;
}

/** Receipt custody and Compose convergence use different native image references.
 * The activation reference stays equal when another service alone is deployed. */
function deploymentImageRepository(environmentInstanceId: string, service: string): string {
    return `happier-deployment/${createHash('sha256').update(environmentInstanceId).digest('hex')}/${createHash('sha256').update(service).digest('hex')}`;
}

/** Build/export custody exists before the native CONFIG digest is known. */
export function resolveNativeComposeDeploymentOwnedImageTag(input: Readonly<{
    environmentInstanceId: string; deploymentId: string; service: string; platform: string;
}>): string {
    const identity = createHash('sha256').update(JSON.stringify([input.deploymentId, input.platform])).digest('hex');
    return `${deploymentImageRepository(input.environmentInstanceId, input.service)}:${identity}`;
}

export function resolveNativeComposeDeploymentImageReferences(input: Readonly<{
    environmentInstanceId: string;
    deploymentId: string;
    image: Pick<DeploymentImageV1, 'service' | 'platform' | 'configDigest'>;
}>): Readonly<{ ownedTag: string; activationRef: string }> {
    const repository = deploymentImageRepository(input.environmentInstanceId, input.image.service);
    const configIdentity = createHash('sha256').update(JSON.stringify([input.image.platform, input.image.configDigest])).digest('hex');
    return { ownedTag: resolveNativeComposeDeploymentOwnedImageTag({ environmentInstanceId: input.environmentInstanceId,
        deploymentId: input.deploymentId, service: input.image.service, platform: input.image.platform }),
        activationRef: `${repository}:config-${configIdentity}` };
}

/** One invocation-local identity owner for selected images and running-container refs. */
export function createNativeComposeImageIdentity(input: Readonly<{
    /** undefined is local/source IO; null is explicit anonymous registry IO. */
    run(args: readonly string[], signal?: AbortSignal, registry?: NativeComposeRegistryAcquisition | null,
        authority?: NativeComposeEffectAuthority): Promise<Readonly<{ stdout: string; exitCode?: number }>>;
    directory(): Promise<string>;
}>) {
    const proven = new Map<string, Readonly<{ reference: string; config: Record<string, unknown> }>>();
    const preparedArchives = new Map<string, Readonly<{ path: string; reference?: string }>>();
    const imageKey = (image: DeploymentImageV1) => JSON.stringify([image.service, image.platform, image.configDigest, image.manifestDigest]);
    const prove = async (reference: string, image: DeploymentImageV1, inspection?: unknown): Promise<Record<string, unknown>> => {
        const key = JSON.stringify([reference, image.configDigest, image.manifestDigest, image.platform]);
        const existing = proven.get(key);
        if (existing) return existing.config;
        const observed = inspection ?? JSON.parse((await input.run(['image', 'inspect', '--platform', image.platform, reference])).stdout);
        if (!Array.isArray(observed) || observed.length !== 1 || !record(observed[0])) return refuse('deployment_image_identity_unavailable');
        const nativeId = observed[0].Id;
        if (typeof nativeId !== 'string') return refuse('deployment_image_identity_unavailable');
        const nativeKey = JSON.stringify([nativeId, image.configDigest, image.manifestDigest, image.platform]);
        const file = join(await input.directory(), `image-${createHash('sha256').update(nativeKey).digest('hex')}.tar`);
        try {
            // Native Id is an invocation-local lookup alias only. Snapshot it
            // before saving so a mutable source tag cannot change these bytes.
            await input.run(['image', 'save', '--platform', image.platform, '--output', file, nativeId]);
            const saved = await verifyNativeComposeImageArchive(file, image);
            // Classic and containerd stores retain different manifest metadata.
            // Receipt CONFIG bytes and platform establish portable equality.
            const snapshot = { reference: nativeId, config: saved.config };
            proven.set(key, snapshot);
            proven.set(nativeKey, snapshot);
            return saved.config;
        } finally { await rm(file, { force: true }); }
    };
    /** Only declared/admitted lookup aliases; never scan the image inventory.
     * Every result is stabilized to native Id after portable CONFIG proof. */
    const locate = async (references: readonly string[], image: DeploymentImageV1) => {
        for (const reference of new Set(references)) {
            const existing = proven.get(JSON.stringify([reference, image.configDigest, image.manifestDigest, image.platform]));
            if (existing) return existing;
            const result = await input.run(['image', 'inspect', '--platform', image.platform, reference]);
            if (result.exitCode !== undefined && result.exitCode !== 0) continue;
            const inspection: unknown = JSON.parse(result.stdout);
            await prove(reference, image, inspection);
            return proven.get(JSON.stringify([reference, image.configDigest, image.manifestDigest, image.platform]))
                ?? refuse('deployment_image_identity_unavailable');
        }
        return null;
    };
    const identity = {
        /** Host-private repo:tag from the canonical ownedTag/activationRef
         * producer, not a native ID, digest, pattern or inventory request.
         * Docker's exact positional contract: https://docs.docker.com/reference/cli/docker/image/ls/ */
        async observeLocalAlias(reference: string) {
            const inventory = await input.run(['image', 'ls', '--all', '--quiet', '--no-trunc', reference]);
            if (inventory.exitCode !== 0) return { kind: 'unavailable' as const };
            return inventory.stdout.trim() ? { kind: 'present' as const } : { kind: 'absent' as const };
        },
        /** Fresh local observation; native Id is only a save alias. Never
         * resolves a mutable registry reference, pulls, loads or retains tags. */
        async readLocalImage(reference: string) {
            const result = await input.run(['image', 'inspect', reference]);
            if (result.exitCode !== undefined && result.exitCode !== 0) return refuse('deployment_image_identity_unavailable');
            const observed = readNativeImageJson(result.stdout);
            if (!Array.isArray(observed) || observed.length !== 1 || !record(observed[0])) return refuse('deployment_image_identity_unavailable');
            const native = observed[0];
            // Engine Go slices may encode known-empty aliases as null.
            // A missing/malformed field remains unknown, never tagless proof.
            const rawTags = native.RepoTags === null ? [] : native.RepoTags;
            const rawDigests = native.RepoDigests === null ? [] : native.RepoDigests;
            if (typeof native.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(native.Id)
                || !Array.isArray(rawTags) || !rawTags.every(value => typeof value === 'string')
                || !Array.isArray(rawDigests) || !rawDigests.every(value => typeof value === 'string')) return refuse('deployment_image_identity_unavailable');
            const nativeId = native.Id;
            const repoTags = rawTags.filter((value): value is string => typeof value === 'string');
            const repoDigests = rawDigests.filter((value): value is string => typeof value === 'string');
            const descriptor = record(native.Descriptor) ? native.Descriptor : undefined;
            const manifestDigest = descriptor && (descriptor.mediaType === 'application/vnd.oci.image.manifest.v1+json'
                || descriptor.mediaType === 'application/vnd.docker.distribution.manifest.v2+json')
                && typeof descriptor.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)
                ? descriptor.digest : undefined;
            const scratch = await mkdtemp(join(await input.directory(), 'local-'));
            const file = join(scratch, 'image.tar');
            try {
                const saved = await input.run(['image', 'save', '--output', file, nativeId]);
                if (saved.exitCode !== undefined && saved.exitCode !== 0) return refuse('deployment_image_identity_unavailable');
                const image = await readNativeComposeImageArchiveConfig(file, { ...(manifestDigest ? { manifestDigest } : {}) });
                return { nativeId, repoTags, repoDigests,
                    variants: [{ configDigest: image.configDigest, platform: nativeArchivePlatform(image.config) }] };
            } finally { await rm(scratch, { recursive: true, force: true }); }
        },
        async resolve(selection: Readonly<{ service: string; reference: string; platform: string }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<DeploymentImageV1> {
            const inspection: unknown = JSON.parse((await input.run(['image', 'inspect', '--platform', selection.platform, selection.reference], options?.signal)).stdout);
            if (!Array.isArray(inspection) || inspection.length !== 1 || !record(inspection[0])) return refuse('deployment_image_identity_unavailable');
            const native = inspection[0];
            const repoDigests = Array.isArray(native.RepoDigests) ? native.RepoDigests.filter((ref): ref is string => typeof ref === 'string') : [];
            const manifestDigest = record(native.Descriptor) && typeof native.Descriptor.digest === 'string' ? native.Descriptor.digest
                : repoDigests.find(ref => selection.reference.includes('@') ? ref === selection.reference : true)?.split('@').at(-1);
            if (!manifestDigest || !/^sha256:[a-f0-9]{64}$/u.test(manifestDigest)
                || selection.reference.includes('@') && !selection.reference.endsWith(`@${manifestDigest}`)) return refuse('deployment_image_manifest_mismatch');
            const reference = selection.reference.includes('@') ? selection.reference
                : repoDigests.find(ref => ref.endsWith(`@${manifestDigest}`));
            // Native references can contain bound secrets; scratch names must
            // not publish a dictionary-testable digest of that reference.
            const scratch = await mkdtemp(join(await input.directory(), 'candidate-'));
            const file = join(scratch, 'image.tar');
            let retained = false;
            try {
                // A mutable tag may move after inspection. Native Id is only an
                // invocation-local save alias; archive bytes establish CONFIG.
                const saveReference = reference ?? (typeof native.Id === 'string' ? native.Id : refuse('deployment_image_identity_unavailable'));
                await input.run(['image', 'save', '--platform', selection.platform, '--output', file, saveReference], options?.signal);
                const saved = await verifyNativeComposeImageArchive(file, { manifestDigest, platform: selection.platform });
                const manifestType = record(native.Descriptor) ? native.Descriptor.mediaType : undefined;
                // RepoDigests can name a multi-platform index. Only a native
                // manifest descriptor or the manifest's own bytes proves this
                // field; an index digest must never masquerade as a variant.
                if (!saved.manifestMatches && manifestType !== 'application/vnd.oci.image.manifest.v1+json'
                    && manifestType !== 'application/vnd.docker.distribution.manifest.v2+json') return refuse('deployment_image_manifest_mismatch');
                const image: DeploymentImageV1 = { service: selection.service, platform: selection.platform, configDigest: saved.configDigest, manifestDigest,
                    ...(reference ? { registryReference: reference } : {}) };
                preparedArchives.set(imageKey(image), { path: file, reference: saveReference });
                retained = true;
                return image;
            } finally { if (!retained) await rm(scratch, { recursive: true, force: true }); }
        },
        /** Review resolves a mutable name once. Later platforms use NAME@index
         * from that approval, never another resolution of the source tag. */
        async resolveVariants(selection: Readonly<{ service: string; reference: string; platforms?: readonly string[] }>,
            options?: Readonly<{ signal?: AbortSignal; registries?: readonly NativeComposeRegistryAcquisition[] }>): Promise<readonly DeploymentImageV1[]> {
            const signal = options?.signal;
            const platforms = selection.platforms === undefined ? undefined : [...new Set(selection.platforms.map(normalizeNativeComposePlatform))];
            if (platforms?.length === 0) return [];
            const unavailable = (): never => { throw new PluginError({ code: 'deployment_image_unavailable',
                message: 'The exact platform image is unavailable' }); };
            const actualPlatform = (os: unknown, architecture: unknown, variant: unknown) =>
                typeof os === 'string' && os.length > 0 && os !== 'unknown'
                    && typeof architecture === 'string' && architecture.length > 0 && architecture !== 'unknown'
                    ? normalizeNativeComposePlatform([os, architecture, ...(typeof variant === 'string' && variant.length > 0 ? [variant] : [])].join('/'))
                    : undefined;
            const at = selection.reference.lastIndexOf('@');
            const repository = at < 0 ? selection.reference : selection.reference.slice(0, at);
            const expected = at < 0 ? undefined : selection.reference.slice(at + 1);
            if (!repository || /[\s@\\]/u.test(repository) || repository.includes('://') || repository.startsWith('-')
                || expected !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(expected)) return refuse('deployment_image_registry_mismatch');
            signal?.throwIfAborted();
            if (expected === undefined) {
                const inspection = await input.run(['image', 'inspect', ...(platforms ? ['--platform', platforms[0]!] : []), selection.reference], signal);
                if (inspection.exitCode === undefined || inspection.exitCode === 0) {
                    const local: unknown = JSON.parse(inspection.stdout);
                    if (Array.isArray(local) && local.length === 1 && record(local[0])
                        && (!Array.isArray(local[0].RepoDigests) || local[0].RepoDigests.length === 0)) {
                        // A local-only image has no registry index provenance. Its
                        // exact native archive can serve only its proved platform.
                        if (platforms && platforms.length !== 1) return unavailable();
                        const platform = platforms?.[0] ?? actualPlatform(local[0].Os, local[0].Architecture, local[0].Variant);
                        if (!platform) return unavailable();
                        return [await identity.resolve({ service: selection.service, reference: selection.reference, platform }, options)];
                    }
                }
            }
            const parse = (raw: string): Record<string, unknown> => {
                let value: unknown;
                try { value = JSON.parse(raw); } catch { return refuse('deployment_image_manifest_mismatch'); }
                if (!record(value) || value.schemaVersion !== 2) return refuse('deployment_image_manifest_mismatch');
                return value;
            };
            const raw = async (reference: string) => {
                signal?.throwIfAborted();
                const result = await input.run(['buildx', 'imagetools', 'inspect', '--raw', reference], signal,
                    resolveNativeComposeRegistryForReference(reference, options?.registries) ?? null);
                signal?.throwIfAborted();
                return { bytes: result.stdout, digest: `sha256:${createHash('sha256').update(result.stdout).digest('hex')}`, value: parse(result.stdout) };
            };
            const single = (mediaType: unknown) => mediaType === 'application/vnd.oci.image.manifest.v1+json'
                || mediaType === 'application/vnd.docker.distribution.manifest.v2+json';
            const root = await raw(selection.reference);
            if (expected !== undefined && root.digest !== expected) return refuse('deployment_image_manifest_mismatch');
            const index = root.value.mediaType === 'application/vnd.oci.image.index.v1+json'
                || root.value.mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json';
            if (!index && !single(root.value.mediaType)) return refuse('deployment_image_manifest_mismatch');
            if (index && !Array.isArray(root.value.manifests)) return refuse('deployment_image_manifest_mismatch');
            // An unplaced review needs one immutable source seed, not a guess at
            // the builder's host platform or an eager fetch of every variant.
            let requested: readonly (string | undefined)[] | undefined = platforms;
            let sourceDescriptor: Record<string, unknown> | undefined;
            if (!requested) {
                if (index) {
                    const first = (root.value.manifests as unknown[]).find(value => record(value) && single(value.mediaType)
                        && value.artifactType === undefined && record(value.platform)
                        && (!record(value.annotations) || value.annotations['vnd.docker.reference.type'] !== 'attestation-manifest')
                        && actualPlatform(value.platform.os, value.platform.architecture, value.platform.variant) !== undefined);
                    if (!record(first) || !record(first.platform)) return unavailable();
                    sourceDescriptor = first;
                    requested = [actualPlatform(first.platform.os, first.platform.architecture, first.platform.variant)!];
                } else requested = [undefined];
            }
            const images: DeploymentImageV1[] = [];
            for (let platform of requested) {
                let manifest = root;
                if (index) {
                    const descriptors = sourceDescriptor ? [sourceDescriptor] : (root.value.manifests as unknown[]).filter(value => record(value) && record(value.platform)
                        && normalizeNativeComposePlatform([value.platform.os, value.platform.architecture, value.platform.variant]
                            .filter(part => typeof part === 'string' && part.length > 0).join('/')) === platform);
                    if (!descriptors.length) return unavailable();
                    if (descriptors.length !== 1 || !record(descriptors[0])) return refuse('deployment_image_manifest_mismatch');
                    const descriptor = descriptors[0];
                    if (!single(descriptor.mediaType) || typeof descriptor.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)
                        || typeof descriptor.size !== 'number' || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) return refuse('deployment_image_manifest_mismatch');
                    manifest = await raw(`${repository}@${descriptor.digest}`);
                    if (manifest.digest !== descriptor.digest || Buffer.byteLength(manifest.bytes) !== descriptor.size) return refuse('deployment_image_manifest_mismatch');
                }
                if (!single(manifest.value.mediaType) || !record(manifest.value.config)
                    || typeof manifest.value.config.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(manifest.value.config.digest)) return refuse('deployment_image_manifest_mismatch');
                const reference = `${repository}@${manifest.digest}`;
                signal?.throwIfAborted();
                const config: unknown = JSON.parse((await input.run(['buildx', 'imagetools', 'inspect', '--format', '{{json .Image}}', reference], signal,
                    resolveNativeComposeRegistryForReference(reference, options?.registries) ?? null)).stdout);
                signal?.throwIfAborted();
                const configPlatform = record(config) ? actualPlatform(config.os, config.architecture, config.variant) : undefined;
                if (platform === undefined) platform = configPlatform;
                if (!platform || configPlatform !== platform) {
                    if (!index) return unavailable();
                    return refuse('deployment_image_platform_mismatch');
                }
                images.push({ service: selection.service, platform, manifestDigest: manifest.digest, configDigest: manifest.value.config.digest,
                    ...(index ? { indexDigest: root.digest } : {}), registryReference: reference });
            }
            return images;
        },
        /** Native exporter metadata supplies manifest provenance on classic stores;
         * the actual exported CONFIG bytes establish the portable image identity. */
        async resolveBuildArchive(selection: Readonly<{
            service: string; platform: string; archivePath: string; metadata: unknown;
        }>): Promise<DeploymentImageV1> {
            const metadata = selection.metadata;
            if (!record(metadata)) return refuse('deployment_image_identity_unavailable');
            const configDigest = metadata['containerimage.config.digest'];
            const manifestDigest = metadata['containerimage.digest'];
            const descriptor = metadata['containerimage.descriptor'];
            if (typeof configDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(configDigest)
                || typeof manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(manifestDigest)
                || !record(descriptor) || descriptor.digest !== manifestDigest
                || descriptor.mediaType !== 'application/vnd.oci.image.manifest.v1+json'
                    && descriptor.mediaType !== 'application/vnd.docker.distribution.manifest.v2+json') {
                return refuse('deployment_image_manifest_mismatch');
            }
            const image: DeploymentImageV1 = { service: selection.service, platform: selection.platform, configDigest, manifestDigest };
            await verifyNativeComposeImageArchive(selection.archivePath, image);
            preparedArchives.set(imageKey(image), { path: selection.archivePath });
            return image;
        },
        async exportImage(image: DeploymentImageV1, request: Readonly<{
            references: readonly string[]; ownedTag: string; signal?: AbortSignal; authority?: NativeComposeEffectAuthority;
        }>): Promise<NativeComposeImageArchive> {
            request.signal?.throwIfAborted();
            const prepared = preparedArchives.get(imageKey(image));
            let path = prepared?.path;
            if (!prepared || prepared.reference) {
                const reference = prepared?.reference ?? (await createNativeComposeImageIdentity({ directory: input.directory,
                    run: args => input.run(args, request.signal) }).locate(request.references, image))?.reference;
                if (!reference) return refuse('deployment_image_identity_unavailable');
                if (!request.authority) throw new MachineNativeEffectAdmissionError('admission_unavailable');
                await input.run(['image', 'tag', reference, request.ownedTag], request.signal, undefined, request.authority);
                path = join(await mkdtemp(join(await input.directory(), 'export-')), 'image.tar');
                await input.run(['image', 'save', '--platform', image.platform, '--output', path, request.ownedTag], request.signal);
            }
            if (!path) return refuse('deployment_image_identity_unavailable');
            await verifyNativeComposeImageArchive(path, image);
            const transport = await readNativeComposeArchiveTransportIdentity(path);
            request.signal?.throwIfAborted();
            return { image, path, ...transport };
        },
        /** Publication may change compressed manifest representation, never the
         * retained source archive's portable CONFIG/platform identity. */
        async retainPublishedArchive(source: DeploymentImageV1, published: DeploymentImageV1): Promise<void> {
            if (source.service !== published.service || normalizeNativeComposePlatform(source.platform) !== normalizeNativeComposePlatform(published.platform)
                || source.configDigest !== published.configDigest) {
                return refuse('deployment_image_identity_mismatch');
            }
            const prepared = preparedArchives.get(imageKey(source));
            if (!prepared) return refuse('deployment_image_identity_unavailable');
            await verifyNativeComposeImageArchive(prepared.path, published);
            preparedArchives.set(imageKey(published), prepared);
        },
        prove,
        locate,
        /** Deploy and rollback share local proof, immutable acquisition and refusal. */
        async acquire(image: DeploymentImageV1, request: Readonly<{
            references: readonly string[];
            /** Source builds and the host's pinned finite-operation runtime use public distribution. */
            purpose?: 'buildSource' | 'operationRuntime';
            /** Local lookup only, against this already-approved image identity. */
            localSourceReference?(): Promise<string>;
            authority?: NativeComposeEffectAuthority;
            acquisition?: NativeComposeImageAcquisition;
            pull(registry: NativeComposeRegistryAcquisition | null, reference: string): Promise<void>;
        }>) {
            if (image.registryReference && !image.registryReference.endsWith(`@${image.manifestDigest}`)) return refuse('deployment_image_manifest_mismatch');
            const local = await locate(request.references, image);
            if (local) return local;
            if (request.purpose === 'buildSource' && request.localSourceReference) {
                const source = await locate([await request.localSourceReference()], image);
                if (source) return source;
            }
            const reference = image.registryReference;
            const repository = reference?.slice(0, reference.lastIndexOf('@'));
            const registry = reference && request.purpose !== undefined
                ? resolveNativeComposeRegistryForReference(reference, request.acquisition?.registries)
                : resolveNativeComposeImageDistributionRegistry(image, request.acquisition?.registries);
            if (reference && (registry || request.purpose !== undefined)) {
                // A chosen registry failure is terminal, never an archive downgrade.
                if (!repository || /[\s@\\]/u.test(repository) || repository.includes('://') || repository.startsWith('-')) return refuse('deployment_image_registry_mismatch');
                if (!request.authority) throw new MachineNativeEffectAdmissionError('admission_unavailable');
                await request.pull(registry ?? null, reference);
                return await locate(request.references, image) ?? refuse('deployment_image_identity_unavailable');
            }
            const archive = request.acquisition?.archives?.find(candidate => candidate.image.service === image.service
                && normalizeNativeComposePlatform(candidate.image.platform) === normalizeNativeComposePlatform(image.platform) && candidate.image.configDigest === image.configDigest
                && candidate.image.manifestDigest === image.manifestDigest);
            if (!archive) throw new PluginError({ code: request.acquisition?.operation === 'rollback' ? 'rollback_image_unavailable' : 'deployment_image_unavailable',
                message: 'The exact platform image is unavailable' });
            const received = await archive.acquire();
            if (received.sizeBytes !== archive.sizeBytes || received.sha256 !== archive.sha256) return refuse('deployment_image_archive_identity_mismatch');
            const actual = await readNativeComposeArchiveTransportIdentity(received.path);
            if (actual.sizeBytes !== archive.sizeBytes || actual.sha256 !== archive.sha256) return refuse('deployment_image_archive_identity_mismatch');
            await verifyNativeComposeImageArchive(received.path, image);
            // The host/transfer owner retains this file on unknown import/load.
            // Project disposal must not remove operation-held archive custody.
            if (!request.authority) throw new MachineNativeEffectAdmissionError('admission_unavailable');
            await input.run(['image', 'load', '--platform', image.platform, '--input', received.path], undefined, undefined, request.authority);
            return await locate(request.references, image) ?? refuse('deployment_image_identity_unavailable');
        },
    };
    return identity;
}
