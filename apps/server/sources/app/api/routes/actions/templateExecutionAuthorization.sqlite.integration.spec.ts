import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { Server } from 'socket.io';
import { encodeBase64 } from 'privacy-kit';
import { encodeBase64 as encodeCanonicalBase64 } from '@happier-dev/protocol/crypto/base64';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionDaemonDispatchRequestSchema,
    createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { verifyExternalActionMachineRpcExecution, readAdmittedTemplateExecutionPrincipal,
    projectExternalActionBoundPrincipal, verifyTemplateRequesterExecutionAuthorization,
    verifyTemplateRequesterHttpExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedDiscussionHttpFixture as signedFixture } from './discussionExecutionAuthorization.testkit';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionPatchRoute } from '../session/registerSessionPatchRoute';
import { projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { VerifiedEphemeralSessionRunnerPrincipalSchema } from '@happier-dev/protocol/ephemeralRunner/principal';

const content = { v: 1, identity: { name: 'Helper', description: '' }, instructions: { markdown: 'Help.' },
    memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } };
const createBody = (id: string) => ({ id, kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
    header: 'aA==', body: 'Yg==', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
const updateBody = { header: 'aA==', body: 'Yg==', expectedHeaderVersion: 1, expectedBodyVersion: 1 };

describe('signed template parent HTTP purposes', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-execution-auth-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it.each([
        { scope: 'restricted', allowedAction: 'template.instantiate', ownStatus: 403 },
        { scope: 'unrestricted', allowedAction: undefined, ownStatus: 200 },
    ] as const)('keeps $scope PAT template authorship within its admitted HTTP purposes', async ({ allowedAction, ownStatus }) => {
        const f = await signedFixture(allowedAction, [], true);
        try {
            // Source existence is deliberately irrelevant to the PAT scope boundary.
            const input = { source: { kind: 'artifact', artifactId: randomUUID() } };
            const root = await f.mint('template.instantiate', input);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1,
                requestId: root.binding.requestId, target: root.binding.target, input });
            const bearer = { authorization: `Bearer ${f.pat.token}` };
            const userPath = `/v1/user/${encodeURIComponent(f.account.id)}`;
            expect((await f.app.inject({ method: 'GET', url: userPath, headers: bearer })).statusCode).toBe(403);
            for (const requesterAuthorship of ['other', 'requester'] as const) {
                const enriched = await f.app.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1('template.instantiate'), headers: bearer,
                    payload: { v: 1, machineId: f.machine.id, envelope,
                        templateRequesterSetupEnrichment: { authorization: root, requesterAuthorship } } });
                expect(enriched.statusCode).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(enriched.json());
                const headers = { ...bearer,
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'template.instantiate',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target) };
                const expectedStatus = requesterAuthorship === 'requester' ? ownStatus : 403;
                expect((await f.app.inject({ method: 'GET', url: userPath, headers })).statusCode).toBe(expectedStatus);
                expect(await f.verify(authorization, { method: 'GET', path: userPath,
                    routeInput: { id: f.account.id } }) !== null).toBe(expectedStatus === 200);
                expect((await f.app.inject({ method: 'GET', url: '/v1/account/encryption', headers })).statusCode).toBe(200);
                await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption' })).resolves.not.toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it('lets a signed requester author use ordinary Account access while another author stays template-confined', async () => {
        const f = await signedFixture('template.instantiate', [], true);
        try {
            const input = { source: { kind: 'artifact', artifactId: randomUUID() } };
            const original = await f.mint('template.instantiate', input, true);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: original.binding.requestId,
                target: original.binding.target, input });
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('template.instantiate');
            const enrich = async (requesterAuthorship: 'requester' | 'other', authorization = original) => f.app.inject({
                method: 'POST', url: path, headers: { authorization: `Bearer ${f.presentUserToken}` },
                payload: { v: 1, machineId: f.machine.id, envelope,
                    templateRequesterSetupEnrichment: { authorization, requesterAuthorship } },
            });
            const authorResponse = await enrich('requester');
            expect(authorResponse.statusCode, authorResponse.body).toBe(200);
            const author = ExternalActionExecutionAuthorizationV1Schema.parse(authorResponse.json());
            expect(author.binding).toMatchObject({ templateRequesterAuthorship: 'requester' });
            const otherResponse = await enrich('other');
            expect(otherResponse.statusCode, otherResponse.body).toBe(200);
            const other = ExternalActionExecutionAuthorizationV1Schema.parse(otherResponse.json());
            const userPath = `/v1/user/${encodeURIComponent(f.account.id)}`;
            const headers = (authorization: typeof author, effectActionId = 'template.instantiate') => ({
                authorization: `Bearer ${f.presentUserToken}`,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
            });
            await expect(f.verify(author, { method: 'GET', path: userPath, routeInput: { id: f.account.id } })).resolves.not.toBeNull();
            await expect(f.verify(other, { method: 'GET', path: userPath, routeInput: { id: f.account.id } })).resolves.toBeNull();
            await expect(verifyTemplateRequesterHttpExecutionRequest({ authorizationToken: author.token,
                encodedTarget: encodeExternalActionResolvedTargetV1(author.binding.target), effectActionId: 'template.instantiate',
                method: 'GET', path: userPath, body: undefined, machineSignature: '' },
                { accountId: f.account.id, authority: 'present_user', tokenEpoch: f.account.tokenEpoch })).resolves.not.toBeNull();
            const ordinaryGet = await f.app.inject({ method: 'GET', url: userPath,
                headers: { authorization: `Bearer ${f.presentUserToken}` } });
            expect(ordinaryGet.statusCode, ordinaryGet.body).toBe(200);
            const authorGet = await f.app.inject({ method: 'GET', url: userPath, headers: headers(author) });
            expect(authorGet.statusCode, authorGet.body).toBe(200);
            expect((await f.app.inject({ method: 'GET', url: userPath, headers: headers(other) })).statusCode).toBe(403);
            const reviewedChild = { actionId: 'memory.remember', role: 'memory:reviewed', inputDigest: 'a'.repeat(43) };
            await expect(f.verify(author, { method: 'GET', path: userPath, routeInput: { id: f.account.id }, reviewedChild },
                'memory.remember')).resolves.not.toBeNull();
            await expect(f.verify(author, { method: 'GET', path: userPath, routeInput: { id: f.account.id },
                reviewedChild: { ...reviewedChild, role: 'invalid' } }, 'memory.remember')).resolves.toBeNull();
            expect((await enrich('other', author)).statusCode).toBe(403);
            const authentication = createPresentUserSessionAccessAuthentication();
            await expect(verifyTemplateRequesterExecutionAuthorization({ authorization: author,
                originalActionEnvelope: envelope, accountId: f.account.id, authentication })).resolves.not.toBeNull();
            await expect(verifyTemplateRequesterExecutionAuthorization({ authorization: author,
                originalActionEnvelope: envelope, accountId: randomUUID(), authentication })).resolves.toBeNull();
            await expect(verifyTemplateRequesterExecutionAuthorization({ authorization: author,
                originalActionEnvelope: { ...envelope, requestId: randomUUID() },
                accountId: f.account.id, authentication })).resolves.toBeNull();
            await expect(verifyTemplateRequesterExecutionAuthorization({ authorization: { ...author,
                binding: { ...author.binding, templateRequesterAuthorship: 'other' } },
                originalActionEnvelope: envelope, accountId: f.account.id, authentication })).resolves.toBeNull();
            await expect(verifyTemplateRequesterExecutionAuthorization({ authorization: author,
                originalActionEnvelope: envelope, accountId: f.account.id,
                authentication: { ...authentication, sessionRuntimePrincipal: VerifiedEphemeralSessionRunnerPrincipalSchema.parse({
                    kind: 'ephemeral_session_runner', authority: 'session_runtime', accountId: f.account.id,
                    activationId: randomUUID(), sessionId: randomUUID(), machineId: f.machine.id,
                    installationId: f.machine.installationId, installationPublicKey: encodeCanonicalBase64(f.keyPair.publicKey, 'base64url'), creatorTokenEpoch: 0,
                }) } })).resolves.toBeNull();

            const sessionId = randomUUID();
            const sessionRouteTarget = { kind: 'session' as const, sessionId };
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            const child = (actionId: 'prompt_doc.create' | 'session.instructions.set' | 'memory.remember'
                | 'skills.create' | 'mcp.servers.create' | 'session.bot.face.set', role: string) => ({
                actionId, role, inputDigest: computeActionInputApprovalDigestV1(actionId, {}),
            });
            const contentWrite = { method: 'POST', path: '/v1/artifacts?extra=1', body: createBody(randomUUID()) };
            for (const [actionId, role, request] of [
                ['prompt_doc.create', 'create_instructions', contentWrite],
                ['session.instructions.set', 'attach_instructions', { method: 'PATCH',
                    path: `/v2/sessions/${sessionId}?extra=1`, body: ownerPatch, sessionRouteTarget }],
                ['memory.remember', 'memory:guide', contentWrite],
                ['skills.create', 'skill:guide', contentWrite],
                ['mcp.servers.create', 'create_template_mcp', { method: 'POST',
                    path: `${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}?extra=1`, body: McpServerCatalogRowMutationV1Schema.parse({
                        expectedRevision: 1, content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } },
                    }) }],
            ] as const) {
                const proof = { ...request, reviewedChild: child(actionId, role) };
                await expect(f.verify(author, proof, actionId), actionId).resolves.not.toBeNull();
                await expect(f.verify(other, proof, actionId), actionId).resolves.toBeNull();
            }

            const updateInput = { sessionRef: { serverId: 'home', sessionId },
                expectedVersion: '1.1.0', expectedMetadataRevision: 1 };
            const updateRoot = await f.mint('template.updates.apply', updateInput, true);
            const updateEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: updateRoot.binding.requestId,
                target: updateRoot.binding.target, input: updateInput });
            const updateResponse = await f.app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('template.updates.apply'),
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: { v: 1, machineId: f.machine.id,
                    envelope: updateEnvelope, templateRequesterSetupEnrichment: { authorization: updateRoot,
                        requesterAuthorship: 'requester' } } });
            expect(updateResponse.statusCode, updateResponse.body).toBe(200);
            const updateAuthor = ExternalActionExecutionAuthorizationV1Schema.parse(updateResponse.json());
            await expect(f.verify(updateAuthor, { method: 'PATCH', path: `/v2/sessions/${sessionId}?extra=1`,
                body: ownerPatch, sessionRouteTarget,
                reviewedChild: child('session.bot.face.set', 'update_face') }, 'session.bot.face.set'))
                .resolves.not.toBeNull();
            const artifactId = randomUUID();
            const report = { artifactId, copyId: sessionId, acceptedVersion: '1.1.0' };
            await expect(f.verify(updateAuthor, { method: 'PUT',
                path: `/v1/artifacts/${artifactId}/access/accepted-version?extra=1`, body: report,
                routeInput: { id: artifactId, ...report } })).resolves.not.toBeNull();
        } finally { await f.app.close(); }
    });

    it('keeps template metadata batch reads equivalent to their admitted detail reads', async () => {
        const f = await signedFixture();
        try {
            const sessionId = randomUUID();
            const body = { sessionIds: [sessionId], accessProjectionVersion: 1, includeSnapshot: true,
                includeTurns: false, includeMessages: false };
            for (const root of ['template.draft', 'template.instantiate', 'template.updates.diff',
                'template.updates.apply', 'template.updates.skip', 'template.follow.stop'] as const) {
                const authorization = await f.mint(root, {}, true);
                await expect(f.verify(authorization, { method: 'GET', path: `/v2/sessions/${sessionId}?accessProjectionVersion=1`,
                    sessionRouteTarget: { kind: 'session', sessionId } })).resolves.not.toBeNull();
                expect(await f.verify(authorization, { method: 'POST', path: '/v2/sessions/read-batch', body,
                    routeInput: body }), root).not.toBeNull();
            }
            for (const root of ['template.release', 'template.preview', 'template.export_file'] as const) {
                const authorization = await f.mint(root, {}, true);
                await expect(f.verify(authorization, { method: 'POST', path: '/v2/sessions/read-batch', body })).resolves.toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it('derives only the reviewed update Plan root from its retained Manage admission', async () => {
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const f = await signedFixture('template.updates.apply', [], false, custodian.id);
        try {
            const rootEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(),
                target: { kind: 'machine', machineId: f.machine.id }, input: { sessionRef: { serverId: 'home', sessionId: randomUUID() } } });
            const rootPath = bindExternalActionExecutionAuthorizationHttpPathV1('template.updates.apply');
            const rootResponse = await f.app.inject({ method: 'POST', url: rootPath, headers: { authorization: `Bearer ${f.pat.token}` },
                payload: { v: 1, machineId: f.machine.id, envelope: rootEnvelope, templateRequesterSetupAdmission: { kind: 'software' } } });
            expect(rootResponse.statusCode).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const plan = { homeId: root.binding.serverIdentityId, machineId: f.machine.id, mode: 'effects' as const };
            const planInputDigest = computeActionInputApprovalDigestV1('machines.setup.plan', plan);
            const enrichedResponse = await f.app.inject({ method: 'POST', url: rootPath, headers: { authorization: `Bearer ${f.pat.token}` },
                payload: { v: 1, machineId: f.machine.id, envelope: rootEnvelope,
                    templateRequesterSetupEnrichment: { authorization: root, planInputDigest } } });
            expect(enrichedResponse.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(enrichedResponse.json());
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id } }))).toMatchObject({ kind: 'removed' });
            expect((await f.app.inject({ method: 'POST', url: rootPath, headers: { authorization: `Bearer ${f.pat.token}` },
                payload: { v: 1, machineId: f.machine.id, envelope: { ...rootEnvelope, requestId: randomUUID() },
                    templateRequesterSetupAdmission: { kind: 'software' } } })).statusCode).not.toBe(200);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: rootEnvelope.requestId,
                target: rootEnvelope.target, input: plan });
            const derive = (candidate = envelope, original = rootEnvelope, parent = authorization) => f.app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.plan'),
                headers: { authorization: `Bearer ${f.pat.token}` }, payload: { v: 1, machineId: f.machine.id, envelope: candidate,
                    templateRequesterSetupPlanContinuation: { authorization: parent, originalActionEnvelope: original } } });
            const response = await derive();
            expect(response.statusCode).toBe(200);
            const native = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(native.binding).toMatchObject({
                actionId: 'machines.setup.plan', admittedMachineRole: 'manage', accountId: root.binding.accountId,
                templateRequesterSetupPlanAdmission: { parentActionId: 'template.updates.apply',
                    parentRequestEnvelopeDigest: root.binding.requestEnvelopeDigest, planInputDigest } });
            expect((await derive({ ...envelope, input: { ...plan, mode: 'check' } })).statusCode).not.toBe(200);
            expect((await derive(envelope, { ...rootEnvelope, requestId: randomUUID() })).statusCode).not.toBe(200);
            expect((await derive(envelope, rootEnvelope, root)).statusCode).not.toBe(200);
            await expect(f.verify(native, { method: 'GET', path: '/v1/account/encryption/currentness' })).resolves.not.toBeNull();
            const method = `${f.machine.id}:${RPC_METHODS.MACHINE_SETUP_PLAN}`;
            const requestId = randomUUID();
            const signPlan = (params: unknown, proof = native) => ({ v: 1 as const, authorization: proof, effectActionId: 'machines.setup.plan',
                target: proof.binding.target, installationId: proof.binding.installationId,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: proof.token,
                    effectActionId: 'machines.setup.plan', target: proof.binding.target, installationId: proof.binding.installationId,
                    method, requestId, params, privateKey: f.keyPair.secretKey }) });
            await expect(verifyExternalActionMachineRpcExecution(signPlan(plan, authorization), { method, requestId, params: plan,
                originalActionEnvelope: rootEnvelope })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution(signPlan(plan), { method, requestId, params: plan })).resolves.not.toBeNull();
            const changed = { ...plan, mode: 'check' };
            await expect(verifyExternalActionMachineRpcExecution(signPlan(changed), { method, requestId, params: changed })).resolves.toBeNull();
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true,
                operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
            const accepted = readAdmittedTemplateExecutionPrincipal(native.binding);
            const principal = accepted && projectExternalActionBoundPrincipal(native.binding, accepted);
            if (!principal) throw new Error('Derived Plan lost its captured requester');
            const dispatch = createExternalActionDaemonDispatcher({ io: new Server(),
                // Replace only the daemon RPC network; issuer, placement and retained admission stay real.
                forwardRpc: async ({ callParams }) => {
                    const packet = ExternalActionDaemonDispatchRequestSchema.parse(callParams);
                    return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                        v: 1, actionId: packet.actionId, requestId: packet.envelope.requestId,
                        execution: { ok: true, result: { planned: true } } })) };
                } });
            const dispatched = await dispatch({ actionId: 'machines.setup.plan', envelope, principal, executionAuthorization: native });
            expect(dispatched.kind).toBe('response');
            if (dispatched.kind !== 'response') throw new Error('The retained Plan did not reach its daemon');
            expect(JSON.parse(dispatched.prepared.body)).toMatchObject({ execution: { ok: true, result: { planned: true } } });
        } finally { await f.app.close(); }
    });

    it('prepares requester custody only from the selected Machine publication', async () => {
        const f = await signedFixture('template.instantiate');
        try {
            const authorization = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } });
            await expect(f.verify(authorization, { method: 'GET', path: `/v1/machines/${encodeURIComponent(f.machine.id)}`,
                routeInput: { id: f.machine.id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `/v1/machines/${randomUUID()}` })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/machines' })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('retains admitted template content after Machine role withdrawal while refusing a new root', async () => {
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const f = await signedFixture('template.instantiate', [], false, custodian.id);
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(),
                target: { kind: 'machine', machineId: f.machine.id }, input: { source: { kind: 'artifact', artifactId: randomUUID() } } });
            const mint = (requestId: string) => f.app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('template.instantiate'),
                headers: { authorization: `Bearer ${f.pat.token}` }, payload: { v: 1, machineId: f.machine.id,
                    envelope: { ...envelope, requestId }, templateRequesterSetupAdmission: { kind: 'software' } } });
            const admitted = await mint(envelope.requestId!);
            expect(admitted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(admitted.json());
            expect(authorization.binding.admittedMachineRole).toBe('manage');
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id } }))).toMatchObject({ kind: 'removed' });
            expect((await mint(randomUUID())).statusCode).not.toBe(200);
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()),
                reviewedChild: { actionId: 'skills.create', role: 'skill:reviewed', inputDigest: 'a'.repeat(43) } }, 'skills.create'))
                .resolves.not.toBeNull();
        } finally { await f.app.close(); }
    });

    it('seals prepared setup on the original Manage admission and verifies its exact installed Plan child', async () => {
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const f = await signedFixture('template.instantiate', [], false, custodian.id);
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(),
                target: { kind: 'machine', machineId: f.machine.id }, input: { source: { kind: 'artifact', artifactId: randomUUID() } } });
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('template.instantiate');
            const rootResponse = await f.app.inject({ method: 'POST', url: path,
                headers: { authorization: `Bearer ${f.pat.token}` }, payload: { v: 1, machineId: f.machine.id, envelope,
                    templateRequesterSetupAdmission: { kind: 'software' } } });
            expect(rootResponse.statusCode).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            expect(root.binding.admittedMachineRole).toBe('manage');
            const plan = { homeId: root.binding.serverIdentityId, machineId: f.machine.id, mode: 'effects' as const };
            const inputDigest = computeActionInputApprovalDigestV1('machines.setup.plan', plan);
            const enrichedResponse = await f.app.inject({ method: 'POST', url: path,
                headers: { authorization: `Bearer ${f.pat.token}` }, payload: { v: 1, machineId: f.machine.id, envelope,
                    templateRequesterSetupEnrichment: { authorization: root, planInputDigest: inputDigest } } });
            expect(enrichedResponse.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(enrichedResponse.json());
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id } }))).toMatchObject({ kind: 'removed' });
            const method = `${f.machine.id}:${RPC_METHODS.MACHINE_SETUP_PLAN}`;
            const requestId = randomUUID();
            const reviewedChild = { actionId: 'machines.setup.plan', role: 'template_setup_plan', inputDigest };
            const signed = { authorizationToken: authorization.token, effectActionId: 'machines.setup.plan',
                target: authorization.binding.target, installationId: authorization.binding.installationId, method, requestId,
                params: plan, reviewedChild };
            const execution = { v: 1 as const, authorization, effectActionId: signed.effectActionId, target: signed.target,
                installationId: signed.installationId, reviewedChild,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, privateKey: f.keyPair.secretKey }) };
            await expect(verifyExternalActionMachineRpcExecution(execution, { method, requestId, params: plan,
                originalActionEnvelope: envelope })).resolves.not.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution(execution, { method, requestId, params: { ...plan, mode: 'check' },
                originalActionEnvelope: envelope })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution({ ...execution, reviewedChild: { ...reviewedChild, role: 'other' } },
                { method, requestId, params: plan, originalActionEnvelope: envelope })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution(execution, { method, requestId, params: plan,
                originalActionEnvelope: { ...envelope, requestId: randomUUID() } })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('authenticates the template requester without a selected Machine signature and confines the root purpose', async () => {
        const f = await signedFixture('template.instantiate');
        try {
            const authorization = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } });
            const headers = { authorization: `Bearer ${f.presentUserToken}`,
                'x-happier-action-execution-authorization': authorization.token,
                'x-happier-action-effect': 'template.instantiate',
                'x-happier-action-target': encodeExternalActionResolvedTargetV1(authorization.binding.target) };
            const accepted = await f.app.inject({ method: 'GET', url: '/v1/features/authenticated', headers });
            expect(accepted.statusCode).toBe(200);
            const accountMode = await f.app.inject({ method: 'GET', url: '/v1/account/encryption', headers });
            expect(accountMode.statusCode, accountMode.body).toBe(200);
            expect(accountMode.json()).toMatchObject({ mode: 'plain' });
            expect((await f.app.inject({ method: 'GET', url: '/v1/account/encryption?extra=1', headers })).statusCode).toBe(403);
            await expect(f.verify(authorization, { method: 'GET', path: '/v2/account/settings' },
                'template.instantiate')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PATCH', path: '/v1/account/encryption',
                body: { mode: 'e2ee' } }, 'template.instantiate')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption',
                routeInput: {}, reviewedChild: { actionId: 'prompt_doc.create', role: 'create_instructions',
                    inputDigest: 'a'.repeat(43) } }, 'prompt_doc.create')).resolves.not.toBeNull();
            expect((await f.app.inject({ method: 'GET', url: '/v1/features/authenticated',
                headers: { ...headers, 'x-happier-action-effect': 'machines.setup.apply' } })).statusCode).toBe(403);
            expect((await f.app.inject({ method: 'GET', url: '/v1/features/authenticated',
                headers: { ...headers, authorization: 'Bearer invalid' } })).statusCode).toBe(401);
            const other = await signedFixture('template.instantiate');
            try {
                expect((await f.app.inject({ method: 'GET', url: '/v1/features/authenticated', headers: {
                    ...headers, authorization: `Bearer ${other.presentUserToken}` } })).statusCode).toBe(403);
            } finally { await other.app.close(); }
            const unrelated = await f.mint('template.preview', { source: { kind: 'artifact', artifactId: randomUUID() } }, true);
            expect((await f.app.inject({ method: 'GET', url: '/v1/features/authenticated', headers: { ...headers,
                'x-happier-action-execution-authorization': unrelated.token, 'x-happier-action-effect': 'template.preview' } })).statusCode).toBe(403);
        } finally { await f.app.close(); }
    });

    it.each(['artifact.public_link.create', 'artifact.public_link.list', 'artifact.public_link.revoke'] as const)(
        '%s spends only its signed-in link management phase', async actionId => {
            const f = await signedFixture(actionId);
            try {
                const artifactId = randomUUID();
                const lookupId = randomUUID();
                const input = { artifactId, audience: 'signed_in',
                    ...(actionId === 'artifact.public_link.revoke' ? { shareId: artifactId } : {}) };
                const authorization = await f.mint(actionId, input, actionId === 'artifact.public_link.create');
                const collection = '/v1/artifact-signed-in-links';
                const body = { artifactId, lookupId };
                const request = actionId === 'artifact.public_link.create'
                    ? { method: 'POST', path: collection, body, routeInput: body }
                    : actionId === 'artifact.public_link.list'
                        ? { method: 'GET', path: `${collection}?artifactId=${artifactId}`, routeInput: { artifactId } }
                        : { method: 'DELETE', path: `${collection}/${artifactId}`, routeInput: { artifactId } };
                await expect(f.verify(authorization, request)).resolves.not.toBeNull();
                await expect(f.verify(authorization, { method: 'GET', path: `/v1/artifacts/${artifactId}`,
                    routeInput: { id: artifactId } })).resolves.not.toBeNull();
                await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' })).resolves.not.toBeNull();
                await expect(f.verify(authorization, { ...request, method: 'PUT' })).resolves.toBeNull();
                await expect(f.verify(authorization, { ...request, routeInput: { artifactId: randomUUID() } })).resolves.toBeNull();
                await expect(f.verify(authorization, { ...request, path: `${request.path}${request.path.includes('?') ? '&' : '?'}extra=1` })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'POST', path: `${collection}/${lookupId}/join`, body: {} })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'POST', path: '/v1/public-shares',
                    body: { subject: { kind: 'artifact', id: artifactId }, lookupId, keyDerivation: 'fragment_v1' } })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `/v1/artifacts/${artifactId}/access/grants`,
                    body: { artifactId, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'admin' } })).resolves.toBeNull();
                await expect(f.verify(authorization, request, 'artifact.public_link.join')).resolves.toBeNull();
                if (actionId === 'artifact.public_link.create') {
                    const automation = await f.mint(actionId, input);
                    await expect(f.verify(automation, request)).resolves.toBeNull();
                    await expect(f.verify(authorization, { ...request, body: { ...body, unexpected: true } })).resolves.toBeNull();
                    await expect(f.verify(authorization, { ...request, body: { ...body, encryptedDataKey: 'sealed-key' },
                        routeInput: { ...body, encryptedDataKey: 'sealed-key' } })).resolves.not.toBeNull();
                }
                if (actionId === 'artifact.public_link.revoke') {
                    await expect(f.verify(authorization, { method: 'GET', path: `${collection}?artifactId=${artifactId}`,
                        routeInput: { artifactId } })).resolves.not.toBeNull();
                }
            } finally { await f.app.close(); }
        });

    it('signed-in join retains exact lookup preparation and self-envelope commit without grant or publication authority', async () => {
        const f = await signedFixture('artifact.public_link.join');
        try {
            const lookupId = randomUUID();
            const authorization = await f.mint('artifact.public_link.join', { lookupId });
            const path = `/v1/artifact-signed-in-links/${lookupId}/join`;
            const routeInput = { lookupId };
            await expect(f.verify(authorization, { method: 'GET', path, routeInput })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: {}, routeInput })).resolves.not.toBeNull();
            const recipientKey = tweetnacl.box.keyPair();
            const keyEnvelope = { recipientAccountId: f.account.id,
                encryptedDataKey: encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                    recipientPublicKey: recipientKey.publicKey, randomBytes: tweetnacl.randomBytes }))),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKey.publicKey) };
            await expect(f.verify(authorization, { method: 'POST', path, body: { keyEnvelope },
                routeInput: { ...routeInput, keyEnvelope } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { lookupId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: {}, routeInput: { lookupId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, body: {} })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}?lookupId=other` })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifact-signed-in-links/%ZZ/join' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path, body: {} })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: { recipientAccountId: f.account.id } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: { keyEnvelope: {} } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifact-signed-in-links',
                body: { artifactId: randomUUID(), lookupId } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifacts' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'artifact.get')).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('release spends its reviewed signed-in link child without anonymous, list, revoke or join authority', async () => {
        const f = await signedFixture('template.release');
        try {
            const artifactId = randomUUID();
            const authorization = await f.mint('template.release', { draftArtifactId: randomUUID(),
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
                share: { recipients: [], signedInLink: true } });
            const childInput = { artifactId, audience: 'signed_in', preserveExisting: true };
            const reviewedChild = { actionId: 'artifact.public_link.create', role: 'signed_in_link',
                inputDigest: computeActionInputApprovalDigestV1('artifact.public_link.create', childInput) };
            const body = { artifactId, lookupId: randomUUID(), preserveExisting: true };
            const path = '/v1/artifact-signed-in-links';
            await expect(f.verify(authorization, { method: 'POST', path, body, reviewedChild }, 'artifact.public_link.create')).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `/v1/artifacts/${artifactId}`, reviewedChild },
                'artifact.public_link.create')).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness', reviewedChild },
                'artifact.public_link.create')).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body }, 'artifact.public_link.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body, reviewedChild: { ...reviewedChild, role: 'unrelated' } },
                'artifact.public_link.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/public-shares', body: {
                subject: { kind: 'artifact', id: artifactId }, lookupId: body.lookupId, keyDerivation: 'fragment_v1' }, reviewedChild },
                'artifact.public_link.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}?artifactId=${artifactId}`, reviewedChild },
                'artifact.public_link.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'DELETE', path: `${path}/${artifactId}`, reviewedChild },
                'artifact.public_link.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/${body.lookupId}/join`, body: {}, reviewedChild },
                'artifact.public_link.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()), reviewedChild },
                'artifact.public_link.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `/v1/artifacts/${artifactId}/access/grants`,
                body: { artifactId, principal: { kind: 'team', teamId: 'cmvtemplate-team' }, accessLevel: 'view' }, reviewedChild },
                'artifact.public_link.create')).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['template.preview', 'template.export_file'] as const)('%s retains only its exact Artifact codec purposes on a restricted PAT', async actionId => {
        const f = await signedFixture(actionId);
        try {
            const id = randomUUID();
            const authorization = await f.mint(actionId, { source: { kind: 'artifact', serverId: 'home', artifactId: id },
                ...(actionId === 'template.export_file' ? { skillKey: 'guide', path: 'SKILL.md' } : {}) });
            const path = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}/access/grants`, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}/access/recipients`, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/access/key-envelopes`, body: {
                artifactId: id, expectedDataEncryptionKey: 'A'.repeat(140), recipientKeyEnvelopes: [],
            } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/features/authenticated' })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { id: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, body: {} })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}?extra=1` })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifacts' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(id) })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: updateBody })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'artifact.get')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'template.draft')).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('authenticates signed draft owner tuples but refuses legacy metadata and mixed bearer credentials', async () => {
        const f = await signedFixture('template.draft');
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerSessionPatchRoute(app);
        try {
            const ownerMetadata = { t: 'plain' as const, v: { v: 1 as const } };
            const sharedMetadata = JSON.stringify(projectSessionSharedMetadataV1({ metadata: {}, agentState: null }));
            for (const mode of ['owner', 'owner_migration'] as const) {
                const session = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(),
                    encryptionMode: 'plain', metadataLayoutVersion: mode === 'owner' ? 1 : 0,
                    metadata: mode === 'owner' ? sharedMetadata : '{}', metadataVersion: 0,
                    ownerMetadata: mode === 'owner' ? JSON.stringify(ownerMetadata) : null,
                    agentState: null, agentStateVersion: 0 } });
                const authorization = await f.mint('template.draft', { sourceSessionRef: { serverId: 'home', sessionId: session.id }, content }, true);
                const path = `/v2/sessions/${session.id}`;
                const body = SessionMetadataTuplePatchV1Schema.parse(mode === 'owner' ? {
                    mode, metadataLayoutVersion: 1, expectedOwnerMetadata: ownerMetadata, ownerMetadata,
                    sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 },
                } : {
                    mode, expectedAccountEncryptionMode: 'plain', expectedAccountContentPublicKeyFingerprint: null,
                    source: { metadataLayoutVersion: 0, metadata: { version: 0, ciphertext: '{}' }, ownerMetadata: null,
                        agentState: { version: 0, ciphertext: null } },
                    target: { metadataLayoutVersion: 1, sharedMetadata: { ciphertext: sharedMetadata }, ownerMetadata, agentState: { ciphertext: null } },
                });
                const headers = (payload: unknown) => ({
                    'x-happier-account-stored-content-protocol': '2',
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'template.draft',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: 'template.draft', target: authorization.binding.target,
                        installationId: f.machine.installationId!, requestId: authorization.binding.requestId,
                        method: 'PATCH', path, body: payload, privateKey: f.keyPair.secretKey }),
                });
                const mixed = await app.inject({ method: 'PATCH', url: path, headers: { ...headers(body), authorization: `Bearer ${f.presentUserToken}` }, payload: body });
                expect(mixed.statusCode, mixed.body).toBe(403);
                expect(mixed.json()).toEqual({ error: 'credential_scope_denied' });
                const legacy = { metadata: { ciphertext: '{}', expectedVersion: 0 } };
                const denied = await app.inject({ method: 'PATCH', url: path, headers: headers(legacy), payload: legacy });
                expect(denied.statusCode, denied.body).toBe(401);
                expect(denied.json()).toEqual({ error: 'invalid_token' });
                const accepted = await app.inject({ method: 'PATCH', url: path, headers: headers(body), payload: body });
                expect(accepted.statusCode, `${mode}: ${accepted.body}`).toBe(200);
                expect(accepted.json()).toMatchObject({ success: true, metadataLayoutVersion: 1 });
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
                    .toMatchObject({ metadataLayoutVersion: 1, metadataVersion: 1, ownerMetadata: JSON.stringify(ownerMetadata) });
            }
        } finally { await app.close(); await f.app.close(); }
    });

    it('draft retains Artifact publication and owner metadata CAS, with no grant or Session lifecycle effect', async () => {
        const sessionId = 'cmvtemplate-source';
        const f = await signedFixture('template.draft', [sessionId]);
        try {
            const id = randomUUID();
            const authorization = await f.mint('template.draft', { sourceSessionRef: { serverId: 'home', sessionId }, content });
            const artifactPath = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(id) })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: artifactPath, body: updateBody,
                routeInput: { id, ...updateBody } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: '/v1/artifacts', body: createBody(id) })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: { ...createBody(id), unexpected: true } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: artifactPath, body: { ...updateBody, unexpected: true } })).resolves.toBeNull();
            const sessionPath = `/v2/sessions/${sessionId}`;
            const sessionRouteTarget = { kind: 'session' as const, sessionId };
            await expect(f.verify(authorization, { method: 'GET', path: `${sessionPath}?accessProjectionVersion=1`, sessionRouteTarget })).resolves.not.toBeNull();
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: ownerPatch, sessionRouteTarget })).resolves.not.toBeNull();
            const migrationPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner_migration', expectedAccountEncryptionMode: 'plain',
                expectedAccountContentPublicKeyFingerprint: null,
                source: { metadataLayoutVersion: 0, metadata: { version: 0, ciphertext: '{}' }, ownerMetadata: null,
                    agentState: { version: 0, ciphertext: null } },
                target: { metadataLayoutVersion: 1, sharedMetadata: { ciphertext: '{}' }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                    agentState: { ciphertext: null } } });
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: migrationPatch, sessionRouteTarget })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: { mode: 'shared_editor', metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 } }, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${sessionPath}/archive`, body: {}, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${artifactPath}/access/grants`, body: {
                artifactId: id, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' } })).resolves.toBeNull();
            for (const principal of [{ kind: 'team', teamId: 'cmvtemplate-team' },
                { kind: 'group', teamId: 'cmvtemplate-team', groupId: 'cmvtemplate-group' }]) {
                await expect(f.verify(authorization, { method: 'PUT', path: `${artifactPath}/access/grants`, body: {
                    artifactId: id, principal, accessLevel: 'view' } })).resolves.toBeNull();
            }
            await expect(f.verify(authorization, { method: 'DELETE', path: artifactPath })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('instantiate retains source reads, private accepted-base creation and recipient owner metadata only', async () => {
        const sessionId = 'cmvtemplate-recipient';
        const f = await signedFixture('template.instantiate', [sessionId]);
        try {
            const id = randomUUID();
            const authorization = await f.mint('template.instantiate', {
                source: { kind: 'artifact', serverId: 'home', artifactId: id }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                creation: { creationKey: randomUUID(), executionTarget: { serverId: 'home', machineId: f.machine.id },
                    directory: { kind: 'path', path: '/work' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
            });
            const path = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}/access/grants`, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()) })).resolves.not.toBeNull();
            const sessionPath = `/v2/sessions/${sessionId}`;
            const sessionRouteTarget = { kind: 'session' as const, sessionId };
            await expect(f.verify(authorization, { method: 'GET', path: sessionPath, sessionRouteTarget })).resolves.not.toBeNull();
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: ownerPatch, sessionRouteTarget })).resolves.not.toBeNull();
            const birthChild = { actionId: 'session.spawn_new', role: 'create_bot',
                inputDigest: computeActionInputApprovalDigestV1('session.spawn_new', {}) };
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness', reviewedChild: birthChild },
                'session.spawn_new'), 'birth reads requester encryption currentness').resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()), reviewedChild: birthChild },
                'session.spawn_new')).resolves.toBeNull();
            for (const [actionId, role] of [
                ['prompt_doc.create', 'create_instructions'], ['session.instructions.set', 'attach_instructions'],
                ['memory.remember', 'memory:guide'], ['skills.create', 'skill:guide'],
            ] as const) {
                const reviewedChild = { actionId, role, inputDigest: computeActionInputApprovalDigestV1(actionId, {}) };
                const request = actionId === 'session.instructions.set'
                    ? { method: 'PATCH', path: sessionPath, body: ownerPatch, sessionRouteTarget }
                    : { method: 'POST', path: '/v1/artifacts', body: { ...createBody(randomUUID()), kind: deriveArtifactStoredKindV1({
                        kind: actionId === 'memory.remember' ? 'memory_doc.v1' : actionId === 'skills.create' ? 'prompt_bundle.v2' : 'prompt_doc.v2',
                    }) } };
                await expect(f.verify(authorization, { ...request, reviewedChild }, actionId), actionId).resolves.not.toBeNull();
                await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness', reviewedChild }, actionId),
                    `${actionId} metadata codec currentness`).resolves.not.toBeNull();
                if (actionId !== 'session.instructions.set') {
                    await expect(f.verify(authorization, { method: 'GET', path: PROMPT_LIBRARY_ROWS_ROUTE_V1, reviewedChild }, actionId)).resolves.not.toBeNull();
                    await expect(f.verify(authorization, { method: 'GET', path: `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/coding`, reviewedChild }, actionId)).resolves.not.toBeNull();
                    const update = f.verify(authorization, { method: 'POST', path, body: updateBody, reviewedChild }, actionId);
                    if (actionId === 'memory.remember') await expect(update).resolves.not.toBeNull();
                    else await expect(update).resolves.toBeNull();
                }
                if (actionId === 'memory.remember' || actionId === 'skills.create') {
                    await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: ownerPatch, sessionRouteTarget,
                        reviewedChild }, actionId)).resolves.not.toBeNull();
                }
                await expect(f.verify(authorization, request, actionId), `${actionId} without admitted child`).resolves.toBeNull();
                await expect(f.verify(authorization, { ...request, reviewedChild: { ...reviewedChild, role: 'unrelated' } }, actionId)).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'POST', path: `${sessionPath}/archive`, body: {}, sessionRouteTarget,
                    reviewedChild }, actionId)).resolves.toBeNull();
            }
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifacts' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: updateBody })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: {
                artifactId: id, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: { mode: 'shared_editor', metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 } }, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${sessionPath}/archive`, body: {}, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'artifact.get')).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['template.updates.diff', 'template.updates.apply', 'template.updates.skip', 'template.follow.stop'] as const)(
        '%s retains its own read or owner-mutation scope without spending sibling effects', async actionId => {
        const sessionId = 'cmvtemplate-update-recipient';
        const f = await signedFixture(actionId, [sessionId]);
        try {
            const authorization = await f.mint(actionId, { sessionRef: { serverId: 'home', sessionId },
                ...(actionId === 'template.updates.apply' ? { expectedVersion: '1.1.0', expectedMetadataRevision: 1 } : {}),
                ...(actionId === 'template.updates.skip' ? { version: '1.1.0' } : {}) });
            const path = `/v2/sessions/${sessionId}`;
            const sessionRouteTarget = { kind: 'session' as const, sessionId };
            await expect(f.verify(authorization, { method: 'GET', path, sessionRouteTarget })).resolves.not.toBeNull();
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            const mutation = f.verify(authorization, { method: 'PATCH', path, body: ownerPatch, sessionRouteTarget });
            if (actionId === 'template.updates.diff') await expect(mutation).resolves.toBeNull();
            else await expect(mutation).resolves.not.toBeNull();
            const artifactId = randomUUID();
            const read = f.verify(authorization, { method: 'GET', path: `/v1/artifacts/${artifactId}`, routeInput: { id: artifactId } });
            if (actionId === 'template.updates.diff' || actionId === 'template.updates.apply') await expect(read).resolves.not.toBeNull();
            else await expect(read).resolves.toBeNull();
            const create = f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()) });
            if (actionId === 'template.updates.apply') await expect(create).resolves.not.toBeNull();
            else await expect(create).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `/v1/artifacts/${artifactId}`, body: updateBody })).resolves.toBeNull();
            const cleanup = f.verify(authorization, { method: 'DELETE', path: `/v1/artifacts/${artifactId}`, routeInput: { id: artifactId } });
            if (actionId === 'template.updates.apply') await expect(cleanup).resolves.not.toBeNull();
            else await expect(cleanup).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/archive`, body: {}, sessionRouteTarget })).resolves.toBeNull();
            if (actionId === 'template.updates.apply') {
                for (const [childId, role] of [['prompt_doc.update', 'update_instructions'], ['skills.updates.apply', 'skill:guide']] as const) {
                    const reviewedChild = { actionId: childId, role, inputDigest: computeActionInputApprovalDigestV1(childId, {}) };
                    const request = { method: 'POST', path: `/v1/artifacts/${artifactId}`, body: updateBody };
                    await expect(f.verify(authorization, { ...request, reviewedChild }, childId)).resolves.not.toBeNull();
                    await expect(f.verify(authorization, request, childId)).resolves.toBeNull();
                    await expect(f.verify(authorization, { ...request, reviewedChild: { ...reviewedChild, role: 'unrelated' } }, childId)).resolves.toBeNull();
                }
            }
        } finally { await f.app.close(); }
    });

    it('reviewed MCP children spend only catalog and Session capability effects', async () => {
        const sessionId = 'cmvtemplate-mcp-recipient';
        const f = await signedFixture('template.instantiate', [sessionId]);
        try {
            const authorization = await f.mint('template.instantiate', {
                source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                creation: { creationKey: randomUUID(), executionTarget: { serverId: 'home', machineId: f.machine.id },
                    directory: { kind: 'path', path: '/work' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
            });
            const child = (actionId: 'mcp.servers.list' | 'mcp.servers.create' | 'session.capabilities.set', role: string) => ({
                actionId, role, inputDigest: computeActionInputApprovalDigestV1(actionId, {}),
            });
            const read = { method: 'GET', path: MCP_SERVER_CATALOG_ROWS_ROUTE_V1 };
            await expect(f.verify(authorization, { ...read, reviewedChild: child('mcp.servers.list', 'template_mcp_catalog') }, 'mcp.servers.list')).resolves.not.toBeNull();
            await expect(f.verify(authorization, read, 'mcp.servers.list')).resolves.toBeNull();
            const body = McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: 1,
                content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } });
            const write = { method: 'POST', path: MCP_SERVER_CATALOG_ROWS_ROUTE_V1, body };
            await expect(f.verify(authorization, { ...write, reviewedChild: child('mcp.servers.create', 'create_template_mcp') }, 'mcp.servers.create')).resolves.not.toBeNull();
            await expect(f.verify(authorization, { ...write, reviewedChild: child('mcp.servers.list', 'template_mcp_catalog') }, 'mcp.servers.list')).resolves.toBeNull();
            await expect(f.verify(authorization, { ...write, body: { ...body, unexpected: true },
                reviewedChild: child('mcp.servers.create', 'create_template_mcp') }, 'mcp.servers.create')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()),
                reviewedChild: child('mcp.servers.create', 'create_template_mcp') }, 'mcp.servers.create')).resolves.toBeNull();
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            await expect(f.verify(authorization, { method: 'PATCH', path: `/v2/sessions/${sessionId}`, body: ownerPatch,
                sessionRouteTarget: { kind: 'session', sessionId }, reviewedChild: child('session.capabilities.set', 'template_mcp:github') },
                'session.capabilities.set')).resolves.not.toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['template.instantiate', 'template.updates.apply', 'template.preview'] as const)(
        '%s spends only its exact closed accepted-version report purpose', async actionId => {
        const sessionId = 'cmvtemplate-accepted-report';
        const f = await signedFixture(actionId, [sessionId]);
        try {
            const source = { kind: 'artifact', serverId: 'home', artifactId: randomUUID() };
            const authorization = await f.mint(actionId, actionId === 'template.updates.apply'
                ? { sessionRef: { serverId: 'home', sessionId }, expectedVersion: '1.1.0', expectedMetadataRevision: 1 }
                : actionId === 'template.preview' ? { source }
                : { source, expectedVersion: '1.0.0', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                    creation: { creationKey: randomUUID(), executionTarget: { serverId: 'home', machineId: f.machine.id },
                        directory: { kind: 'path', path: '/work' },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } });
            const body = { artifactId: source.artifactId, copyId: sessionId, acceptedVersion: '1.0.0' };
            const request = { method: 'PUT', path: `/v1/artifacts/${body.artifactId}/access/accepted-version`,
                body, routeInput: { id: body.artifactId, ...body } };
            const accepted = f.verify(authorization, request);
            if (actionId === 'template.preview') await expect(accepted).resolves.toBeNull();
            else await expect(accepted).resolves.not.toBeNull();
            await expect(f.verify(authorization, { ...request, body: { ...body, unexpected: true } })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, body: { ...body, artifactId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, routeInput: { ...request.routeInput, id: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, path: `${request.path}?extra=1` })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, method: 'POST' })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('release retains Account, Team and Group Can-copy grants and key delivery, excluding edit, anonymous links and removal', async () => {
        const f = await signedFixture('template.release');
        try {
            const id = randomUUID();
            const authorization = await f.mint('template.release', { draftArtifactId: randomUUID(),
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
                share: { recipients: [{ kind: 'account', accountId: f.account.id }, { kind: 'team', teamId: 'cmvtemplate-team' },
                    { kind: 'group', teamId: 'cmvtemplate-team', groupId: 'cmvtemplate-group' }] } });
            const path = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(id) })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: updateBody })).resolves.not.toBeNull();
            const grant = { artifactId: id, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' };
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: grant,
                routeInput: { id, ...grant } })).resolves.not.toBeNull();
            const commit = { artifactId: id, expectedDataEncryptionKey: 'A'.repeat(140), recipientKeyEnvelopes: [] };
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/access/key-envelopes`, body: commit })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/access/key-envelopes`, body: { ...commit, artifactId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: { ...grant, accessLevel: 'edit' } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: { ...grant, accessLevel: 'admin' } })).resolves.toBeNull();
            for (const principal of [{ kind: 'team', teamId: 'cmvtemplate-team' },
                { kind: 'group', teamId: 'cmvtemplate-team', groupId: 'cmvtemplate-group' }]) {
                const sharedGrant = { ...grant, principal };
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: sharedGrant,
                    routeInput: { id, ...sharedGrant } })).resolves.not.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`,
                    body: { ...sharedGrant, artifactId: randomUUID() } })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: sharedGrant,
                    routeInput: { id: randomUUID(), ...sharedGrant } })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: sharedGrant },
                    'artifact.public_link.create')).resolves.toBeNull();
            }
            await expect(f.verify(authorization, { method: 'DELETE', path: `${path}/access/grants`, body: grant })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/public-shares', body: { subjectKind: 'artifact', subjectId: id } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts/content/binary', body: createBody(id) })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });
});
