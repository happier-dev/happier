import { join } from 'node:path';
import { expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readDeploymentSourceIdentityForHost, readOwnServerDeploymentEnvironmentIdForHost,
    resolveDeploymentSourcePathForHost, resolveOwnServerDeploymentIdentityForHost,
    resolveOwnServerDeploymentRootForHost, readOwnServerDeploymentStorageRootForPathForHost } from './paths';

it('separates deployment roots for two Homes sharing the same local Machine and Environment id', async () => {
    await withTempDir('deployment-home-roots-', async home => {
        const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
            serversDir: configuration.serversDir, activeServerId: configuration.activeServerId };
        Object.assign(configuration, { happyHomeDir: home, settingsFile: join(home, 'settings.json'), serversDir: join(home, 'servers') });
        try {
            const homes = [
                await addServerProfile({ name: 'deployment-home-a', serverUrl: 'https://deployment-home-a.invalid',
                    webappUrl: 'https://deployment-home-a.invalid' }),
                await addServerProfile({ name: 'deployment-home-b', serverUrl: 'https://deployment-home-b.invalid',
                    webappUrl: 'https://deployment-home-b.invalid' }),
            ];
            const serverIds = ['srv_deployment_home_a', 'srv_deployment_home_b'] as const;
            for (const [index, profile] of homes.entries()) {
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
                    v: 1, homeServerIdentityId: serverIds[index]!, canonicalServerUrl: profile.serverUrl, revision: 1,
                    endpoints: [{ kind: 'https', url: profile.serverUrl }],
                } });
            }
            const roots = await Promise.all(serverIds.map(serverId => resolveOwnServerDeploymentRootForHost(home, serverId)));
            expect(roots).toEqual(homes.map(profile => join(home, 'servers', profile.id, 'deployments')));
            expect(new Set(roots).size).toBe(2);
            const storagePaths = { serversDir: join(home, 'servers'), activeServerDir: join(home, 'servers', homes[0]!.id) };
            for (const root of roots) {
                expect(readOwnServerDeploymentStorageRootForPathForHost(root, storagePaths)).toBe(root);
                expect(readOwnServerDeploymentStorageRootForPathForHost(join(root, 'environment', 'releases', 'receipt'), storagePaths)).toBe(root);
                expect(readOwnServerDeploymentStorageRootForPathForHost(join(root, 'environment', 'shared'), storagePaths)).toBe(root);
                expect(readOwnServerDeploymentStorageRootForPathForHost(`${root}-ordinary`, storagePaths)).toBeNull();
            }
            const environmentId = 'shared-environment';
            const identities = await Promise.all(serverIds.map(serverId => resolveOwnServerDeploymentIdentityForHost({
                happierHomeDir: home, serverId, environmentId,
            })));
            const a = identities[0]!;
            const b = identities[1]!;
            const profileAliases = await Promise.all(homes.map(profile => resolveOwnServerDeploymentIdentityForHost({
                happierHomeDir: home, serverId: profile.id, environmentId,
            })));
            expect(profileAliases).toEqual(identities);
            expect(identities.map(identity => identity.homeServerIdentityId)).toEqual(serverIds);
            expect(identities.map(identity => identity.environmentId)).toEqual([environmentId, environmentId]);
            expect(identities.map(identity => identity.deploymentRoot)).toEqual(roots);
            expect(a.environmentInstanceId).not.toBe(b.environmentInstanceId);
            expect(a.projectName).not.toBe(b.projectName);
            expect(readOwnServerDeploymentEnvironmentIdForHost(serverIds[0], a.environmentInstanceId)).toBe(environmentId);
            const coldHomeId = await resolveServerProfileHomeIdentityId(homes[0]!.id);
            expect(coldHomeId).toBe(serverIds[0]);
            expect(readOwnServerDeploymentEnvironmentIdForHost(coldHomeId!, a.environmentInstanceId)).toBe(environmentId);
            expect(readOwnServerDeploymentEnvironmentIdForHost(homes[0]!.id, a.environmentInstanceId)).toBeNull();
            expect(readOwnServerDeploymentEnvironmentIdForHost(serverIds[1], a.environmentInstanceId)).toBeNull();
            expect(readOwnServerDeploymentEnvironmentIdForHost(serverIds[0], environmentId)).toBeNull();
            Object.assign(configuration, { activeServerId: homes[1]!.id });
            expect(await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: home, serverId: serverIds[0], environmentId })).toEqual(a);
            const sourceA = resolveDeploymentSourcePathForHost({ ...a, deploymentId: 'original-release' });
            const sourceB = resolveDeploymentSourcePathForHost({ ...b, deploymentId: 'original-release' });
            expect(sourceA).not.toBe(sourceB);
            expect(readDeploymentSourceIdentityForHost({ deploymentRoot: a.deploymentRoot, sourcePath: sourceA }))
                .toEqual({ environmentInstanceId: a.environmentInstanceId, deploymentId: 'original-release' });
            expect(readDeploymentSourceIdentityForHost({ deploymentRoot: b.deploymentRoot, sourcePath: sourceA })).toBeNull();
            const restored = resolveDeploymentSourcePathForHost({ ...a, deploymentId: 'original-release', restorationForDeploymentId: 'failed-release' });
            expect(readDeploymentSourceIdentityForHost({ deploymentRoot: a.deploymentRoot, sourcePath: restored }))
                .toEqual({ environmentInstanceId: a.environmentInstanceId, deploymentId: 'original-release', restorationForDeploymentId: 'failed-release' });
        } finally { Object.assign(configuration, previous); }
    });
});
