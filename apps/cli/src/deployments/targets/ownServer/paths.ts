import { isAbsolute, join, relative, resolve, sep, posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveCliHomeStoragePaths } from '@/configuration/homeStoragePaths';

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
}>): string {
    const segments = [admitted.environmentInstanceId, admitted.deploymentId,
        ...(admitted.restorationForDeploymentId === undefined ? [] : [admitted.restorationForDeploymentId])];
    for (const id of segments) assertDeploymentIdentitySegment(id);
    const environmentRoot = join(admitted.deploymentRoot, admitted.environmentInstanceId);
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
