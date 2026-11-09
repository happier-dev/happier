import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createTar } from 'tar';
import { describe, expect, it } from 'vitest';
import { createNativeComposeImageIdentity, resolveNativeComposeDeploymentImageReferences } from './nativeComposeImageIdentity';
import { withFiniteComposeFixture } from './serviceExec.testkit';

describe('native Compose image CONFIG identity', () => {
    it('reads a tagless local image CONFIG and platform through native archive bytes, not its different native Id', async () => {
        await withFiniteComposeFixture(async ({ docker, exec, root }) => {
            const image = await docker.registerImage('dangling-local-reader', 'exact-config');
            // Only Docker's external state is changed. Identity parsing and
            // the admitted executable/process path are the actual owners.
            const nativeId = await docker.setImagePruneState(image.registryReference!, { repoTags: [], repoDigests: [] });
            expect(nativeId).not.toBe(image.configDigest);
            const directory = await mkdtemp(join(root, 'local-image-probes-'));
            const tool = await exec.systemTools.resolve({ toolId: 'docker', purpose: 'local-image-identity', cwd: root });
            const owner = createNativeComposeImageIdentity({ directory: async () => directory, async run(args) {
                const result = await exec.run({ executable: tool.executable, args, cwd: root });
                if (result.termination.observed.kind !== 'exit') throw new Error('Expected native image metadata exit');
                return { stdout: Buffer.from(result.stdout).toString('utf8'), exitCode: result.termination.observed.exitCode };
            } });
            const read = Reflect.get(owner, 'readLocalImage') as ((reference: string) => Promise<unknown>) | undefined;
            // Missing method stays an intended runtime RED, not a future
            // export/import failure before the real Docker fixture is ready.
            expect(await read?.(nativeId)).toEqual({ nativeId, repoTags: [], repoDigests: [],
                variants: [{ configDigest: image.configDigest, platform: image.platform }] });
            // The same invocation must not cache a stale tagless observation.
            await docker.setImagePruneState(nativeId, { repoTags: ['foreign/keep:latest'], repoDigests: [] });
            expect(await read?.(nativeId)).toMatchObject({ nativeId, repoTags: ['foreign/keep:latest'],
                variants: [{ configDigest: image.configDigest, platform: image.platform }] });
            expect(await readdir(directory)).toEqual([]);
            const native = await docker.readInvocations();
            expect(native.filter(row => row.args[0] === 'image' && row.args[1] === 'save')
                .every(row => row.args.at(-1) === nativeId)).toBe(true);
            expect(native.some(row => ['pull', 'load', 'tag', 'rm', 'prune'].includes(row.args[1] ?? ''))).toBe(false);
        });
    });

    it.each([
        { state: 'unavailable', inventoryExitCode: 1 },
        { state: 'absent', inventoryExitCode: 0 },
    ] as const)('distinguishes exact-alias absence from unavailable native inventory after failed inspect ($state)', async ({ state, inventoryExitCode }) => {
        const reference = resolveNativeComposeDeploymentImageReferences({ environmentInstanceId: 'environment', deploymentId: 'expired',
            image: { service: 'app', platform: 'linux/amd64', configDigest: `sha256:${'c'.repeat(64)}` } }).ownedTag;
        // Docker's image ls REPOSITORY:TAG operand is an exact match, and a
        // successful empty result proves absence. A failed inspect/list does
        // not. Only the native command boundary is substituted here.
        // https://docs.docker.com/reference/cli/docker/image/ls/
        const owner = createNativeComposeImageIdentity({
            async directory() { throw new Error('Missing image observations must not create an archive'); },
            async run(args) {
                if (args[0] !== 'image' || args.at(-1) !== reference) throw new Error('Expected an exact-alias native observation');
                if (args[1] === 'inspect') return { exitCode: 1, stdout: '' };
                if (args[1] === 'ls') return { exitCode: inventoryExitCode, stdout: '' };
                throw new Error('Unexpected image effect while observing absence');
            },
        });
        const observe = Reflect.get(owner, 'observeLocalAlias') as ((reference: string) => Promise<unknown>) | undefined;
        if (state === 'unavailable') await expect(owner.readLocalImage(reference)).rejects.toMatchObject({
            code: 'native_failed', details: { reason: 'deployment_image_identity_unavailable' },
        });
        expect(await observe?.(reference)).toEqual({ kind: state });
    });

    it('does not reinterpret failed native-ID inspection as exact-alias absence', async () => {
        const nativeId = `sha256:${'a'.repeat(64)}`;
        const owner = createNativeComposeImageIdentity({
            async directory() { throw new Error('Unavailable identity has no archive'); },
            async run(args) {
                if (args[0] !== 'image' || args[1] !== 'inspect' || args.at(-1) !== nativeId) {
                    throw new Error('Native-ID absence cannot use a repository:tag inventory operand');
                }
                return { exitCode: 1, stdout: '' };
            },
        });
        await expect(owner.readLocalImage(nativeId)).rejects.toMatchObject({ code: 'native_failed',
            details: { reason: 'deployment_image_identity_unavailable' } });
    });

    it.each(['classic', 'containerd'] as const)('verifies %s archive bytes independently of native Id and retains image VOLUME metadata', async store => {
        const root = await mkdtemp(join(tmpdir(), 'happier-image-identity-'));
        try {
            const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'arm64', variant: 'v8',
                config: { Volumes: { '/var/lib/data': {} } } }));
            const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
            const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: configDigest }, layers: [] }));
            const manifestDigest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
            const nativeId = store === 'classic' ? configDigest : manifestDigest;
            const archive = join(root, 'native.tar');
            if (store === 'classic') {
                await writeFile(join(root, `${configDigest.slice(7)}.json`), config);
                await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, Layers: [] }]));
                await createTar({ cwd: root, file: archive }, [`${configDigest.slice(7)}.json`, 'manifest.json']);
            } else {
                await mkdir(join(root, 'blobs', 'sha256'), { recursive: true });
                await writeFile(join(root, 'blobs', 'sha256', configDigest.slice(7)), config);
                await writeFile(join(root, 'blobs', 'sha256', manifestDigest.slice(7)), manifest);
                await createTar({ cwd: root, file: archive }, ['blobs']);
            }
            const staging = join(root, 'staging');
            await mkdir(staging);
            let nativeReads = 0;
            // Docker process output/archive bytes are the genuine external boundary.
            const owner = createNativeComposeImageIdentity({ directory: async () => staging, async run(args) {
                nativeReads++;
                if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Id: nativeId,
                    Descriptor: { digest: manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' } }]) };
                if (args[1] !== 'save') throw new Error('Unexpected native effect');
                await copyFile(archive, args[args.indexOf('--output') + 1]);
                return { stdout: '' };
            } });
            const image = { service: 'app', platform: 'linux/arm64/v8', configDigest, manifestDigest };
            await expect(owner.resolve({ service: 'app', reference: `app@${manifestDigest}`, platform: image.platform }))
                .resolves.toEqual({ ...image, registryReference: `app@${manifestDigest}` });
            const actual = await owner.prove(`app@${manifestDigest}`, image);
            expect(actual.config).toEqual({ Volumes: { '/var/lib/data': {} } });
            // Docker's native default arm64 platform and explicit v8 describe
            // the same CONFIG in both image stores.
            await expect(owner.prove(nativeId, { ...image, platform: 'linux/arm64' })).resolves.toMatchObject({
                architecture: 'arm64', variant: 'v8', config: { Volumes: { '/var/lib/data': {} } } });
            const before = nativeReads;
            expect(await owner.prove(nativeId, image)).toBe(actual);
            expect(await owner.prove(`app@${manifestDigest}`, image)).toBe(actual);
            expect(nativeReads - before).toBe(0);
            // Successful discovery retains exactly its verified export until
            // the owning project disposes/adopts it; failed probes add nothing.
            const retained = await readdir(staging);
            expect(retained).toHaveLength(1);
            expect(await readFile(join(staging, retained[0], 'image.tar'))).toEqual(await readFile(archive));
            if (store === 'classic') {
                const indexOnly = createNativeComposeImageIdentity({ directory: async () => staging, async run(args) {
                    if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Id: nativeId,
                        Descriptor: { digest: manifestDigest, mediaType: 'application/vnd.oci.image.index.v1+json' },
                        RepoDigests: [`app@${manifestDigest}`] }]) };
                    await copyFile(archive, args[args.indexOf('--output') + 1]);
                    return { stdout: '' };
                } });
                await expect(indexOnly.resolve({ service: 'app', reference: `app@${manifestDigest}`, platform: image.platform }))
                    .rejects.toMatchObject({ details: { reason: 'deployment_image_manifest_mismatch' } });
                expect(await readdir(staging)).toEqual(retained);
            }
            await expect(owner.prove(`app@${manifestDigest}`, { ...image, platform: 'linux/amd64' }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_platform_mismatch' } });
            expect(await readdir(staging)).toEqual(retained);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('refuses a substituted CONFIG even when native descriptor and archive name claim the selected digest', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-image-substitution-'));
        try {
            const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Labels: { version: 'A' } } }));
            const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
            const manifestDigest = `sha256:${'b'.repeat(64)}`;
            await writeFile(join(root, `${configDigest.slice(7)}.json`), config.toString().replace('"A"', '"B"'));
            await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, Layers: [] }]));
            const archive = join(root, 'native.tar');
            await createTar({ cwd: root, file: archive }, [`${configDigest.slice(7)}.json`, 'manifest.json']);
            const owner = createNativeComposeImageIdentity({ directory: async () => root, async run(args) {
                if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Id: configDigest, Descriptor: { digest: manifestDigest } }]) };
                await copyFile(archive, args[args.indexOf('--output') + 1]);
                return { stdout: '' };
            } });
            await expect(owner.prove(configDigest, { service: 'app', platform: 'linux/amd64', configDigest, manifestDigest }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_identity_mismatch' } });
            await expect(owner.resolve({ service: 'app', reference: `app@${manifestDigest}`, platform: 'linux/amd64' }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_identity_mismatch' } });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
