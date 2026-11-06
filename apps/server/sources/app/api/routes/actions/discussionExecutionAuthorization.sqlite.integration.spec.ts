import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { randomUUID } from 'node:crypto';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { discussionActionHttpWireInputSchemaV1, type DiscussionActionIdV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildDiscussionMutationRequestBodyV1, DISCUSSION_HTTP_PATHS_V1, DiscussionCreateRequestV1Schema, type DiscussionCreateRequestV1 } from '@happier-dev/protocol/discussions/api';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocEditAcceptTransportInputV1Schema, DocEditDeclineTransportInputV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DiscussionMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1 } from '@happier-dev/protocol/discussions/secondOpinion';
import { ArtifactAccessGrantSetInputV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant, setDiscussionGrant } from '@/app/discussions/accessService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { DiscussionListInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createSignedDiscussionHttpFixture as fixture, createSignedDiscussionModelBirthFixture } from './discussionExecutionAuthorization.testkit';

import { buildSessionSpawnNewArgs } from '../../../../../../../packages/protocol/src/actions/executor/sessionSpawn';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { DeploymentPrepareInputV1Schema, buildDeploymentPreparationBriefV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { deriveDeploymentPrepareSessionCreationIdentityV1, buildSessionActionChildCreationProofPayloadV1,
    type SessionActionChildCreationProofV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { inTx } from '@/storage/inTx';

// Runtime composition uses the CLI Vitest resolver, not the Server compiler's
// rootDir/aliases. Both composed flows retain the shared typed Action port.
const { createDiscussionActionDeps } = await vi.importActual<{
    createDiscussionActionDeps(options: Readonly<{
        credentials: { token: string; encryption: null }; serverId: string; serverHttpBaseUrl: string;
        serverIdentityId: string; externalActionMachineInstallationId: string;
        externalActionMachineRequestPrivateKey: Uint8Array;
    }>): Pick<ActionExecutorDeps, 'discussionAction'>;
}>('../../../../../../cli/src/discussions/discussionActionDeps');

describe('signed Account Discussion HTTP admission', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-discussion-execution-auth-',
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
                HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1',
                HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1',
                HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
            },
        });
    }, 300_000);

    afterAll(async () => { await harness?.close(); });

    it('admits only the existing read-only candidate directory and Session page under an Account-wide signed root', async () => {
        const f = await fixture();
        const scoped = await fixture('discussion.candidates.list');
        try {
            const authorization = await f.mint('discussion.candidates.list', { source: 'people', query: 'bob' });
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/user/search?query=bob&purpose=collaboration' })).not.toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/user/search?query=bob&purpose=collaboration&cursor=native-page' })).not.toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/features/authenticated' })).not.toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/user/search?query=bob' })).toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/user/search?query=bob&purpose=collaboration&purpose=other' })).toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/user/bob' })).toBeNull();
            expect(await f.verify(authorization, { method: 'POST', path: '/v1/user/search', body: { query: 'bob', purpose: 'collaboration' } })).toBeNull();
            const query = { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
                audiences: [], tagIds: [], includeAttention: false };
            const sessions = await f.mint('discussion.candidates.list', { source: 'sessions' });
            expect(await f.verify(sessions, { method: 'POST', path: '/v2/sessions/query', body: query })).not.toBeNull();
            expect(await f.verify(sessions, { method: 'POST', path: '/v2/sessions/query', body: { ...query, includeAttention: true } })).toBeNull();
            expect(await f.verify(sessions, { method: 'GET', path: '/v2/sessions' })).toBeNull();
            expect(await f.verify(sessions, { method: 'GET', path: '/v2/account/settings' })).toBeNull();
            expect(await f.verify(sessions, { method: 'GET', path: '/v2/sessions/private-session',
                sessionRouteTarget: { kind: 'session', sessionId: 'private-session', actionId: 'session.transcript.get' } })).toBeNull();
            expect(await f.verify(sessions, { method: 'GET', path: '/v1/sessions/private-session/messages',
                sessionRouteTarget: { kind: 'session', sessionId: 'private-session', actionId: 'session.transcript.get' } })).toBeNull();
            expect(await f.verify(sessions, { method: 'GET', path: '/v1/discussions/selected-discussion/participants',
                routeInput: { discussionId: 'selected-discussion' } })).not.toBeNull();
            expect(await f.verify(sessions, { method: 'GET', path: '/v1/discussions/selected-discussion/participants',
                routeInput: { discussionId: 'another-discussion' } })).toBeNull();
            const restricted = await scoped.mint('discussion.candidates.list', { source: 'sessions' });
            expect(await scoped.verify(restricted, { method: 'POST', path: '/v2/sessions/query', body: query })).toBeNull();
            expect(await scoped.verify(restricted, { method: 'GET', path: '/v1/user/search?query=bob&purpose=collaboration' })).toBeNull();
        } finally {
            await f.app.close();
            await scoped.app.close();
        }
    });

    it('executes candidate reads through the signed CLI transport and existing directory owners', async () => {
        const f = await fixture(undefined, [], true);
        const person = await db.account.create({ data: { encryptionMode: 'plain', name: 'Candidate Bob', username: randomUUID() } });
        await db.userRelationship.create({ data: { fromUserId: f.account.id, toUserId: person.id, status: 'friend' } });
        const session = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }) } });
        const serverId = await getOrCreateServerIdentityId();
        const serverHttpBaseUrl = await f.app.listen({ port: 0, host: '127.0.0.1' });
        const deps = createDiscussionActionDeps({ credentials: { token: f.presentUserToken, encryption: null }, serverId,
            serverHttpBaseUrl, serverIdentityId: serverId, externalActionMachineInstallationId: f.machine.installationId!,
            externalActionMachineRequestPrivateKey: f.keyPair.secretKey });
        const read = async (input: { source: 'people'; query: string } | { source: 'sessions' }) => {
            const authorization = await f.mint('discussion.candidates.list', input);
            return deps.discussionAction!({ actionId: 'discussion.candidates.list', input, context: { surface: 'cli', serverId,
                authority: 'account_automation', externalActionExecutionAuthorization: authorization,
                externalActionTarget: authorization.binding.target } });
        };
        try {
            expect(await read({ source: 'people', query: 'Candidate Bob' })).toMatchObject({ source: 'people', candidates: [
                { kind: 'account', participant: { kind: 'account', accountId: person.id } },
            ] });
            expect(await read({ source: 'sessions' })).toMatchObject({ source: 'sessions', candidates: [
                { kind: 'session', selection: { kind: 'session', session: { serverId, sessionId: session.id } } },
            ] });
        } finally { await f.app.close(); }
    });

    it.each([
        { sourceKind: 'doc', sharedBeforeInvite: true },
        { sourceKind: 'doc', sharedBeforeInvite: false },
        { sourceKind: 'session', sharedBeforeInvite: false },
    ] as const)('withholds executable $sourceKind roots and inherited replies from a broader participant Session (shared before invite: $sharedBeforeInvite)', async ({ sourceKind, sharedBeforeInvite }) => {
        const f = await fixture();
        const authentication = createPresentUserSessionAccessAuthentication();
        const bob = await db.account.create({ data: { encryptionMode: 'plain' } });
        const receiver = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: f.account.id, machineId: f.machine.id, sessionId: receiver.id, data: 'source' } });
        const shareReceiver = () => db.sessionShare.create({ data: { sessionId: receiver.id,
            sharedByUserId: f.account.id, sharedWithUserId: bob.id, accessLevel: 'view' } });
        const privateText = 'Alice-only source passage';
        const text = (value: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text: value }] });
        let sourceSessionId: string | undefined;
        let artifactId: string | undefined;
        let request: DiscussionCreateRequestV1;
        if (sourceKind === 'doc') {
            const created = await createArtifact({ actorUserId: f.account.id, artifactId: randomUUID(),
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Private source' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: privateText })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            artifactId = created.artifact.id;
            const doc = { ref: { kind: 'doc' as const, artifactId, serverId: 'home' },
                revision: { headerVersion: created.artifact.headerVersion, bodyVersion: created.artifact.bodyVersion } };
            request = DiscussionCreateRequestV1Schema.parse({ creationLocalId: randomUUID(),
                titleContent: { t: 'plain', v: { v: 1, title: 'Source discussion' } }, firstMessage: { localId: randomUUID(),
                    content: { t: 'plain', v: { kind: 'doc_passage_comment', passage: { ...doc,
                        range: { start: 0, end: privateText.length }, quote: privateText, prefix: '', suffix: '' }, content: text('Root') } },
                    mentionedAccountIds: [], replyTarget: { kind: 'doc_passage', doc } } });
        } else {
            const source = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            sourceSessionId = source.id;
            const answer = await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, messageRole: 'agent', content: { t: 'plain', v: { text: privateText } } } });
            request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(),
                anchor: { kind: 'session', sessionId: source.id, messageId: answer.id },
                titleContent: { t: 'plain', v: { v: 1, title: 'Source discussion' } }, firstMessage: { localId: randomUUID(),
                    content: { t: 'plain', v: text(privateText) }, authoredContent: text(privateText), mentionedAccountIds: [] } });
        }
        const created = await createDiscussion({ authentication, actorAccountId: f.account.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const inherited = await postDiscussionMessage({ authentication, actorAccountId: f.account.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(),
                content: { t: 'plain', v: text(privateText) }, authoredContent: text(privateText), mentionedAccountIds: [],
                replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } }) });
        if (!inherited.ok) throw new Error(inherited.error);
        // Doc Discussion grants do not themselves confer Doc access.
        if (sourceKind === 'doc') expect(await setDiscussionGrant({ authentication, actorAccountId: f.account.id, discussionId,
            request: { principal: { kind: 'account', accountId: bob.id }, accessLevel: 'view' } })).toMatchObject({ ok: true });
        if (sharedBeforeInvite) await shareReceiver();
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: f.account.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id } } })).toMatchObject({ ok: true });
        let readAddress = { messageId: inherited.value.message.id, throughSeq: inherited.value.message.seq };
        const target = { kind: 'machine' as const, machineId: f.machine.id };
        const serverId = await getOrCreateServerIdentityId();
        const serverHttpBaseUrl = await f.app.listen({ port: 0, host: '127.0.0.1' });
        const deps = createDiscussionActionDeps({ credentials: { token: f.presentUserToken, encryption: null }, serverId,
            serverHttpBaseUrl, serverIdentityId: serverId, externalActionMachineInstallationId: f.machine.installationId!,
            externalActionMachineRequestPrivateKey: f.keyPair.secretKey });
        const execute = async (actionId: 'discussion.read' | 'discussion.get', afterSeq?: number) => {
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: receiver.id,
                starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'reading-turn', callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' }, requestId: randomUUID() });
            const input = { discussionId, ...(afterSeq === undefined ? {} : { afterSeq }),
                ...(actionId === 'discussion.read' ? { throughSeq: readAddress.throughSeq } : {}) };
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId, target, input });
            const source = { machineId: f.machine.id, installationId: f.machine.installationId! };
            const minted = await f.app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: { v: 1, machineId: f.machine.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source,
                    installationProof: signMachineInstallationProof({ privateKey: f.keyPair.secretKey, payload: { version: 1,
                        accountId: f.account.id, ...source, externalActionOrigin: { homeId: serverId, actionId,
                            requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            return deps.discussionAction!({ actionId, input, context: { surface: 'agent', serverId, authority: 'account_automation',
                defaultSessionId: receiver.id, actionCaller: origin.caller,
                externalActionExecutionAuthorization: authorization, externalActionTarget: target,
                ...(actionId === 'discussion.read' ? { sessionInputSource: { sourceSessionId: receiver.id,
                    sourceTurnId: origin.sourceTurnId, via: 'action', discussionAddressing: {
                        discussionId, ...readAddress, participantSessionId: receiver.id } } } : {}) } });
        };
        try {
            // No client-side protected-summary suppression: Home itself must
            // withhold the latest inherited quote from a broader Session.
            const latest = await execute('discussion.get');
            expect(latest).toMatchObject({ discussion: { id: discussionId } });
            if (sharedBeforeInvite) expect(JSON.stringify(latest)).not.toContain(privateText);
            else expect(JSON.stringify(latest)).toContain(privateText);
            // A standalone mention has no Doc/source reply target of its own.
            const mentioned = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: receiver.id } }] };
            const question = await postDiscussionMessage({ authentication, actorAccountId: f.account.id, discussionId,
                request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(), content: { t: 'plain', v: mentioned },
                    authoredContent: mentioned, mentionedAccountIds: [], mentionedSessionIds: [receiver.id] }) });
            if (!question.ok) throw new Error(question.error);
            readAddress = { messageId: question.value.message.id, throughSeq: question.value.message.seq };
            if (!sharedBeforeInvite) {
                expect(await execute('discussion.read')).toMatchObject({ messages: expect.arrayContaining([
                    expect.objectContaining({ id: created.value.firstMessage.id })]) });
                await shareReceiver();
            }
            // The result is refused before returning opened content to the Agent's Session.
            expect(await execute('discussion.read')).toMatchObject({ ok: false, errorCode: 'discussion_access_forbidden' });
            expect(await execute('discussion.read', 1)).toMatchObject({ ok: false, errorCode: 'discussion_access_forbidden' });
            if (sourceKind === 'doc') expect(await execute('discussion.read', inherited.value.message.seq))
                .toMatchObject({ messages: [expect.objectContaining({ id: question.value.message.id })] });
            const metadata = await execute('discussion.get');
            expect(metadata).toMatchObject({ discussion: { id: discussionId } });
            expect(JSON.stringify(metadata)).not.toContain(privateText);
            const direct = await f.app.inject({ method: 'GET', url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId),
                headers: { authorization: `Bearer ${f.presentUserToken}` } });
            expect(direct.statusCode, direct.body).toBe(200);
            expect(direct.body).toContain(privateText);
            if (artifactId) await db.artifactAccountGrant.create({ data: { artifactId, accountId: bob.id,
                accessLevel: 'view', createdByAccountId: f.account.id } });
            if (sourceSessionId) await db.sessionShare.create({ data: { sessionId: sourceSessionId,
                sharedByUserId: f.account.id, sharedWithUserId: bob.id, accessLevel: 'view' } });
            expect(await execute('discussion.read', 1)).toMatchObject({ messages: expect.arrayContaining([
                expect.objectContaining({ id: inherited.value.message.id })]) });
        } finally { await f.app.close(); }
    });

    it.each(['Session', 'E2EE Session'] as const)('creates exactly the Prepare child at the real Session birth boundary using the unchanged signed root (%s)', async callerKind => {
        const f = await fixture();
        try {
            const encrypted = callerKind === 'E2EE Session';
            const contentKeys = tweetnacl.box.keyPair();
            const contentKey = encrypted ? createMachineDataEncryptionKeyV1({ material: { type: 'dataKey', machineKey: contentKeys.secretKey },
                dataKeyPublicKey: contentKeys.publicKey, randomBytes: tweetnacl.randomBytes }) : undefined;
            if (contentKey) {
                await db.account.update({ where: { id: f.account.id }, data: {
                    encryptionMode: 'e2ee', ...createSignedAccountContentBinding(contentKeys.publicKey),
                } });
                const metadata = sealSessionStoredContent({ mode: 'e2ee',
                    ctx: { encryptionKey: contentKey.encryptionKey, encryptionVariant: 'dataKey' },
                    payload: decodePlainMachineStoredContent(f.machine.metadata) });
                if (metadata.t !== 'encrypted') throw new Error('Expected encrypted Prepare Machine');
                await db.machine.update({ where: { id: f.machine.id }, data: {
                    metadata: metadata.c, dataEncryptionKey: new Uint8Array(contentKey.dataEncryptionKey),
                } });
            }
            const serverId = await getOrCreateServerIdentityId();
            const created = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
                requestKey: randomUUID(), name: 'Prepare birth',
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'example/prepare', cloneUrl: 'https://github.com/example/prepare.git' }, protocol: 'https' } }));
            if (!created.ok) throw new Error(created.error);
            const input = DeploymentPrepareInputV1Schema.parse({ projectSourceId: created.source.id, sourceRevision: created.source.revision,
                repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/prepare' },
                baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId, id: 'prepare-workspace' } });
            const caller = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            await db.accessKey.create({ data: { accountId: f.account.id, machineId: f.machine.id, sessionId: caller.id, data: 'source' } });
            const sessionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: caller.id,
                starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'prepare-turn', callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' }, requestId: randomUUID() });
            const actionCaller = sessionOrigin.caller;
            const origin = sessionOrigin;
            const buildEnvelope = (rootInput: typeof input) => encrypted
                ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId, accountId: f.account.id,
                    actionId: 'deployments.prepare', requestId: origin.requestId,
                    target: { kind: 'machine', machineId: f.machine.id }, authentication: { kind: 'account', tokenEpoch: 0 } },
                    input: rootInput, material: { type: 'dataKey', machineKey: contentKeys.secretKey }, randomBytes: tweetnacl.randomBytes })
                : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
                    target: { kind: 'machine', machineId: f.machine.id }, input: rootInput });
            const envelope = buildEnvelope(input);
            const source = { machineId: f.machine.id, installationId: f.machine.installationId! };
            const minted = await f.app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('deployments.prepare'),
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: { v: 1, machineId: f.machine.id, envelope,
                    sessionActionOrigin: sessionOrigin, sessionActionSource: source,
                    installationProof: signMachineInstallationProof({ privateKey: f.keyPair.secretKey, payload: { version: 1,
                        accountId: f.account.id, ...source, externalActionOrigin: { homeId: serverId, actionId: 'deployments.prepare',
                            requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const identity = deriveDeploymentPrepareSessionCreationIdentityV1(authorization.binding);
            if (!identity) throw new Error('missing_prepare_child_identity');
            const spawn = SessionSpawnNewActionInputV2Schema.parse({ executionTarget: { serverId, machineId: f.machine.id },
                directory: { kind: 'path', path: '/prepare' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                initialInput: { text: buildDeploymentPreparationBriefV1(input) } });
            const args = buildSessionSpawnNewArgs(spawn, { serverId, runtimeAccountId: f.account.id,
                authority: 'account_automation', surface: 'agent', defaultSessionId: caller.id,
                actionRequestId: identity.requestId, agentStartWorkDepth: 1, actionCaller, externalActionExecutionAuthorization: authorization });
            expect(args).not.toBeNull();
            if (!args?.creationAuthorization) throw new Error('missing_real_spawn_creation_authorization');
            const sessionContent = contentKey ? sealSessionStoredContent({ mode: 'e2ee',
                ctx: { encryptionKey: contentKey.encryptionKey, encryptionVariant: 'dataKey' }, payload: { v: 1 } })
                : { t: 'plain' as const, v: { v: 1 } };
            const body = { tag: args.sessionCreationTag, metadataLayoutVersion: 1, encryptionMode: encrypted ? 'e2ee' : 'plain',
                sharedMetadata: { ciphertext: sessionContent.t === 'encrypted' ? sessionContent.c : JSON.stringify(sessionContent.v) },
                ownerMetadata: encrypted ? sealSessionOwnerMetadataEnvelopeV1({
                    material: { type: 'dataKey', machineKey: contentKeys.secretKey }, ownerMetadata: { v: 1 },
                    randomBytes: tweetnacl.randomBytes }) : sessionContent,
                dataEncryptionKey: contentKey ? encodeBase64(contentKey.dataEncryptionKey, 'base64') : null,
                originKind: args.originKind,
                ...(args.originSessionId === undefined ? {} : { originSessionId: args.originSessionId }),
                ...(args.originRunId === undefined ? {} : { originRunId: args.originRunId }), workDepth: args.workDepth };
            const machineAdmission = { machineId: f.machine.id, installationId: f.machine.installationId!, actorAccountId: f.account.id,
                custodianAccountId: f.machine.accountId, role: 'manage' as const, encryptionMode: encrypted ? 'e2ee' as const : 'plain' as const };
            const method = `${f.machine.id}:${RPC_METHODS.SESSION_SPAWN_NEW}`;
            const makeProof = (requestBody: Readonly<Record<string, unknown>>, params: SessionActionChildCreationProofV1['sourceExecution']['params'] = encrypted ? undefined : spawn,
                admission = machineAdmission, requestId = identity.requestId, originalActionEnvelope = envelope): SessionActionChildCreationProofV1 => {
                const sourceExecution = { method, requestId, ...(params === undefined ? {} : { params }), originalActionEnvelope,
                    externalActionExecution: { v: 1 as const, authorization, effectActionId: 'session.spawn_new',
                        target: authorization.binding.target, installationId: f.machine.installationId!,
                        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                            effectActionId: 'session.spawn_new', target: authorization.binding.target,
                            installationId: f.machine.installationId!, method, requestId, ...(params === undefined ? {} : { params }),
                            privateKey: f.keyPair.secretKey }) } };
                return { v: 1, machineAdmission: admission, sourceExecution, proof: signMachineInstallationProof({
                    privateKey: f.keyPair.secretKey,
                    payload: buildSessionActionChildCreationProofPayloadV1({ machineAdmission: admission, sourceExecution, body: requestBody }) }) };
            };
            const send = (payload: unknown) => f.app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { authorization: `Bearer ${f.presentUserToken}`, 'content-type': 'application/json', 'x-happier-account-stored-content-protocol': '2',
                    [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: authorization.token }, payload: JSON.stringify(payload) });
            const rootOnly = await send(body);
            expect(rootOnly.statusCode, rootOnly.body).toBe(401);
            expect(rootOnly.json()).toMatchObject({ error: 'invalid_token' });
            const foreignOrigin = { ...body, originSessionId: 'cmvforeignparent' };
            const secondChild = { ...body, tag: randomUUID() };
            const forged = makeProof(body);
            forged.proof = signMachineInstallationProof({ privateKey: tweetnacl.sign.keyPair().secretKey,
                payload: buildSessionActionChildCreationProofPayloadV1({ machineAdmission, sourceExecution: forged.sourceExecution, body }) });
            for (const payload of [
                { ...body, creationAuthorizationProof: forged },
                { ...foreignOrigin, creationAuthorizationProof: makeProof(foreignOrigin) },
                { ...secondChild, creationAuthorizationProof: makeProof(secondChild) },
                { ...body, creationAuthorizationProof: makeProof(body, spawn, { ...machineAdmission, custodianAccountId: randomUUID() }) },
                { ...body, creationAuthorizationProof: makeProof(body, spawn, { ...machineAdmission, installationId: randomUUID() }) },
                { ...body, creationAuthorizationProof: makeProof(body, { ...spawn, executionTarget: { ...spawn.executionTarget, serverId: 'foreign-home' } }) },
                { ...body, creationAuthorizationProof: makeProof(body, spawn, machineAdmission, identity.requestId,
                    buildEnvelope({ ...input, workspace: { ...input.workspace, id: 'foreign-workspace' } })) },
                { ...body, creationAuthorizationProof: makeProof(body, spawn, machineAdmission, randomUUID()) },
                ...(!encrypted ? [{ ...body, creationAuthorizationProof: makeProof(body, 'opaque-child-input') }] : []),
                { ...body, creationAuthorizationProof: makeProof(body, { ...spawn, initialInput: { text: 'different brief' } }) },
            ]) {
                const refused = await send(payload);
                expect(refused.statusCode, refused.body).toBe(401);
            }
            expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(1);
            const proof = makeProof(body);
            if (encrypted) {
                expect(envelope).not.toHaveProperty('input');
                expect(proof.sourceExecution).not.toHaveProperty('params');
                expect(JSON.stringify(proof)).not.toContain(buildDeploymentPreparationBriefV1(input));
            }
            const response = await send({ ...body, creationAuthorizationProof: proof });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ created: true });
            const retry = await send({ ...body, creationAuthorizationProof: proof });
            expect(retry.statusCode, retry.body).toBe(200);
            expect(retry.json().session.id).toBe(response.json().session.id);
            expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(2);
        } finally { await f.app.close(); }
    });

    it('creates only the reserved model Session using the original root and selected receiver body proof', async () => {
        const f = await fixture();
        const { body, proof, machineAdmission, sourceExecution, ref, send } = await createSignedDiscussionModelBirthFixture(f);
        try {
            expect((await send(body)).statusCode).toBe(401);
            for (const tampered of [
                { ...body, tag: 'unreviewed-session', creationAuthorizationProof: proof },
                { ...body, creationAuthorizationProof: { ...proof, machineAdmission: { ...machineAdmission, machineId: f.machine.id } } },
                { ...body, creationAuthorizationProof: { ...proof, sourceExecution: { ...sourceExecution, requestId: randomUUID() } } },
                { ...body, discussionParticipant: { ...ref, participantSlotId: 'other-slot' }, creationAuthorizationProof: proof },
            ]) expect([400, 401]).toContain((await send(tampered)).statusCode);
            expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(0);
            const response = await send({ ...body, creationAuthorizationProof: proof });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ created: true });
            const row = await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: ref } });
            expect(row.sessionId).toBeTruthy();
            expect(await db.session.findUniqueOrThrow({ where: { id: row.sessionId! } })).toMatchObject({
                accountId: f.account.id, originKind: 'discussion', originDiscussionId: ref.discussionId,
                originDiscussionParticipantSlotId: ref.participantSlotId });
            await db.discussionParticipant.update({ where: { discussionId_participantSlotId: ref }, data: { removedAt: new Date() } });
            expect((await send({ ...body, creationAuthorizationProof: proof })).statusCode).toBe(401);
        } finally { await f.app.close(); }
    });

    const discussionId = 'independent-discussion';
    const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Independent resource' }] };
    const grant = { principal: { kind: 'account' as const, accountId: 'chosen-person' }, accessLevel: 'view' as const };

    it('spends a Second opinion root only on its consumed preview and Discussion effects', async () => {
        const f = await fixture('discussion.second_opinion.start', ['cmv3sourceopinion']);
        const source = { kind: 'session' as const, message: { kind: 'session' as const,
            session: { serverId: 'home-1', sessionId: 'cmv3sourceopinion' }, messageId: 'answer-1' } };
        const input = { intent: 'preview', source, title: 'Review', question: 'Please check', reviewers: [],
            retry: { creationLocalId: 'create-opinion', quoteLocalId: 'quote-opinion', questionLocalId: 'ask-opinion' } };
        const creation = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: 'create-opinion',
            titleContent: { t: 'plain', v: { v: 1, title: 'Review' } },
            firstMessage: { localId: 'quote-opinion', content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] } });
        const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'ask-opinion',
            content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] });
        try {
            const authorization = await f.mint('discussion.second_opinion.start', input, true);
            const previewBody = { source, reviewers: [] };
            expect(await f.verify(authorization, { method: 'POST', path: DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1,
                body: previewBody, routeInput: previewBody })).not.toBeNull();
            expect(await f.verify(authorization, { method: 'POST', path: DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1,
                body: { ...previewBody, quote: 'private source' } })).toBeNull();
            for (const c of [
                { effect: 'discussion.create', wire: creation },
                { effect: 'discussion.post', wire: { discussionId, ...post } },
                { effect: 'discussion.invite', wire: { discussionId,
                    participant: { kind: 'session', sessionId: 'cmv3revieweropinion' }, answerPolicy: 'when_addressed' } },
                { effect: 'discussion.participants.list', wire: { discussionId } },
            ] as const) {
                const request = bindHomeDomainHttpRequestV1({ transport: getActionSpec(c.effect).serverTransport!,
                    inputSchema: discussionActionHttpWireInputSchemaV1(c.effect), input: c.wire });
                expect(await f.verify(authorization, { ...request, routeInput: c.wire }, c.effect), c.effect).not.toBeNull();
                expect(await f.verify(authorization, { ...request, method: 'DELETE', routeInput: c.wire }, c.effect), c.effect).toBeNull();
            }
            const detail = DISCUSSION_HTTP_PATHS_V1.discussion.replace(':discussionId', discussionId);
            for (const effect of ['discussion.rename', 'discussion.access.grants.set', 'discussion.reply', 'artifact.update', 'doc.edit.accept']) {
                expect(await f.verify(authorization, { method: 'GET', path: detail }, effect), effect).toBeNull();
            }
            expect(await f.verify(authorization, { method: 'GET', path: '/v2/account/settings' })).toBeNull();
            const sourceGrant = { sessionId: source.message.session.sessionId, subject: { kind: 'account', accountId: 'chosen-person' },
                accessLevel: 'view', canApprovePermissions: false };
            const spec = getActionSpec('session.access.grant.set');
            const grantRequest = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema, input: sourceGrant });
            expect(await f.verify(authorization, { ...grantRequest, routeInput: sourceGrant,
                sessionRouteTarget: { kind: 'session', sessionId: sourceGrant.sessionId, actionId: 'session.access.grant.set' } },
                'session.access.grant.set')).not.toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: `/v2/sessions/${sourceGrant.sessionId}`,
                sessionRouteTarget: { kind: 'session', sessionId: sourceGrant.sessionId, actionId: 'session.transcript.get' } })).not.toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: `/v1/sessions/${sourceGrant.sessionId}/messages?scope=main&roles=agent&limit=100`,
                sessionRouteTarget: { kind: 'session', sessionId: sourceGrant.sessionId, actionId: 'session.transcript.get' } })).not.toBeNull();
            for (const denied of [
                { path: `/v2/sessions/${sourceGrant.sessionId}/messages/replies/pending`, actionId: 'session.transcript.get' },
                { path: `/v1/sessions/${sourceGrant.sessionId}/access/grants`, actionId: 'session.access.grants.list' },
            ] as const) {
                expect(await f.verify(authorization, { method: 'GET', path: denied.path,
                    sessionRouteTarget: { kind: 'session', sessionId: sourceGrant.sessionId, actionId: denied.actionId } })).toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it('retains a Second opinion Doc grant under its original signed root and exact Artifact codecs', async () => {
        const f = await fixture('discussion.second_opinion.start');
        const artifactId = 'source-doc';
        const source = { kind: 'doc_passage', passage: { ref: { kind: 'doc', artifactId, serverId: 'home-1' },
            revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 7 }, quote: 'Passage' } };
        const input = { intent: 'preview', source, title: 'Review', question: 'Check this', reviewers: [],
            retry: { creationLocalId: 'create-doc-opinion', quoteLocalId: 'quote-doc-opinion', questionLocalId: 'ask-doc-opinion' } };
        const grantBody = ArtifactAccessGrantSetInputV1Schema.parse({ artifactId,
            principal: { kind: 'account', accountId: 'chosen-person' }, accessLevel: 'view' });
        const commit = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse({ artifactId,
            expectedDataEncryptionKey: encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1)), recipientKeyEnvelopes: [] });
        try {
            const authorization = await f.mint('discussion.second_opinion.start', input, true);
            for (const effect of ['artifact.get', 'artifact.access.grants.set']) {
                for (const request of [
                    { method: 'GET', path: `/v1/artifacts/${artifactId}`, routeInput: { id: artifactId } },
                    { method: 'GET', path: '/v1/account/encryption/currentness', routeInput: {} },
                    { method: 'GET', path: `/v1/artifacts/${artifactId}/access/recipients`, routeInput: { id: artifactId } },
                    { method: 'POST', path: `/v1/artifacts/${artifactId}/access/key-envelopes`, body: commit, routeInput: { id: artifactId, ...commit } },
                ]) expect(await f.verify(authorization, request, effect), `${effect}: ${request.path}`).not.toBeNull();
            }
            const grant = { method: 'PUT', path: `/v1/artifacts/${artifactId}/access/grants`, body: grantBody,
                routeInput: { id: artifactId, ...grantBody } };
            expect(await f.verify(authorization, grant, 'artifact.access.grants.set')).not.toBeNull();
            expect(await f.verify(authorization, grant, 'artifact.get')).toBeNull();
            expect(await f.verify(authorization, { ...grant, body: { ...grantBody, artifactId: 'another-doc' } }, 'artifact.access.grants.set')).toBeNull();
            expect(await f.verify(authorization, { ...grant, body: { ...grantBody, unreviewed: true } }, 'artifact.access.grants.set')).toBeNull();
            expect(await f.verify(authorization, { ...grant, method: 'DELETE' }, 'artifact.access.grants.remove')).toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/artifacts' }, 'artifact.get')).toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['doc.comment.reply', 'doc.edit.propose'] as const)(
        'spends only the %s root credential on its consumed Discussion effects', async actionId => {
        const f = await fixture(actionId);
        const target = { ref: { kind: 'doc', artifactId: 'doc-1' }, revision: { headerVersion: 1, bodyVersion: 1 },
            range: { start: 0, end: 7 }, quote: 'Passage' };
        const input = actionId === 'doc.comment.reply' ? { target, localId: 'comment-1', content }
            : { target, discussionRef: { serverId: 'home-1', discussionId }, localId: 'proposal-1',
                baseRevision: target.revision, before: target.quote, after: 'Replacement', reason: 'Clarify' };
        const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'post-retry',
            content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] });
        const creation = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: 'doc-comment-retry',
            titleContent: { t: 'plain', v: { v: 1, title: 'Document comments' } },
            firstMessage: { localId: 'post-retry', content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] } });
        const cases = [
            { effect: 'discussion.read', wire: { discussionId, beforeSeq: 12 } },
            { effect: 'discussion.post', wire: { discussionId, ...post } },
            { effect: 'discussion.reply', wire: { discussionId, ...post,
                replyTarget: { kind: 'message', messageId: 'parent-1' } } },
            ...(actionId === 'doc.comment.reply' ? [{ effect: 'discussion.create', wire: creation } as const] : []),
        ] as const;
        try {
            const authorization = await f.mint(actionId, input);
            const accountAuthorization = await f.mint(actionId, input, true);
            for (const c of cases) {
                const effect = c.effect as DiscussionActionIdV1;
                const request = bindHomeDomainHttpRequestV1({ transport: getActionSpec(effect).serverTransport!,
                    inputSchema: discussionActionHttpWireInputSchemaV1(effect), input: c.wire });
                expect(await f.verify(authorization, { ...request, routeInput: c.wire }, effect), effect).not.toBeNull();
                expect(await f.verify(accountAuthorization, { ...request, routeInput: c.wire }, effect), effect).not.toBeNull();
                expect(await f.verify(authorization, { ...request, method: 'DELETE', routeInput: c.wire }, effect), effect).toBeNull();
                expect(await f.verify(authorization, { ...request, path: `${request.path}?extra=true`, routeInput: c.wire }, effect), effect).toBeNull();
                expect(await f.verify(authorization, { method: 'GET', path: '/v1/features/authenticated' }, effect)).not.toBeNull();
            }
            const detail = DISCUSSION_HTTP_PATHS_V1.discussion.replace(':discussionId', discussionId);
            expect(await f.verify(authorization, { method: 'GET', path: detail }, 'discussion.post')).not.toBeNull();
            if (actionId === 'doc.comment.reply') {
                expect(await f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' }, 'discussion.create')).not.toBeNull();
                expect(await f.verify(authorization, { method: 'GET', path:
                    `${DISCUSSION_HTTP_PATHS_V1.collection}?creationLocalId=doc-comment-retry&state=active` }, 'discussion.create')).not.toBeNull();
            } else {
                expect(await f.verify(authorization, { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.collection,
                    body: creation, routeInput: creation }, 'discussion.create')).toBeNull();
            }
            for (const effect of ['discussion.get', 'discussion.rename', 'discussion.access.grants.set',
                'artifact.update', 'doc.edit.accept', 'doc.edit.decline']) {
                expect(await f.verify(authorization, { method: 'GET', path: detail }, effect), effect).toBeNull();
            }
            expect(await f.verify(authorization, { method: 'GET', path: '/v2/account/settings' }, 'discussion.read')).toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path:
                DISCUSSION_HTTP_PATHS_V1.recipientCensus.replace(':discussionId', discussionId) }, 'discussion.create')).toBeNull();
            // Current root permissions and selected execution target are rechecked for every child spend.
            await auth.updateApiToken({ accountId: f.account.id, tokenId: f.pat.tokenId,
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
                    targets: { sessions: [], machines: ['another-machine'] } } });
            expect(await f.verify(authorization, { method: 'GET', path: detail }, 'discussion.read')).toBeNull();
            await auth.updateApiToken({ accountId: f.account.id, tokenId: f.pat.tokenId,
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['discussion.read'] },
                    targets: { sessions: [], machines: [f.machine.id] } } });
            expect(await f.verify(authorization, { method: 'GET', path: detail }, 'discussion.read')).toBeNull();
        } finally { await f.app.close(); }
    });

    it('spends a signed doc.read root on its read-only Artifact codec without sibling authority', async () => {
        const f = await fixture('doc.read');
        try {
            const authorization = await f.mint('doc.read', { ref: { kind: 'doc', artifactId: 'doc-1', serverId: 'home-1' } });
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/features/authenticated' }), 'current original root').not.toBeNull();
            for (const request of [
                { method: 'GET', path: '/v1/artifacts/doc-1', routeInput: { id: 'doc-1' } },
                { method: 'GET', path: '/v1/account/encryption/currentness', routeInput: {} },
                { method: 'GET', path: '/v1/features/authenticated' },
            ]) {
                expect(await f.verify(authorization, request, 'artifact.get'), request.path).not.toBeNull();
            }
            for (const request of [
                { method: 'GET', path: '/v1/artifacts' },
                { method: 'GET', path: '/v1/artifacts/doc-1?extra=true' },
                { method: 'GET', path: '/v1/artifacts/doc-1/access/recipients' },
                { method: 'POST', path: '/v1/artifacts/doc-1', body: {} },
                { method: 'GET', path: '/v1/artifacts/doc-1', routeInput: { id: 'doc-2' } },
            ]) expect(await f.verify(authorization, request, 'artifact.get'), request.path).toBeNull();
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/artifacts/doc-1' }, 'artifact.update')).toBeNull();
            await auth.updateApiToken({ accountId: f.account.id, tokenId: f.pat.tokenId,
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['artifact.get'] },
                    targets: { sessions: [], machines: [f.machine.id] } } });
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/artifacts/doc-1' }, 'artifact.get')).toBeNull();
        } finally { await f.app.close(); }
    });

    it('bounds signed doc.read counts to active Doc-filtered lists without Discussion read authority', async () => {
        const f = await fixture('doc.read');
        try {
            const input = { ref: { kind: 'doc', artifactId: 'doc-1', serverId: 'home-1' } };
            const list = DiscussionListInputV1Schema.parse({ state: 'active', anchorDocArtifactId: 'doc-1' });
            const bind = (actionId: DiscussionActionIdV1, wire: unknown) => ({
                ...bindHomeDomainHttpRequestV1({ transport: getActionSpec(actionId).serverTransport!,
                    inputSchema: discussionActionHttpWireInputSchemaV1(actionId), input: wire }), routeInput: wire,
            });
            const authorization = await f.mint('doc.read', input);
            for (const request of [
                { effect: 'discussion.list', ...bind('discussion.list', list) },
                { effect: 'discussion.list', ...bind('discussion.list', { ...list, cursor: 'next-page' }) },
                { effect: 'discussion.list', method: 'GET', path: '/v1/features/authenticated' },
            ]) expect(await f.verify(authorization, request, request.effect), request.path).not.toBeNull();
            for (const request of [
                { effect: 'discussion.list', ...bind('discussion.list', { state: 'active' }) },
                { effect: 'discussion.list', method: 'GET', path: bind('discussion.list', list).path.replace('state=active', 'state=archived'),
                    routeInput: { ...list, state: 'archived' } },
                { effect: 'discussion.list', ...bind('discussion.list', { ...list, creationLocalId: 'unrelated-create' }) },
                { effect: 'discussion.list', ...bind('discussion.list', { ...list, anchorSessionId: 'unrelated-session' }) },
                { effect: 'discussion.list', ...bind('discussion.list', { ...list, limit: 1 }) },
                { effect: 'discussion.list', ...bind('discussion.list', list), method: 'POST', body: {} },
                { effect: 'discussion.read', ...bind('discussion.get', { discussionId }) },
                { effect: 'discussion.read', ...bind('discussion.read', { discussionId, afterSeq: 0, throughSeq: 1, limit: 1 }) },
                { effect: 'discussion.get', ...bind('discussion.get', { discussionId }) },
                { effect: 'discussion.read', method: 'GET', path: `${DISCUSSION_HTTP_PATHS_V1.discussion.replace(':discussionId', discussionId)}?anchorDocArtifactId=doc-1`,
                    routeInput: { discussionId, anchorDocArtifactId: 'doc-1' } },
                { effect: 'discussion.read', method: 'GET', path: `${DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId)}?anchorDocArtifactId=doc-1&afterSeq=0&throughSeq=1&limit=1`,
                    routeInput: { discussionId, anchorDocArtifactId: 'doc-1', afterSeq: 0, throughSeq: 1, limit: 1 } },
                { effect: 'discussion.list', method: 'GET', path: '/v1/account/encryption/currentness' },
                { effect: 'discussion.read', method: 'GET', path: '/v1/features/authenticated' },
                { effect: 'discussion.read', method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.read.replace(':discussionId', discussionId), body: { seq: 1 } },
                { effect: 'discussion.list', method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.recipientCensus.replace(':discussionId', discussionId), routeInput: { discussionId } },
                { effect: 'discussion.list', ...bind('discussion.list', list), routeInput: { ...list, anchorDocArtifactId: 'doc-2' } },
                { effect: 'discussion.list', ...bind('discussion.list', list),
                    path: bind('discussion.list', list).path + '&anchorDocArtifactId=doc-2' },
            ]) expect(await f.verify(authorization, request, request.effect), request.path).toBeNull();
            await auth.updateApiToken({ accountId: f.account.id, tokenId: f.pat.tokenId,
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['discussion.list', 'discussion.read'] },
                    targets: { sessions: [], machines: [f.machine.id] } } });
            expect(await f.verify(authorization, bind('discussion.list', list), 'discussion.list')).toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['doc.edit.accept', 'doc.edit.decline'] as const)(
        'never lends %s authority to a Discussion post or Artifact mutation', async actionId => {
        const f = await fixture();
        try {
            const proposalRef = DiscussionMessageRefV1Schema.parse({ kind: 'discussion', discussion: { serverId: 'home-1', discussionId }, messageId: 'proposal-1' });
            const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'post-retry',
                content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] });
            const wire = { discussionId, ...post };
            const request = bindHomeDomainHttpRequestV1({ transport: getActionSpec('discussion.post').serverTransport!,
                inputSchema: discussionActionHttpWireInputSchemaV1('discussion.post'), input: wire });
            for (const person of [false, true]) {
                const authorization = await f.mint(actionId, { proposalRef,
                    ...(actionId === 'doc.edit.accept' ? { expectedRevision: { headerVersion: 1, bodyVersion: 1 } } : {}) }, person);
                expect(await f.verify(authorization, { ...request, routeInput: wire }, 'discussion.post')).toBeNull();
                expect(await f.verify(authorization, { ...request, routeInput: wire }, 'artifact.update')).toBeNull();
                const countInput = DiscussionListInputV1Schema.parse({ state: 'active', anchorDocArtifactId: 'doc-1' });
                const countRequest = bindHomeDomainHttpRequestV1({ transport: getActionSpec('discussion.list').serverTransport!,
                    inputSchema: discussionActionHttpWireInputSchemaV1('discussion.list'), input: countInput });
                expect(await f.verify(authorization, { ...countRequest, routeInput: countInput }, 'discussion.list')).toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it.each(['doc.edit.accept', 'doc.edit.decline'] as const)(
        'spends the present-person %s root only on its prepared decision and read phases', async actionId => {
        const f = await fixture();
        const proposalRef = DiscussionMessageRefV1Schema.parse({ kind: 'discussion', discussion: { serverId: 'home-1', discussionId }, messageId: 'proposal-1' });
        const input = { proposalRef,
            ...(actionId === 'doc.edit.accept' ? { expectedRevision: { headerVersion: 1, bodyVersion: 1 } } : {}) };
        const packet = { ...input, ...(actionId === 'doc.edit.accept' ? { preparation: {
            doc: { ref: { kind: 'doc', artifactId: 'doc-1', serverId: 'home-1' }, revision: { headerVersion: 1, bodyVersion: 1 } },
            body: 'encoded-artifact-content' } } : {}) };
        const path = actionId === 'doc.edit.accept' ? DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept : DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.decline;
        try {
            const present = await f.mint(actionId, input, true);
            const automation = await f.mint(actionId, input);
            expect((actionId === 'doc.edit.accept' ? DocEditAcceptTransportInputV1Schema : DocEditDeclineTransportInputV1Schema).safeParse(packet).success).toBe(true);
            expect(await f.verify(present, { method: 'GET', path: '/v1/features/authenticated' }, actionId), 'root signature and current credential').not.toBeNull();
            for (const request of [
                { effect: actionId, method: 'POST', path, body: packet, routeInput: packet },
                ...(actionId === 'doc.edit.accept' ? [
                    { effect: 'discussion.read', method: 'GET', path: `${DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId)}?beforeSeq=5`,
                        routeInput: { discussionId, beforeSeq: 5 } },
                    { effect: 'discussion.read', method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.discussion.replace(':discussionId', discussionId), routeInput: { discussionId } },
                    { effect: 'artifact.get', method: 'GET', path: '/v1/artifacts/doc-1', routeInput: { id: 'doc-1' } },
                    { effect: 'artifact.get', method: 'GET', path: '/v1/account/encryption/currentness', routeInput: {} },
                ] : []),
            ]) {
                expect(await f.verify(present, request, request.effect), request.effect).not.toBeNull();
                expect(await f.verify(automation, request, request.effect), request.effect).toBeNull();
                expect(await f.verify(present, { ...request, method: 'DELETE' }, request.effect), request.effect).toBeNull();
            }
            expect(await f.verify(present, { method: 'POST', path, body: { ...packet, presentPerson: true } }, actionId)).toBeNull();
            expect(await f.verify(present, { method: 'POST', path: '/v1/artifacts/doc-1', body: packet }, 'artifact.update')).toBeNull();
            expect(await f.verify(present, { method: 'GET', path: '/v1/artifacts' }, 'artifact.get')).toBeNull();
            expect(await f.verify(present, { method: 'GET', path: '/v1/artifacts/doc-1?extra=true' }, 'artifact.get')).toBeNull();
            expect(await f.verify(present, { method: 'POST', path: actionId === 'doc.edit.accept'
                ? DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.decline : DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept, body: packet }, actionId)).toBeNull();
        } finally { await f.app.close(); }
    });

    it('admits canonical reads, stored writes and grants without an owning Session', async () => {
        const f = await fixture();
        const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'post-retry',
            content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] });
        const firstMessage = { localId: 'first-retry', content, mentionedAccountIds: [] };
        const creation = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: 'create-retry',
            titleContent: { t: 'plain', v: { v: 1, title: 'Title' } },
            firstMessage: { ...firstMessage, content: { t: 'plain', v: content }, authoredContent: content } });
        const rename = buildDiscussionMutationRequestBodyV1({ kind: 'rename',
            titleContent: { t: 'plain', v: { v: 1, title: 'Renamed' } } });
        const replyTarget = { kind: 'message' as const, messageId: 'committed-message' };
        const cases = [
            { actionId: 'discussion.get', input: { discussionId }, wire: { discussionId } },
            { actionId: 'discussion.create', input: { title: 'Title', creationLocalId: 'create-retry', firstMessage }, wire: creation },
            { actionId: 'discussion.post', input: { discussionId, localId: 'post-retry', content }, wire: { discussionId, ...post } },
            { actionId: 'discussion.reply', input: { discussionId, localId: 'post-retry', content, replyTarget }, wire: { discussionId, ...post, replyTarget } },
            { actionId: 'discussion.rename', input: { discussionId, title: 'Renamed' }, wire: { discussionId, ...rename } },
            { actionId: 'discussion.access.grants.set', input: { discussionId, ...grant }, wire: { discussionId, ...grant } },
            { actionId: 'discussion.access.grants.remove', input: { discussionId, principal: grant.principal }, wire: { discussionId, principal: grant.principal } },
        ] as const;
        try {
            for (const c of cases) {
                const authorization = await f.mint(c.actionId, c.input,
                    c.actionId === 'discussion.create' || c.actionId === 'discussion.rename');
                const transport = getActionSpec(c.actionId).serverTransport!;
                const request = bindHomeDomainHttpRequestV1({ transport,
                    inputSchema: discussionActionHttpWireInputSchemaV1(c.actionId), input: c.wire });
                expect(await f.verify(authorization, { ...request, routeInput: c.wire }), c.actionId).not.toBeNull();
                expect(await f.verify(authorization, { ...request,
                    method: request.method === 'DELETE' ? 'PATCH' : 'DELETE', routeInput: c.wire }), c.actionId).toBeNull();
                expect(await f.verify(authorization, { ...request, path: `${request.path}?extra=true`, routeInput: c.wire }), c.actionId).toBeNull();
                expect(await f.verify(authorization, { ...request, routeInput: { ...c.wire, sessionId: 'not-an-owner' } }), c.actionId).toBeNull();
                expect(await f.verify(authorization, { ...request, body: { extra: true }, routeInput: c.wire }), c.actionId).toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it('admits only the selected root preparation phases and strict recipient commits', async () => {
        const f = await fixture();
        const inputs = [
            { actionId: 'discussion.create', input: { title: 'Title', creationLocalId: 'create-retry',
                firstMessage: { localId: 'first-retry', content } } },
            { actionId: 'discussion.invite', input: { discussionId, participant: { kind: 'account', accountId: 'chosen-person' } } },
            { actionId: 'discussion.access.grants.set', input: { discussionId, ...grant } },
            { actionId: 'discussion.post', input: { discussionId, localId: 'post-retry', content } },
            { actionId: 'discussion.read', input: { discussionId } },
            { actionId: 'discussion.reply', input: { discussionId, content,
                replyTarget: { kind: 'message', messageId: 'committed-message' } } },
            { actionId: 'discussion.rename', input: { discussionId, title: 'Title' } },
        ] as const;
        const detail = DISCUSSION_HTTP_PATHS_V1.discussion.replace(':discussionId', discussionId);
        const census = DISCUSSION_HTTP_PATHS_V1.recipientCensus.replace(':discussionId', discussionId);
        const envelopes = DISCUSSION_HTTP_PATHS_V1.recipientEnvelopes.replace(':discussionId', discussionId);
        const commit = { expectedDataEncryptionKey: encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1)), recipientKeyEnvelopes: [] };
        try {
            for (const c of inputs) {
                const authorization = await f.mint(c.actionId, c.input,
                    c.actionId === 'discussion.create' || c.actionId === 'discussion.rename');
                if (c.actionId === 'discussion.create') {
                    expect(await f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' })).not.toBeNull();
                    for (const state of ['active', 'archived']) {
                        expect(await f.verify(authorization, { method: 'GET', path:
                            `${DISCUSSION_HTTP_PATHS_V1.collection}?creationLocalId=create-retry&state=${state}&cursor=next` })).not.toBeNull();
                    }
                    expect(await f.verify(authorization, { method: 'GET', path: `${DISCUSSION_HTTP_PATHS_V1.collection}?state=active` })).toBeNull();
                    expect(await f.verify(authorization, { method: 'GET', path: `${DISCUSSION_HTTP_PATHS_V1.collection}?creationLocalId=create-retry&unknown=true` })).toBeNull();
                } else {
                    expect(await f.verify(authorization, { method: 'GET', path: detail })).not.toBeNull();
                    expect(await f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' })).toBeNull();
                }
                if (c.actionId === 'discussion.create' || c.actionId === 'discussion.invite'
                    || c.actionId === 'discussion.access.grants.set') {
                    expect(await f.verify(authorization, { method: 'GET', path: census })).not.toBeNull();
                    expect(await f.verify(authorization, { method: 'PUT', path: envelopes, body: commit })).not.toBeNull();
                    expect(await f.verify(authorization, { method: 'PUT', path: envelopes, body: { ...commit, extra: true } })).toBeNull();
                } else {
                    expect(await f.verify(authorization, { method: 'GET', path: census })).toBeNull();
                    expect(await f.verify(authorization, { method: 'PUT', path: envelopes, body: commit })).toBeNull();
                }
                expect(await f.verify(authorization, { method: 'GET', path: '/v2/account/settings' })).toBeNull();
                expect(await f.verify(authorization, { method: 'GET', path: '/v2/sessions/anchor' })).toBeNull();
                expect(await f.verify(authorization, { method: 'GET', path: detail }, 'discussion.get')).toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it('does not grant content or key preparation to metadata-only management', async () => {
        const f = await fixture();
        try {
            const authorization = await f.mint('discussion.leave', { discussionId }, true);
            const path = DISCUSSION_HTTP_PATHS_V1.leave.replace(':discussionId', discussionId);
            expect(await f.verify(authorization, { method: 'POST', path, body: {}, routeInput: { discussionId } })).not.toBeNull();
            for (const path of [DISCUSSION_HTTP_PATHS_V1.discussion, DISCUSSION_HTTP_PATHS_V1.recipientCensus]) {
                expect(await f.verify(authorization, { method: 'GET', path: path.replace(':discussionId', discussionId) })).toBeNull();
            }
        } finally { await f.app.close(); }
    });

    it('does not turn an automation token into present-user creation authority', async () => {
        const f = await fixture();
        try {
            const authorization = await f.mint('discussion.create', { title: 'Title',
                firstMessage: { localId: 'first-retry', content } });
            expect(await f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' })).toBeNull();
        } finally { await f.app.close(); }
    });
});
