import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDiscussionAgentPublisher, prepareApprovedDiscussionAgentPublication,
  DiscussionAgentPublisherRequestV1Schema as PrivatePublicationSchema } from './discussionAgentPublisher';
import { DiscussionAgentPublisherRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { createWorkflowAccountRunActionOwner, materializeWorkflowAcceptedSnapshotV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { workflowInvocationKey } from '@/daemon/workflows/coordinator';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { WorkflowInvocationGetRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { decodeBase64 } from '@/api/encryption';
import { verifyDiscussionAttachmentAgentUploadV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import { readBinaryUploadFrameV1, decodeDiscussionUploadMetadataV1 } from '@happier-dev/transfers';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';

vi.mock('axios', async original => {
  const actual = await original<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: vi.fn() } };
});

describe('approved Discussion private carrier', () => {
  const request = DiscussionAgentPublisherRequestV1Schema.parse({
    v: 1, operation: 'create', sessionId: 'session',
    request: { creationLocalId: 'created-discussion', titleContent: { t: 'plain', v: { v: 1, title: 'Review' } },
      firstMessage: { localId: 'first-message', mentionedAccountIds: [],
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Review this' }] } } } },
  });

  it('refuses a replay without a recorded artifact before the private RPC transport', () => {
    expect(prepareApprovedDiscussionAgentPublication({ request, replay: {} })).toBeNull();
  });

  it('projects the recorded artifact into the strict private RPC contract', () => {
    const publication = prepareApprovedDiscussionAgentPublication({ request,
      replay: { artifactId: 'approval', deploymentReview: {} } });
    expect(PrivatePublicationSchema.parse(publication)).toEqual({ request,
      approvedActionReplay: { artifactId: 'approval' } });
  });
});

describe('trusted Discussion reply publisher', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads an exact workspace leaf only after the real host witness admits a signed streamed creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-discussion-agent-source-'));
    const sourcePath = join(directory, 'evidence.bin');
    const bytes = Buffer.from([0, 255, 1, 128]);
    await writeFile(sourcePath, bytes);
    const installation = await readOrCreateInstallationIdentity();
    const blobId = randomUUID();
    const accountId = 'account';
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
    const content = { v: 1 as const, parts: [{ t: 'attachment' as const, attachment: { kind: 'file' as const,
      id: blobId, name: 'evidence.bin', file: { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') } } }] };
    const wire = { id: 'first', discussionId: 'discussion', localId: 'first', seq: 1, authorAccountId: accountId,
      accountActor: { v: 1, accountId, profile: null }, producerV1: null,
      content: { t: 'plain' as const, v: content }, mentionedAccountIds: [], createdAt: 1 };
    const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1] };
    const rpc = new RpcHandlerManager({ scopePrefix: 'receiver', encryptionMode: 'plain' });
    const posts: unknown[] = [];
    registerDiscussionAgentPublisher({ rpcHandlerManager: rpc, serverId: 'home', serverUrl: 'https://home.test',
      machineId: 'machine', getServerIdentityId: () => 'home', readOwnerAccountCredentials: async () => credentials,
      isApprovalExecutionOriginCurrent: async () => false,
      session: { sessionId: 'receiver', getActiveTurnAdmissionWitness: () => witness,
        postAgentDiscussionMessage: async request => { posts.push(request); return { v: 1, ok: false, error: 'discussion_post_denied' }; } },
    });
    // The HTTP boundary consumes the real CLI source reader, encryption/frame producer and strict consumer.
    const http = vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (!config.data || typeof config.data !== 'object' || !(Symbol.asyncIterator in config.data)) throw new Error('Missing stream');
      const leaves: Uint8Array[] = [];
      const metadata = await readBinaryUploadFrameV1(config.data as AsyncIterable<Uint8Array>, {
        metadataMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1, decodeMetadata: decodeDiscussionUploadMetadataV1,
        onMetadata: async metadata => {
          if (metadata.operation !== 'create' || !metadata.agent) throw new Error('Missing admitted agent');
          expect(metadata.agent.publication).toMatchObject({ sourceSession: { sourceSessionId: 'receiver', sourceInputId: 'input', sourceTurnId: 'turn' } });
          expect(verifyDiscussionAttachmentAgentUploadV1({ homeId: 'home', accountId, metadata,
            signature: metadata.agent.signature, publicKey: decodeBase64(installation.publicKey, 'base64url') })).toBe(true);
          expect(JSON.stringify(metadata)).not.toContain(sourcePath);
          return metadata.attachments;
        },
        onSegment: async (_index, chunks) => { for await (const chunk of chunks) leaves.push(chunk); },
      });
      expect(Buffer.concat(leaves)).toEqual(bytes);
      if (metadata.operation !== 'create') throw new Error('Missing creation');
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { discussion: { id: 'discussion', ownerAccountId: accountId, encryptionMode: 'plain',
        keyReadiness: true, dataEncryptionKey: null, anchor: null, access: 'owner', titleContent: metadata.input.titleContent,
        creationLocalId: 'creation', latestMessage: { id: wire.id, localId: wire.localId, seq: wire.seq,
          authorAccountId: accountId, accountActor: wire.accountActor, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: [accountId], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } },
        firstMessage: wire } };
    });
    const request = { v: 1, operation: 'create', sessionId: 'receiver', attachmentSources: [{ blobId, path: sourcePath }], request: {
      creationLocalId: 'creation', titleContent: { t: 'plain', v: { v: 1, title: 'Files' } }, firstMessage: {
        localId: 'first', content: wire.content, mentionedAccountIds: [], attachments: [{ blobId, t: 'plain' }] },
    } };
    try {
      expect(await rpc.invokeLocal(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, { witness: { ...witness, turnId: 'forged' }, request }))
        .toMatchObject({ ok: false, error: 'discussion_post_denied' });
      expect(http).not.toHaveBeenCalled();
      expect(await rpc.invokeLocal(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, { witness, request })).toMatchObject({ ok: true });
      expect(http).toHaveBeenCalledTimes(1);
      expect(posts).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    { status: 503, error: 'discussions_unavailable' },
    { status: undefined, error: 'discussions_unavailable' },
    { status: 403, error: 'discussion_post_denied' },
  ] as const)('distinguishes unavailable original custody from a refused terminal return (HTTP $status)', async ({ status, error }) => {
    const config = { headers: new AxiosHeaders() };
    vi.mocked(axios.get).mockRejectedValue(new AxiosError('Private transport details',
      status === undefined ? 'ETIMEDOUT' : 'ERR_BAD_RESPONSE', config, undefined,
      status === undefined ? undefined : { status, statusText: 'Unavailable', headers: {}, config, data: {} }));
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({ scopePrefix: 'receiver', encryptionMode: 'plain', logger });
    const posts: unknown[] = [];
    registerDiscussionAgentPublisher({ rpcHandlerManager: rpc,
      serverId: 'home', serverUrl: 'https://home.test',
      getServerIdentityId: () => 'home',
      readOwnerAccountCredentials: async () => ({ token: 'token', encryption: null }),
      isApprovalExecutionOriginCurrent: async () => false,
      session: { sessionId: 'receiver', postAgentDiscussionMessage: async request => {
        posts.push(request);
        return { v: 1, ok: false, error: 'discussion_post_denied' };
      } },
    });
    const response = await rpc.invokeLocal(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, { request: {
      v: 1, sessionId: 'receiver', discussionId: 'discussion',
      replyReturn: { serverId: 'home', requestLocalId: 'input', acceptedTurnId: 'completed-turn' },
      request: { localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId: 'receiver', localId: 'input', acceptedTurnId: 'completed-turn' }),
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Final answer' }] } },
        mentionedAccountIds: [], mentionedSessionIds: [], replyTarget: { kind: 'message', messageId: 'question' } },
    } });
    expect(response).toEqual({ v: 1, ok: false, error });
    expect(posts).toEqual([]);
    expect(JSON.stringify(response)).not.toContain('Private transport details');
    expect(logger).toHaveBeenCalledWith('[RPC] Request completed', expect.objectContaining({
      outcomeCode: error, admissionPredicate: 'discussion_reply_custody',
    }));
    expect(JSON.stringify(logger.mock.calls)).not.toContain('Private transport details');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('Final answer');
  });

  it.each([false, true])('keeps active explicit replies behind accepted Workflow output (workflow=%s)', async workflow => {
    const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'receiver' };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { v: 1, status: 'available', progress: {
      v: 1, mode: workflow ? 'wait' : 'return', discussion: addressing, acceptedTurnId: 'turn', disposition: 'observing',
      ...(workflow ? { workflow: { purpose: 'invocation', runId: 'run', invocationRecordId: 'invocation' } } : {}),
    } } });
    const witness = { turnId: 'turn', inputId: 'input', discussionAddressing: addressing,
      userMessageSeq: 1, userMessageSeqs: [1] };
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({ scopePrefix: 'receiver', encryptionMode: 'plain', logger });
    const posts: unknown[] = [];
    registerDiscussionAgentPublisher({ rpcHandlerManager: rpc,
      serverId: 'home', serverUrl: 'https://home.test',
      getServerIdentityId: () => 'home',
      readOwnerAccountCredentials: async () => ({ token: 'token', encryption: null }),
      isApprovalExecutionOriginCurrent: async () => false,
      session: { sessionId: 'receiver', getActiveTurnAdmissionWitness: () => witness,
        postAgentDiscussionMessage: async request => {
          posts.push(request);
          return { v: 1, ok: false, error: 'discussion_post_denied' };
        } },
    });
    expect(await rpc.invokeLocal(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, { witness, request: { v: 1, sessionId: 'receiver', discussionId: 'discussion',
      request: { localId: 'authored-id', content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'answer' }] } },
        mentionedAccountIds: [], mentionedSessionIds: [], replyTarget: { kind: 'message', messageId: 'question' } },
    } })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
    expect(posts).toHaveLength(workflow ? 0 : 1);
    expect(logger).toHaveBeenCalledWith('[RPC] Request completed', expect.objectContaining({
      outcomeCode: 'discussion_post_denied',
      admissionPredicate: workflow ? 'discussion_reply_custody' : 'discussion_publication',
    }));
  });

  it.each(['absent', 'origin_only', 'other_delivery', 'delivery', 'profile_delivery', 'foreign_delivery', 'unknown_delivery', 'profile_marker', 'profile_publication_ref', 'typed_delivery', 'failed_delivery', 'cancelled_delivery',
    'storage_unavailable', 'run_access_denied', 'missing_source_reader'] as const)('opens the actual completed Workflow invocation and its frozen Discussion delivery (%s)', async binding => {
    const bound = ['delivery', 'profile_delivery', 'typed_delivery', 'failed_delivery', 'cancelled_delivery'].includes(binding);
    const serverId = 'local-profile';
    const serverIdentityId = 'srv_publication_home';
    const deliveryHome = binding === 'profile_delivery' ? serverId : binding === 'foreign_delivery' ? 'srv_foreign'
      : binding === 'unknown_delivery' ? 'unknown-profile' : serverIdentityId;
    const lifecycle = binding === 'failed_delivery' ? 'failed' : binding === 'cancelled_delivery' ? 'cancelled' : 'completed';
    const publishable = bound && lifecycle === 'completed';
    const resultValue = binding === 'typed_delivery' ? { checked: true } : 'accepted answer';
    const throughSeq = binding === 'other_delivery' ? 3 : 2;
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const accountId = 'account';
    const recordId = 'invocation';
    const workflow = { purpose: 'invocation' as const, runId, invocationRecordId: recordId };
    const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
    const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'receiver' };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
    },
      blocks: [{ kind: 'step', id: 'answer', document: { text: 'Answer', references: [], attachments: [] },
        input: [], result: { kind: 'text' }, execution: { conversation: { kind: 'fresh' } } }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', ...(binding !== 'absent' ? { discussion: { discussion: { serverId: deliveryHome, discussionId: 'discussion' },
          messageId: 'question', throughSeq } } : {}) },
        ...(bound || ['other_delivery', 'foreign_delivery', 'unknown_delivery', 'profile_marker', 'profile_publication_ref', 'storage_unavailable', 'run_access_denied', 'missing_source_reader'].includes(binding) ? { resultDelivery: { kind: 'originating_discussion' as const,
          discussion: { serverId: deliveryHome, discussionId: 'discussion' }, messageId: 'question', throughSeq } } : {}),
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot }));
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', accountId, origin: { kind: 'direct' }, acceptedEnvelope });
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'root', nextSequence: '1',
      frontier: { nextBlockOrdinal: 0, paused: false } };
    const root = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'root', sequence: '0',
        parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: 'root' } }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'unused',
      rootInvocation: { id: 'root', contentEnvelope: root } });
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId: 'root',
      revision: storage.run().revision, checkpoint, storage,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    const key = workflowInvocationKey({ runId, blockId: 'answer', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId, runId, blockId: 'answer', path: { blockId: 'answer', scope: [] },
      blockKind: 'step', memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle, ...(lifecycle === 'completed' ? { result: resultValue } : {}),
      execution: { kind: 'session', sessionId: 'receiver', localInputId: localId } });
    const owner = createWorkflowAccountRunActionOwner({ storage: { execute: async (operation, options) => {
      // Only the opaque HTTP/storage boundary is unavailable/refused; the
      // invocation Action owner and terminal verifier stay real.
      if (binding === 'storage_unavailable' || binding === 'run_access_denied') {
        throw Object.assign(new Error('Private storage details'), {
          response: { status: binding === 'storage_unavailable' ? 503 : 403, data: { error: binding } },
        });
      }
      return storage.execute(operation, options);
    } }, resolveAccountId: async () => accountId,
      definitions: { get: async () => { throw new Error('No mutable definition read'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain keys are absent'); } });
    let committed = false;
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/reply')) return { status: 200, data: { v: 1, status: 'available', progress: {
        v: 1, mode: 'wait', workflow, discussion: addressing, acceptedTurnId: 'turn', disposition: 'inline',
        outcome: lifecycle !== 'completed' ? { kind: lifecycle } : committed || binding === 'profile_publication_ref' ? { kind: 'answer', publicationRef: { kind: 'discussion',
          discussion: { serverId: binding === 'profile_publication_ref' ? serverId : serverIdentityId, discussionId: 'discussion' }, messageId: 'published' } }
          : { kind: 'answer', result: { sessionId: 'receiver', messageId: 'native-final' } },
      } } };
      return { status: 200, data: { discussion: { id: 'discussion', ownerAccountId: accountId, encryptionMode: 'plain',
        anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'created',
        titleContent: { t: 'plain', v: { v: 1, title: 'Question' } }, messageSeq: 2, lastReadSeq: 0,
        unreadCount: 2, unreadMentionCount: 0, recentAuthorAccountIds: [accountId], archivedAt: null,
        latestMessage: { id: 'question', localId: 'question-local', seq: 2, authorAccountId: accountId,
          accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 2 },
        capabilities: { postMessages: true, rename: true, archive: true, restore: false,
          askAgent: true, sendToSession: true, manageAccess: true, leave: false },
      } } };
    });
    const logger = vi.fn();
    const rpc = new RpcHandlerManager({ scopePrefix: 'receiver', encryptionMode: 'plain', logger });
    const posts: unknown[] = [];
    registerDiscussionAgentPublisher({ rpcHandlerManager: rpc,
      serverId, serverUrl: 'https://home.test', readOwnerAccountCredentials: async () => ({ token: 'token', encryption: null }),
      getServerIdentityId: () => serverIdentityId,
      isApprovalExecutionOriginCurrent: async () => false,
      ...(binding === 'missing_source_reader' ? {} : { executeSourceAction: async (actionId, input, context) => {
        if (actionId !== 'workflow.run.invocations.get') return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        try { return { ok: true, result: await owner.execute({ actionId, input: WorkflowInvocationGetRequestV1Schema.parse(input), context }) }; }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
          return { ok: false, errorCode: error.code, error: 'Workflow read failed' };
        }
      } } satisfies Pick<Parameters<typeof registerDiscussionAgentPublisher>[0], 'executeSourceAction'>),
      session: { sessionId: 'receiver', postAgentDiscussionMessage: async request => {
        posts.push(request); committed = true; return { v: 1, ok: false, error: 'discussion_post_denied' };
      } },
    });
    const handler = (request: unknown) => rpc.invokeLocal(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, request);
    const publication = (text: string, attempt = '0') => ({ request: { v: 1, sessionId: 'receiver', discussionId: 'discussion',
      replyReturn: { serverId: binding === 'profile_marker' ? serverId : serverIdentityId, requestLocalId: localId, acceptedTurnId: 'turn',
        workflow: { runId, invocationRecordId: recordId, invocationAttempt: attempt } },
      request: { localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId: 'receiver', localId, acceptedTurnId: 'turn' }),
        content: { t: 'plain', v: text !== 'accepted answer' ? { v: 1, parts: [{ t: 'text', text }] }
          : binding === 'typed_delivery' ? { v: 1, parts: [{ t: 'text', text: 'The requested work finished.' }] }
            : { v: 1, parts: [{ t: 'text', text: lifecycle === 'failed' ? 'The requested session failed.'
              : lifecycle === 'cancelled' ? 'The requested work was cancelled.' : text }] } }, mentionedAccountIds: [], mentionedSessionIds: [],
        replyTarget: { kind: 'message', messageId: 'question' } },
    } });
    const unavailable = binding === 'storage_unavailable' || binding === 'missing_source_reader';
    expect(await handler(publication('forged output'))).toMatchObject({ ok: false,
      error: unavailable ? 'discussions_unavailable' : 'discussion_post_denied' });
    expect(logger).toHaveBeenCalledWith('[RPC] Request completed', expect.objectContaining({
      outcomeCode: unavailable ? 'discussions_unavailable' : 'discussion_post_denied', admissionPredicate: binding === 'profile_marker' || binding === 'profile_publication_ref'
        ? 'discussion_reply_custody' : 'discussion_reply_result',
    }));
    expect(JSON.stringify(logger.mock.calls)).not.toContain('forged output');
    await handler(publication('accepted answer', '1'));
    expect(posts).toEqual([]);
    await handler(publication('accepted answer'));
    expect(posts).toHaveLength(publishable ? 1 : 0);
    await handler(publication('accepted answer'));
    expect(posts).toHaveLength(publishable ? 2 : 0);
    if (publishable) expect(posts[1]).toEqual(posts[0]);
  });
});
