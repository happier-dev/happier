import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { RawIngressStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApiClient } from '@/api/api';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { projectRawIngressSessionAttachmentsV1 } from './projectRawIngressSessionAttachmentsV1';
import { admitSessionStructuredInputV1 } from '../services/admitSessionStructuredInputV1';
import { createSessionClientTranscriptApi } from '@/api/session/client/transcript/sessionClientTranscriptApi';
import type { PersistedSessionUserMessageAdmission } from '@/api/session/client/transcript/sessionUserMessageAdmissionRejoin';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { SOCKET_RPC_EVENTS, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { MachineInstallationProofV1Schema, RequesterSessionCurrentnessPurposeV1Schema,
  verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { logger } from '@/ui/logger';
import { createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub } from '@/testkit/backends/apiSessionSocketHarness';

async function createAttachmentRpcBoundary(directory: string) {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'happier-intake-home-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
  let server: ReturnType<typeof createServer> | undefined;
  let socketServer: Server | undefined;
  let client: ReturnType<ApiClient['sessionSyncClient']> | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try { await client?.close(); }
    finally {
      try {
        if (socketServer) await new Promise<void>(resolve => socketServer!.close(() => resolve()));
        const currentServer = server;
        if (currentServer?.listening) await new Promise<void>((resolve, reject) => {
          currentServer.close(error => error ? reject(error) : resolve());
        });
      } finally {
        env.restore(); reloadConfiguration();
        await rm(homeDirectory, { recursive: true, force: true });
      }
    }
  };
  onTestFinished(dispose);
  env.patch({ HAPPIER_HOME_DIR: homeDirectory, HAPPIER_ACTIVE_SERVER_ID: 'attachment-intake-profile' });
  reloadConfiguration();
  const installation = await readOrCreateInstallationIdentity();
  const host = { custodianAccountId: 'owner', machineId: 'machine', installationId: installation.installationId };
  const owner = SocketRpcMachineAdmissionContextV1Schema.parse({ ...host, actorAccountId: 'owner',
    role: 'manage', encryptionMode: 'plain' });
  const token = 'synthetic-owner-token';
  const homeServerIdentityId = 'srv_attachment_intake';
  const features = FeaturesResponseSchema.parse({ features: {},
    capabilities: { serverIdentity: { serverIdentityId: homeServerIdentityId } } });
  const homeVerification = { entered: 0, settled: 0, accepted: 0,
    route: 'none', method: 'none', bearerMatches: false, contextValid: false,
    purposeValid: false, proofValid: false, signatureValid: false };
  server = createServer(async (request, response) => {
    homeVerification.entered++;
    const pathname = request.url?.split('?')[0];
    homeVerification.route = pathname === '/v1/machines/machine/admission/verify' ? 'admissionVerify'
      : pathname === '/v1/account/encryption/currentness' ? 'accountCurrentness'
      : pathname === '/v1/account/encryption' ? 'accountEncryption'
      : pathname === '/v1/features' ? 'features'
      : pathname === '/v1/features/authenticated' ? 'authenticatedFeatures'
      : pathname === '/v1/auth/ping' ? 'authPing'
      : pathname !== undefined && /^\/v1\/access-keys\/[^/]+\/[^/]+$/u.test(pathname) ? 'sessionMachineAccessKey'
      : pathname === '/v1/updates' || pathname === '/v1/updates/' ? 'sessionSocket'
      : pathname === '/socket.io/' ? 'socketIo' : 'other';
    homeVerification.method = request.method === 'GET' ? 'get' : request.method === 'POST' ? 'post' : 'other';
    let raw = '';
    for await (const chunk of request) raw += chunk;
    // Only Home HTTP is substituted; Session admission and proof crypto stay real.
    let body: unknown;
    try { body = JSON.parse(raw); } catch { body = null; }
    const context = SocketRpcMachineAdmissionContextV1Schema.safeParse(body && typeof body === 'object' && 'context' in body ? body.context : undefined);
    const purpose = RequesterSessionCurrentnessPurposeV1Schema.safeParse(body && typeof body === 'object' && 'purpose' in body ? body.purpose : undefined);
    const proof = MachineInstallationProofV1Schema.safeParse(body && typeof body === 'object' && 'proof' in body ? body.proof : undefined);
    const signatureValid = context.success && purpose.success && proof.success
      && purpose.data.sessionId === 'session-1' && verifyMachineInstallationProof({ publicKey: installation.publicKey,
        proof: proof.data, payload: { version: 1, accountId: 'owner', machineId: 'machine',
          installationId: installation.installationId, rpcAdmission: { context: context.data, purpose: purpose.data } } });
    homeVerification.bearerMatches = request.headers.authorization === `Bearer ${token}`;
    homeVerification.contextValid = context.success;
    homeVerification.purposeValid = purpose.success;
    homeVerification.proofValid = proof.success;
    homeVerification.signatureValid = signatureValid;
    const valid = request.url === '/v1/machines/machine/admission/verify'
      && homeVerification.bearerMatches && signatureValid;
    // Match the real AccessKey HTTP binding before the Session transport connects;
    // this Plain Account's binding is not client Account encryption material.
    const existingBinding = request.method === 'GET' && pathname === '/v1/access-keys/session-1/machine';
    const featureRead = request.method === 'GET' && pathname === '/v1/features';
    const authPing = request.method === 'GET' && pathname === '/v1/auth/ping';
    const admissionVerify = pathname === '/v1/machines/machine/admission/verify';
    const status = existingBinding || authPing ? homeVerification.bearerMatches ? 200 : 403
      : featureRead ? 200 : admissionVerify ? valid ? 200 : 403 : 404;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(existingBinding && status === 200
      ? { accessKey: { data: 'session-machine-control:attachment-fixture', dataVersion: 0, createdAt: 0, updatedAt: 0 } }
      : featureRead ? features : admissionVerify ? { v: 1, ok: valid } : {}));
    homeVerification.settled++;
    if (valid) homeVerification.accepted++;
  });
  // Reuse the canonical Session Home's genuine Socket.IO boundary and schema
  // responders; connection supervision and RPC registration remain real.
  socketServer = new Server(server, { path: '/v1/updates/' });
  const transcriptHome = createSessionTranscriptHomeStub();
  const activityHome = createSessionRuntimeActivityHomeStub({ machineId: host.machineId });
  socketServer.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.REGISTER, ({ method }: { method: string }) => {
      socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
    });
    socket.onAny((event, payload, acknowledge) => {
      const answer = transcriptHome.answer(event, payload) ?? activityHome.answer(event, payload);
      if (answer !== null && typeof acknowledge === 'function') acknowledge(answer);
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing intake Home fixture address');
  env.patch({ HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}` });
  reloadConfiguration();
  const api = await ApiClient.create({ token, encryption: null });
  api.setLocalMachineId('machine');
  api.setServerFeaturesSnapshotProvider(() => ({ status: 'ready', features }));
  client = api.sessionSyncClient(createPlainSessionFixture({ id: 'session-1', metadata: createTestMetadata({ path: directory }) }),
    { durableMutationDeliveryInitiallyActive: false });
  const rpc = client.rpcHandlerManager;
  // Observe the existing logger boundary without replacing execution or admission.
  const completionSpy = vi.spyOn(logger, 'debug');
  onTestFinished(() => completionSpy.mockRestore());
  const filesystemEffectAdmission = createFilesystemEffectAdmission({
    resolveHomeServerIdentityId: async () => homeServerIdentityId,
    resolveHostIdentity: async () => host,
  });
  // The actual Session receiver verifies Home's physical receipt and supplies
  // its local cancellation callback; the payload remains Session-owner scoped.
  const call = (method: string, params: unknown, custody: 'owner' | 'missing' | 'foreign' = 'owner') => rpc.handleRequest({
    method: `session-1:${method}`, params, callerAuthority: 'present_user',
    authorization: { kind: 'session.write', sessionId: 'session-1' },
    ...(custody === 'missing' ? {} : { machineAdmission: custody === 'foreign'
      ? { ...owner, actorAccountId: 'foreign-account' } : owner }),
  }, undefined, 'authenticated_home_socket');
  const diagnostic = (result: unknown, stage: string) => attachmentRpcDiagnostic(result, stage,
    completionSpy.mock.calls.filter(([message]) => message === '[RPC] Request completed').at(-1)?.[1], homeVerification);
  return { rpc, filesystemEffectAdmission, call, dispose, diagnostic };
}

function attachmentRpcDiagnostic(result: unknown, stage: string, completion?: unknown,
  homeVerification?: Readonly<{ entered: number; settled: number; accepted: number;
    route: string; method: string; bearerMatches: boolean; contextValid: boolean;
    purposeValid: boolean; proofValid: boolean; signatureValid: boolean }>): string {
  const record = result !== null && typeof result === 'object' ? result : null;
  const error = record && 'error' in record && typeof record.error === 'string' ? record.error : null;
  return JSON.stringify({ stage, resultType: typeof result, isArray: Array.isArray(result),
    fields: Object.fromEntries(['error', 'success', 'status', 'kind', 'code', 'errorCode', 'result', 'v', 't']
      .map(key => [key, record !== null && Object.hasOwn(record, key)])),
    errorType: record && 'error' in record ? typeof record.error : 'absent',
    knownError: {
      transportDisconnected: error === 'RPC target transport disconnected',
      missingMethod: error === "Cannot read properties of undefined (reading 'startsWith')"
        || error === "Cannot read properties of null (reading 'startsWith')",
      missingGrantBinding: error === "Cannot use 'in' operator to search for 'grant' in undefined"
        || error === "Cannot use 'in' operator to search for 'grant' in null",
      missingAuthorizationResult: error === "Cannot read properties of undefined (reading 'ok')"
        || error === "Cannot read properties of null (reading 'ok')",
      uninitializedRoutePolicy: error === "Cannot access 'POLICY_BY_METHOD' before initialization",
      unavailableRoutePolicyFunction: error !== null && /resolveMachineRpcRoutePolicy\)? is not a function$/u.test(error),
    },
    ...(homeVerification ? { homeVerification } : {}),
    ...(completion !== null && typeof completion === 'object' ? {
      completion: Object.fromEntries(['method', 'outcomeCode', 'admissionPredicate', 'failedPhase', 'code']
        .flatMap(key => {
          const value: unknown = Reflect.get(completion, key);
          return typeof value === 'string' ? [[key, value]] : [];
        })),
      cancelled: 'cancelled' in completion && completion.cancelled === true,
    } : {}),
  });
}

function createTranscriptIntake(params: Readonly<{
  resolveSessionAttachment?: Parameters<typeof createSessionClientTranscriptApi>[0]['resolveSessionAttachment'];
  transformSessionInputBeforeCommit?: Parameters<typeof createSessionClientTranscriptApi>[0]['transformSessionInputBeforeCommit'];
  admitSessionUserMessage?: Parameters<typeof createSessionClientTranscriptApi>[0]['admitSessionUserMessage'];
  findPersistedSessionUserMessageAdmission?: Parameters<typeof createSessionClientTranscriptApi>[0]['findPersistedSessionUserMessageAdmission'];
  getMetadataSnapshot?: Parameters<typeof createSessionClientTranscriptApi>[0]['getMetadataSnapshot'];
}>) {
  return createSessionClientTranscriptApi({
    token: 'token', sessionId: 'session-1', outboundShapeLogger: { log: () => {} },
    getSocket: () => ({ connected: false, emit: () => {} }),
    getLatestTurnSnapshot: () => null,
    getSessionConnectionSupervisor: () => null, getMetadataSnapshot: () => null,
    updateAgentState: async () => {}, updateMetadata: async () => {},
    enqueueCommittedTranscriptMessage: async () => ({ persisted: true, delivered: false }),
    enqueueCommittedVoiceAgentTranscriptTurn: async () => ({ persisted: true, delivered: false }),
    usageObservationPublisher: { publish: async () => {} },
    buildOutboundSessionMessagePayload: content => ({ t: 'plain', v: content }),
    toolCallCanonicalNameByProviderAndId: new Map(), permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
    admitSessionUserMessage: async ({ localId }) => ({ status: 'accepted', localId }),
    findPersistedSessionUserMessageAdmission: async () => null,
    getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }), ...params,
  });
}

describe('issued Session attachments at target intake', () => {
  it('refuses attachment filesystem effects without owner custody at the Home boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-attachment-intake-custody-'));
    const { rpc, filesystemEffectAdmission, call, dispose } = await createAttachmentRpcBoundary(directory);
    const registration = registerSessionHandlers(rpc, directory, { sessionId: 'session-1', filesystemEffectAdmission });
    try {
      for (const custody of ['missing', 'foreign'] as const) {
        expect(await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
          t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'unadmitted-input',
          fileName: 'private.txt', sizeBytes: 0, uploadLocation: 'workspace', workspaceRelativeDir: '.uploads',
          vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
        }, custody)).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
      }
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await registration.dispose();
      await dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([false, true])('issues one directory descriptor preserving empty folders (empty root=%s)', async (empty) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-folder-intake-'));
    const { rpc, filesystemEffectAdmission, call, dispose, diagnostic } = await createAttachmentRpcBoundary(directory);
    const registration = registerSessionHandlers(rpc, directory, { sessionId: 'session-1', filesystemEffectAdmission });
    try {
      let folderHandle: unknown;
      for (const [index, relativePath] of (empty ? [] : ['a.txt', 'nested/b.txt']).entries()) {
        const bytes = Buffer.from(index === 0 ? 'hello' : 'world!');
        const init = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
          t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'folder-input',
          fileName: relativePath.split('/').at(-1), relativePath: `draft-1/project/${relativePath}`,
          sizeBytes: bytes.length,
          uploadLocation: 'workspace', workspaceRelativeDir: '.uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
        }) as { success: boolean; uploadId: string; recipientPublicKeyBase64: string };
        expect(init.success, diagnostic(init, 'directory.file.upload.init')).toBe(true);
        const chunk = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
          payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
        expect(await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0,
          payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 })).toEqual({ success: true });
        const finalized = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId }) as {
          success: boolean; attachmentHandle: unknown;
        };
        expect(finalized.success).toBe(true);
        folderHandle = finalized.attachmentHandle;
        expect(await readFile(join(directory, '.uploads/messages/folder-input/draft-1/project', relativePath))).toEqual(bytes);
      }
      const folderInit = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'folder-input',
        fileName: 'project', attachmentId: 'draft-1', relativePath: 'draft-1/project', directoryEntries: ['empty-child', 'nested/empty'], sizeBytes: 0,
        uploadLocation: 'workspace', workspaceRelativeDir: '.uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
      }) as { success: boolean; uploadId: string };
      expect(folderInit.success, diagnostic(folderInit, 'directory.upload.init')).toBe(true);
      const folderResult = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: folderInit.uploadId }) as {
        success: boolean; attachmentHandle: unknown;
      };
      expect(folderResult.success).toBe(true);
      folderHandle = folderResult.attachmentHandle;
      const { stat } = await import('node:fs/promises');
      expect((await stat(join(directory, '.uploads/messages/folder-input/draft-1/project/empty-child'))).isDirectory()).toBe(true);
      expect((await stat(join(directory, '.uploads/messages/folder-input/draft-1/project/nested/empty'))).isDirectory()).toBe(true);
      const projected = projectRawIngressSessionAttachmentsV1({ sessionId: 'session-1', text: 'Read this folder',
        meta: { happierStructuredInputV1: { v: 1, sessionAttachments: [folderHandle] } },
        resolveSessionAttachment: registration.resolveSessionAttachment });
      expect(projected.meta).toMatchObject({ happier: { kind: 'attachments.v1', payload: { attachments: [{
        id: 'draft-1', name: 'project', path: '.uploads/messages/folder-input/draft-1/project', mimeType: 'inode/directory', sizeBytes: empty ? 0 : 11,
      }] } } });
    } finally {
      await registration.dispose();
      await dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    { name: 'notes.txt', bytes: Buffer.from('real target attachment\n'), mimeType: null, text: '' },
    { name: 'pixel.png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'), mimeType: 'image/png', text: 'Read this' },
  ])('projects real uploaded $name bytes with text "$text" and refuses forged or other-Session handles', async ({ name, bytes, mimeType, text }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-issued-intake-'));
    const { rpc, filesystemEffectAdmission, call, dispose, diagnostic } = await createAttachmentRpcBoundary(directory);
    let intake: ReturnType<typeof createTranscriptIntake> | null = null;
    let received: unknown = null;
    const registration = registerSessionHandlers(rpc, directory, {
      sessionId: 'session-1',
      filesystemEffectAdmission,
      sessionRuntimeControls: {
        handleUserMessage: async () => { throw new Error('Issued attachments bypassed target admission'); },
        preparePendingMessageComposerAdmission: async request => {
          if (!intake) throw new Error('Missing target intake');
          return await intake.preparePendingMessageComposerAdmission(request);
        },
      },
      enqueueSessionUserMessage: async request => {
        if (!intake || !request.localId) throw new Error('Missing target intake');
        await intake.enqueueSessionUserMessage({ ...request, localId: request.localId });
      },
    });
    try {
      const init = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'target-input',
        fileName: name, sizeBytes: bytes.length,
        uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
      }) as { success: boolean; uploadId: string; recipientPublicKeyBase64: string };
      expect(init.success, diagnostic(init, 'file.upload.init')).toBe(true);
      const encrypted = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
        payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
      expect(await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0,
        payloadBase64: encrypted.payloadBase64, encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 })).toEqual({ success: true });
      const finalized = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId }) as {
        success: boolean; path: string; attachmentHandle: unknown;
      };
      expect(finalized.success).toBe(true);
      const handle = SessionAttachmentHandleV1Schema.parse(finalized.attachmentHandle);
      const structuredInput = RawIngressStructuredInputV1Schema.parse({ v: 1, sessionAttachments: [handle] });
      const projected = projectRawIngressSessionAttachmentsV1({
        sessionId: 'session-1', text, meta: { happierStructuredInputV1: structuredInput },
        resolveSessionAttachment: registration.resolveSessionAttachment,
      });
      const admitted = admitSessionStructuredInputV1({ ...projected,
        admissionPolicy: { allowedLocalImagePaths: projected.allowedLocalImagePaths },
      });
      expect(admitted.meta).toMatchObject({ happier: { kind: 'attachments.v1', payload: { attachments: [{
        path: finalized.path, name, sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), attachmentHandle: handle,
      }] } } });
      expect(admitted.structuredInput).not.toHaveProperty('sessionAttachments');
      if (mimeType) expect(admitted.structuredInput).toMatchObject({ imageInputs: [{
        path: finalized.path, mimeType, sha256: createHash('sha256').update(bytes).digest('hex'),
      }] });
      expect(projected.text).toBe(text);
      expect(await readFile(join(directory, finalized.path))).toEqual(bytes);
      const published = projected.meta.happier as { payload: { attachments: { attachmentHandle: { id: string } }[] } };
      published.payload.attachments[0].attachmentHandle.id = 'mutated-presentation';
      expect(registration.resolveSessionAttachment(handle)?.handle.id).toBe(handle.id);
      published.payload.attachments[0].attachmentHandle.id = handle.id;

      intake = createTranscriptIntake({ resolveSessionAttachment: registration.resolveSessionAttachment,
        admitSessionUserMessage: async request => {
          received = request;
          return { status: 'accepted', localId: request.localId };
        },
        // A contributed transform is an external plugin boundary. Its real strict
        // hook reader must see the issued projection before it can select slots.
        transformSessionInputBeforeCommit: payload => {
          expect(payload.meta).toMatchObject({ happier: { kind: 'attachments.v1' } });
          return { ...payload, text: `${payload.text}\n[configured hook]` };
        },
      });
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text, structuredInput,
      })).toMatchObject({ ok: true, text: projected.text, sessionAttachmentMetadata: {
        key: 'happier', envelope: admitted.meta.happier,
      } });
      expect(await call(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, { localId: 'target-input',
        text, meta: { happierStructuredInputV1: structuredInput } })).toEqual({ ok: true });
      expect(received).toMatchObject({ meta: admitted.meta, text: `${projected.text}\n[configured hook]` });
      if (mimeType) {
        let queuedReceived: unknown = null;
        const queued = createTranscriptIntake({
          getMetadataSnapshot: () => createTestMetadata({ path: directory }),
          admitSessionUserMessage: async request => {
            queuedReceived = request;
            return { status: 'accepted', localId: request.localId };
          },
        });
        // The original Pending input carries a prepared descriptor, not a
        // volatile issued handle or a caller-supplied image allowlist.
        await queued.enqueueSessionUserMessage({ localId: 'queued-image', text: projected.text, meta: projected.meta });
        expect(queuedReceived).toMatchObject({ meta: { happierStructuredInputV1: { imageInputs: [{
          path: finalized.path, mimeType, sha256: createHash('sha256').update(bytes).digest('hex'),
        }] } } });
      }
      // The production transformer cannot succeed if its issued-store binding is missing.
      await expect(createTranscriptIntake({}).preparePendingMessageComposerAdmission({ localId: 'unbound',
        text: 'Read this', meta: { happierStructuredInputV1: structuredInput } }))
        .rejects.toMatchObject({ code: 'session_structured_input_session_attachment_invalid' });

      for (const [index, invalid] of [{ ...handle, sessionId: 'source-session' }, { ...handle, id: 'forged-upload' },
        { ...handle, sha256: 'a'.repeat(64) }, { ...handle, path: '/etc/passwd' }].entries()) {
        expect(() => projectRawIngressSessionAttachmentsV1({ sessionId: 'session-1', text: 'Read this',
          meta: { happierStructuredInputV1: { v: 1, sessionAttachments: [invalid] } },
          resolveSessionAttachment: registration.resolveSessionAttachment,
        })).toThrowError('session_structured_input_session_attachment_invalid');
        expect(await call(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
          localId: `invalid-${index}`, text: 'Read this',
          meta: { happierStructuredInputV1: { v: 1, sessionAttachments: [invalid] } },
        })).toMatchObject({ ok: false, errorCode: expect.stringMatching(/^session_structured_input_/) });
      }
      expect(() => admitSessionStructuredInputV1({ text: 'Read this', meta: {
        happierStructuredInputV1: structuredInput,
      } })).toThrowError('session_structured_input_session_attachment_preparation_required');

      const persisted = received as PersistedSessionUserMessageAdmission;
      await registration.dispose();
      expect(registration.resolveSessionAttachment(handle)).toBeNull();
      intake = createTranscriptIntake({ resolveSessionAttachment: registration.resolveSessionAttachment,
        findPersistedSessionUserMessageAdmission: async () => persisted,
        transformSessionInputBeforeCommit: () => { throw new Error('Preparation reran a configured hook'); },
      });
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text, structuredInput,
      })).toMatchObject({ ok: true, text: projected.text, sessionAttachmentMetadata: { envelope: admitted.meta.happier } });
      // Reconstruct current intent; only the original writer may decide equality.
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text: 'Changed instructions', structuredInput,
      })).toMatchObject({ ok: true, text: 'Changed instructions' });
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text, structuredInput: { ...structuredInput,
          sessionAttachments: [{ ...handle, id: 'changed-selection' }],
        },
      })).toMatchObject({ ok: false });
    } finally {
      await registration.dispose();
      await dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
