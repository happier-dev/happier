import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { Server, type Socket } from 'socket.io';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionAuthorizationVerifyRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { DiscussionPostInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionAttachmentUploadRequestV1Schema, readDiscussionAttachmentAgentPublicationV1, signDiscussionAttachmentAgentUploadV1,
    verifyDiscussionAttachmentAgentUploadV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import { buildDiscussionAttachmentBindingsV1, buildDiscussionMutationRequestBodyV1, DISCUSSION_AGENT_POST_EVENT_V1, DiscussionMessagesResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { accountSettingsParse, encodePasswordCredentialFieldV1 } from '@happier-dev/protocol';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createResourceDataKey } from '../../../../../../cli/src/api/encryption/resourceDataKey';
import { openResourceBinaryContent } from '../../../../../../cli/src/api/encryption/resourceBinaryContent';
import { sealSessionStoredContent, openSessionStoredContent } from '../../../../../../cli/src/session/transport/encryption/sessionStoredContentCodec';
import { buildSessionMetadataEnvelopeFields } from '../../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createHappierMcpServer } from '../../../../../../cli/src/mcp/createHappierMcpServer';
import { createSessionDaemonAuthorityFixture } from '../../../../../../cli/src/mcp/runtime/sessionDaemonAuthority.testkit';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '../../../../../../cli/src/testkit/backends/sessionMetadata';
import type { AgentInvocationTurnAdmissionWitness } from '../../../../../../cli/src/plugins/runtime/invocation/services/types';
import { createMachineDataEncryptionKeyV1, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionMessageReplyReadResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import { auth } from '@/app/auth/auth';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { normalizeSocketHandshakeClientType } from '@/app/api/socket';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerAuthPingRoute } from '../auth/registerAuthPingRoute';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerDiscussionRoutes } from '../discussions/registerDiscussionRoutes';
import { registerSessionListingRoutes } from '../session/registerSessionListingRoutes';
import { registerSessionPatchRoute } from '../session/registerSessionPatchRoute';
import { registerSessionMessageRoutes } from '../session/registerSessionMessageRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../account/registerAccountSettingsRoutes';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { kvRoutes } from '../kv/kvRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { admitInstalledDiscussionPublisherInTx } from '@/app/discussions/installedPublisherAdmission';
import { inviteDiscussionParticipant, removeDiscussionParticipant, setDiscussionParticipantPolicy } from '@/app/discussions/accessService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { resolveVerifiedMachineSocketInstallationId, VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { createCliActionExecutor } from '../../../../../../cli/src/session/actions/createCliActionExecutor';
import { createCliApprovalsArtifactStore } from '../../../../../../cli/src/session/actions/approvals/artifactStore';
import { createDaemonSessionAccountActionExecutor } from '../../../../../../cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareExternalActionRequesterAccountAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { readOrCreateInstallationIdentity } from '../../../../../../cli/src/daemon/identity/store';
import { createApprovedDiscussionAgentPublisher } from '../../../../../../cli/src/discussions/approvedDiscussionAgentPublisher';
import { ApiMachineClient } from '../../../../../../cli/src/api/apiMachine';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createStopSession } from '../../../../../../cli/src/daemon/sessions/stopSession';
import { createOnChildExited } from '../../../../../../cli/src/daemon/sessions/onChildExited';
import { retireExactTerminalControlServiceability } from '../../../../../../cli/src/daemon/sessions/retireTerminalControlServiceability';
import { readProcessIdentityByPid } from '../../../../../../cli/src/daemon/processIdentity';
import { projectMachineRpcTransportAcknowledgement } from '../../../../../../cli/src/api/machine/projectMachineRpcTransportAcknowledgement';
import { buildCurrentCliClientCompatibilitySocketAuth, buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { createConnectedServiceCredentialApi } from '../../../../../../cli/src/api/client/connectedServiceCredentialApi';
import { hasStoredSessionCredentialProvenance, readStoredCredentialsForServerId, writeCredentialsTokenOnlyForServerId, type StoredCredentials } from '../../../../../../cli/src/persistence';
import type { TrackedSession } from '../../../../../../cli/src/daemon/types';
import { configuration } from '../../../../../../cli/src/configuration';
import { ConnectedServiceRuntimeRegistry } from '../../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createServerUrlServerFeaturesSnapshotStore } from '../../../../../../cli/src/features/serverFeaturesSnapshotStore';

const document = (text: string) => ({ t: 'plain' as const, v: { v: 1 as const, parts: [{ t: 'text' as const, text }] } });

describe.skipIf(process.platform !== 'linux')('signed private Discussion draft after person Stop', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-reviewed-discussion-stop-',
        initAuth: true, initEncrypt: true, initFiles: true, env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS__ENABLED: '1',
            HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } }); }, 300_000);
    afterAll(async () => { resetInMemoryAccountSettingsContextForTests(); await database?.close(); });

    it.each(['none', 'attachment-local', 'attachment-signed', 'attachment-signed-post', 'attachment-e2ee-mcp-post-terminal-daemon', 'attachment-source-mismatch', 'policy-withdrawn', 'session-access', 'participant', 'account-credential', 'home-unavailable', 'wrong-machine',
        'stop-during-publication', 'stop-after-commit-lost-ack', 'stop-during-preparation-read'] as const)(
        'posts the exact signed private draft after canonical Stop only without real revocation (%s)', async revocation => {
        const e2eeMcp = revocation === 'attachment-e2ee-mcp-post-terminal-daemon';
        const accountMode = e2eeMcp ? 'e2ee' as const : 'plain' as const;
        const sourceMismatch = revocation === 'attachment-source-mismatch';
        const attachmentPost = revocation === 'attachment-signed-post' || e2eeMcp || sourceMismatch;
        const attached = revocation === 'attachment-local' || revocation === 'attachment-signed' || attachmentPost;
        const stopDuringReplay = revocation === 'stop-during-publication' || revocation === 'stop-after-commit-lost-ack'
            || revocation === 'stop-during-preparation-read';
        const contentKeys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { encryptionMode: accountMode,
            ...(e2eeMcp ? createSignedAccountContentBinding(contentKeys.publicKey) : {}) } });
        await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerUserId: `${account.id}@review.test`, profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: { v: 1, kind: 'plain_password_hash', hash: {
            v: 1, algorithm: 'scrypt', parameters: { n: 16_384, r: 8, p: 5, keyLength: 32 },
            salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)), digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)) } } } });
        const installation = await readOrCreateInstallationIdentity();
        const machineKey = e2eeMcp ? createMachineDataEncryptionKeyV1({ material: { type: 'dataKey', machineKey: contentKeys.secretKey },
            dataKeyPublicKey: contentKeys.publicKey, randomBytes: tweetnacl.randomBytes }) : null;
        const machineContent = machineKey ? sealSessionStoredContent({ mode: 'e2ee', ctx: {
            encryptionKey: machineKey.encryptionKey, encryptionVariant: 'dataKey' }, payload: {} }) : null;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: installation.installationId,
            installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), metadata: machineContent?.t === 'encrypted'
                ? machineContent.c : encodePlainMachineStoredContent({}),
            dataEncryptionKey: machineKey ? new Uint8Array(machineKey.dataEncryptionKey) : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } } } });
        const personToken = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials: StoredCredentials = { token: e2eeMcp
            ? await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' }) : personToken,
            encryption: e2eeMcp ? { type: 'dataKey', publicKey: contentKeys.publicKey, machineKey: contentKeys.secretKey } : null };
        const sessionKey = await createResourceDataKey({ credentials, mode: accountMode });
        const sessionCrypto = sessionKey.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
            : { mode: 'e2ee' as const, ctx: { encryptionKey: sessionKey.dataKey, encryptionVariant: 'dataKey' as const } };
        const sessionDocument = (text: string) => sealSessionStoredContent({ ...sessionCrypto,
            payload: { v: 1, parts: [{ t: 'text', text }] } });
        const discussionKey = await createResourceDataKey({ credentials, mode: accountMode });
        const discussionCrypto = discussionKey.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
            : { mode: 'e2ee' as const, ctx: { encryptionKey: discussionKey.dataKey, encryptionVariant: 'dataKey' as const } };
        const equality = (canonicalIntent: string) => discussionKey.mode === 'e2ee'
            ? { kind: 'e2eeTag' as const, tag: deriveDiscussionMutationEqualityTagV1({ dataKey: discussionKey.dataKey, canonicalIntent }) } : undefined;
        const homeId = await getOrCreateServerIdentityId();
        expect(await initializeServerIdentityCache(), 'Fixture startup-published Home identity').toBe(homeId);
        const serverId = homeId;
        const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"],
            { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = once(child, 'exit');
        let apiMachine: ApiMachineClient | undefined;
        let closeSockets: (() => Promise<void>) | undefined;
        let closeHttp: (() => Promise<void>) | undefined;
        let startup: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
        try {
        await once(child, 'message');
        const pid = child.pid!;
        const identity = await readProcessIdentityByPid(pid);
        if (!identity) throw new Error('Owned test process identity unavailable');
        const metadata = { machineId: machine.id, path: database.baseDir, hostPid: pid, permissionMode: 'default',
            hostProcessStartTimeMs: identity.processStartTimeMs, startedBy: 'daemon', sessionDirectoryV1: { v: 1, kind: 'managed' } };
        const metadataFields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: accountMode, metadata,
            agentState: null, ...(sessionKey.mode === 'plain' ? { storedContentMode: 'plain' as const }
                : { storedContentMode: 'e2ee' as const, encryptionKey: sessionKey.dataKey, encryptionVariant: 'dataKey' as const }) });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: accountMode, metadataLayoutVersion: 1,
            metadata: metadataFields.sharedMetadata.ciphertext, ownerMetadata: JSON.stringify(metadataFields.ownerMetadata),
            ...(sessionKey.mode === 'e2ee' ? { dataKeyEnvelopes: { create: { recipientAccountId: account.id,
                encryptedDataKey: new Uint8Array(decodeBase64(sessionKey.dataEncryptionKey)) } } } : {}), seq: 1 } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'opaque' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const title = { v: 1 as const, title: 'Retained private Post' };
        const firstMessage = { localId: randomUUID(), content: document('Context').v, mentionedAccountIds: [] };
        const created = await createDiscussion({ actorAccountId: account.id, authentication, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: randomUUID(), titleContent: sealSessionStoredContent({ ...discussionCrypto, payload: title }),
            creationEqualityEvidenceV1: equality(serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title, firstMessage })),
            ...(discussionKey.mode === 'e2ee' ? { dataEncryptionKey: discussionKey.dataEncryptionKey,
                expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentKeys.publicKey) } : {}),
            firstMessage: { ...firstMessage, authoredContent: firstMessage.content,
                content: sealSessionStoredContent({ ...discussionCrypto, payload: firstMessage.content }),
                requestEqualityEvidenceV1: equality(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...firstMessage })) } }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ actorAccountId: account.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: e2eeMcp ? 'when_addressed' : 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const question = { content: DiscussionPostInputV1Schema.shape.content.parse({ v: 1, parts: e2eeMcp
            ? [{ t: 'text', text: 'Unaddressed owned context' }]
            : [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] }),
            mentionedAccountIds: [], mentionedSessionIds: e2eeMcp ? [] : [session.id] };
        const asked = await postDiscussionMessage({ actorAccountId: account.id, authentication, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', ...question, localId: randomUUID(), authoredContent: question.content,
                content: sealSessionStoredContent({ ...discussionCrypto, payload: question.content }),
                requestEqualityEvidenceV1: equality(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...question })) }) });
        if (!asked.ok) throw new Error(asked.error);
        const addressing = { discussionId, messageId: asked.value.message.id, throughSeq: asked.value.message.seq, participantSessionId: session.id };
        const inputId = deriveDiscussionFollowInputLocalIdV1(addressing);
        const turnId = randomUUID();
        const progress = e2eeMcp ? null : await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: account.id, reply: { mode: 'return', discussion: addressing } }));
        if (!e2eeMcp && !progress) throw new Error('Original Discussion return custody unavailable');
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: inputId, seq: 1, messageRole: 'user', content: sessionDocument(e2eeMcp ? 'Create an owned file and request its Discussion post through MCP.' : 'Original addressed input'),
            ...(progress ? { replyProgress: { ...progress, acceptedTurnId: turnId }, replyDisposition: progress.disposition, replyTargetMachineId: machine.id } : {}) } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId, status: 'in_progress', startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, userMessageSeqs: [1] }) } });
        const emptyFinal = { v: 1, sessionId: session.id, mutationId: randomUUID(), action: 'complete', turnId,
            observedAt: 3, transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1] } } satisfies SessionTurnMutationV1;
        const presence = createSessionPublisherPresence();
        const publisherSocket = {};
        expect(await presence.registerPublisher({ socket: publisherSocket, binding: { accountId: account.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
        const tracked: TrackedSession = { pid, childProcess: child, startedBy: 'daemon', happySessionId: session.id,
            processStartTimeMs: identity.processStartTimeMs, spawnOptions: { directory: database.baseDir } };
        const sessions = new Map([[pid, tracked]]);
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        const httpOutcomes: string[] = [];
        const uploadAdmissions: Array<{ status: number; tokenKind: string; externalAction: boolean }> = [];
        let capturedAgentUpload: Buffer | undefined;
        let phase = 'HTTP startup';
        let interruptPreparationRead: (() => Promise<void>) | undefined;
        let refuseDifferentBlob: (() => Promise<void>) | undefined;
        let preparationReadInterrupted = false;
        onTestFailed(async () => {
            // Project only admission facts, never the private upload or approval.
            let uploadFacts: unknown;
            if (capturedAgentUpload) {
                const metadata = DiscussionAttachmentUploadRequestV1Schema.parse(JSON.parse(
                    capturedAgentUpload.subarray(0, capturedAgentUpload.indexOf(10)).toString('utf8')));
                const publication = readDiscussionAttachmentAgentPublicationV1(metadata);
                if (metadata.operation !== 'encryption-conversion' && metadata.agent && publication) {
                    const agent = metadata.agent;
                    const admission = await inTx(tx => admitInstalledDiscussionPublisherInTx(tx, { accountId: account.id,
                        machineId: agent.machineId, installationId: agent.installationId,
                        source: { sessionId: publication.sessionId, sourceSession: publication.sourceSession } }));
                    const review = 'draftReview' in publication && publication.draftReview
                        ? await db.artifact.findUnique({ where: { id: publication.draftReview.artifactId },
                            select: { accountId: true, kind: true, approvalSessionId: true, deletedAt: true } }) : null;
                    uploadFacts = { publisherAdmission: admission.ok ? 'admitted' : admission.error,
                        signatureValid: verifyDiscussionAttachmentAgentUploadV1({ homeId, accountId: account.id,
                            metadata, publicKey: decodeBase64(installation.publicKey, 'base64url'), signature: agent.signature }),
                        reviewed: 'draftReview' in publication && Boolean(publication.draftReview),
                        sourcePresent: Boolean(publication.sourceSession), reviewFound: Boolean(review),
                        reviewAccountMatches: review?.accountId === account.id, reviewKind: review?.kind,
                        reviewSessionMatches: review?.approvalSessionId === publication.sessionId, reviewDeleted: Boolean(review?.deletedAt) };
                }
            }
            console.error('Discussion Stop composition:', { revocation, phase, httpOutcomes, uploadAdmissions, uploadFacts });
        });
        app.addHook('onResponse', async (request, reply) => {
            // Boundary diagnostics exclude credentials, query strings and bodies.
            httpOutcomes.push(`${request.method} ${request.url.split('?')[0]} ${reply.statusCode}`);
            if (request.url === '/v1/discussions/upload') uploadAdmissions.push({ status: reply.statusCode,
                tokenKind: request.authTokenKind ?? 'unknown', externalAction: request.externalActionExecutionAuthorized === true });
        });
        app.addHook('preHandler', async (request, reply) => {
            // Observe the actual E2EE upload at the network boundary, then
            // restore its exact stream. Never synthesize the positive carrier.
            if (e2eeMcp && request.method === 'POST' && request.url === '/v1/discussions/upload' && !capturedAgentUpload) {
                if (!(request.body instanceof Readable)) throw new Error('Upload byte stream unavailable');
                const chunks: Buffer[] = [];
                for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
                capturedAgentUpload = Buffer.concat(chunks);
                request.body = Readable.from([capturedAgentUpload]);
            }
            if (request.method === 'POST' && request.url === '/v1/discussions/upload' && refuseDifferentBlob) {
                const check = refuseDifferentBlob;
                refuseDifferentBlob = undefined;
                await check();
            }
            if (request.method !== 'GET' || request.url.split('?')[0] !== `/v1/discussions/${discussionId}`
                || !interruptPreparationRead) return;
            const interrupt = interruptPreparationRead;
            interruptPreparationRead = undefined;
            await interrupt();
            preparationReadInterrupted = true;
            reply.hijack();
            reply.raw.destroy();
        });
        closeHttp = () => app.close();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); enableAuthentication(app);
        // Replace socket-room discovery only. Its answer follows the real
        // tracked-runner owner that canonical Stop retires below.
        app.decorate('resolveCurrentSessionMachine', async () => sessions.has(pid) ? machine.id : null);
        registerAuthPingRoute(app);
        registerExternalActionRoutes(app); registerDiscussionRoutes(app); registerSessionListingRoutes(app); registerSessionPatchRoute(app);
        registerSessionMessageRoutes(app); registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app); registerAccountProfileRoute(app);
        artifactsRoutes(app); kvRoutes(app); featuresRoutes(app);
        const io = new Server(app.server, { path: '/v1/updates' });
        closeSockets = () => new Promise<void>(resolve => io.close(() => resolve()));
        let resolveMachineConnection: ((socket: Socket) => void) | undefined;
        let rejectMachineConnection: ((error: Error) => void) | undefined;
        const machineConnection = new Promise<Socket>((resolve, reject) => {
            resolveMachineConnection = resolve; rejectMachineConnection = reject;
        });
        let beforePublication: (() => Promise<void>) | undefined;
        let afterPublication: (() => Promise<void>) | undefined;
        io.use(async (socket, next) => {
            try {
                const token: unknown = socket.handshake.auth.token;
                if (typeof token !== 'string') throw new Error('Fixture handshake has no token');
                const verified = await auth.verifyTokenForRoute(token);
                const clientType = normalizeSocketHandshakeClientType(socket.handshake.auth.clientType);
                if (!verified || verified.userId !== account.id || !['account', 'terminal'].includes(verified.authTokenKind)
                    || !['machine-scoped', 'user-scoped'].includes(clientType)) throw new Error('Fixture handshake principal mismatch');
                Object.assign(socket.data, { userId: verified.userId, authTokenKind: verified.authTokenKind,
                    authAuthority: narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling),
                    authTokenAuthenticationEvidence: verified.authenticationEvidence, clientType });
                if (clientType === 'machine-scoped') {
                    if (socket.handshake.auth.machineId !== machine.id) throw new Error('Fixture Machine routing mismatch');
                    const installationId = resolveVerifiedMachineSocketInstallationId({ accountId: account.id,
                        machineId: machine.id, machine, socketAuth: socket.handshake.auth });
                    if (installationId !== installation.installationId) throw new Error('Fixture Machine installation proof unavailable');
                    Object.assign(socket.data, { machineId: machine.id,
                        [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId });
                }
                const compatibility = evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth);
                if (!compatibility.evaluation.supportsCurrentProtocol) throw new Error('Fixture Machine compatibility declaration unavailable');
                writeAccountStoredContentCompatibilityForSocket(socket, compatibility);
                next();
            } catch (error) {
                const refusal = error instanceof Error ? error : new Error('Fixture Machine admission failed');
                rejectMachineConnection?.(refusal); next(refusal);
            }
        });
        io.on('connection', async socket => {
            await socket.join(`user:${account.id}`);
            // The canonical requester encryption observer uses this ordinary
            // authenticated user channel before reading currentness via HTTP.
            if (socket.data.clientType !== 'machine-scoped') return;
            // Pause the real incoming publication or its committed ACK at the
            // network boundary; the actual Stop and append owners stay real.
            socket.use((packet, next) => {
                if (packet[0] !== DISCUSSION_AGENT_POST_EVENT_V1) return next();
                if (revocation === 'none') expect(packet[1]).not.toHaveProperty('terminalReturn');
                if (afterPublication) {
                    const acknowledge = packet.at(-1);
                    if (typeof acknowledge !== 'function') return next(new Error('Publication ACK unavailable'));
                    packet[packet.length - 1] = async () => {
                        await afterPublication?.();
                        acknowledge({ committedButAcknowledgementUnavailable: true });
                    };
                }
                void Promise.resolve().then(() => beforePublication?.()).then(() => next(), error => next(error));
            });
            // The real token, installation and compatibility owners above
            // consume the actual ApiMachineClient handshake before dispatch.
            machineUpdateHandler(account.id, socket, { sessionPublisherPresence: presence,
                operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
            resolveMachineConnection?.(socket);
        });
        const serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const serverFeatures = createServerUrlServerFeaturesSnapshotStore({ serverUrl: serverHttpBaseUrl, token: credentials.token });
            await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
                await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
                apiMachine = new ApiMachineClient(credentials.token, { id: machine.id, metadata: null,
                    metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
                    ...(machineKey ? { encryptionMode: 'e2ee', encryptionKey: machineKey.encryptionKey, encryptionVariant: 'dataKey' }
                        : { encryptionMode: 'plain' }) });
                apiMachine.connect();
                const admittedMachineSocket = await machineConnection;
                expect(await createConnectedServiceCredentialApi(credentials).getAccountEncryptionMode({ refresh: true,
                    throwOnTransportError: true }), `Fixture Account mode: ${JSON.stringify(httpOutcomes)}`).toBe(accountMode);
                const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId: machine.id,
                    serverId, serverApiUrl: serverHttpBaseUrl, isSessionCallerCurrent: async () => sessions.has(pid) });
                if (!currentness) throw new Error('Canonical credential-backed approval currentness unavailable');
                const publisher = createApprovedDiscussionAgentPublisher({ credentials, machineId: machine.id, serverId, serverUrl: serverHttpBaseUrl,
                    isApprovalExecutionOriginCurrent: currentness, publish: (publication, options) => apiMachine!.postAgentDiscussionMessage(publication, options) });
                let decideOnDaemon: ReturnType<typeof createCliActionExecutor>['execute'] | undefined;
                const createExecutor = (executionCredentials: StoredCredentials, forwardApprovedReplay = false): ReturnType<typeof createCliActionExecutor> => createCliActionExecutor({ credentials: executionCredentials,
                    token: executionCredentials.token, serverId, serverIdentityId: homeId,
                    serverHttpBaseUrl, sessionId: session.id, ...sessionCrypto, isApprovalExecutionOriginCurrent: currentness,
                    externalActionMachineRequestPrivateKey: installation.privateKey,
                    externalActionMachineInstallationId: installation.installationId,
                    // Substitute only the exact-daemon RPC network hop. The
                    // actual deciding executor admits the stored interactive
                    // credential before a fresh credential-bound replay owner
                    // consumes its authenticated authority.
                    ...(forwardApprovedReplay ? { approvalRequestApprovedReplay: async ({ artifactId, decision, context, signal }) => {
                        if (!decideOnDaemon) throw new Error('Fixture actual daemon decision is unavailable');
                        return await decideOnDaemon('approval.request.decide', { artifactId, decision: decision ?? 'approve' }, {
                            ...context, serverId, serverIdentityId: homeId, runtimeAccountId: account.id,
                            ...(signal ? { signal } : {}),
                        });
                    } } : {}),
                    postAgentDiscussionMessage: async () => { throw new Error('Only the actual startup replay owner may publish this private body'); } });
                const executor = createExecutor(credentials);
                const capture = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token: credentials.token, credentials, machineId: machine.id,
                    resolveServerFeaturesSnapshot: () => serverFeatures.refresh(),
                    ...(!e2eeMcp ? { prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, isCallerCurrent }) => {
                        const target = { kind: 'machine' as const, machineId: machine.id };
                        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: operation.actionId, input: operation.input,
                            requestId: operation.requestId, target, machineId: machine.id, sourceMachineId: machine.id, accountId: account.id,
                            accountEncryptionMode: 'plain', tokenEpochHint: account.tokenEpoch, token: credentials.token, serverId, serverIdentityId: homeId,
                            serverHttpBaseUrl, installationId: machine.installationId!, privateKey: installation.privateKey, sessionActionOrigin, isCurrent: isCallerCurrent });
                        return authorization ? { authorization, target } : null;
                    } } : {}), createExecutor: () => ({ execute: (actionId, input, context) => executor.execute(actionId, input, { ...context,
                        serverIdentityId: homeId, runtimeAccountId: account.id, signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({
                            authorizationToken: args.authorization.token, actionId: args.actionId, input: args.input, target: args.target, privateKey: installation.privateKey }) }) }) });
                const sourceText = 'The approved workspace file.';
                const bytes = new TextEncoder().encode(sourceText + '\n');
                const blobId = randomUUID();
                const sourcePath = join(database.baseDir, `${blobId}.txt`);
                // R45's Agent wrote a literal backslash+n while its approved
                // reference described one newline. Keep that real OS mismatch
                // through signed approval, streaming HTTP and the message writer.
                if (attached) await writeFile(sourcePath, sourceMismatch ? sourceText + '\\n' : bytes);
                const attachmentSources = attached ? [{ blobId, path: sourcePath }] : undefined;
                const content = DiscussionPostInputV1Schema.shape.content.parse({ v: 1, parts: attached ? [{ t: 'attachment', attachment: {
                    kind: 'file', id: blobId, name: 'evidence.txt', file: { blobId, mime: 'text/plain', sizeBytes: bytes.length,
                        sha256: createHash('sha256').update(bytes).digest('hex') },
                } }] : [{ t: 'text', text: 'The exact privately approved answer' }] });
                phase = 'actual signed draft capture';
                const draft = e2eeMcp ? await (async () => {
                    const witness: AgentInvocationTurnAdmissionWitness = { turnId, inputId, userMessageSeq: 1, userMessageSeqs: [1], callerPermissionMode: 'default',
                        agentStartCaller: { kind: 'session' as const, sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' } };
                    const daemon = await createSessionDaemonAuthorityFixture({ sessionId: session.id,
                        execute: operation => capture(operation, { sessionId: session.id, isCurrent: async () => sessions.has(pid) }) });
                    await serverFeatures.refresh();
                    const runtime = createHappierMcpServer({ sessionId: session.id,
                        getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
                        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: session.id, encryptionMode: 'plain' }),
                        updateMetadata: () => {}, getMetadataSnapshot: () => createTestMetadata({ ...metadata, permissionMode: 'default',
                            startedBy: 'daemon', sessionDirectoryV1: { v: 1, kind: 'managed' } }), getWorkDepth: () => 0,
                        getHostTurnWorkDepth: () => 0, getActiveTurnAdmissionWitness: () => witness,
                        getServerFeaturesSnapshot: () => serverFeatures.getSnapshot(),
                    }, { credentials, sessionInputVia: 'mcp', accountSettings: accountSettingsParse({}), isCredentialCurrent: () => true });
                    const client = new Client({ name: 'owned-e2ee-attachment', version: '1' });
                    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                    try {
                        await runtime.mcp.connect(serverTransport); await client.connect(clientTransport);
                        const response = await client.callTool({ name: 'action_execute', arguments: { actionId: 'discussion.post',
                            input: { discussionId, localId: randomUUID(), content, attachmentSources, mentionedSessionIds: [] } } });
                        expect(response.isError ?? false, JSON.stringify(response)).toBe(false);
                        expect(JSON.stringify(response)).toContain('approval_request_created');
                        return response;
                    } finally { await client.close(); await runtime.mcp.close(); await daemon.close(); }
                })() : revocation === 'policy-withdrawn'
                    ? await executor.execute('discussion.reply', { discussionId, content,
                        replyTarget: { kind: 'message', messageId: addressing.messageId } }, {
                        surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                        serverId, serverIdentityId: homeId, runtimeAccountId: account.id,
                        defaultSessionId: session.id, defaultSessionMachineId: machine.id,
                        sessionInputSource: { sourceSessionId: session.id, sourceInputId: inputId, sourceTurnId: turnId,
                            via: 'action', discussionAddressing: addressing },
                    })
                    : await capture({ kind: 'action.execute', actionId: attachmentPost ? 'discussion.post' : 'discussion.reply', requestId: randomUUID(),
                    input: { discussionId, content, ...(attachmentSources ? { attachmentSources } : {}),
                        ...(!attachmentPost ? { replyTarget: { kind: 'message', messageId: addressing.messageId } } : {}) }, witness: {
                        turnId, inputId, userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0, callerPermissionMode: 'default', discussionAddressing: addressing,
                        agentStartCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } } },
                    { sessionId: session.id, isCurrent: async () => sessions.has(pid) });
                if (!e2eeMcp) expect(draft, JSON.stringify({ draft, httpOutcomes })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                // Native completion and original-outcome projection are one
                // transaction in applySessionTurnMutation. Seeding a completed
                // turn directly bypasses its original-outcome projection.
                // The explicit draft exists, but C2 has no native final result.
                expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: emptyFinal }))
                    .toMatchObject({ ok: true });
                if (!e2eeMcp) expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: inputId } } }))
                    .toMatchObject({ replyProgress: { disposition: 'return_pending', outcome: { kind: 'terminal_no_result' } } });
                const store = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl });
                const open = await store.approvalsList({ serverId, status: 'open', limit: 10 });
                expect(open.items).toHaveLength(1);
                const artifactId = open.items[0]!.artifactId;
                const approval = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId }));
                expect(approval.discussionDraftReview).toBe(e2eeMcp ? undefined : true);
                // Production recovery records a returned approval Artifact via
                // settleDiscussionReplyReturnPublication before review. This
                // fixture called the Action directly and must complete that
                // same HTTP step instead of leaving the original unbound.
                const pendingPublication = !e2eeMcp ? await app.inject({ method: 'POST',
                    url: `/v2/sessions/${session.id}/messages/by-local-id/${encodeURIComponent(inputId)}/reply`,
                    headers: { authorization: `Bearer ${credentials.token}` }, payload: {
                        kind: 'discussion_publication', discussionId, messageId: addressing.messageId, acceptedTurnId: turnId,
                        publication: { kind: 'approval_pending', artifactId },
                    } }) : null;
                if (pendingPublication) {
                    expect(pendingPublication.statusCode, pendingPublication.body).toBe(200);
                    expect(pendingPublication.json()).toMatchObject({ v: 1, ok: true, progress: {
                        returnPublication: { kind: 'approval_pending', artifactId }, acceptedTurnId: turnId,
                    } });
                }
                if (revocation === 'none') expect(approval.executionOriginV1).toMatchObject({ caller: { kind: 'session' } });
                const binding = approval.executionOriginV1.externalActionExecutionAuthorization?.binding;
                if (e2eeMcp) expect(binding, 'Ordinary MCP capture has no fabricated external authorization').toBeUndefined();
                // Project only non-secret binding facts into assertion output.
                if (revocation === 'policy-withdrawn') {
                    expect(approval.executionOriginV1).toMatchObject({ caller: { kind: 'host' },
                        discussionReplyReturn: { requestLocalId: inputId, acceptedTurnId: turnId } });
                    expect(binding).toBeUndefined();
                } else if (e2eeMcp) expect(approval.executionOriginV1).toMatchObject({ caller: { kind: 'session', sessionId: session.id },
                    sessionInputSource: { sourceSessionId: session.id, sourceInputId: inputId, sourceTurnId: turnId, via: 'action' } });
                else expect({ source: binding?.sessionActionSource, origin: binding?.sessionActionOrigin }).toMatchObject({
                        origin: { sourceInputId: inputId, sourceTurnId: turnId }, source: { machineId: machine.id } });
                const initialStaleReasons: string[] = [];
                expect(await currentness({ origin: approval.executionOriginV1, request: approval,
                    reportStale: reason => initialStaleReasons.push(reason) }),
                    `Fixture signed origin current before Stop: ${JSON.stringify(initialStaleReasons)}`).toBe(true);
                expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                const terminalToken = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
                await writeCredentialsTokenOnlyForServerId(serverId, { token: terminalToken });
                const personCredentials = await readStoredCredentialsForServerId(serverId);
                if (!personCredentials || !hasStoredSessionCredentialProvenance(personCredentials)) throw new Error('Fixture interactive stored CLI credential unavailable');
                let currentMachineId: string | null = machine.id;
                startup = await createRequesterSessionControlRuntimeFixture({
                    happyHomeDir: configuration.happyHomeDir, activeServerDir: join(configuration.happyHomeDir, 'servers', serverId),
                    serverId, serverHttpBaseUrl, machineId: machine.id, custodianAccountId: account.id, credentials,
                    connectedServicesMaterializationBaseDir: join(database.baseDir, 'connected-services'),
                    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: sessions, getRequester: () => null,
                    getApiMachineForSessions: () => apiMachine!,
                    resolveQualifiedConnectedAccountV4Support: () => { throw new Error('Unexpected Connected Account operation'); },
                    processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '0' },
                    startup: { resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                        serverUrl: serverHttpBaseUrl, resolveCurrentMachineId: () => currentMachineId,
                    }) },
                });
                expect(startup.installation?.installationId, 'Fixture startup retains the actual signing installation').toBe(installation.installationId);
                expect(startup.installation?.publicKey === installation.publicKey, 'Fixture startup retains the actual signing public key').toBe(true);
                const ingress = startup.runtime.externalActionIngressOwner;
                if (!ingress) throw new Error('Fixture startup-composed Action ingress is unavailable');
                // The canonical startup fixture selects the active Home. Its
                // Account settings snapshot must be admitted in that namespace,
                // not inherited from the former test profile's bootstrap.
                await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
                expect(await currentness({ origin: approval.executionOriginV1, request: approval }),
                    'Fixture signed origin and Account policy current in the startup-selected Home before Stop').toBe(true);
                decideOnDaemon = (...args) => ingress.executor.execute(...args);
                const personExecutor = createExecutor(e2eeMcp ? credentials : personCredentials, true);
                const onExit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
                    getApiMachineForSessions: () => apiMachine!, removeSessionMarkerFn: async () => undefined });
                const stop = createStopSession({ pidToTrackedSession: sessions, readHostAttachmentState: async () => ({ status: 'absent' }),
                    readTerminalAttachmentInfo: async () => null, waitForTrackedRunnersExit: async () => {
                        const [code, signal] = await exited; await onExit(pid, { reason: 'process-exited', code, signal });
                        return sessions.size === 0;
                    }, retireAbsentTerminalControlServiceability: ({ trackedSession }) => retireExactTerminalControlServiceability({ credentials,
                        sessionId: session.id, terminalMode: 'plain', expectedRunner: { pid: trackedSession.pid, startTimeMs: trackedSession.processStartTimeMs } }) });
                expect(admittedMachineSocket.data[VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY], 'Fixture installed Machine identity').toBe(installation.installationId);
                expect(await resolveMachineAdmission({ actorAccountId: account.id, machineId: machine.id,
                    rpcMethod: RPC_METHODS.STOP_SESSION, requireOnline: true }), 'Fixture current Stop Machine admission')
                    .toMatchObject({ kind: 'admitted', installationId: installation.installationId });
                const target = { id: admittedMachineSocket.id, data: admittedMachineSocket.data, timeout: () => ({ emitWithAck: async (event: string, packet: unknown) => {
                    expect(event).toBe(SOCKET_RPC_EVENTS.REQUEST);
                    if (!packet || typeof packet !== 'object' || !('method' in packet) || !('params' in packet)) throw new Error('Fixture Stop RPC packet unavailable');
                    expect(packet.method).toBe(`${machine.id}:${RPC_METHODS.STOP_SESSION}`);
                    const operand = getActionSpec('session.stop').inputSchema.parse(packet.params);
                    expect(operand.sessionId).toBe(session.id);
                    const result = StopSessionResultSchema.parse(await stop(operand.sessionId));
                    return { v: 1, result, acknowledgement: projectMachineRpcTransportAcknowledgement({ method: RPC_METHODS.STOP_SESSION, result }) };
                } }) };
                const discovery = createSocketRoomDiscoveryHarness(async () => [target]);
                const person = await auth.verifyTokenForRoute(personToken);
                if (!person || person.userId !== account.id || person.authority !== 'present_user') throw new Error('Fixture person Stop credential unavailable');
                const caller = createFakeSocket({ data: { clientType: 'user-scoped', authTokenKind: person.authTokenKind,
                    authAuthority: person.authority, authTokenAuthenticationEvidence: person.authenticationEvidence } });
                writeAccountStoredContentCompatibilityForSocket(caller as unknown as Socket,
                    evaluateAccountStoredContentSocketCompatibility(buildCurrentCliClientCompatibilitySocketAuth('daemon')));
                registerSocketRpcHandlers({ userId: account.id, socket: caller as unknown as Socket, io: discovery, sessionPublisherPresence: presence });
                const stopParticipant = async () => {
                    const stopped: unknown[] = [];
                    await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method: `${machine.id}:${RPC_METHODS.STOP_SESSION}`,
                        params: { sessionId: session.id }, authorization: { kind: 'session.write', sessionId: session.id } }, (value: unknown) => stopped.push(value));
                    expect(stopped).toEqual([{ ok: true, result: { status: 'stopped' } }]);
                    expect(sessions.size).toBe(0);
                    expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { active: true } })).toEqual({ active: false });
                };
                if (!stopDuringReplay && revocation !== 'policy-withdrawn' && !attachmentPost) await stopParticipant();
                phase = 'signed origin verification';
                if (revocation !== 'policy-withdrawn') {
                    if (!e2eeMcp) {
                    const authorization = approval.executionOriginV1.externalActionExecutionAuthorization;
                    const originalTarget = approval.executionOriginV1.target;
                    const originalSource = approval.executionOriginV1.sessionInputSource;
                    if (!authorization || !originalTarget || !originalSource) throw new Error('Fixture signed original proof unavailable');
                    const { sourceTurnId: _acceptedTurn, ...unacceptedSource } = originalSource;
                    expect(ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse({ v: 1,
                        retainedDiscussionSource: unacceptedSource }).success, 'An unaccepted original is not retained-turn proof').toBe(false);
                    const verification = { authorization, effectActionId: approval.actionId, target: originalTarget,
                        privateKey: installation.privateKey, installationId: installation.installationId, serverHttpBaseUrl };
                    // Retiring this source does not waive ordinary root currentness
                    // or accept an unrelated retained input under the same signer.
                    expect(await verifyExternalActionExecutionAuthorizationCurrent(verification)).toBe(stopDuringReplay || attachmentPost);
                    expect(await verifyExternalActionExecutionAuthorizationCurrent({ ...verification,
                        retainedDiscussionSource: { ...originalSource, sourceInputId: 'not-the-original' } })).toBe(false);
                    }
                    const capturedInput = DiscussionPostInputV1Schema.parse(approval.actionArgs);
                    phase = 'open draft publication refusal';
                    // Neither a direct draft nor its still-open Artifact reference
                    // gains publication authority merely because the host stopped.
                    expect(await publisher({ v: 1, sessionId: session.id, discussionId, request: {
                        localId: capturedInput.localId!, content: sealSessionStoredContent({ ...discussionCrypto, payload: capturedInput.content }),
                        ...buildDiscussionAttachmentBindingsV1(capturedInput.content, discussionCrypto.mode === 'plain' ? 'plain' : 'encrypted'),
                        mentionedAccountIds: [], replyTarget: capturedInput.replyTarget,
                    }, ...(attachmentSources ? { attachmentSources } : {}) }, { approvedActionReplay: { artifactId }, callerAuthority: 'present_user' }))
                        .toMatchObject({ ok: false, error: 'discussion_post_denied' });
                    expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                    if (attached) refuseDifferentBlob = async () => {
                        expect(ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId })).status).toBe('executing');
                        const otherBlobId = randomUUID();
                        const otherContent = DiscussionPostInputV1Schema.shape.content.parse({ v: 1, parts: [{ t: 'attachment', attachment: {
                            kind: 'file', id: otherBlobId, name: 'evidence.txt', file: { blobId: otherBlobId, mime: 'text/plain',
                                sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
                        } }] });
                        expect(await publisher({ v: 1, sessionId: session.id, discussionId, request: {
                            localId: capturedInput.localId!, content: sealSessionStoredContent({ ...discussionCrypto, payload: otherContent }),
                            ...buildDiscussionAttachmentBindingsV1(otherContent, discussionCrypto.mode === 'plain' ? 'plain' : 'encrypted'), mentionedAccountIds: [], replyTarget: capturedInput.replyTarget,
                        }, attachmentSources: [{ blobId: otherBlobId, path: sourcePath }] }, {
                            approvedActionReplay: { artifactId }, callerAuthority: 'present_user',
                        })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
                        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                    };
                }
                if (revocation === 'session-access') await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
                    accountId: account.id, machineId: machine.id, sessionId: session.id } } });
                if (revocation === 'participant') expect(await removeDiscussionParticipant({ actorAccountId: account.id, authentication,
                    discussionId, request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
                if (revocation === 'policy-withdrawn') expect(await setDiscussionParticipantPolicy({ actorAccountId: account.id, authentication,
                    discussionId, request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'reads_only' } })).toMatchObject({ ok: true });
                if (revocation === 'account-credential') await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
                if (revocation === 'home-unavailable') currentMachineId = null;
                if (revocation === 'wrong-machine') currentMachineId = randomUUID();
                if (stopDuringReplay) {
                    const stopExecutingParticipant = async () => {
                        phase = 'Stop during executing publication';
                        expect(ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId })).status).toBe('executing');
                        expect(sessions.size).toBe(1);
                        expect(await db.discussionMessage.count({ where: { discussionId, seq: { gt: addressing.throughSeq } } }))
                            .toBe(revocation === 'stop-after-commit-lost-ack' ? 1 : 0);
                        await stopParticipant();
                    };
                    if (revocation === 'stop-after-commit-lost-ack') afterPublication = stopExecutingParticipant;
                    else if (revocation === 'stop-during-preparation-read') interruptPreparationRead = stopExecutingParticipant;
                    else beforePublication = stopExecutingParticipant;
                }
                phase = 'person approval decision';
                let signedAttachmentResult: Awaited<ReturnType<typeof personExecutor.execute>> | undefined;
                let repeatedSignedAttachmentResult: Awaited<ReturnType<typeof personExecutor.execute>> | undefined;
                if (revocation === 'policy-withdrawn' || revocation === 'attachment-signed' || attachmentPost) {
                    // The browser's real Post reaches an installed daemon with a
                    // fresh reviewer root, not an ambient Account bearer.
                    const actionId = 'approval.request.decide';
                    const input = { artifactId, decision: 'approve', serverIdentityId: homeId };
                    const requestId = randomUUID();
                    const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input, requestId,
                        target: { kind: 'machine', machineId: machine.id }, machineId: machine.id, accountId: account.id,
                        accountEncryptionMode: accountMode, tokenEpochHint: account.tokenEpoch, token: personToken,
                        ...(credentials.encryption?.type === 'dataKey' ? { material: { type: 'dataKey', machineKey: credentials.encryption.machineKey } } : {}),
                        serverId, serverIdentityId: homeId, serverHttpBaseUrl, installationId: installation.installationId,
                        privateKey: installation.privateKey, isCurrent: async () => true });
                    if (!authorization) throw new Error('Reviewer root unavailable');
                    const reviewer = await ingress.prepareRequesterAccountContext?.({ authorization });
                    if (!reviewer) throw new Error('Startup-composed reviewer custody unavailable');
                    try {
                        const post = () => reviewer.executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
                            serverId, serverIdentityId: homeId, runtimeAccountId: account.id, actionRequestId: requestId,
                            defaultSessionMachineId: machine.id,
                            actionCaller: { kind: 'host' }, externalActionTarget: authorization.binding.target,
                            externalActionExecutionAuthorization: reviewer.authorization });
                        const changeWhere = { accountId: account.id, kind: 'discussion', entityId: discussionId };
                        const before = await db.accountChange.findFirstOrThrow({ where: changeWhere });
                        const result = await post();
                        if (attached) {
                            signedAttachmentResult = result;
                            if (e2eeMcp && result.ok && result.result && typeof result.result === 'object'
                                && 'status' in result.result && result.result.status === 'executed') {
                                repeatedSignedAttachmentResult = await post();
                                expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(3);
                            }
                        } else {
                            expect(result, JSON.stringify({ result, httpOutcomes })).toMatchObject({ ok: true,
                                result: { status: 'failed', execution: { ok: false, errorCode: 'discussion_answer_policy_denied' } } });
                            expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: inputId } } }))
                                .toMatchObject({ replyProgress: { disposition: 'released', returnPublication: { kind: 'failed', failure: {
                                    code: 'discussion_answer_policy_denied', phase: 'action_admission', retryable: false } } } });
                            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                            const originalRead = await app.inject({ method: 'GET',
                                url: `/v1/discussions/${discussionId}/messages?messageId=${addressing.messageId}`,
                                headers: { authorization: `Bearer ${credentials.token}` } });
                            expect(originalRead.statusCode).toBe(200);
                            expect(DiscussionMessagesResponseV1Schema.parse(originalRead.json()).messages[0]?.participantDeliveryV1)
                                .toEqual([{ participantSessionId: session.id, disposition: 'failed', failure: {
                                    code: 'discussion_answer_policy_denied', phase: 'action_admission', retryable: false } }]);
                            const changed = await db.accountChange.findFirstOrThrow({ where: changeWhere });
                            expect(changed).not.toEqual(before);
                            expect(await post()).toMatchObject({ ok: true, result: { status: 'failed' } });
                            expect(await db.accountChange.findFirstOrThrow({ where: changeWhere })).toEqual(changed);
                        }
                    } finally { await reviewer.dispose(); }
                    if (!attached) return;
                }
                const result = signedAttachmentResult ?? await personExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' },
                    { serverId, serverIdentityId: homeId, surface: 'cli' });
                const rows = await db.discussionMessage.findMany({ where: { discussionId, seq: { gt: addressing.throughSeq } } });
                if (sourceMismatch) {
                    expect(result, JSON.stringify({ result, httpOutcomes })).toMatchObject({ ok: true,
                        result: { status: 'outcome_unknown', execution: { ok: false, effectAttempted: true } } });
                    expect(rows).toHaveLength(0);
                    expect(httpOutcomes).not.toContain('POST /v1/discussions/upload 200');
                    expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                } else if (revocation === 'stop-during-preparation-read') {
                    expect(preparationReadInterrupted).toBe(true);
                    expect(rows).toHaveLength(0);
                    const settledDraft = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId }));
                    const retainedOriginal = await db.sessionMessage.findUniqueOrThrow({ where: {
                        sessionId_localId: { sessionId: session.id, localId: inputId },
                    }, select: { replyProgress: true } });
                    const originalRead = await app.inject({ method: 'GET',
                        url: `/v1/discussions/${discussionId}/messages?messageId=${addressing.messageId}`,
                        headers: { authorization: `Bearer ${credentials.token}` } });
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed',
                        execution: { ok: false, errorCode: 'discussions_unavailable' } } });
                    expect(settledDraft).toMatchObject({ status: 'failed',
                        execution: { errorCode: 'discussions_unavailable' } });
                    expect(retainedOriginal).toMatchObject({ replyProgress: { disposition: 'return_pending',
                        acceptedTurnId: turnId, outcome: { kind: 'terminal_no_result' },
                        returnPublication: { kind: 'failed', failure: {
                            code: 'discussions_unavailable', phase: 'action_admission', retryable: true,
                        } } } });
                    expect(originalRead.statusCode).toBe(200);
                    // Temporary unavailability is recoverable original custody,
                    // not a permanent refusal or a fabricated public answer.
                    expect(DiscussionMessagesResponseV1Schema.parse(originalRead.json()).messages[0])
                        .toMatchObject({ id: addressing.messageId, seq: addressing.throughSeq });
                    const custodyRead = await app.inject({ method: 'GET',
                        url: `/v2/sessions/${session.id}/messages/by-local-id/${encodeURIComponent(inputId)}/reply`,
                        headers: { authorization: `Bearer ${credentials.token}` } });
                    expect(custodyRead.statusCode).toBe(200);
                    expect(SessionMessageReplyReadResultV1Schema.parse(custodyRead.json()))
                        .toMatchObject({ status: 'available', progress: retainedOriginal.replyProgress });
                    expect(await personExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' },
                        { serverId, serverIdentityId: homeId, surface: 'cli' }))
                        .toMatchObject({ ok: true, result: { status: 'failed',
                            execution: { errorCode: 'discussions_unavailable' } } });
                    expect(await db.sessionMessage.findUniqueOrThrow({ where: {
                        sessionId_localId: { sessionId: session.id, localId: inputId },
                    }, select: { replyProgress: true } })).toEqual(retainedOriginal);
                    expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                } else if (revocation === 'none' || attached || stopDuringReplay) {
                    const lostAcknowledgement = revocation === 'stop-after-commit-lost-ack';
                    expect(result, JSON.stringify({ result, httpOutcomes, publishedRows: rows.length })).toMatchObject({ ok: true,
                        result: lostAcknowledgement
                            ? { status: 'outcome_unknown', execution: { ok: false, errorCode: 'outcome_unknown', effectAttempted: true } }
                            : { status: 'executed' } });
                    expect(rows).toHaveLength(1);
                    expect(openSessionStoredContent({ ...discussionCrypto, content: rows[0]!.content })).toEqual(content);
                    expect(rows[0]).toMatchObject({ producerV1: { kind: 'agent', sessionId: session.id,
                        sourceSession: { sourceSessionId: session.id, sourceInputId: inputId, sourceTurnId: turnId } } });
                    if (revocation === 'none') {
                        expect(rows[0]?.producerV1).toMatchObject({ replyReturn: { outcome: 'answer' } });
                        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: inputId } } }))
                            .toMatchObject({ replyProgress: { disposition: 'returned', outcome: { kind: 'answer', publicationRef: {
                                kind: 'discussion', discussion: { serverId: homeId, discussionId }, messageId: rows[0]!.id,
                            } } } });
                    }
                    expect(httpOutcomes.filter(value => value.startsWith('POST /v1/discussions/')))
                        .toEqual(attached ? ['POST /v1/discussions/upload 200'] : []);
                    if (e2eeMcp) expect(uploadAdmissions, 'One terminal-backed upload; the repeated person decision performs no second upload')
                        .toEqual([{ status: 200, tokenKind: 'terminal', externalAction: false }]);
                    if (e2eeMcp) {
                        if (!capturedAgentUpload) throw new Error('Actual MCP attachment carrier not observed');
                        expect(capturedAgentUpload.includes(Buffer.from(bytes)), 'Server receives opaque encrypted file bytes').toBe(false);
                        const newline = capturedAgentUpload.indexOf(10);
                        const admitted = DiscussionAttachmentUploadRequestV1Schema.parse(JSON.parse(capturedAgentUpload.subarray(0, newline).toString('utf8')));
                        if (admitted.operation !== 'post' || !admitted.agent) throw new Error('Expected actual signed post upload');
                        const ciphertext = capturedAgentUpload.subarray(newline + 1);
                        const probe = (metadata: unknown, token = credentials.token) => app.inject({ method: 'POST', url: '/v1/discussions/upload',
                            headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                                authorization: `Bearer ${token}`, 'content-type': 'application/vnd.happier.discussion-upload-v1' },
                            payload: Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), ciphertext]) });
                        const fresh = () => ({ ...structuredClone(admitted), input: { ...admitted.input, localId: randomUUID() } });
                        const sign = (metadata: ReturnType<typeof fresh>, accountId = account.id) => ({ ...metadata, agent: { ...metadata.agent!,
                            signature: signDiscussionAttachmentAgentUploadV1({ homeId, accountId, metadata,
                                privateKey: decodeBase64(installation.privateKey, 'base64url') }) } });
                        // APPR-S3 admits ordinary terminal Actions; scoped API
                        // credentials still cannot attest an installed publisher.
                        const scopedCredential = await auth.createApiToken({ accountId: account.id,
                            tokenId: randomUUID(), label: 'Discussion publisher negative' });
                        expect((await probe(sign(fresh()), scopedCredential.token)).statusCode).toBe(403);
                        const differentAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
                        const differentTerminal = await auth.createToken(differentAccount.id, undefined, { kind: 'terminal', authority: 'account_automation' });
                        expect((await probe(admitted, differentTerminal)).statusCode).toBe(403);
                        expect((await probe(sign(fresh(), differentAccount.id))).statusCode).toBe(403);
                        const wrongKey = sign(fresh());
                        const otherDiscussionKey = await createResourceDataKey({ credentials, mode: accountMode });
                        if (otherDiscussionKey.mode !== 'e2ee') throw new Error('Expected encrypted second Discussion');
                        const otherCrypto = { mode: 'e2ee' as const, ctx: { encryptionKey: otherDiscussionKey.dataKey, encryptionVariant: 'dataKey' as const } };
                        const otherDiscussion = await createDiscussion({ actorAccountId: account.id, authentication,
                            request: buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(),
                                titleContent: sealSessionStoredContent({ ...otherCrypto, payload: title }),
                                creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: deriveDiscussionMutationEqualityTagV1({
                                    dataKey: otherDiscussionKey.dataKey, canonicalIntent: serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title, firstMessage }) }) },
                                dataEncryptionKey: otherDiscussionKey.dataEncryptionKey,
                                expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentKeys.publicKey),
                                firstMessage: { ...firstMessage, authoredContent: firstMessage.content,
                                    content: sealSessionStoredContent({ ...otherCrypto, payload: firstMessage.content }),
                                    requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: deriveDiscussionMutationEqualityTagV1({ dataKey: otherDiscussionKey.dataKey,
                                        canonicalIntent: serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...firstMessage }) }) } } }) });
                        if (!otherDiscussion.ok) throw new Error(otherDiscussion.error);
                        // Make Y otherwise publishable by this same Session, so
                        // missing membership cannot mask a broken signature check.
                        expect(await inviteDiscussionParticipant({ actorAccountId: account.id, authentication,
                            discussionId: otherDiscussion.value.discussion.id,
                            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed' } }))
                            .toMatchObject({ ok: true });
                        const transplanted = structuredClone(admitted);
                        transplanted.input.discussionId = otherDiscussion.value.discussion.id;
                        expect((await probe(transplanted)).statusCode, 'Valid signed review for X cannot be transplanted into Y').toBe(403);
                        expect(await db.discussionMessage.count({ where: { discussionId: otherDiscussion.value.discussion.id } })).toBe(1);
                        wrongKey.agent.signature = signDiscussionAttachmentAgentUploadV1({ homeId, accountId: account.id,
                            metadata: wrongKey, privateKey: tweetnacl.sign.keyPair().secretKey });
                        expect((await probe(wrongKey)).statusCode).toBe(403);
                        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
                        try { expect((await probe(admitted)).statusCode, 'Stale terminal epoch is refused by real authentication').toBe(401); }
                        finally { await db.account.update({ where: { id: account.id }, data: { tokenEpoch: account.tokenEpoch } }); }
                        const mismatch = fresh();
                        mismatch.input.content = { t: 'plain', v: content };
                        delete mismatch.input.requestEqualityEvidenceV1;
                        mismatch.input.attachments = mismatch.input.attachments?.map(entry => ({ ...entry, t: 'plain' }));
                        mismatch.attachments = mismatch.attachments.map(entry => ({ ...entry, t: 'plain' }));
                        DiscussionAttachmentUploadRequestV1Schema.parse(mismatch);
                        const mixedMode = await probe(sign(mismatch));
                        expect(mixedMode.statusCode).toBe(400);
                        expect(mixedMode.json().error).toBe('discussion_encryption_mode_mismatch');
                        const changedBlob = structuredClone(admitted);
                        const conflictingBlobId = randomUUID();
                        changedBlob.input.attachments = changedBlob.input.attachments?.map(entry => ({ ...entry, blobId: conflictingBlobId }));
                        changedBlob.attachments = changedBlob.attachments.map(entry => ({ ...entry, blobId: conflictingBlobId }));
                        const conflict = await probe(sign(changedBlob));
                        expect(conflict.statusCode, 'Same localId cannot rejoin different blob bindings').toBe(409);
                        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(3);
                    }
                    if (attached) {
                        expect(refuseDifferentBlob, 'Wrong-blob replay was exercised while the approval was executing').toBeUndefined();
                        const path = `/v1/discussions/${discussionId}/messages/${rows[0]!.id}/attachments/${blobId}`;
                        const member = await app.inject({ method: 'GET', url: path,
                            headers: { authorization: `Bearer ${credentials.token}` } });
                        expect(member.statusCode, member.body).toBe(200);
                        const reference = content.parts.find(part => part.t === 'attachment')!;
                        if (reference.t !== 'attachment' || reference.attachment.kind !== 'file') throw new Error('Expected fixture leaf');
                        expect(await openResourceBinaryContent(discussionKey, reference.attachment.file, member.json().content)).toEqual(bytes);
                        if (e2eeMcp) {
                            expect(member.json().content.t).toBe('encrypted');
                            expect(rows[0]!.content).toMatchObject({ t: 'encrypted' });
                        }
                        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
                        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
                        expect((await app.inject({ method: 'GET', url: path,
                            headers: { authorization: `Bearer ${outsiderToken}` } })).statusCode).toBe(404);
                    }
                    const settled = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId }));
                    expect(sameStrictJsonValue(settled.executionOriginV1, approval.executionOriginV1), 'Original signed provenance remains immutable').toBe(true);
                    expect(repeatedSignedAttachmentResult ?? await personExecutor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' }))
                        .toMatchObject({ ok: true, result: { status: lostAcknowledgement ? 'outcome_unknown' : 'executed' } });
                    expect(await db.discussionMessage.count({ where: { discussionId, seq: { gt: addressing.throughSeq } } })).toBe(1);
                    if (revocation === 'none') {
                        // A repeated empty terminal cannot replace the explicit
                        // publication or reopen its already-returned obligation.
                        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
                            mutation: { ...emptyFinal, mutationId: randomUUID(), observedAt: 4 } })).toMatchObject({ ok: true });
                        expect(await db.discussionMessage.findUniqueOrThrow({ where: { id: rows[0]!.id } }))
                            .toMatchObject({ producerV1: { replyReturn: { outcome: 'answer' } } });
                        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: inputId } } }))
                            .toMatchObject({ replyProgress: { disposition: 'returned', outcome: { kind: 'answer', publicationRef: { messageId: rows[0]!.id } } } });
                        expect(await db.discussionMessage.count({ where: { discussionId, seq: { gt: addressing.throughSeq } } })).toBe(1);
                    }
                } else {
                    expect(result).not.toMatchObject({ ok: true, result: { status: 'executed' } });
                    expect(rows).toHaveLength(0);
                }
                if (attachmentPost) await stopParticipant();
                expect(sessions.size).toBe(0);
            });
        } finally {
            if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
            await startup?.dispose();
            await apiMachine?.shutdown(); await closeSockets?.(); await closeHttp?.();
            resetInMemoryAccountSettingsContextForTests();
        }
    });
});
