import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createTar } from 'tar';
import { describe, expect, it } from 'vitest';
import { createNativeComposeImageIdentity, verifyNativeComposeImageArchive } from './nativeComposeImageIdentity';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';

async function fixture(run: (input: {
    acquire(): ReturnType<ReturnType<typeof createNativeComposeImageIdentity>['acquire']>;
    operations: string[][];
    setLocal(value: boolean): void;
    setCorrupt(value: boolean): void;
    setPlatform(value: string): void;
    setRegistry(value: boolean): void;
    setRegistryAccess(value: 'pull' | 'pushPull'): void;
    setBuildSource(value: boolean): void;
    setExpectedImage(value: Readonly<{ configDigest?: string; platform?: string }>): void;
    setCopyError(error: Error): void;
    setLoadError(error: Error): void;
    setManifestLookupOnly(): void;
    setPlatformChild(): void;
    readReceived(): Promise<Buffer>;
}) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-archive-'));
    try {
        const holder = join(root, 'holder');
        const receiver = join(root, 'receiver');
        await Promise.all([mkdir(holder), mkdir(receiver)]);
        const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} }));
        const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
        const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: configDigest }, layers: [] }));
        const manifestDigest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
        const image = { service: 'app', platform: 'linux/amd64', configDigest, manifestDigest };
        const configPath = `${configDigest.slice(7)}.json`;
        await writeFile(join(holder, configPath), config);
        await writeFile(join(holder, 'manifest.json'), JSON.stringify([{ Config: configPath, RepoTags: ['archive:retained'], Layers: [] }]));
        const archive = join(holder, 'image.tar');
        await createTar({ cwd: holder, file: archive }, [configPath, 'manifest.json']);
        const bytes = await readFile(archive);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const operations: string[][] = [];
        let local = false;
        let loaded = false;
        let corrupt = false;
        let platform = image.platform;
        let registry = false;
        let registryAccess: 'pull' | 'pushPull' = 'pushPull';
        let buildSource = false;
        let selectedImage = image;
        let copyError: Error | undefined;
        let loadError: Error | undefined;
        let manifestLookupOnly = false;
        let platformChild = false;
        const rootReference = `archive@sha256:${'a'.repeat(64)}`;
        const native = createNativeComposeImageIdentity({ async directory() { return receiver; }, async run(args) {
            operations.push([...args]);
            if (args[1] === 'inspect') return (local || loaded) && (!manifestLookupOnly || args.at(-1) === selectedImage.manifestDigest)
                ? { stdout: JSON.stringify([{ Id: manifestLookupOnly ? selectedImage.manifestDigest : 'store-specific-id', ...(platformChild ? { RepoDigests: [rootReference] } : {}) }]), exitCode: 0 }
                : { stdout: '', exitCode: 1 };
            if (args[1] === 'save') {
                if (platformChild && args.at(-1) !== rootReference) throw new Error('No such image: platform child');
                await copyFile(archive, args[args.indexOf('--output') + 1]!); return { stdout: '', exitCode: 0 };
            }
            if (args[1] === 'load') { if (loadError) throw loadError; loaded = true; return { stdout: 'Loaded image: archive:retained', exitCode: 0 }; }
            throw new Error(`Unexpected native request ${args.join(' ')}`);
        } });
        const keys = [{ kind: 'dockerEngine', dockerEndpoint: `native-archive-boundary:${root}` }] as const;
        await machineNativeEffectAdmission.run({ operation: { operationId: 'archive-import', kind: 'deployment' }, keys }, async context => {
        await run({ operations, setLocal(value) { local = value; }, setCorrupt(value) { corrupt = value; },
            setPlatform(value) { platform = value; }, setRegistry(value) { registry = value; },
            setRegistryAccess(value) { registryAccess = value; }, setBuildSource(value) { buildSource = value; },
            setExpectedImage(value) { selectedImage = { ...image, ...value }; platform = selectedImage.platform; },
            setCopyError(error) { copyError = error; }, setLoadError(error) { loadError = error; },
            setManifestLookupOnly() { manifestLookupOnly = true; },
            setPlatformChild() { platformChild = true; },
            readReceived() { return readFile(join(receiver, 'received.tar')); },
            acquire() { return native.acquire({ ...selectedImage, ...(registry ? { registryReference: `registry.example/app@${manifestDigest}` } : {}) }, {
                references: ['owned:retained'], authority: { context },
                ...(buildSource ? { purpose: 'buildSource' as const } : {}),
                acquisition: { operation: 'rollback',
                    ...(registry ? { registries: [{ origin: 'https://registry.example', access: registryAccess,
                        bindingIdentity: 'binding', envPort: {} as never }] } : {}),
                    archives: [{ image: { ...selectedImage, platform }, sizeBytes: bytes.length, sha256,
                        async acquire() {
                            const path = join(receiver, 'received.tar');
                            operations.push(['copy', path]);
                            if (copyError) throw copyError;
                            await copyFile(archive, path);
                            if (corrupt) await writeFile(path, Buffer.from('corrupt archive'));
                            return { path, sizeBytes: bytes.length, sha256 };
                        } }],
                }, async pull() { operations.push(['pull']); throw Object.assign(new Error('Registry denied'), { code: 'registry_denied' }); },
            }); },
        });
        });
    } finally { await rm(root, { recursive: true, force: true }); }
}

describe('receiver archive acquisition at the canonical native image owner', () => {
    it('proves a containerd platform child through its addressable immutable root', async () => {
        await fixture(async input => {
            input.setPlatformChild();
            input.setLocal(true);
            await expect(input.acquire()).resolves.toMatchObject({ config: { os: 'linux', architecture: 'amd64' } });
        });
    });
    it('rejects a classic archive containing an extra image before it can be loaded', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-extra-archive-'));
        try {
            const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} }));
            const digest = createHash('sha256').update(config).digest('hex');
            const configPath = `${digest}.json`;
            const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${digest}` }, layers: [] }));
            const manifestDigest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
            await writeFile(join(root, configPath), config);
            await mkdir(join(root, 'blobs', 'sha256'), { recursive: true });
            await writeFile(join(root, 'blobs', 'sha256', manifestDigest.slice(7)), manifest);
            await writeFile(join(root, 'manifest.json'), JSON.stringify([
                { Config: configPath, RepoTags: ['owned:receipt'], Layers: [] },
                { Config: configPath, RepoTags: ['unrelated:injected'], Layers: [] },
            ]));
            const archive = join(root, 'image.tar');
            await createTar({ cwd: root, file: archive }, [configPath, 'manifest.json', `blobs/sha256/${manifestDigest.slice(7)}`]);
            await expect(verifyNativeComposeImageArchive(archive, { platform: 'linux/amd64',
                configDigest: `sha256:${digest}`, manifestDigest }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_identity_mismatch' } });
            await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: configPath, RepoTags: ['owned:receipt'], Layers: [] }]));
            await createTar({ cwd: root, file: archive }, [configPath, 'manifest.json', `blobs/sha256/${manifestDigest.slice(7)}`]);
            await expect(verifyNativeComposeImageArchive(archive, { platform: 'linux/amd64',
                configDigest: `sha256:${digest}`, manifestDigest })).resolves.toMatchObject({ manifestMatches: true });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('imports an exact classic archive and proves CONFIG despite different receiver store identity', async () => {
        await fixture(async input => {
            const acquired = await input.acquire();
            expect(acquired.config).toMatchObject({ os: 'linux', architecture: 'amd64' });
            expect(input.operations.filter(args => args[0] === 'copy')).toHaveLength(1);
            expect(input.operations.find(args => args[1] === 'load')).toEqual(['image', 'load', '--platform', 'linux/amd64', '--input', expect.any(String)]);
        });
    });
    it('acquires a verified archive when the receiver exposes its manifest identity instead of CONFIG', async () => {
        await fixture(async input => {
            input.setManifestLookupOnly();
            const acquired = await input.acquire();
            expect(acquired.config).toMatchObject({ os: 'linux', architecture: 'amd64' });
            expect(acquired.reference).toMatch(/^sha256:[a-f0-9]{64}$/u);
            // A later acquisition must use the proved local image even when
            // the original archive holder is no longer reachable.
            input.setCopyError(new Error('The original archive holder is unavailable'));
            await expect(input.acquire()).resolves.toMatchObject(acquired);
        });
    });
    it('uses exact local CONFIG with zero archive copy or load', async () => {
        await fixture(async input => { input.setLocal(true); await input.acquire();
            expect(input.operations.some(args => args[0] === 'copy' || args[1] === 'load')).toBe(false); });
    });
    it('checks actual copied bytes before load rather than trusting the transfer success metadata', async () => {
        await fixture(async input => { input.setCorrupt(true);
            await expect(input.acquire()).rejects.toMatchObject({ details: { reason: 'deployment_image_archive_identity_mismatch' } });
            expect(input.operations.some(args => args[1] === 'load')).toBe(false); });
    });
    it('refuses a missing exact platform archive before copying', async () => {
        await fixture(async input => { input.setPlatform('linux/arm64');
            await expect(input.acquire()).rejects.toMatchObject({ code: 'rollback_image_unavailable' });
            expect(input.operations.some(args => args[0] === 'copy' || args[1] === 'load')).toBe(false); });
    });
    it('preserves pushPull priority and never copies after registry failure', async () => {
        await fixture(async input => { input.setRegistry(true);
            await expect(input.acquire()).rejects.toMatchObject({ code: 'registry_denied' });
            expect(input.operations.some(args => args[0] === 'copy' || args[1] === 'load')).toBe(false); });
    });
    it('uses a pull-only registry only for explicit admitted builder source preparation, never runtime distribution', async () => {
        await fixture(async input => { input.setRegistry(true); input.setRegistryAccess('pull');
            await input.acquire();
            expect(input.operations.some(args => args[0] === 'pull')).toBe(false);
            expect(input.operations.some(args => args[0] === 'copy')).toBe(true); });
        await fixture(async input => { input.setRegistry(true); input.setRegistryAccess('pull'); input.setBuildSource(true);
            await expect(input.acquire()).rejects.toMatchObject({ code: 'registry_denied' });
            expect(input.operations.some(args => args[0] === 'copy' || args[1] === 'load')).toBe(false); });
    });
    it.each([
        [{ configDigest: `sha256:${'d'.repeat(64)}` }, 'deployment_image_identity_mismatch'],
        [{ platform: 'linux/arm64' }, 'deployment_image_platform_mismatch'],
    ] as const)('refuses archive CONFIG/platform mismatch before native load', async (image, reason) => {
        await fixture(async input => { input.setExpectedImage(image);
            await expect(input.acquire()).rejects.toMatchObject({ details: { reason } });
            expect(input.operations.some(args => args[1] === 'load')).toBe(false); });
    });
    it('preserves unknown transfer custody without issuing native load', async () => {
        await fixture(async input => { input.setCopyError(Object.assign(new Error('Unknown transfer custody'), { code: 'outcome_unknown' }));
            await expect(input.acquire()).rejects.toMatchObject({ code: 'outcome_unknown' });
            expect(input.operations.some(args => args[1] === 'load')).toBe(false); });
    });
    it('preserves the operation archive when native load settlement is unknown', async () => {
        await fixture(async input => { input.setLoadError(Object.assign(new Error('Unknown native settlement'), { code: 'outcome_unknown' }));
            await expect(input.acquire()).rejects.toMatchObject({ code: 'outcome_unknown' });
            expect(await input.readReceived()).not.toHaveLength(0); });
    });
});
