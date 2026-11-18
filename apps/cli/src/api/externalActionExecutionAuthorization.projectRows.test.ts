import { expect, it } from 'vitest';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyResponseV1Schema,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SCM_WORKTREE_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/scmActionIdsV1';
import { ACTION_IDS, isProjectCheckoutRemovalActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { projectExternalActionRequesterHttpAuthorization } from './externalActionExecutionAuthorization';

it.each([SCM_WORKTREE_CREATE_ACTION_ID_V1, ...ACTION_IDS.filter(isProjectCheckoutRemovalActionIdV1)])(
    'reads the admitted requester source association through its own Account HTTP custody for %s', async actionId => {
    const app = fastify();
    const channel = await createRequesterCurrentnessSocketHarness();
    const origin = 'http://scm-requester-source.test';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.fixture`, encryption: null };
    app.get('/v1/account/profile', async () => ({ id: 'requester' }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v2/changes', async () => ({ changes: [], nextCursor: 0 }));
    app.post(bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId), async () =>
        ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true }));
    const workspace = { id: 'source-workspace', serverId: 'home', machineId: 'machine', rootPath: '/source',
        projectKey: 'source-project', createdAtMs: 1, lastOpenedAtMs: null };
    const rows = [createPlainProjectAccountRefRow(workspace)];
    const readBearers: Array<string | undefined> = [];
    app.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, async (request, reply) => {
        readBearers.push(request.headers.authorization);
        // Home's ordinary Account row boundary cannot spend a Machine effect proof.
        if (request.headers.authorization !== `Bearer ${credentials.token}`) return reply.code(403).send({ error: 'verification_purpose' });
        return projectAccountRowsReadHttpResponse(rows, request.url, request.body).data;
    });
    const restore = installAxiosFastifyAdapter({ app, origin });
    let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
    try {
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-root', binding: {
            accountId: 'requester', custodianAccountId: 'custodian', accountEncryptionMode: 'plain',
            authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'home', machineId: 'machine',
            installationId: 'installation', actionId, requestId: 'original-request',
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } });
        requester = await admitRequesterAccountActionContext({ authorization, credentials,
            serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: origin, isCurrent: async () => true });
        if (!requester) throw new Error('Requester custody not admitted');
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
            serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: origin, target: authorization.binding.target,
            installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey, isCurrent: requester.isCurrent });
        if (!carrier?.requesterHttpProjection) throw new Error('Requester HTTP custody not admitted');
        const accepted = await resolveProjectSetupAcceptedWorkspace({ ...projectRuntimeAccountRowsInput({ accountAuthorization: carrier }),
            serverId: 'home', serverHttpBaseUrl: origin, address: { serverId: 'home', machineId: 'machine', rootPath: '/source' },
            allowUnassociated: true, allowProjectless: true });
        expect(accepted).toMatchObject({ workspace: { id: 'source-workspace', rootPath: '/source' },
            project: { serverId: 'home', projectId: 'source-project' } });
        expect(readBearers).toEqual([`Bearer ${credentials.token}`]);
        // The same custody remains read-only; mutations still spend the signed root.
        const writeHeaders = await carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: actionId,
            method: 'POST', path: `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, body: {} });
        expect(writeHeaders).not.toHaveProperty('Authorization');
    } finally { await requester?.dispose(); restore(); await channel.close(); await app.close(); }
});
