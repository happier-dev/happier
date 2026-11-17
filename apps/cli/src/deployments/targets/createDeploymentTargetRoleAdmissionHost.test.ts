import { expect, it } from 'vitest';
import fastify from 'fastify';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { registerAccountArtifactRoutes, registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createDeploymentTargetRoleAdmissionFixture } from './deploymentTargetRoleAdmission.testkit';
import { createDeploymentTargetRoleAdmissionHost } from './createDeploymentTargetRoleAdmissionHost';
import { readDeploymentTargetEnvironmentForHost } from './admitDeploymentTargetRoleForHost';

it.each(['controller', 'native-member'])('opens live data Link content only on its controller (%s)', async machineId => {
    const stored = createDeploymentTargetRoleAdmissionFixture('branches.list');
    const selected = stored.state.environment.targetLinks[0]!;
    const header = stored.state.environment.environment;
    const detached = createDeploymentTargetLinkHeaderV1({ ...selected.targetLink, id: 'detached-data',
        contentArtifactId: 'unopened-detached-content', detachedAtMs: 1 });
    const app = fastify();
    registerAccountHomeHttp(app, { accountId: 'custody-account', serverId: 'home' });
    const artifacts = registerAccountArtifactRoutes(app, 'custody-account', { encryptionMode: 'plain' });
    artifacts.seed(header.contentArtifactId,
        encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Environment' }),
        encodePlainArtifactStoredContent({ body: JSON.stringify(stored.state.environment.content) }));
    artifacts.seed(selected.targetLink.contentArtifactId,
        encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Selected data' }),
        encodePlainArtifactStoredContent({ body: JSON.stringify(selected.content) }));
    // Metadata and Artifact HTTP are the boundaries; host selection and document codecs stay real.
    app.get('/v1/deployments/environments/:environmentId', async () => ({ ok: true, environment: header,
        targetLinks: [...stored.state.environment.targetLinks.map(row => row.targetLink), detached] }));
    const restore = installAxiosFastifyAdapter({ app, origin: 'https://discovery.test' });
    try {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'custody-account' })).toString('base64url')}.signature`;
        const host = await createDeploymentTargetRoleAdmissionHost({}, {
            resolveRequesterIdentity: stored.host.resolveRequesterIdentity,
            readCurrentMachineId: () => machineId,
            accountExecution: { credentials: { token, encryption: null }, serverUrl: 'https://discovery.test',
                serverIdentityId: 'home', isCurrent: async () => true },
        });
        if (!host) throw new Error('Expected captured Account host');
        const scope = { serverId: 'home', environmentId: header.id, projectSourceId: header.projectSourceId, context: {} };
        const metadata = await readDeploymentTargetEnvironmentForHost(scope, host);
        expect(metadata.targetLinks.every(row => row.content === undefined)).toBe(true);
        const discovered = await readDeploymentTargetEnvironmentForHost({ ...scope, includeDataTargetLinkContent: true }, host);
        expect(discovered.targetLinks.find(row => row.targetLink.id === selected.targetLink.id)?.content)
            .toEqual(machineId === 'controller' ? selected.content : undefined);
        expect(discovered.targetLinks.filter(row => row.targetLink.id !== selected.targetLink.id)
            .every(row => row.content === undefined)).toBe(true);
    } finally { restore(); await app.close(); }
});
