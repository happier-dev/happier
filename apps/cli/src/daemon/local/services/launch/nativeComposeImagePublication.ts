import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import { createNativeComposeImageIdentity, resolveNativeComposeDeploymentOwnedImageTag, resolveNativeComposeRegistryForReference, normalizeNativeComposePlatform,
    type NativeComposeImageAcquisition, type NativeComposeRegistryAcquisition, type NativeComposeEffectAuthority } from './nativeComposeImageIdentity';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function refuse(reason: string): never {
    throw new PluginError({ code: 'native_failed', message: 'Native registry publication could not be completed', details: { reason } });
}
function repositoryRequired(secret = false): never {
    throw new PluginError({ code: 'invalid_request', message: secret
        ? 'Use a non-secret explicit image repository for registry publication'
        : 'Add an explicit image repository to each source-build service before registry publication',
    details: { reason: secret ? 'secret_registry_repository' : 'deployment_registry_repository_required' } });
}

/** One native build result, two delivery representations. Publishing never
 * builds again: the verified archive is loaded and pushed, then the registry's
 * actual manifest/index bytes establish its distribution identity. */
export async function publishNativeComposeImages(input: Readonly<{
    phase: 'build' | 'runtime'; source: DeploymentSourceMaterializationV1;
    model: Record<string, unknown>; images: readonly DeploymentImageV1[]; acquisition?: NativeComposeImageAcquisition;
    identity: ReturnType<typeof createNativeComposeImageIdentity>; composeArgs: readonly string[];
    authority?: NativeComposeEffectAuthority;
    parseComposeModel(stdout: string): Record<string, unknown>;
    directory(): Promise<string>; assertCurrent(signal?: AbortSignal): Promise<void>; signal?: AbortSignal;
    run(args: readonly string[], signal?: AbortSignal, checkExit?: boolean, registry?: NativeComposeRegistryAcquisition | null,
        authority?: NativeComposeEffectAuthority): Promise<Readonly<{ stdout: string; exitCode: number }>>;
    withOutput<T>(args: readonly string[], signal: AbortSignal | undefined, visit: (stdout: string, redact: (value: string) => string) => Promise<T>): Promise<T>;
}>): Promise<readonly DeploymentImageV1[]> {
    if (!input.acquisition?.registries?.some(registry => registry.access === 'pushPull')) return input.images;
    if (!record(input.model.services)) return refuse('native_compose_configuration_invalid');
    const services = Object.entries(input.model.services).filter(([service, definition]) => record(definition)
        && definition.build !== undefined && input.images.some(image => image.service === service));
    if (!services.length) return input.images;
    if (input.phase !== 'build') return refuse('deployment_build_phase_required');
    for (const [, definition] of services) if (!record(definition) || typeof definition.image !== 'string' || !definition.image.trim()) repositoryRequired();
    const file = join(await input.directory(), 'publication.compose.json');
    await writeFile(file, JSON.stringify({ services: Object.fromEntries(services.map(([service, definition]) =>
        [service, { image: (definition as Record<string, unknown>).image }])) }), { mode: 0o600 });
    const destinations = await input.withOutput([...input.composeArgs, '--file', file, 'config', '--format', 'json'], input.signal, async (stdout, redact) => {
        const model = input.parseComposeModel(stdout);
        if (!record(model.services)) return refuse('native_compose_configuration_invalid');
        const definitions = model.services;
        return services.flatMap(([service]) => {
            const definition = definitions[service];
            if (!record(definition) || typeof definition.image !== 'string' || !definition.image.trim()) return repositoryRequired();
            const reference = definition.image;
            if (redact(reference) !== reference) return repositoryRequired(true);
            if (/\s|[@\\]/u.test(reference) || reference.includes('://') || reference.startsWith('-')) return repositoryRequired();
            const tag = reference.lastIndexOf(':');
            const repository = tag > reference.lastIndexOf('/') ? reference.slice(0, tag) : reference;
            if (!repository) return repositoryRequired();
            const registry = resolveNativeComposeRegistryForReference(reference, input.acquisition!.registries);
            if (registry?.access !== 'pushPull') return [];
            if (!registry.publicationEnvPort) return refuse('deployment_registry_publication_unavailable');
            return [{ service, reference, repository, registry: { ...registry, envPort: registry.publicationEnvPort } }];
        });
    });
    const published = new Map<string, DeploymentImageV1>();
    for (const [index, destination] of destinations.entries()) {
        const sourceImages = input.images.filter(image => image.service === destination.service);
        const variants: DeploymentImageV1[] = [];
        for (const image of sourceImages) {
            await input.assertCurrent(input.signal);
            const ownedTag = resolveNativeComposeDeploymentOwnedImageTag({ environmentInstanceId: input.source.environmentInstanceId,
                deploymentId: input.source.deploymentId, service: image.service, platform: image.platform });
            const archive = await input.identity.exportImage(image, { references: [image.configDigest], ownedTag, signal: input.signal, authority: input.authority });
            await input.run(['image', 'load', '--platform', image.platform, '--input', archive.path], input.signal, true, destination.registry, input.authority);
            await input.identity.prove(ownedTag, image);
            const variantTag = `${destination.repository}:${ownedTag.slice(ownedTag.lastIndexOf(':') + 1)}`;
            await input.run(['image', 'tag', ownedTag, variantTag], input.signal, true, destination.registry, input.authority);
            await input.run(['image', 'push', '--platform', image.platform, variantTag], input.signal, true, destination.registry, input.authority);
            const raw = await input.run(['buildx', 'imagetools', 'inspect', '--raw', variantTag], input.signal, true, destination.registry);
            const digest = `sha256:${createHash('sha256').update(raw.stdout).digest('hex')}`;
            const selected = await input.identity.resolveVariants({ service: image.service,
                reference: `${destination.repository}@${digest}`, platforms: [image.platform] },
            { signal: input.signal, registries: [destination.registry] });
            if (selected.length !== 1 || selected[0].configDigest !== image.configDigest
                || normalizeNativeComposePlatform(selected[0].platform) !== normalizeNativeComposePlatform(image.platform)
                || selected[0].indexDigest !== undefined) return refuse('deployment_image_identity_mismatch');
            variants.push(selected[0]);
        }
        const metadataPath = join(await input.directory(), `publication-${index}.metadata.json`);
        await input.run(['buildx', 'imagetools', 'create', '--metadata-file', metadataPath, '--tag', destination.reference,
            ...variants.map(image => image.registryReference!)], input.signal, true, destination.registry);
        const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
        const descriptor = record(metadata) ? metadata['containerimage.descriptor'] : undefined;
        if (!record(descriptor) || typeof descriptor.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)
            || !['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(String(descriptor.mediaType))) {
            return refuse('deployment_image_manifest_mismatch');
        }
        const images = await input.identity.resolveVariants({ service: destination.service,
            reference: `${destination.repository}@${descriptor.digest}`, platforms: sourceImages.map(image => image.platform) },
        { signal: input.signal, registries: [destination.registry] });
        for (const image of images) {
            const source = sourceImages.find(candidate => normalizeNativeComposePlatform(candidate.platform) === normalizeNativeComposePlatform(image.platform));
            const variant = variants.find(candidate => normalizeNativeComposePlatform(candidate.platform) === normalizeNativeComposePlatform(image.platform));
            if (!source || !variant || image.configDigest !== source.configDigest || image.manifestDigest !== variant.manifestDigest
                || image.indexDigest !== descriptor.digest) return refuse('deployment_image_identity_mismatch');
            await input.identity.retainPublishedArchive(source, image);
            published.set(JSON.stringify([image.service, normalizeNativeComposePlatform(image.platform)]), image);
        }
    }
    await input.assertCurrent(input.signal);
    return input.images.map(image => published.get(JSON.stringify([image.service, normalizeNativeComposePlatform(image.platform)])) ?? image);
}
