import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, posix, relative, win32 } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentImageV1, OwnServerDeploymentImageArchiveV1 } from '@happier-dev/deployment-protocol';
import { readNativeComposeArchiveTransportIdentity, verifyNativeComposeImageArchive,
    type NativeComposeImageArchive } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { resolveDeploymentSourcePathForHost, type DeploymentSourceAdmissionForHost } from './exactCommitRelease';
import { filesystemPathComparisonKey, isFilesystemPathAbsolute, normalizeFilesystemPathForPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { withConfinedWorkspaceSyncParent } from '@/workspaces/sync/workspaceSyncConfinedFileSystem';
import type { PreparedFilesystemReadFile } from '@/machines/transfer/preparedFilesystemTransferScope';
import { readOwnServerDeploymentEnvironmentIdForHost, resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';

type ArchivePlacement = Pick<DeploymentSourceAdmissionForHost, 'deploymentRoot' | 'environmentInstanceId' | 'deploymentId' | 'restorationForDeploymentId'>;
type ArchiveAdmission = ArchivePlacement & Pick<DeploymentSourceAdmissionForHost, 'machineId' | 'installationId'>;

function identityMismatch(): never {
    throw new PluginError({ code: 'native_failed', message: 'The deployment image archive does not match its recorded identity',
        details: { reason: 'deployment_image_archive_identity_mismatch' } });
}

function custodyRequired(): never {
    throw new PluginError({ code: 'filesystem_transfer_custody_required',
        message: 'The image archive is outside the admitted deployment receipt' });
}

/** Builder adoption and receiving import derive the same host-only operation root.
 * Keeping archives outside source releases preserves unchanged source bind semantics. */
export function resolveOwnServerImageArchivePathForHost(admission: ArchivePlacement, sha256: string): Readonly<{ rootPath: string; path: string }> {
    resolveDeploymentSourcePathForHost(admission);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) return identityMismatch();
    const rootPath = join(admission.deploymentRoot, admission.environmentInstanceId, 'image-archives',
        admission.restorationForDeploymentId ?? admission.deploymentId);
    return { rootPath, path: join(rootPath, `${sha256}.tar`) };
}

/** Invert only the canonical archive layout to supply a routing hint. This is
 * NOT admission: Home proves the selected receipt's immutable lineage, then
 * the holder verifies these ids against its own configured native root. */
export function readOwnServerImageArchiveOriginHint(archive: Pick<OwnServerDeploymentImageArchiveV1, 'holder' | 'sha256'>): Readonly<{
    environmentId: string; deploymentId: string;
}> {
    const platform = isFilesystemPathAbsolute(archive.holder.rootPath, 'win32')
        && !isFilesystemPathAbsolute(archive.holder.rootPath, 'linux') ? 'win32' : 'linux';
    if (!isFilesystemPathAbsolute(archive.holder.rootPath, platform) || !isFilesystemPathAbsolute(archive.holder.path, platform)
        || !/^[a-f0-9]{64}$/u.test(archive.sha256)) return custodyRequired();
    const api = platform === 'win32' ? win32 : posix;
    const root = normalizeFilesystemPathForPolicy(archive.holder.rootPath, platform);
    const deploymentId = api.basename(root);
    const archivesRoot = api.dirname(root);
    const environmentRoot = api.dirname(archivesRoot);
    const environmentInstanceId = api.basename(environmentRoot);
    const deploymentRoot = api.dirname(environmentRoot);
    // Reuse the canonical identity-segment validation without interpreting the
    // remote holder's drive or home directory as this receiver's filesystem.
    try { resolveDeploymentSourcePathForHost({ deploymentRoot, environmentInstanceId, deploymentId }); }
    catch { return custodyRequired(); }
    const environmentId = readOwnServerDeploymentEnvironmentIdForHost(archive.holder.serverId, environmentInstanceId);
    if (environmentId === null) return custodyRequired();
    if (api.basename(archivesRoot) !== 'image-archives'
        || filesystemPathComparisonKey(api.join(root, `${archive.sha256}.tar`), platform)
            !== filesystemPathComparisonKey(archive.holder.path, platform)) return custodyRequired();
    return { environmentId, deploymentId };
}

async function verifyArchiveRoot(admission: ArchivePlacement, sha256: string) {
    const target = resolveOwnServerImageArchivePathForHost(admission, sha256);
    // The configured root can be operator-owned symlink; descendants cannot
    // redirect receipt adoption or transfer into another filesystem tree.
    const physical = resolveOwnServerImageArchivePathForHost({ ...admission, deploymentRoot: await realpath(admission.deploymentRoot) }, sha256);
    if (filesystemPathComparisonKey(await realpath(target.rootPath)) !== filesystemPathComparisonKey(physical.rootPath)) return custodyRequired();
    return physical;
}

async function createArchiveRoot(admission: ArchivePlacement, assertCurrent: () => Promise<void>) {
    await assertCurrent();
    await mkdir(admission.deploymentRoot, { recursive: true, mode: 0o700 });
    let parent = await realpath(admission.deploymentRoot);
    for (const segment of [admission.environmentInstanceId, 'image-archives', admission.restorationForDeploymentId ?? admission.deploymentId]) {
        const next = join(parent, segment);
        await assertCurrent();
        try { await mkdir(next, { mode: 0o700 }); }
        catch (error) {
            if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        if (!(await lstat(next)).isDirectory()) return custodyRequired();
        parent = next;
    }
}

/** Receiving copy and builder adoption prepare only their current receipt's
 * canonical directory. The existing transfer owner still owns the bytes. */
export async function prepareOwnServerImageArchiveDestinationForHost(input: Readonly<{
    admission: ArchivePlacement;
    sha256: string;
    destination: Readonly<{ rootPath: string; path: string }>;
    signal: AbortSignal;
    assertCurrent(): Promise<void>;
}>): Promise<Readonly<{ rootPath: string; path: string }>> {
    const target = resolveOwnServerImageArchivePathForHost(input.admission, input.sha256);
    if (filesystemPathComparisonKey(target.rootPath) !== filesystemPathComparisonKey(input.destination.rootPath)
        || filesystemPathComparisonKey(target.path) !== filesystemPathComparisonKey(input.destination.path)) return custodyRequired();
    const assertCurrent = async () => {
        input.signal.throwIfAborted();
        await input.assertCurrent();
        input.signal.throwIfAborted();
    };
    await createArchiveRoot(input.admission, assertCurrent);
    await verifyArchiveRoot(input.admission, input.sha256);
    await assertCurrent();
    return target;
}

/** Holder-side filesystem admission consumes the verified parent receipt identity.
 * Native adoption owns these exact files; no receipt decryption or path grant is introduced. */
export async function verifyOwnServerImageArchiveForHost(input: Readonly<{
    deploymentRoot: string;
    serverId: string;
    environmentId: string;
    selectedDeploymentId: string;
    source: Readonly<{ rootPath: string; path: string }>;
    expected?: Readonly<{ sizeBytes: number; sha256: string; image?: DeploymentImageV1 }>;
    retainReadFile?: boolean;
}>): Promise<Readonly<{ rootPath: string; path: string; sizeBytes: number; sha256: string; readFile?: PreparedFilesystemReadFile }>> {
    const match = /^([a-f0-9]{64})\.tar$/u.exec(basename(input.source.path));
    if (!match || !isFilesystemPathAbsolute(input.source.rootPath) || !isFilesystemPathAbsolute(input.source.path)) return custodyRequired();
    const placement = { deploymentRoot: input.deploymentRoot,
        environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost(input.serverId, input.environmentId),
        deploymentId: input.selectedDeploymentId };
    const target = resolveOwnServerImageArchivePathForHost(placement, match[1]!);
    if (filesystemPathComparisonKey(target.rootPath) !== filesystemPathComparisonKey(input.source.rootPath)
        || filesystemPathComparisonKey(target.path) !== filesystemPathComparisonKey(input.source.path)
        || input.expected && input.expected.sha256 !== match[1]) return custodyRequired();
    if (!(await lstat(target.path)).isFile()) return custodyRequired();
    const physical = await verifyArchiveRoot(placement, match[1]!);
    if (filesystemPathComparisonKey(await realpath(target.path)) !== filesystemPathComparisonKey(physical.path)) return custodyRequired();
    if (!input.retainReadFile) {
        const actual = await readNativeComposeArchiveTransportIdentity(target.path);
        if (actual.sha256 !== match[1] || input.expected && actual.sizeBytes !== input.expected.sizeBytes) return identityMismatch();
        if (input.expected?.image) await verifyNativeComposeImageArchive(target.path, input.expected.image);
        return { ...target, ...actual };
    }
    // The already-owned Linux confinement primitive pins every directory. The
    // resulting file descriptor, rather than this pathname, carries read custody.
    const handle = await withConfinedWorkspaceSyncParent({ rootPath: input.deploymentRoot,
        relativePath: relative(input.deploymentRoot, target.path),
        run: parent => open(join(parent.parentHandlePath, parent.finalName), constants.O_RDONLY | constants.O_NOFOLLOW) });
    try {
        const before = await handle.stat();
        if (!before.isFile()) return custodyRequired();
        const hash = createHash('sha256');
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let sizeBytes = 0;
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, sizeBytes);
            if (bytesRead === 0) break;
            hash.update(chunk.subarray(0, bytesRead));
            sizeBytes += bytesRead;
        }
        const after = await handle.stat();
        const sha256 = hash.digest('hex');
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode || sizeBytes !== after.size
            || sha256 !== match[1] || input.expected && sizeBytes !== input.expected.sizeBytes) return identityMismatch();
        if (input.expected?.image) await verifyNativeComposeImageArchive(`/proc/self/fd/${handle.fd}`, input.expected.image);
        return { ...target, sizeBytes, sha256, readFile: { ...target, handle, sizeBytes, sha256 } };
    } catch (error) { await handle.close(); throw error; }
}

/** Adopt native exports before their invocation scratch is disposed. The receipt
 * remains the provenance owner; settled cleanup belongs to deployment retention. */
export async function adoptOwnServerImageArchives(input: Readonly<{
    archives: readonly NativeComposeImageArchive[];
    admission: ArchiveAdmission;
    serverId: string;
    signal: AbortSignal;
    assertCurrent(): Promise<void>;
}>): Promise<readonly OwnServerDeploymentImageArchiveV1[]> {
    const environmentId = readOwnServerDeploymentEnvironmentIdForHost(input.serverId, input.admission.environmentInstanceId);
    if (environmentId === null) return custodyRequired();
    const adopted: OwnServerDeploymentImageArchiveV1[] = [];
    for (const archive of input.archives) {
        input.signal.throwIfAborted();
        await input.assertCurrent();
        const actual = await readNativeComposeArchiveTransportIdentity(archive.path);
        if (actual.sizeBytes !== archive.sizeBytes || actual.sha256 !== archive.sha256) return identityMismatch();
        await verifyNativeComposeImageArchive(archive.path, archive.image);
        const target = resolveOwnServerImageArchivePathForHost(input.admission, archive.sha256);
        await prepareOwnServerImageArchiveDestinationForHost({ admission: input.admission, sha256: archive.sha256,
            destination: target, signal: input.signal, assertCurrent: input.assertCurrent });
        try { await copyFile(archive.path, target.path, constants.COPYFILE_EXCL); }
        catch (error) {
            if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        await verifyOwnServerImageArchiveForHost({ deploymentRoot: input.admission.deploymentRoot,
            serverId: input.serverId, environmentId,
            selectedDeploymentId: input.admission.restorationForDeploymentId ?? input.admission.deploymentId,
            source: target, expected: { sizeBytes: archive.sizeBytes, sha256: archive.sha256 } });
        await chmod(target.path, 0o600);
        await input.assertCurrent();
        input.signal.throwIfAborted();
        adopted.push({ image: archive.image, sizeBytes: archive.sizeBytes, sha256: archive.sha256,
            holder: { serverId: input.serverId, machineId: input.admission.machineId,
                installationId: input.admission.installationId, ...target } });
    }
    return adopted;
}
