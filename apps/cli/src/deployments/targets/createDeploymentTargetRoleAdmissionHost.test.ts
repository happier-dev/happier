import { expect, it } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
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

it('opens the selected Environment data Link using signed Session requester transport', async () => {
    const stored = createDeploymentTargetRoleAdmissionFixture('branches.list');
    const { environment: header, content, targetLinks } = stored.state.environment;
    const selected = targetLinks[0]!;
    const app = fastify();
    const serverHttpBaseUrl = 'https://session-environment.test';
    const accountId = 'custody-account';
    const serverId = 'home';
    const machineId = 'controller';
    const installationId = 'installation-controller';
    const sessionId = 'source-session';
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    registerAccountHomeHttp(app, { accountId, serverId });
    const artifacts = registerAccountArtifactRoutes(app, accountId, { encryptionMode: 'plain' });
    artifacts.seed(header.contentArtifactId,
        encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Environment' }),
        encodePlainArtifactStoredContent({ body: JSON.stringify(content) }));
    artifacts.seed(selected.targetLink.contentArtifactId,
        encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Selected data' }),
        encodePlainArtifactStoredContent({ body: JSON.stringify(selected.content) }));
    app.get('/v1/deployments/environments/:environmentId', async request => ({ ok: true,
        environment: request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'owner-admission'
            ? header : { ...header, capabilities: { ...header.capabilities, read: false } },
        targetLinks: targetLinks.map(row => row.targetLink),
    }));
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    try {
        const target = { kind: 'machine' as const, machineId };
        const envelope = { v: 1 as const, requestId: 'database-read', target, input: stored.input };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'owner-admission', binding: {
            serverIdentityId: serverId, accountId, authentication: { kind: 'account', tokenEpoch: 1 },
            admittedMachineRole: 'use', custodianAccountId: accountId, machineId, installationId,
            actionId: 'deployments.environments.get', requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            sessionActionSource: { machineId, installationId },
            sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'turn', callerPermissionMode: null, requestId: envelope.requestId },
        } });
        const isCurrent = async () => true;
        const privateKey = tweetnacl.sign.keyPair().secretKey;
        const config = { resolveRequesterIdentity: stored.host.resolveRequesterIdentity, readCurrentMachineId: () => machineId };
        const scope = { serverId, environmentId: header.id, projectSourceId: header.projectSourceId,
            targetLinkId: selected.targetLink.id };
        const project = async (token: string) => {
            const http = await projectExternalActionRequesterHttpAuthorization({ authorization: { ...authorization, token },
                serverId, serverIdentityId: serverId, serverHttpBaseUrl, target, installationId, privateKey, isCurrent, rootAdmitted: true });
            if (!http) throw new Error('Expected signed Session HTTP projection');
            const requester = await projectRequesterAccountActionAuthorization({ authorization: http, serverIdentityId: serverId,
                bootstrap: { credentials, serverHttpBaseUrl, isCurrent, getBoundSessionId: () => sessionId,
                    attribution: { serverId, accountId, machineId, installationId } } });
            if (!requester) throw new Error('Expected Session Account transport projection');
            const context = { externalActionExecutionAuthorization: requester };
            const host = await createDeploymentTargetRoleAdmissionHost(context, config);
            if (!host) throw new Error('Environment role host refused signed Session transport');
            return readDeploymentTargetEnvironmentForHost({ ...scope, context }, host);
        };
        const opened = await project('owner-admission');
        expect(opened.targetLinks.find(row => row.targetLink.id === selected.targetLink.id)?.content).toEqual(selected.content);
        await expect(project('no-source-membership')).rejects.toMatchObject({ errorCode: 'deployment_access_denied' });
    } finally { restore(); await app.close(); }
});
