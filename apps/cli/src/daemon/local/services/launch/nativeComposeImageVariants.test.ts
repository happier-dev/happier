import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create as createTar } from 'tar';
import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createNativeComposeImageIdentity } from './nativeComposeImageIdentity';
import { NATIVE_COMPOSE_REGISTRY_INSPECT_PHASE } from './nativeComposeFailure';
import { nativeRegistryPause310 as fixture } from './nativeComposeImageRegistry.testkit';
import { nativeDocker29LocalBuild } from './nativeComposeImageDocker29.testkit';

function boundary(options: Readonly<{ corruptIndex?: boolean; corruptManifest?: boolean; defaultArm64Variant?: boolean; armOnly?: boolean; duplicateFirst?: boolean; publishedBuild?: boolean }> = {}) {
    const requests: string[][] = [];
    const repository = fixture.reference;
    const source = JSON.parse(fixture.index);
    const descriptors = options.armOnly ? source.manifests.filter((descriptor: { platform: { architecture: string } }) => descriptor.platform.architecture === 'arm64') : source.manifests;
    const selectedDescriptors = options.duplicateFirst ? [descriptors[0], ...descriptors] : descriptors;
    const index = options.defaultArm64Variant || options.armOnly || options.duplicateFirst ? JSON.stringify({ ...source, manifests: selectedDescriptors.map(
        (descriptor: { platform: { architecture: string }; digest: string }) => descriptor.platform.architecture === 'arm64'
            && options.defaultArm64Variant ? { ...descriptor, platform: { ...descriptor.platform, variant: 'v8' } } : descriptor) }) : fixture.index;
    const indexDigest = `sha256:${createHash('sha256').update(index).digest('hex')}`;
    const variants = fixture.variants.map(variant => ({ ...variant,
        digest: `sha256:${createHash('sha256').update(variant.manifest).digest('hex')}` }));
    const native = createNativeComposeImageIdentity({ async directory() { throw new Error('Registry discovery must not stage image bytes'); },
        async run(args, signal, registry) {
            signal?.throwIfAborted();
            requests.push([...args]);
            // Native Docker and registry IO are the only substituted boundary.
            if (args[0] === 'image' && args[1] === 'inspect') { expect(registry).toBeUndefined(); return options.publishedBuild
                ? { stdout: JSON.stringify([{ ...nativeDocker29LocalBuild.inspect[0], Identity: { Build: nativeDocker29LocalBuild.inspect[0].Identity.Build, Pull: [{ Repository: 'registry.k8s.io/pause' }] } }]), exitCode: 0 }
                : { stdout: '', exitCode: 1 }; }
            if (args.slice(0, 3).join(' ') !== 'buildx imagetools inspect') throw new Error(`Unexpected native request ${args.join(' ')}`);
            expect(registry).toBeNull(); // Explicit anonymous registry demand, not ambient/source credentials.
            const reference = args.at(-1);
            if (args.includes('--raw') && (reference === repository || reference === `${repository}@${indexDigest}`)) {
                return { stdout: options.corruptIndex ? `${index} ` : index, exitCode: 0 };
            }
            const variant = variants.find(item => reference === `${repository}@${item.digest}`);
            if (!variant) throw new Error('A mutable or unapproved registry request escaped the selected index');
            return { stdout: args.includes('--raw') ? options.corruptManifest ? `${variant.manifest} ` : variant.manifest : variant.config, exitCode: 0 };
        } });
    return { native, requests, variants, repository, indexDigest };
}

describe('preapproval native immutable index and variant discovery', () => {
    it('discovers one actual source seed without a host-platform assumption or fetching every index variant', async () => {
        const armOnly = boundary({ armOnly: true });
        const [arm] = await armOnly.native.resolveVariants({ service: 'app', reference: fixture.reference });
        expect(arm).toMatchObject({ platform: 'linux/arm64', indexDigest: armOnly.indexDigest });
        const indexed = boundary();
        expect(await indexed.native.resolveVariants({ service: 'app', reference: fixture.reference }))
            .toHaveLength(1);
        expect(indexed.requests.some(args => args.at(-1) === `${fixture.reference}@${indexed.variants[1]!.digest}`)).toBe(false);
        const repeatedPlatform = boundary({ duplicateFirst: true });
        expect(await repeatedPlatform.native.resolveVariants({ service: 'app', reference: fixture.reference }))
            .toMatchObject([{ platform: 'linux/amd64', manifestDigest: repeatedPlatform.variants[0]!.digest }]);
        const single = boundary();
        const variant = single.variants[1]!;
        expect(await single.native.resolveVariants({ service: 'app', reference: `${fixture.reference}@${variant.digest}` }))
            .toEqual([{ service: 'app', platform: variant.platform, manifestDigest: variant.digest,
                configDigest: JSON.parse(variant.manifest).config.digest, registryReference: `${fixture.reference}@${variant.digest}` }]);
    });
    it('keeps registry index discovery for a build with engine-reported push/pull provenance', async () => {
        const input = boundary({ publishedBuild: true });
        expect(await input.native.resolveVariants({ service: 'app', reference: fixture.reference, platforms: ['linux/amd64', 'linux/arm64'] }))
            .toMatchObject(input.variants.map(variant => ({ platform: variant.platform, indexDigest: input.indexDigest, registryReference: `${fixture.reference}@${variant.digest}` })));
    });
    it('uses native default arm64/v8 equivalence without admitting a different explicit variant', async () => {
        const input = boundary({ defaultArm64Variant: true });
        const images = await input.native.resolveVariants({ service: 'app', reference: fixture.reference,
            platforms: ['linux/arm64', 'linux/arm64/v8'] });
        expect(images).toHaveLength(1);
        expect(images[0]).toMatchObject({ platform: 'linux/arm64', indexDigest: input.indexDigest });
        await expect(input.native.resolveVariants({ service: 'app', reference: `${fixture.reference}@${input.indexDigest}`,
            platforms: ['linux/arm64/v9'] })).rejects.toMatchObject({ code: 'deployment_image_unavailable' });
    });
    it('retains a local-only private image without inventing an index or querying a registry', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-local-variant-'));
        try {
            const variant = fixture.variants[0];
            const configDigest = `sha256:${createHash('sha256').update(variant.config).digest('hex')}`;
            const manifestDigest = `sha256:${createHash('sha256').update(variant.manifest).digest('hex')}`;
            const configPath = `${configDigest.slice(7)}.json`;
            await writeFile(join(root, configPath), variant.config);
            await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: configPath, RepoTags: ['private:local'], Layers: [] }]));
            const archive = join(root, 'private.tar');
            await createTar({ cwd: root, file: archive }, [configPath, 'manifest.json']);
            const identity = createNativeComposeImageIdentity({ async directory() { return root; }, async run(args) {
                if (args[0] !== 'image') throw new Error('Local-only source must not query a registry');
                if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Id: 'native-store-local-id', RepoDigests: [], Os: 'linux', Architecture: 'amd64',
                    Descriptor: { mediaType: 'application/vnd.docker.distribution.manifest.v2+json', digest: manifestDigest } }]), exitCode: 0 };
                if (args[1] === 'save') { await copyFile(archive, args[args.indexOf('--output') + 1]!); return { stdout: '', exitCode: 0 }; }
                throw new Error('Unexpected native image effect');
            } });
            expect(await identity.resolveVariants({ service: 'app', reference: 'private:local', platforms: ['linux/amd64'] }))
                .toEqual([{ service: 'app', platform: 'linux/amd64', configDigest, manifestDigest }]);
            expect(await identity.resolveVariants({ service: 'app', reference: 'private:local' }))
                .toEqual([{ service: 'app', platform: 'linux/amd64', configDigest, manifestDigest }]);
            await expect(identity.resolveVariants({ service: 'app', reference: 'private:local', platforms: ['linux/amd64', 'linux/arm64'] }))
                .rejects.toMatchObject({ code: 'deployment_image_unavailable' });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it.each([true, false])('retains the exact Docker29 local index when origin information is present=%s', async reportsOrigin => {
        const root = await mkdtemp(join(tmpdir(), 'happier-docker29-'));
        try {
            const captured = nativeDocker29LocalBuild;
            for (const [path, bytes] of Object.entries(captured.entries)) {
                await mkdir(join(root, path, '..'), { recursive: true });
                await writeFile(join(root, path), bytes);
            }
            const archive = join(root, 'local.tar');
            await createTar({ cwd: root, file: archive }, Object.keys(captured.entries));
            const reference = captured.inspect[0].RepoTags[0];
            const registryDenied = new PluginError({ code: 'native_failed', message: 'Native Compose operation could not be completed',
                failureCause: { phase: `${NATIVE_COMPOSE_REGISTRY_INSPECT_PHASE}.deployment_image_pull_denied`, errorClass: 'Error',
                    errorCode: 'deployment_image_pull_denied', httpStatus: null } });
            const identity = createNativeComposeImageIdentity({ async directory() { return root; }, async run(args) {
                // Docker is the substituted external boundary. Child IDs are not addressable.
                if (args[0] === 'buildx' && !reportsOrigin) throw registryDenied;
                if (args[0] !== 'image') throw new Error('Local build with known origin queried a registry');
                if (args[1] === 'inspect') {
                    const [native] = args.includes('--platform') ? captured.platformInspect : captured.inspect;
                    return { stdout: JSON.stringify([{ ...native, ...(!reportsOrigin ? { Identity: undefined } : {}) }]), exitCode: 0 };
                }
                if (args[1] === 'save') {
                    expect(args.at(-1)).toBe(captured.inspect[0].RepoDigests[0]);
                    await copyFile(archive, args[args.indexOf('--output') + 1]!);
                    return { stdout: '', exitCode: 0 };
                }
                throw new Error('Unexpected Docker effect');
            } });
            const expected = [{ service: 'app', platform: 'linux/amd64',
                manifestDigest: captured.platformInspect[0].Descriptor.digest,
                configDigest: JSON.parse(captured.entries['manifest.json'])[0].Config.replace('blobs/sha256/', 'sha256:') }];
            expect(await identity.resolveVariants({ service: 'app', reference, platforms: ['linux/amd64'] })).toEqual(expected);
            expect(await identity.resolveVariants({ service: 'app', reference })).toEqual(expected);
            if (!reportsOrigin) {
                await expect(identity.resolveVariants({ service: 'app', reference: captured.inspect[0].RepoDigests[0] }))
                    .rejects.toBe(registryDenied);
                await expect(identity.resolveVariants({ service: 'app', reference, platforms: ['linux/amd64', 'linux/arm64'] }))
                    .rejects.toBe(registryDenied);
                await expect(identity.resolveVariants({ service: 'app', reference }, { registries: [{
                    origin: 'https://docker.io', access: 'pull', bindingIdentity: 'selected-registry',
                    envPort: { async prepare() { throw new Error('Registry preparation belongs to the native boundary'); } },
                }] })).rejects.toBe(registryDenied);
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('pins only the needed review variant and later derives another platform solely from the approved index', async () => {
        const review = boundary();
        const approved = await review.native.resolveVariants({ service: 'app', reference: fixture.reference, platforms: ['linux/amd64'] });
        const amd64 = review.variants.find(item => item.platform === 'linux/amd64')!;
        expect(approved).toEqual([{ service: 'app', platform: 'linux/amd64', indexDigest: fixture.indexDigest,
            manifestDigest: amd64.digest, configDigest: JSON.parse(amd64.manifest).config.digest,
            registryReference: `${fixture.reference}@${amd64.digest}` }]);
        expect(review.requests.some(args => args.at(-1) === `${fixture.reference}@${review.variants[1]!.digest}`)).toBe(false);
        const queued = boundary();
        const arm64 = queued.variants.find(item => item.platform === 'linux/arm64')!;
        const images = await queued.native.resolveVariants({ service: 'app', reference: `${fixture.reference}@${approved[0]!.indexDigest}`,
            platforms: ['linux/arm64'] });
        expect(images).toEqual([{ service: 'app', platform: 'linux/arm64', indexDigest: fixture.indexDigest,
            manifestDigest: arm64.digest, configDigest: JSON.parse(arm64.manifest).config.digest,
            registryReference: `${fixture.reference}@${arm64.digest}` }]);
        expect(queued.requests.every(args => args.at(-1)?.includes('@sha256:'))).toBe(true);
    });
    it.each(['corruptIndex', 'corruptManifest'] as const)('rejects changed pinned raw registry bytes (%s)', async kind => {
        const input = boundary({ [kind]: true });
        await expect(input.native.resolveVariants({ service: 'app', reference: `${fixture.reference}@${fixture.indexDigest}`,
            platforms: ['linux/arm64'] })).rejects.toMatchObject({ details: { reason: 'deployment_image_manifest_mismatch' } });
    });
    it('refuses a platform absent from the approved index rather than asking the mutable tag again', async () => {
        const input = boundary();
        await expect(input.native.resolveVariants({ service: 'app', reference: `${fixture.reference}@${fixture.indexDigest}`,
            platforms: ['linux/riscv64'] })).rejects.toMatchObject({ code: 'deployment_image_unavailable' });
        expect(input.requests).toHaveLength(1);
    });
});
