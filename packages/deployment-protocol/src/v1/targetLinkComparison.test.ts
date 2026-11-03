import { expect, it } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1, createDeploymentTargetLinksListResultV1 } from '../testing/v1.js';
import { findExistingNativeComposeTargetLinkV1 } from './targetLinkComparison.js';

it('recognizes the exact linked native Compose project across pages and ignores other engines and installations', async () => {
    const environment = createDeploymentEnvironmentHeaderV1();
    const links = ['other-engine', 'other-installation', 'original'].map(id => createDeploymentTargetLinkHeaderV1({ id,
        members: [{ machineId: 'machine-a', installationId: id === 'other-installation' ? 'retired-installation' : 'installation-a', state: 'active' }] }));
    const origin = { projectName: 'production', dockerEndpoint: 'engine', workingDirectory: '/project', capture: { installationId: 'installation-a' } };
    const found = await findExistingNativeComposeTargetLinkV1({ machineId: 'machine-a', origin }, {
        list: async cursor => createDeploymentTargetLinksListResultV1({ items: (cursor ? links.slice(2) : links.slice(0, 2))
            .map(targetLink => ({ environment: { ...environment, runtimeTargetLinkId: targetLink.id }, targetLink })), nextCursor: cursor ? null : 'next' }),
        artifact: async link => ({ artifactId: link.contentArtifactId, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { kind: 'deployment-target-link.v1', title: '' }, body: JSON.stringify({ nativeOrigin: {
                ...origin, dockerEndpoint: link.id === 'other-engine' ? 'different-engine' : origin.dockerEndpoint,
            } }) }),
    });
    expect(found).toMatchObject({ environment: { id: environment.id }, targetLink: { id: 'original' } });
});
