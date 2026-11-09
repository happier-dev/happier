import { isAbsolute, join, relative, resolve, sep, posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveCliHomeStoragePaths } from '@/configuration/homeStoragePaths';
import { createCanonicalAbsolutePathComparator, resolveCanonicalAbsolutePath } from '@happier-dev/cli-common/path';

function assertDeploymentIdentitySegment(id: string): void {
    if (!id || /[/\\\0]/u.test(id) || id === '.' || id === '..') {
        throw Object.assign(new Error('Invalid deployment identity'), { code: 'invalid_request' });
    }
}

export async function resolveOwnServerDeploymentRootForHost(happierHomeDir: string, serverId: string): Promise<string> {
    const { getServerProfile } = await import('@/server/serverProfiles');
    const profile = await getServerProfile(serverId);
    return deploymentRootForServerDir(join(resolveCliHomeStoragePaths(happierHomeDir).serversDir, profile.id));
}

function deploymentRootForServerDir(serverDir: string, platform: NodeJS.Platform = process.platform): string {
    return (platform === 'win32' ? win32 : posix).join(serverDir, 'deployments');
}

export type OwnServerDeploymentStoragePaths = Readonly<{ serversDir: string; activeServerDir: string }>;

/** Placement survives removing a saved profile: its retained release/shared bytes
 * still belong to deployment retention, never generic Storage removal. */
export function readOwnServerDeploymentStorageRootForPathForHost(path: string, paths: OwnServerDeploymentStoragePaths,
    platform: NodeJS.Platform = process.platform): string | null {
    const api = platform === 'win32' ? win32 : posix;
    const comparison = createCanonicalAbsolutePathComparator({ platform });
    const related = (root: string) => comparison.equal(path, root) || comparison.contains(root, path) || comparison.contains(path, root);
    const activeRoot = deploymentRootForServerDir(paths.activeServerDir, platform);
    if (related(activeRoot)) return activeRoot;
    const serversDir = paths.serversDir;
    const canonicalServers = resolveCanonicalAbsolutePath(serversDir, { platform });
    const canonicalPath = resolveCanonicalAbsolutePath(path, { platform });
    if (!canonicalServers || !canonicalPath) return null;
    const withinServers = api.relative(canonicalServers.comparisonKey, canonicalPath.comparisonKey);
    const [profileId, kind] = withinServers.split(api.sep);
    if (!profileId || profileId === '..' || api.isAbsolute(withinServers) || kind !== undefined && kind !== 'deployments') return null;
    const root = deploymentRootForServerDir(api.join(serversDir, profileId), platform);
    return related(root) ? root : null;
}

/** The caller supplies the exact Home identity, never a saved profile alias. */
export function resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerIdentityId: string, environmentId: string): string {
    if (!homeServerIdentityId) {
        throw Object.assign(new Error('Invalid deployment identity'), { code: 'invalid_request' });
    }
    assertDeploymentIdentitySegment(environmentId);
    return `${createHash('sha256').update(homeServerIdentityId).digest('hex')}--${environmentId}`;
}

/** Routing hint only; the caller supplies the exact Home identity. */
export function readOwnServerDeploymentEnvironmentIdForHost(homeServerIdentityId: string, environmentInstanceId: string): string | null {
    const environmentId = environmentInstanceId.slice(66);
    try {
        return resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerIdentityId, environmentId) === environmentInstanceId ? environmentId : null;
    } catch { return null; }
}

/** Launch and cold reads consume the same native identity, without retained state. */
export async function resolveOwnServerDeploymentIdentityForHost(input: Readonly<{
    happierHomeDir: string; serverId: string; environmentId: string;
}>): Promise<Readonly<{ homeServerIdentityId: string; environmentId: string; environmentInstanceId: string; deploymentRoot: string; projectName: string }>> {
    const [deploymentRoot, homeServerId, { resolveEnvironmentComposeProjectName }] = await Promise.all([
        resolveOwnServerDeploymentRootForHost(input.happierHomeDir, input.serverId),
        import('@/server/serverProfiles').then(({ resolveServerProfileHomeIdentityId }) => resolveServerProfileHomeIdentityId(input.serverId)),
        import('@/workspaces/projectSetup/projectNativeResolution'),
    ]);
    if (!homeServerId) {
        throw Object.assign(new Error('The deployment Home identity is unavailable'), { code: 'target_unavailable' });
    }
    const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerId, input.environmentId);
    return { homeServerIdentityId: homeServerId, environmentId: input.environmentId, environmentInstanceId, deploymentRoot,
        projectName: resolveEnvironmentComposeProjectName({ environmentInstanceId, services: [] }) };
}

/** Physical placement is host-only; public source identity remains the selected receipt. */
export function resolveDeploymentSourcePathForHost(admitted: Readonly<{
    deploymentRoot: string; environmentInstanceId: string; deploymentId: string;
    restorationForDeploymentId?: string; materializationRole?: 'build';
    maintenanceOperationId?: string;
}>): string {
    const segments = [admitted.environmentInstanceId, admitted.deploymentId,
        ...(admitted.restorationForDeploymentId === undefined ? [] : [admitted.restorationForDeploymentId]),
        ...(admitted.maintenanceOperationId === undefined ? [] : [admitted.maintenanceOperationId])];
    for (const id of segments) assertDeploymentIdentitySegment(id);
    const environmentRoot = join(admitted.deploymentRoot, admitted.environmentInstanceId);
    if (admitted.maintenanceOperationId !== undefined) {
        if (admitted.materializationRole || admitted.restorationForDeploymentId === undefined) {
            throw Object.assign(new Error('Invalid deployment source role'), { code: 'invalid_request' });
        }
        // This disposable source never becomes a serving release or a cold runtime routing hint.
        return join(environmentRoot, 'maintenance', admitted.maintenanceOperationId);
    }
    if (admitted.materializationRole === 'build') {
        if (admitted.restorationForDeploymentId !== undefined) throw Object.assign(new Error('Invalid deployment source role'), { code: 'invalid_request' });
        return join(environmentRoot, 'builds', admitted.deploymentId);
    }
    return admitted.restorationForDeploymentId === undefined ? join(environmentRoot, 'releases', admitted.deploymentId)
        : join(environmentRoot, 'restorations', admitted.restorationForDeploymentId, admitted.deploymentId);
}

/** Invert only canonical runtime placements. A native working-directory label
 * remains a routing hint and supplies no physical or executable source custody. */
export function readDeploymentSourceIdentityForHost(input: Readonly<{
    deploymentRoot: string; sourcePath: string;
}>): Readonly<{ environmentInstanceId: string; deploymentId: string; restorationForDeploymentId?: string }> | null {
    if (!isAbsolute(input.deploymentRoot) || !isAbsolute(input.sourcePath)) return null;
    const parts = relative(resolve(input.deploymentRoot), resolve(input.sourcePath)).split(sep);
    const identity = parts.length === 3 && parts[1] === 'releases'
        ? { environmentInstanceId: parts[0]!, deploymentId: parts[2]! }
        : parts.length === 4 && parts[1] === 'restorations'
            ? { environmentInstanceId: parts[0]!, restorationForDeploymentId: parts[2]!, deploymentId: parts[3]! }
            : null;
    if (!identity) return null;
    try {
        return resolveDeploymentSourcePathForHost({ deploymentRoot: input.deploymentRoot, ...identity }) === resolve(input.sourcePath)
            ? identity : null;
    } catch { return null; }
}
