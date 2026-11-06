import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { randomBytes, randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createTemplateRequesterExecutionHttpHeadersV1, decodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { materializeSessionInitialAccessCreateFields } from '@happier-dev/protocol/sessions';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { db } from '@/storage/db';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createSignedDiscussionHttpFixture } from './discussionExecutionAuthorization.testkit';

describe('template initial access signed HTTP purposes', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-initial-access-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        await getOrCreateServerIdentityId();
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it('admits requester template batch reads while retaining Artifact access and exact read grammar', async () => {
        const f = await createSignedDiscussionHttpFixture('template.instantiate', [], false, undefined, { artifactReads: true });
        try {
            const author = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
            const createArtifact = () => db.artifact.create({ data: { id: randomUUID(), accountId: author.id,
                kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
                header: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({ kind: 'bot_template.v1' }))),
                body: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({ body: 'released template' }))),
                dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)), headerVersion: 1, bodyVersion: 1 } });
            const source = await createArtifact();
            const privateArtifact = await createArtifact();
            await db.artifactAccountGrant.create({ data: { artifactId: source.id, accountId: f.account.id,
                accessLevel: 'view', createdByAccountId: author.id } });
            const authorization = await f.mint('template.instantiate', {
                source: { kind: 'artifact', serverId: 'home', artifactId: source.id }, expectedVersion: '1.0.0',
                creation: { executionTarget: { serverId: 'home', machineId: f.machine.id }, directory: { kind: 'managed' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
            }, true);
            const headers = createTemplateRequesterExecutionHttpHeadersV1({ authorization, requesterToken: f.presentUserToken,
                effectActionId: 'template.instantiate', target: authorization.binding.target })!;
            const payload = { artifactIds: [source.id, privateArtifact.id] };
            const read = await f.app.inject({ method: 'POST', url: '/v1/artifacts/read', headers, payload });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ items: [
                { artifactId: source.id, ok: true, artifact: { body: encodeBase64(source.body), access: 'view' } },
                { artifactId: privateArtifact.id, ok: false, status: 404 },
            ] });
            const headerRead = await f.app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                payload: { ...payload, projection: 'headers' } });
            expect(headerRead.statusCode, headerRead.body).toBe(200);
            expect(headerRead.json().items[0]).toMatchObject({ artifactId: source.id, ok: true });
            expect(headerRead.json().items[0].artifact).not.toHaveProperty('body');
            expect((await f.app.inject({ method: 'POST', url: '/v1/artifacts/read?unexpected=1', headers, payload })).statusCode).toBe(403);
        } finally { await f.app.close(); }
    });

    it('keeps Plain admission key-free and refuses a substituted selected-recipient projection', async () => {
        const f = await createSignedDiscussionHttpFixture('template.instantiate');
        try {
            const recipient = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
            const grant = { subject: { kind: 'account' as const, accountId: recipient.id }, accessLevel: 'view' as const, canApprovePermissions: false };
            const initialAccess = { grants: [grant] };
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(),
                target: { kind: 'machine', machineId: f.machine.id }, input: {
                    source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() }, expectedVersion: '1.0.0',
                    creation: { executionTarget: { serverId: 'home', machineId: f.machine.id }, directory: { kind: 'managed' },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, initialAccess },
                } });
            const mint = (projection: unknown, actionId = 'template.instantiate') => f.app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers: { authorization: `Bearer ${f.presentUserToken}` },
                payload: { v: 1, machineId: f.machine.id, envelope, templateRequesterInitialAccessAdmission: projection } });
            const accepted = await mint(initialAccess);
            expect(accepted.statusCode, accepted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(accepted.json());
            expect(authorization.binding.accountEncryptionMode).toBe('plain');
            expect(authorization.binding.templateRequesterInitialAccessAdmission).toEqual(initialAccess);
            expect((await mint({ grants: [{ ...grant, subject: { kind: 'account', accountId: randomUUID() } }] })).statusCode).toBe(400);
            expect((await mint(initialAccess, 'template.updates.apply')).statusCode).toBe(400);
        } finally { await f.app.close(); }
    });

    it('confines recipient key preparation to selected recipients and envelope writes to its actual birth', async () => {
        const f = await createSignedDiscussionHttpFixture('template.instantiate', [], true, undefined, { dataKeyEnvelopes: true, sessionReads: true });
        try {
            const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(29) };
            const ownerKeys = tweetnacl.box.keyPair.fromSecretKey(material.machineKey);
            await db.account.update({ where: { id: f.account.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
            const machineKey = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: ownerKeys.publicKey, randomBytes });
            await db.machine.update({ where: { id: f.machine.id }, data: { metadata: 'opaque', dataEncryptionKey: new Uint8Array(machineKey.dataEncryptionKey) } });
            const recipientKeys = tweetnacl.box.keyPair();
            const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(recipientKeys.publicKey) } });
            await makeShareEligibleForTest(f.account.id, recipient.id);
            const extra = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
            const initialAccess = { grants: [{ subject: { kind: 'account' as const, accountId: recipient.id }, accessLevel: 'view' as const, canApprovePermissions: false }] };
            const creationKey = randomUUID();
            const target = { kind: 'machine' as const, machineId: f.machine.id };
            const input = { source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, creation: { executionTarget: { serverId: 'home', machineId: f.machine.id },
                    directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, initialAccess } };
            const originalActionEnvelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: await getOrCreateServerIdentityId(),
                accountId: f.account.id, actionId: 'template.instantiate', requestId: randomUUID(), target,
                authentication: { kind: 'account', tokenEpoch: f.account.tokenEpoch } }, input, material, randomBytes });
            const bearer = { authorization: `Bearer ${f.presentUserToken}`, 'x-happier-account-stored-content-protocol': '2' };
            const issued = await f.app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('template.instantiate'),
                headers: bearer, payload: { v: 1, machineId: f.machine.id, envelope: originalActionEnvelope,
                    templateRequesterInitialAccessAdmission: initialAccess } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const httpHeaders = (proof = authorization) => ({ ...bearer, ...createTemplateRequesterExecutionHttpHeadersV1({
                authorization: proof, requesterToken: f.presentUserToken, effectActionId: 'template.instantiate', target }) });
            const keyRead = await f.app.inject({ method: 'GET', url: `/v1/user/${recipient.id}`, headers: httpHeaders() });
            expect(keyRead.statusCode, keyRead.body).toBe(200);
            expect((await f.app.inject({ method: 'GET', url: `/v1/user/${extra.id}`, headers: httpHeaders() })).statusCode).toBe(403);
            const fields = await materializeSessionInitialAccessCreateFields({ fields: { initialAccess }, sessionEncryptionMode: 'e2ee',
                sessionDataKey: machineKey.encryptionKey, randomBytes, resolveRecipientContentPublicKey: async () => recipientKeys.publicKey });
            const creationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey });
            const birth = await f.app.inject({ method: 'POST', url: '/v1/sessions', headers: bearer, payload: {
                tag: creationTag, metadataLayoutVersion: 1, encryptionMode: 'e2ee', sharedMetadata: { ciphertext: 'opaque-shared' },
                ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: { v: 1 }, material, randomBytes }),
                dataEncryptionKey: encodeBase64(machineKey.dataEncryptionKey), ...fields,
                templateRequesterAuthorization: { authorization, originalActionEnvelope } } });
            expect(birth.statusCode, birth.body).toBe(200);
            const sessionId = String(birth.json().session.id);
            const snapshotDemand = { sessionIds: [sessionId], accessProjectionVersion: 1, includeSnapshot: true,
                includeTurns: false, includeMessages: false };
            const readSnapshots = (demand: typeof snapshotDemand) => f.app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: httpHeaders(), payload: demand });
            const snapshot = await readSnapshots(snapshotDemand);
            expect(snapshot.statusCode, snapshot.body).toBe(200);
            expect(snapshot.json()).toMatchObject({ results: [{ sessionId, detail: { status: 200, body: { session: { id: sessionId } } } }] });
            expect(snapshot.json().results[0]).not.toHaveProperty('turns');
            expect(snapshot.json().results[0]).not.toHaveProperty('messages');
            for (const extraDemand of [{ includeTurns: true }, { includeMessages: true }, { underSessionId: sessionId }]) {
                expect((await readSnapshots({ ...snapshotDemand, ...extraDemand })).statusCode).toBe(403);
            }
            const foreignSession = await db.session.create({ data: { accountId: extra.id, tag: randomUUID(), metadata: '{}',
                metadataVersion: 0, encryptionMode: 'plain' } });
            const inaccessible = await readSnapshots({ ...snapshotDemand, sessionIds: [foreignSession.id] });
            expect(inaccessible.statusCode, inaccessible.body).toBe(200);
            expect(inaccessible.json()).toMatchObject({ results: [{ sessionId: foreignSession.id, detail: { status: 404 } }] });
            const bound = decodeTemplateBirthExecutionAuthorizationV1(String(birth.headers[TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1]));
            expect(bound).not.toBeNull();
            if (!bound) throw new Error('Missing birth authorization');
            const path = `/v2/sessions/${sessionId}/data-key/envelopes`;
            expect((await f.app.inject({ method: 'GET', url: `${path}?state=all&limit=1`, headers: httpHeaders() })).statusCode).toBe(403);
            const page = await f.app.inject({ method: 'GET', url: `${path}?state=all&limit=1`, headers: httpHeaders(bound) });
            expect(page.statusCode, page.body).toBe(200);
            const directGrant = fields.initialAccess?.grants[0];
            if (!directGrant || !('accountEnvelopeInput' in directGrant) || !directGrant.accountEnvelopeInput) throw new Error('Missing recipient envelope');
            const patch = { entries: [{ recipientAccountId: recipient.id, encryptedDataKey: directGrant.accountEnvelopeInput.encryptedDataKey }] };
            const applied = await f.app.inject({ method: 'PATCH', url: path, headers: httpHeaders(bound), payload: patch });
            expect(applied.statusCode, applied.body).toBe(200);
            expect(applied.json()).toEqual({ appliedCount: 1 });
            const otherSession = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(), metadata: '{}', metadataVersion: 0,
                encryptionMode: 'e2ee' } });
            expect((await f.app.inject({ method: 'GET', url: `/v2/sessions/${otherSession.id}/data-key/envelopes`, headers: httpHeaders(bound) })).statusCode).toBe(403);
            await db.session.update({ where: { id: sessionId }, data: { tag: randomUUID() } });
            expect((await f.app.inject({ method: 'PATCH', url: path, headers: httpHeaders(bound), payload: patch })).statusCode).toBe(403);
        } finally { await f.app.close(); }
    });
});
