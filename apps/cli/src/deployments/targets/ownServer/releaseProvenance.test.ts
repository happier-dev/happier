import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createTar } from 'tar';
import { describe, expect, it } from 'vitest';
import { OwnServerDeploymentImageArchiveV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createNativeComposeImageIdentity } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { adoptOwnServerImageArchives, prepareOwnServerImageArchiveDestinationForHost, readOwnServerImageArchiveOriginHint, resolveOwnServerImageArchivePathForHost, verifyOwnServerImageArchiveForHost } from './releaseProvenance';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';

describe('receipt-owned image archive custody', () => {
    it('creates only the admitted destination while current and refuses unsafe parents before transfer', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-archive-destination-'));
        try {
            const admission = { deploymentRoot: join(root, 'deployments'), environmentInstanceId: 'environment', deploymentId: 'receipt' };
            const sha256 = 'a'.repeat(64);
            const destination = resolveOwnServerImageArchivePathForHost(admission, sha256);
            const signal = new AbortController().signal;
            const revoked = Object.assign(new Error('Approval changed'), { code: 'approval_stale' });
            await expect(prepareOwnServerImageArchiveDestinationForHost({ admission, sha256, destination, signal,
                async assertCurrent() { throw revoked; } })).rejects.toBe(revoked);
            await expect(readdir(admission.deploymentRoot)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(prepareOwnServerImageArchiveDestinationForHost({ admission, sha256, signal,
                destination: { ...destination, path: join(root, `${sha256}.tar`) }, async assertCurrent() {} }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            await expect(readdir(admission.deploymentRoot)).rejects.toMatchObject({ code: 'ENOENT' });
            const abort = new AbortController();
            abort.abort(revoked);
            await expect(prepareOwnServerImageArchiveDestinationForHost({ admission, sha256, destination, signal: abort.signal,
                async assertCurrent() {} })).rejects.toBe(revoked);
            await expect(readdir(admission.deploymentRoot)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await prepareOwnServerImageArchiveDestinationForHost({ admission, sha256, destination, signal,
                async assertCurrent() {} })).toEqual(destination);
            expect(await readdir(destination.rootPath)).toEqual([]);
            const interrupted = { ...admission, environmentInstanceId: 'interrupted' };
            const interruptedRoot = join(admission.deploymentRoot, interrupted.environmentInstanceId);
            await expect(prepareOwnServerImageArchiveDestinationForHost({ admission: interrupted, sha256, signal,
                destination: resolveOwnServerImageArchivePathForHost(interrupted, sha256), async assertCurrent() {
                    if ((await readdir(admission.deploymentRoot)).includes(interrupted.environmentInstanceId)) throw revoked;
                } })).rejects.toBe(revoked);
            expect(await readdir(interruptedRoot)).toEqual([]);
            const outside = join(root, 'outside');
            await mkdir(outside);
            await symlink(outside, join(admission.deploymentRoot, 'linked'), 'dir');
            const linked = { ...admission, environmentInstanceId: 'linked' };
            await expect(prepareOwnServerImageArchiveDestinationForHost({ admission: linked, sha256, signal,
                destination: resolveOwnServerImageArchivePathForHost(linked, sha256), async assertCurrent() {} }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            expect(await readdir(outside)).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it.each(['linux', 'win32'] as const)('projects an exact %s origin hint without treating the receiving or promoted receipt as its producer', platform => {
        const instance = resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'SourceEnvironment');
        const rootPath = platform === 'win32'
            ? `C:\\holder\\deployments\\${instance}\\image-archives\\OriginalReceipt`
            : `/holder/deployments/${instance}/image-archives/OriginalReceipt`;
        const prefix = `${rootPath}${platform === 'win32' ? '\\' : '/'}`;
        const sha256 = 'a'.repeat(64);
        const archive = { sha256, holder: { serverId: 'home', machineId: 'holder', installationId: 'installed', rootPath, path: `${prefix}${sha256}.tar` } };
        expect(readOwnServerImageArchiveOriginHint(archive)).toEqual({ environmentId: 'SourceEnvironment', deploymentId: 'OriginalReceipt' });
        expect(() => readOwnServerImageArchiveOriginHint({ ...archive, holder: { ...archive.holder, serverId: 'other-home' } }))
            .toThrow(expect.objectContaining({ code: 'filesystem_transfer_custody_required' }));
        expect(() => readOwnServerImageArchiveOriginHint({ ...archive, holder: { ...archive.holder, path: `${prefix}unrelated/${sha256}.tar` } }))
            .toThrow(expect.objectContaining({ code: 'filesystem_transfer_custody_required' }));
    });
    it('adopts a native export outside source custody and preserves its raw bytes after native disposal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-archive-custody-'));
        try {
            const nativeRoot = join(root, 'native');
            await mkdir(nativeRoot);
            const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} }));
            const image = { service: 'app', platform: 'linux/amd64', configDigest: `sha256:${createHash('sha256').update(config).digest('hex')}`,
                manifestDigest: `sha256:${'b'.repeat(64)}` };
            const configFile = `${image.configDigest.slice(7)}.json`;
            await writeFile(join(nativeRoot, configFile), config);
            await writeFile(join(nativeRoot, 'manifest.json'), JSON.stringify([{ Config: configFile, Layers: [] }]));
            const nativeArchive = join(root, 'engine-image.tar');
            await createTar({ cwd: nativeRoot, file: nativeArchive }, [configFile, 'manifest.json']);
            const native = createNativeComposeImageIdentity({ directory: async () => nativeRoot, async run(args) {
                if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Id: 'store-specific-id' }]), exitCode: 0 };
                if (args[1] === 'tag') return { stdout: '', exitCode: 0 };
                if (args[1] === 'save') { await copyFile(nativeArchive, args[args.indexOf('--output') + 1]!); return { stdout: '', exitCode: 0 }; }
                throw new Error(`Unexpected native operation ${args.join(' ')}`);
            } });
            const keys = [{ kind: 'dockerEngine', dockerEndpoint: `native-export-boundary:${root}` }] as const;
            const archive = await machineNativeEffectAdmission.run({ operation: { operationId: 'archive-export', kind: 'deployment' }, keys },
                context => native.exportImage(image, { references: ['owned:release'], ownedTag: 'owned:release', authority: { context } }));
            const instance = resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment');
            const admission = { deploymentRoot: join(root, 'deployments'), environmentInstanceId: instance, deploymentId: 'release',
                machineId: 'builder', installationId: 'builder-installation' };
            const [retained] = await adoptOwnServerImageArchives({ archives: [archive], admission, serverId: 'home',
                signal: new AbortController().signal, async assertCurrent() {} });
            expect(OwnServerDeploymentImageArchiveV1Schema.parse(retained)).toEqual(retained);
            expect(retained!.holder.path).toBe(join(root, 'deployments', instance, 'image-archives', 'release', `${archive.sha256}.tar`));
            const proof = { deploymentRoot: admission.deploymentRoot, serverId: 'home', environmentId: 'environment', selectedDeploymentId: 'release',
                source: retained!.holder, expected: { sizeBytes: retained!.sizeBytes, sha256: retained!.sha256, image } };
            expect(readOwnServerImageArchiveOriginHint(retained!)).toEqual({ environmentId: 'environment', deploymentId: 'release' });
            await expect(verifyOwnServerImageArchiveForHost(proof)).resolves.toMatchObject({ path: retained!.holder.path,
                sizeBytes: retained!.sizeBytes, sha256: retained!.sha256 });
            await expect(verifyOwnServerImageArchiveForHost({ ...proof, selectedDeploymentId: 'another-receipt' }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            await expect(verifyOwnServerImageArchiveForHost({ ...proof, environmentId: 'promotion-destination' }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            await expect(verifyOwnServerImageArchiveForHost({ ...proof, serverId: 'other-home' }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            await expect(verifyOwnServerImageArchiveForHost({ ...proof, source: { ...proof.source, path: nativeArchive } }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            await expect(verifyOwnServerImageArchiveForHost({ ...proof, expected: { ...proof.expected,
                image: { ...image, platform: 'linux/arm64' } } }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_platform_mismatch' } });
            await rm(retained!.holder.path);
            await symlink(nativeArchive, retained!.holder.path, 'file');
            await expect(adoptOwnServerImageArchives({ archives: [archive], admission, serverId: 'home',
                signal: new AbortController().signal, async assertCurrent() {} }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            await rm(retained!.holder.path);
            await copyFile(nativeArchive, retained!.holder.path);
            const outside = join(root, 'outside');
            await mkdir(outside);
            await symlink(outside, join(admission.deploymentRoot, 'linked-instance'), 'dir');
            await expect(adoptOwnServerImageArchives({ archives: [archive], admission: { ...admission, environmentInstanceId: 'linked-instance' },
                serverId: 'home', signal: new AbortController().signal, async assertCurrent() {} }))
                .rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
            expect(await readdir(outside)).toEqual([]);
            await rm(nativeRoot, { recursive: true, force: true });
            expect(await readFile(retained!.holder.path)).toEqual(await readFile(nativeArchive));
            const original = await readFile(retained!.holder.path);
            await writeFile(nativeArchive, 'substituted bytes');
            await expect(adoptOwnServerImageArchives({ archives: [{ ...archive, path: nativeArchive }], admission, serverId: 'home',
                signal: new AbortController().signal, async assertCurrent() {} }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_archive_identity_mismatch' } });
            expect(await readFile(retained!.holder.path)).toEqual(original);
            await writeFile(retained!.holder.path, 'changed retained archive');
            await expect(verifyOwnServerImageArchiveForHost(proof))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_archive_identity_mismatch' } });
            expect(resolveOwnServerImageArchivePathForHost({ ...admission, deploymentId: 'uniform', restorationForDeploymentId: 'candidate' }, archive.sha256))
                .toMatchObject({ rootPath: join(root, 'deployments', instance, 'image-archives', 'candidate') });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
