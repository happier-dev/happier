import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { withSessionInputRequestV1, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { buildSessionOrganizationAssignmentSnapshotHttpRequestV1 } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { inTx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { createSignedDiscussionHttpFixture } from './discussionExecutionAuthorization.testkit';
import { createExternalActionAuthorizedRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';

describe('ordinary Session birth and owner-only onboarding', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-requester-birth-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        await getOrCreateServerIdentityId();
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it('admits owner-only onboarding after ordinary bearer birth without a requester root', async () => {
        const f = await createSignedDiscussionHttpFixture('template.instantiate', [], false, undefined, { pending: true });
        try {
            const headers = { authorization: `Bearer ${f.presentUserToken}`,
                'x-happier-account-stored-content-protocol': '2' };
            const creationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: randomUUID() });
            const birth = await f.app.inject({ method: 'POST', url: '/v1/sessions', headers,
                payload: { tag: creationTag, metadataLayoutVersion: 1, encryptionMode: 'plain',
                    sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
                    ownerMetadata: { t: 'plain', v: { v: 1 } }, dataEncryptionKey: null } });
            expect(birth.statusCode, birth.body).toBe(200);
            const sessionId = String(birth.json().session.id);
            await db.machine.update({ where: { id: f.machine.id }, data: {
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.account.id,
                sessionId, machineId: f.machine.id, data: `session-machine-control:${randomUUID()}` })))
                .toMatchObject({ ok: true });
            const request = { v: 1, sessionId, targetMachineId: f.machine.id,
                localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: creationTag }),
                requestedAction: { v: 1, kind: 'send_now' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Introduce yourself.' },
                    meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: 'host', producer: 'hostOnboarding' } },
                        { v: 1, producer: 'hostOnboarding', caller: { kind: 'host' }, permission: {} }) } } };
            const url = `/v2/sessions/${sessionId}/pending/template-onboarding`;
            const enqueue = (bearer: string, candidate: unknown = request) => f.app.inject({ method: 'POST', url,
                headers: { authorization: `Bearer ${bearer}` }, payload: { request: candidate } });
            const accepted = await enqueue(f.presentUserToken);
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toMatchObject({ result: { status: 'accepted', localId: request.localId } });
            expect((await enqueue(f.presentUserToken)).json()).toMatchObject({ result: { status: 'alreadyAccepted' } });
            const other = await db.account.create({ data: { encryptionMode: 'plain' } });
            const otherToken = await auth.createToken(other.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await enqueue(otherToken)).json()).toMatchObject({ result: {
                status: 'rejected', code: 'session_input_target_unavailable' } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId, createdByAccountId: f.account.id,
                accountId: other.id, accessLevel: 'edit' } });
            expect((await enqueue(otherToken)).json()).toMatchObject({ result: {
                status: 'rejected', code: 'session_input_target_unavailable' } });
            expect((await enqueue(f.presentUserToken, { ...request, targetMachineId: randomUUID() })).json())
                .toMatchObject({ result: { status: 'rejected', code: 'session_input_target_unavailable' } });
        } finally { await f.app.close(); }
    });

    it('admits restricted PAT Copy through ordinary birth, AccessKey and owner-only Pending', async () => {
        const f = await createSignedDiscussionHttpFixture('template.instantiate', [], false, undefined,
            { pending: true, sessionLookup: true, sessionOrganization: true, sessionDetail: true });
        try {
            const creationKey = randomUUID();
            const tag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey });
            const authorization = await f.mint('template.instantiate', {
                source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() },
                expectedVersion: '1.0.0', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                creation: { creationKey, executionTarget: { serverId: 'home', machineId: f.machine.id },
                    directory: { kind: 'path', path: '/work' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
            });
            const signedHeaders = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
                createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: 'template.instantiate',
                    target: authorization.binding.target, installationId: f.machine.installationId!,
                    privateKey: f.keyPair.secretKey, method, path,
                    ...(body === undefined ? {} : { body }) });
            const birthBody = { tag, metadataLayoutVersion: 1, encryptionMode: 'plain',
                sharedMetadata: { ciphertext: '{"v":1}' }, ownerMetadata: { t: 'plain', v: { v: 1 } }, dataEncryptionKey: null };
            const birth = await f.app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { ...signedHeaders('POST', '/v1/sessions', birthBody),
                    'x-happier-account-stored-content-protocol': '2' }, payload: birthBody });
            expect(birth.statusCode, birth.body).toBe(200);
            expect((await f.app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { authorization: `Bearer ${f.pat.token}`,
                    'x-happier-account-stored-content-protocol': '2' }, payload: birthBody })).statusCode).toBe(403);
            const sessionId = String(birth.json().session.id);
            const lookupBody = { tags: [tag] };
            const lookupPath = '/v2/sessions/lookup-by-tags';
            const lookup = await f.app.inject({ method: 'POST', url: lookupPath,
                headers: { ...signedHeaders('POST', lookupPath, lookupBody),
                    'x-happier-account-stored-content-protocol': '2' }, payload: lookupBody });
            expect(lookup.statusCode, lookup.body).toBe(200);
            expect(lookup.json()).toMatchObject({ sessions: [{ id: sessionId }] });
            const broadLookupBody = { tags: [tag, randomUUID()] };
            expect((await f.app.inject({ method: 'POST', url: lookupPath,
                headers: signedHeaders('POST', lookupPath, broadLookupBody), payload: broadLookupBody })).statusCode).toBe(401);
            const placementRequest = buildSessionOrganizationAssignmentSnapshotHttpRequestV1([sessionId]);
            const placement = await f.app.inject({ method: 'GET', url: placementRequest.path,
                headers: { ...signedHeaders('GET', placementRequest.path),
                    'x-happier-account-stored-content-protocol': '2' } });
            expect(placement.statusCode, placement.body).toBe(200);
            expect(placement.json()).toMatchObject({ snapshot: { folderAssignments: [], tagAssignments: [] } });
            const broadPlacementPath = '/v2/session-organization?includeFolders=true';
            expect((await f.app.inject({ method: 'GET', url: broadPlacementPath,
                headers: signedHeaders('GET', broadPlacementPath) })).statusCode).toBe(401);
            const keyPath = `/v1/access-keys/${sessionId}/${f.machine.id}`;
            expect((await f.app.inject({ method: 'GET', url: keyPath,
                headers: signedHeaders('GET', keyPath) })).statusCode).toBe(200);
            const keyBody = { data: `session-machine-control:${randomUUID()}` };
            expect((await f.app.inject({ method: 'POST', url: keyPath,
                headers: signedHeaders('POST', keyPath, keyBody), payload: keyBody })).statusCode).toBe(200);
            const sessionPath = `/v2/sessions/${sessionId}`;
            const detail = await f.app.inject({ method: 'GET', url: sessionPath,
                headers: { ...signedHeaders('GET', sessionPath),
                    'x-happier-account-stored-content-protocol': '2' } });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json()).toMatchObject({ session: { id: sessionId } });
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{"v":1}', expectedVersion: 0 },
                agentState: { ciphertext: null, expectedVersion: 0 } });
            const patch = await f.app.inject({ method: 'PATCH', url: sessionPath,
                headers: { ...signedHeaders('PATCH', sessionPath, ownerPatch),
                    'x-happier-account-stored-content-protocol': '2' }, payload: ownerPatch });
            expect(patch.statusCode, patch.body).toBe(200);
            const otherMachineKeyPath = `/v1/access-keys/${sessionId}/${randomUUID()}`;
            expect((await f.app.inject({ method: 'GET', url: otherMachineKeyPath,
                headers: signedHeaders('GET', otherMachineKeyPath) })).statusCode).toBe(401);
            expect((await f.app.inject({ method: 'POST', url: otherMachineKeyPath,
                headers: signedHeaders('POST', otherMachineKeyPath, keyBody), payload: keyBody })).statusCode).toBe(401);
            await db.machine.update({ where: { id: f.machine.id }, data: {
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const unrelatedTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: randomUUID() });
            const unrelatedBirth = await f.app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { authorization: `Bearer ${f.presentUserToken}`,
                    'x-happier-account-stored-content-protocol': '2' },
                payload: { ...birthBody, tag: unrelatedTag } });
            expect(unrelatedBirth.statusCode, unrelatedBirth.body).toBe(200);
            const unrelatedSessionId = String(unrelatedBirth.json().session.id);
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.account.id,
                sessionId: unrelatedSessionId, machineId: f.machine.id,
                data: `session-machine-control:${randomUUID()}` }))).toMatchObject({ ok: true });
            const unrelatedPendingPath = `/v2/sessions/${unrelatedSessionId}/pending/template-onboarding`;
            const unrelatedRequest = { v: 1, sessionId: unrelatedSessionId, targetMachineId: f.machine.id,
                localId: randomUUID(), requestedAction: { v: 1, kind: 'send_now' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Unrelated input.' } } } };
            const unrelatedBody = { request: unrelatedRequest };
            expect((await f.app.inject({ method: 'POST', url: unrelatedPendingPath,
                headers: signedHeaders('POST', unrelatedPendingPath, unrelatedBody), payload: unrelatedBody })).statusCode).toBe(401);
            const request = { v: 1, sessionId, targetMachineId: f.machine.id,
                localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: tag }),
                requestedAction: { v: 1, kind: 'send_now' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Introduce yourself.' },
                    meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: 'host', producer: 'hostOnboarding' } },
                        { v: 1, producer: 'hostOnboarding', caller: { kind: 'host' }, permission: {} }) } } };
            const pendingPath = `/v2/sessions/${sessionId}/pending/template-onboarding`;
            const pendingBody = { request };
            const pending = await f.app.inject({ method: 'POST', url: pendingPath,
                headers: signedHeaders('POST', pendingPath, pendingBody), payload: pendingBody });
            expect(pending.statusCode, pending.body).toBe(200);
            expect(pending.json()).toMatchObject({ result: { status: 'accepted' } });
            const offMachineBody = { request: { ...request, targetMachineId: randomUUID(), localId: randomUUID() } };
            expect((await f.app.inject({ method: 'POST', url: pendingPath,
                headers: signedHeaders('POST', pendingPath, offMachineBody), payload: offMachineBody })).statusCode).toBe(401);
            const other = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const otherToken = await auth.createToken(other.id, undefined, { kind: 'account', authority: 'present_user' });
            const otherBirth = await f.app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { authorization: `Bearer ${otherToken}`,
                    'x-happier-account-stored-content-protocol': '2' },
                payload: { ...birthBody, tag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user',
                    creationKey: randomUUID() }) } });
            expect(otherBirth.statusCode, otherBirth.body).toBe(200);
            const otherSessionId = String(otherBirth.json().session.id);
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: otherSessionId, createdByAccountId: other.id,
                accountId: f.account.id, accessLevel: 'edit' } });
            const foreignBody = { request: { ...request, sessionId: otherSessionId, localId: randomUUID() } };
            const foreignPath = `/v2/sessions/${otherSessionId}/pending/template-onboarding`;
            const foreign = await f.app.inject({ method: 'POST', url: foreignPath,
                headers: signedHeaders('POST', foreignPath, foreignBody), payload: foreignBody });
            expect(foreign.statusCode, foreign.body).toBe(401);
        } finally { await f.app.close(); }
    });


});
