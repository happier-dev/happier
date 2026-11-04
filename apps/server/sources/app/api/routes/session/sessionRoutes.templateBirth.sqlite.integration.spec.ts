import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { EXTERNAL_ACTION_REVIEWED_CHILD_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { resolveMachineAdmissionInTx, setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createSignedDiscussionHttpFixture } from '../actions/discussionExecutionAuthorization.testkit';
import { createExternalActionAuthorizedRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';

describe('ordinary Session birth from an admitted template child', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-birth-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['own', 'shared Use', 'shared Manage'] as const)('creates and rejoins the requester Session on an %s selected Machine; refuses altered proof and body', async custody => {
        const custodian = custody !== 'own'
            ? await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } }) : null;
        const f = await createSignedDiscussionHttpFixture('template.instantiate');
        try {
            if (custodian) {
                await makeShareEligibleForTest(custodian.id, f.account.id);
                await db.machine.update({ where: { id: f.machine.id }, data: { accountId: custodian.id,
                    operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
                    operationProtocolCapabilitiesRevision: 1 } });
                expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                    machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id }, level: custody === 'shared Use' ? 'view' : 'admin' })))
                    .toMatchObject({ kind: 'saved' });
                await expect(inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: f.account.id,
                    machineId: f.machine.id, actionId: 'session.spawn_new' }))).resolves.toMatchObject({ kind: 'admitted' });
            }
            const creation = { creationKey: randomUUID(), executionTarget: { serverId: 'home', machineId: f.machine.id },
                directory: { kind: 'path', path: '/work' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
            const authorization = await f.mint('template.instantiate', {
                source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, creation,
            });
            const child = { actionId: 'session.spawn_new', role: 'create_bot',
                inputDigest: computeActionInputApprovalDigestV1('session.spawn_new', creation) };
            const body = { tag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: creation.creationKey }),
                metadataLayoutVersion: 1, encryptionMode: 'plain', sharedMetadata: { ciphertext: '{"v":1}' },
                ownerMetadata: { t: 'plain', v: { v: 1 } }, dataEncryptionKey: null };
            const signedHeaders = (payload: unknown, reviewedChild = child) => createExternalActionAuthorizedRequestHeaders({
                authorization, effectActionId: 'session.spawn_new', target: authorization.binding.target,
                installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey,
                method: 'POST', path: '/v1/sessions', body: payload, reviewedChild,
            });
            const inject = (payload: unknown, headers: Record<string, string>) => f.app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { 'content-type': 'application/json', 'x-happier-account-stored-content-protocol': '2', ...headers }, payload: JSON.stringify(payload) });
            const naked = await inject(body, { authorization: `Bearer ${f.presentUserToken}`,
                [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: authorization.token });
            expect(naked.statusCode, naked.body).toBe(401);
            const wrongChild = await inject(body, signedHeaders(body, { ...child, role: 'unrelated' }));
            expect(wrongChild.statusCode, wrongChild.body).toBe(401);
            const changedBody = { ...body, tag: `${body.tag}-altered` };
            const tampered = await inject(changedBody, signedHeaders(body));
            expect(tampered.statusCode, tampered.body).toBe(401);
            const alteredDigest = await inject(body, { ...signedHeaders(body), [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]:
                encodeReviewedActionChildHttpProofV1({ ...child, inputDigest: computeActionInputApprovalDigestV1('session.spawn_new', {
                    ...creation, creationKey: 'different-birth',
                }) }) });
            expect(alteredDigest.statusCode, alteredDigest.body).toBe(401);
            const alteredTarget = await inject(body, {
                ...createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: 'session.spawn_new',
                    target: { kind: 'machine', machineId: randomUUID() }, installationId: f.machine.installationId!,
                    privateKey: f.keyPair.secretKey, method: 'POST', path: '/v1/sessions', body, reviewedChild: child }) });
            expect(alteredTarget.statusCode, alteredTarget.body).toBe(401);
            expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(0);
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/sessions', body, reviewedChild: child }, 'session.spawn_new'))
                .resolves.toMatchObject({ reviewedChildAdmission: child, effectActionId: 'session.spawn_new' });

            const serverUrl = await f.app.listen({ port: 0, host: '127.0.0.1' });
            const create = () => fetch(`${serverUrl}/v1/sessions`, { method: 'POST', body: JSON.stringify(body),
                headers: { 'content-type': 'application/json', 'x-happier-account-stored-content-protocol': '2',
                    [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: authorization.token, ...signedHeaders(body) } });
            const created = await create();
            const createdData: unknown = await created.json();
            expect(created.status, JSON.stringify(createdData)).toBe(200);
            const session = await db.session.findFirst({ where: { accountId: f.account.id, tag: body.tag },
                select: { id: true, accountId: true, tag: true } });
            expect(session).toMatchObject({ accountId: f.account.id, tag: body.tag });
            expect(createdData).toMatchObject({ created: true, session: { id: session?.id } });
            const rejoined = await create();
            const rejoinedData: unknown = await rejoined.json();
            expect(rejoined.status, JSON.stringify(rejoinedData)).toBe(200);
            expect(rejoinedData).toMatchObject({ created: false, session: { id: session?.id } });
            if (!session) throw new Error('Expected the committed requester Session');
            const accessKeyPath = `/v1/access-keys/${session.id}/${f.machine.id}`;
            const control = (method: 'GET' | 'POST' | 'PUT', path: string, controlBody?: unknown) => fetch(`${serverUrl}${path}`, {
                method, ...(controlBody === undefined ? {} : { body: JSON.stringify(controlBody) }),
                headers: { 'content-type': 'application/json', ...createExternalActionAuthorizedRequestHeaders({
                    authorization, effectActionId: 'session.spawn_new', target: authorization.binding.target,
                    installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey,
                    method, path, ...(controlBody === undefined ? {} : { body: controlBody }), reviewedChild: child,
                }) },
            });
            const keyRead = await control('GET', accessKeyPath);
            expect(keyRead.status, await keyRead.text()).toBe(200);
            const controlBody = { data: `session-machine-control:${randomUUID()}` };
            const keyCreated = await control('POST', accessKeyPath, controlBody);
            expect(keyCreated.status, await keyCreated.text()).toBe(200);
            expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                accountId: f.account.id, machineId: f.machine.id, sessionId: session.id,
            } }, select: { data: true } })).toEqual(controlBody);
            const unrelatedMachine = await control('GET', `/v1/access-keys/${session.id}/${randomUUID()}`);
            expect(unrelatedMachine.status).toBe(401);
            const update = await control('PUT', accessKeyPath, { ...controlBody, expectedVersion: 0 });
            expect(update.status).toBe(401);
            const extraBody = await control('POST', accessKeyPath, { ...controlBody, unrelated: true });
            expect(extraBody.status).toBe(401);
        } finally { await f.app.close(); }
    });
});
