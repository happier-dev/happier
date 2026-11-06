import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { randomBytes, randomUUID } from 'node:crypto';
import { encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { decodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { withSessionInputRequestV1, SESSION_MESSAGE_PROVENANCE_META_KEY, SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { inTx } from '@/storage/inTx';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createSignedDiscussionHttpFixture } from './discussionExecutionAuthorization.testkit';

describe('requester template birth and asleep onboarding', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-requester-birth-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        await getOrCreateServerIdentityId();
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it.each([
        { credential: 'present_user', mode: 'plain', sharedMachine: false, withdrawGrantAfterAdmission: false },
        { credential: 'scoped_pat', mode: 'plain', sharedMachine: false, withdrawGrantAfterAdmission: false },
        { credential: 'present_user', mode: 'e2ee', sharedMachine: false, withdrawGrantAfterAdmission: false },
        { credential: 'present_user', mode: 'plain', sharedMachine: true, withdrawGrantAfterAdmission: false },
        { credential: 'present_user', mode: 'plain', sharedMachine: true, withdrawGrantAfterAdmission: true },
    ] as const)('commits one requester-owned birth and one host input without a selected Machine signature ($credential/$mode, shared Machine: $sharedMachine, withdrawn grant: $withdrawGrantAfterAdmission)', async ({ credential, mode, sharedMachine, withdrawGrantAfterAdmission }) => {
        const custodian = sharedMachine ? await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } }) : null;
        const f = await createSignedDiscussionHttpFixture('template.instantiate', [], false, custodian?.id, { pending: true });
        try {
            const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(17) };
            const dataKeyPublicKey = tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
            const encryptedMachineKey = mode === 'e2ee' ? createMachineDataEncryptionKeyV1({
                material, dataKeyPublicKey, randomBytes,
            }) : null;
            if (encryptedMachineKey) {
                await db.account.update({ where: { id: f.account.id }, data: {
                    encryptionMode: 'e2ee', ...createSignedAccountContentBinding(dataKeyPublicKey),
                } });
                await db.machine.update({ where: { id: f.machine.id }, data: {
                    metadata: 'opaque-machine', dataEncryptionKey: new Uint8Array(encryptedMachineKey.dataEncryptionKey),
                } });
            }
            await db.machine.update({ where: { id: f.machine.id }, data: { active: false,
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] }, sessionSpawn: { protocolVersions: [1, 2, 3, 4] } },
                operationProtocolCapabilitiesRevision: 1 } });
            const creationKey = randomUUID();
            const input = { source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                creation: { creationKey, executionTarget: { serverId: 'home', machineId: f.machine.id }, directory: { kind: 'managed' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, permissionMode: 'read-only' } };
            const headers = { authorization: `Bearer ${credential === 'present_user' ? f.presentUserToken : f.pat.token}`, 'content-type': 'application/json',
                'x-happier-account-stored-content-protocol': '2' };
            const requestId = randomUUID();
            const target = { kind: 'machine' as const, machineId: f.machine.id };
            const originalActionEnvelope = encryptedMachineKey === null
                ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input })
                : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: await getOrCreateServerIdentityId(),
                    accountId: f.account.id, actionId: 'template.instantiate', requestId, target,
                    authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch } }, input,
                    material: { type: 'dataKey', machineKey: encryptedMachineKey.encryptionKey }, randomBytes });
            const issued = await f.app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('template.instantiate'),
                headers, payload: { v: 1, machineId: f.machine.id, envelope: originalActionEnvelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            if (withdrawGrantAfterAdmission) {
                expect(await inTx(tx => removeMachineAccessGrantInTx(tx, {
                    actorAccountId: f.machine.accountId, machineId: f.machine.id,
                    principal: { kind: 'account', accountId: f.account.id },
                }))).toMatchObject({ kind: 'removed' });
            }
            const creationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey });
            const birth = { tag: creationTag, metadataLayoutVersion: 1, encryptionMode: mode,
                sharedMetadata: { ciphertext: mode === 'plain' ? JSON.stringify({ v: 1 }) : 'opaque-shared' },
                ownerMetadata: mode === 'plain' ? { t: 'plain', v: { v: 1 } } : sealSessionOwnerMetadataEnvelopeV1({
                    ownerMetadata: { v: 1 }, material, randomBytes,
                }),
                dataEncryptionKey: encryptedMachineKey === null ? null : encodeBase64(new Uint8Array(encryptedMachineKey.dataEncryptionKey)),
                templateRequesterAuthorization: { authorization, originalActionEnvelope } };
            if (credential === 'present_user' && mode === 'plain' && !sharedMachine) {
                await db.machine.update({ where: { id: f.machine.id }, data: { installationId: randomUUID() } });
                const replacedTarget = await f.app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: birth });
                expect(replacedTarget.statusCode, replacedTarget.body).toBe(403);
                expect(replacedTarget.json()).toMatchObject({ error: 'credential_scope_denied' });
                expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(0);
                await db.machine.update({ where: { id: f.machine.id }, data: { installationId: f.machine.installationId } });
            }
            const created = await f.app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: birth });
            expect(created.statusCode, created.body).toBe(200);
            const sessionId = String(created.json().session.id);
            const encoded = created.headers[TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1];
            expect(typeof encoded).toBe('string');
            const boundAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(decodeTemplateBirthExecutionAuthorizationV1(String(encoded)));
            expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                accountId: f.account.id, sessionId, machineId: f.machine.id,
            } } })).not.toBeNull();
            const localId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: creationTag });
            const request = { v: 1, sessionId, targetMachineId: f.machine.id, localId,
                requestedAction: { v: 1, kind: 'send_now' }, ...(mode === 'e2ee' ? { requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) } } : {}),
                content: mode === 'e2ee' ? { t: 'encrypted', c: 'opaque-onboarding' } : { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Introduce yourself.' },
                    meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: 'host', producer: 'hostOnboarding' } },
                        { v: 1, producer: 'hostOnboarding', caller: { kind: 'host' }, permission: {} }) } } };
            const enqueue = (candidate: unknown = request, proof: unknown = boundAuthorization, candidateHeaders = headers) => f.app.inject({ method: 'POST',
                url: `/v2/sessions/${sessionId}/pending/template-onboarding`, headers: candidateHeaders,
                payload: { authorization: proof, originalActionEnvelope, request: candidate } });
            if (withdrawGrantAfterAdmission) {
                const ordinary = await f.app.inject({ method: 'POST', url: `/v2/sessions/${sessionId}/pending`, headers,
                    payload: { localId: 'ordinary-input', targetMachineId: f.machine.id,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'New work.' } } },
                        requestedAction: { v: 1, kind: 'send_now' } } });
                expect(ordinary.statusCode, ordinary.body).toBe(404);
                expect(ordinary.json()).toMatchObject({ code: 'session_input_target_unavailable' });
            }
            const accepted = await enqueue();
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json(), accepted.body).toMatchObject({ v: 1, result: { status: 'accepted', localId } });
            expect((await enqueue()).json()).toMatchObject({ v: 1, result: { status: 'alreadyAccepted', localId } });
            expect((await enqueue({ ...request, localId: 'other-input' })).statusCode).toBe(403);
            expect((await enqueue({ ...request, targetMachineId: randomUUID() })).statusCode).toBe(403);
            expect((await enqueue({ ...request, requestedAction: { v: 1, kind: 'enqueue' } })).statusCode).toBe(403);
            expect((await enqueue({ ...request, reply: { mode: 'wait' } })).statusCode).toBe(400);
            expect((await enqueue(request, authorization)).statusCode).toBe(403);
            const foreign = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await enqueue(request, boundAuthorization, { ...headers, authorization: `Bearer ${foreignToken}` })).statusCode).toBe(403);
            await db.session.update({ where: { id: sessionId }, data: { tag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: randomUUID() }) } });
            expect((await enqueue()).statusCode).toBe(403);
            await db.session.update({ where: { id: sessionId }, data: { tag: creationTag } });
            await db.machine.update({ where: { id: f.machine.id }, data: { installationId: randomUUID() } });
            expect((await enqueue()).statusCode).toBe(403);
            await db.machine.update({ where: { id: f.machine.id }, data: { installationId: f.machine.installationId } });
            const pending = await db.sessionPendingMessage.findMany({ where: { sessionId } });
            expect(pending).toHaveLength(1);
            expect(pending[0]?.inputAdmissionReceipt).toMatchObject({ issuer: 'authenticatedAccount', actorAccountId: f.account.id,
                admittedTarget: { sessionId, machineId: f.machine.id } });
            if (withdrawGrantAfterAdmission) {
                const receipt = SessionInputAdmissionReceiptV1Schema.parse(pending[0]?.inputAdmissionReceipt);
                if (!receipt.admittedTarget) throw new Error('Expected the accepted target placement');
                await db.session.update({ where: { id: sessionId }, data: { runtimeMachineTarget: receipt.admittedTarget } });
                expect((await enqueue()).json()).toMatchObject({ result: { status: 'alreadyAccepted', localId } });
            }
            await db.session.update({ where: { id: sessionId }, data: { archivedAt: new Date() } });
            expect((await enqueue()).json()).toMatchObject({ result: { status: 'rejected', code: 'session_input_archived' } });
            const rejoined = await f.app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: birth });
            expect(rejoined.statusCode, rejoined.body).toBe(200);
            expect(rejoined.json()).toMatchObject({ created: false, session: { id: sessionId } });
            expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).archivedAt).not.toBeNull();
            expect(await db.session.count({ where: { accountId: f.account.id, tag: creationTag } })).toBe(1);
        } finally { await f.app.close(); }
    });

    it('rejects a malformed requester creation tag before committing a Session', async () => {
        const f = await createSignedDiscussionHttpFixture('template.instantiate', [], false, undefined, { pending: true });
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: false,
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] }, sessionSpawn: { protocolVersions: [1, 2, 3, 4] } },
                operationProtocolCapabilitiesRevision: 1 } });
            const input = { source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, creation: { creationKey: randomUUID(),
                    executionTarget: { serverId: 'home', machineId: f.machine.id }, directory: { kind: 'managed' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, permissionMode: 'read-only' } };
            const authorization = await f.mint('template.instantiate', input, true);
            const originalActionEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1,
                requestId: authorization.binding.requestId, target: authorization.binding.target, input });
            const created = await f.app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { authorization: `Bearer ${f.presentUserToken}`, 'x-happier-account-stored-content-protocol': '2' },
                payload: { tag: 'caller-chosen', metadataLayoutVersion: 1, encryptionMode: 'plain',
                    sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) }, ownerMetadata: { t: 'plain', v: { v: 1 } }, dataEncryptionKey: null,
                    templateRequesterAuthorization: { authorization, originalActionEnvelope } } });
            expect(created.statusCode, created.body).toBe(400);
            expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(0);
        } finally { await f.app.close(); }
    });
});
