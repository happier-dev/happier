import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { expect } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, encodePasswordCredentialFieldV1,
    API_TOKEN_FULL_GRANT_V1, type AccountPasswordCredentialV1 } from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, type ExternalActionExecutionAuthorizationV1,
    type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1,
    signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { buildDiscussionModelSessionCreationProofPayloadV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { db } from '@/storage/db';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerSessionCreateOrLoadRoute } from '../session/registerSessionCreateOrLoadRoute';
import { registerSessionListingRoutes } from '../session/registerSessionListingRoutes';
import { userRoutes } from '../user/userRoutes';
import { createDiscussion } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant } from '@/app/discussions/accessService';
import { registerDiscussionRoutes } from '../discussions/registerDiscussionRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { accessKeysRoutes } from '../accessKeys/accessKeysRoutes';
import { sessionPendingRoutes } from '../session/pendingRoutes';
import { registerSessionDataKeyEnvelopeRoutes } from '../session/registerSessionDataKeyEnvelopeRoutes';
import { registerSessionReadBatchRoute } from '../session/registerSessionReadBatchRoute';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { inTx } from '@/storage/inTx';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';

export async function createSignedDiscussionHttpFixture(allowedActionId?: ActionId, allowedSessionIds: readonly string[] = [], candidateDirectories = false, machineCustodianAccountId?: string,
    options?: Readonly<{ pending?: true; dataKeyEnvelopes?: true; sessionReads?: true; artifactReads?: true }>) {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const credential: AccountPasswordCredentialV1 = { v: 1, kind: 'plain_password_hash', hash: {
        v: 1, algorithm: 'scrypt', parameters: { n: 16_384, r: 8, p: 5, keyLength: 32 },
        salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
        digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
    } };
    await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email',
        providerUserId: `${account.id}@discussion-auth.test`, profile: {} } });
    await db.accountPasswordCredential.create({ data: { accountId: account.id, credential } });
    const keyPair = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
        id: randomUUID(), accountId: machineCustodianAccountId ?? account.id,
        metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), metadataVersion: 1,
        daemonState: null, daemonStateVersion: 0,
        installationId: randomUUID(), installationPublicKey: new Uint8Array(keyPair.publicKey),
    } });
    if (machine.accountId !== account.id) expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
        actorAccountId: machine.accountId, machineId: machine.id, principal: { kind: 'account', accountId: account.id }, level: 'admin',
    }))).toMatchObject({ kind: 'saved' });
    const pat = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: 'Discussion test',
        ...(allowedActionId ? { grant: { ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: [allowedActionId] }, targets: { sessions: [...allowedSessionIds], machines: [machine.id] } } } : {}),
        authenticationEvidence: [{ kind: 'home_method', methodId: 'email_password' }] });
    const presentUserToken = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    expect(await auth.verifyToken(presentUserToken)).toMatchObject({ userId: account.id, authority: 'present_user' });
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    app.decorate('resolveCurrentSessionMachine', async () => machine.id);
    registerSessionCreateOrLoadRoute(app);
    if (candidateDirectories) {
        registerSessionListingRoutes(app);
        await userRoutes(app);
    }
    registerDiscussionRoutes(app);
    registerAccountEncryptionRoutes(app);
    featuresRoutes(app);
    accessKeysRoutes(app);
    if (options?.pending) sessionPendingRoutes(app);
    if (options?.dataKeyEnvelopes) registerSessionDataKeyEnvelopeRoutes(app);
    if (options?.sessionReads) registerSessionReadBatchRoute(app);
    if (options?.artifactReads) await artifactsRoutes(app);
    registerExternalActionRoutes(app, {
        // The daemon network is the only replaced boundary; issuance, signatures and DB admission are real.
        dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }),
    });
    await app.ready();

    async function mint(actionId: ActionId, input: unknown, presentUser = false) {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(),
            target: { kind: 'machine', machineId: machine.id }, input });
        const response = await app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${presentUser ? presentUserToken : pat.token}` },
            payload: { v: 1, machineId: machine.id, envelope } });
        expect(response.statusCode, `${actionId} (${presentUser ? 'person' : 'automation'}): ${response.body}`).toBe(200);
        return ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
    }

    async function verify(authorization: ExternalActionExecutionAuthorizationV1,
        request: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown;
            reviewedChild?: ReviewedActionChildHttpProofV1;
            sessionRouteTarget?: { kind: 'session'; sessionId: string; actionId?: ActionId } }>,
        effectActionId = authorization.binding.actionId) {
        const signed = { authorizationToken: authorization.token, installationId: machine.installationId!,
            requestId: authorization.binding.requestId, target: authorization.binding.target,
            effectActionId, method: request.method, path: request.path, body: request.body,
            ...(request.reviewedChild ? { reviewedChild: request.reviewedChild } : {}) };
        return verifyExternalActionDomainExecutionRequest({ ...request,
            body: request.body,
            authorizationToken: authorization.token, effectActionId,
            encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target),
            machineSignature: signExternalActionMachineRequestV1({ ...signed, privateKey: keyPair.secretKey }) });
    }
    return { app, mint, verify, account, pat, machine, keyPair, presentUserToken };
}


export async function createSignedDiscussionModelBirthFixture(f: Awaited<ReturnType<typeof createSignedDiscussionHttpFixture>>) {
    const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Independent resource' }] };
    const targetKeys = tweetnacl.sign.keyPair();
    const target = await db.machine.create({ data: { ...f.machine, id: randomUUID(),
        installationId: randomUUID(), installationPublicKey: new Uint8Array(targetKeys.publicKey) } });
    if (target.accountId !== f.account.id) expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
        actorAccountId: target.accountId, machineId: target.id, principal: { kind: 'account', accountId: f.account.id }, level: 'admin',
    }))).toMatchObject({ kind: 'saved' });
    const launch = { executionTarget: { serverId: 'home-1', machineId: target.id },
        directory: { kind: 'path' as const, path: '/review' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const retry = { creationLocalId: randomUUID(), quoteLocalId: randomUUID(), questionLocalId: randomUUID() };
    const source = { kind: 'session', message: { kind: 'session',
        session: { serverId: 'home-1', sessionId: 'cmv3sourceopinion' }, messageId: 'answer-1' } };
    const reviewer = { selection: { kind: 'model', launch }, participantSlotId: 'model-reviewer', sourceAccess: 'read' };
    const input = { intent: 'ask', source, title: 'Review', question: 'Check this', reviewers: [reviewer], retry,
        confirmedPreview: { source, sourceAudienceAccountIds: [f.account.id], sourceContentReady: true,
            discussionAudienceAccountIds: [f.account.id], missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true }, canGrantSource: true,
            reviewers: [{ ...reviewer, runtimeAccountId: f.account.id, audienceAccountIds: [f.account.id], missingSourceAccountIds: [],
                canGrantSource: true, disclosure: { ok: true } }] } };
    const authorization = await f.mint('discussion.second_opinion.start', input, true);
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: authorization.binding.requestId,
        target: authorization.binding.target, input });
    const authentication = createPresentUserSessionAccessAuthentication();
    const created = await createDiscussion({ actorAccountId: f.account.id, authentication,
        request: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: retry.creationLocalId,
            titleContent: { t: 'plain', v: { v: 1, title: 'Review' } },
            firstMessage: { localId: retry.quoteLocalId, content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] } }) });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    const ref = { discussionId: created.value.discussion.id, participantSlotId: 'model-reviewer' };
    expect(await inviteDiscussionParticipant({ actorAccountId: f.account.id, authentication, discussionId: ref.discussionId,
        request: { participant: { kind: 'model', participantSlotId: ref.participantSlotId, launch }, answerPolicy: 'when_addressed' } }))
        .toMatchObject({ ok: true });
    const publicInput = { ...launch, creationKey: ref.participantSlotId, discussionParticipant: ref, initialTriggers: [] };
    const method = `${target.id}:${RPC_METHODS.SESSION_SPAWN_NEW}`;
    const requestId = randomUUID();
    const signed = { authorizationToken: authorization.token, effectActionId: 'session.spawn_new',
        target: authorization.binding.target, installationId: f.machine.installationId!, method, requestId, params: publicInput };
    const sourceExecution = { method, requestId, params: publicInput, originalActionEnvelope: envelope,
        externalActionExecution: { v: 1 as const, authorization, effectActionId: 'session.spawn_new',
            target: authorization.binding.target, installationId: f.machine.installationId!,
            machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, privateKey: f.keyPair.secretKey }) } };
    const machineAdmission = { machineId: target.id, installationId: target.installationId!, actorAccountId: f.account.id,
        custodianAccountId: target.accountId, role: 'manage' as const, encryptionMode: 'plain' as const };
    const body = { tag: deriveSessionCreationTagV1({ callerCreationNamespace: JSON.stringify(['discussion-participant', ref.discussionId]),
        creationKey: ref.participantSlotId }), metadataLayoutVersion: 1, encryptionMode: 'plain',
        sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) }, ownerMetadata: { t: 'plain', v: { v: 1 } }, dataEncryptionKey: null,
        originKind: 'discussion', discussionParticipant: ref, discussionParticipantLaunch: launch };
    const proof = { v: 1 as const, machineAdmission, sourceExecution, proof: signMachineInstallationProof({
        privateKey: targetKeys.secretKey, payload: buildDiscussionModelSessionCreationProofPayloadV1({ machineAdmission, sourceExecution, body }) }) };
    const send = (payload: unknown) => f.app.inject({ method: 'POST', url: '/v1/sessions',
        headers: { authorization: `Bearer ${f.presentUserToken}`, [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: authorization.token,
            'content-type': 'application/json', 'x-happier-account-stored-content-protocol': '2' }, payload: JSON.stringify(payload) });
    return { target, body, proof, machineAdmission, sourceExecution, ref, send };
}

