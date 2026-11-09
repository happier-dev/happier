import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RawIngressStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionListingRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { sessionPendingRoutes } from '../../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerSessionMessageRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionMessageRoutes';
import { createSessionMessageFromPending } from '../../../../server/sources/app/session/pending/pendingMessageTranscriptCommit';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from './createCliActionDeps';
import { admitSessionStructuredInputV1 } from '@/session/services/admitSessionStructuredInputV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { createSessionClientTranscriptApi } from '@/api/session/client/transcript/sessionClientTranscriptApi';
import { findPersistedSessionUserMessageAdmission } from '@/api/session/client/transcript/sessionUserMessageAdmissionRejoin';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';

describe('host media Action retry through HTTP and SQLite input custody', () => {
  let harness: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-media-action-rejoin-', initAuth: true,
      env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    await getOrCreateServerIdentityId();
  }, 120_000);
  afterAll(async () => { if (harness) await harness.close(); });

  it.each(['admitted', 'stale', 'lookupFailure'] as const)('prepares issued legacy uploads and preserves exact original custody (%s)', async scenario => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
      encryptionMode: 'plain', metadata: '{}', active: true } });
    const directory = join(harness.baseDir, `issued-uploads-${session.id}`);
    await mkdir(directory);
    const localId = randomUUID();
    const rpc = new RpcHandlerManager({ scopePrefix: session.id, encryptionMode: 'plain' });
    let registration: ReturnType<typeof registerSessionHandlers> | undefined;
    const transcript = createSessionClientTranscriptApi({
      token: 'fixture', sessionId: session.id, outboundShapeLogger: { log: () => undefined },
      getSocket: () => ({ connected: false, emit: () => undefined }),
      getLatestTurnSnapshot: () => null,
      getSessionConnectionSupervisor: () => null, getMetadataSnapshot: () => null,
      updateAgentState: async () => undefined, updateMetadata: async () => undefined,
      enqueueCommittedTranscriptMessage: async () => ({ persisted: true, delivered: false }),
      enqueueCommittedVoiceAgentTranscriptTurn: async () => ({ persisted: true, delivered: false }),
      usageObservationPublisher: { publish: async () => undefined },
      buildOutboundSessionMessagePayload: content => ({ t: 'plain', v: content }),
      toolCallCanonicalNameByProviderAndId: new Map(), permissionToolCallRawInputByProviderAndId: new Map(),
      toolCallInputByProviderAndId: new Map(),
      admitSessionUserMessage: async () => { throw new Error('Preparation must not admit an input'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      findPersistedSessionUserMessageAdmission: ({ localId: id }) => findPersistedSessionUserMessageAdmission({
        token: 'fixture', sessionId: session.id, localId: id, queryContext: { encryptionMode: 'plain' },
      }),
      resolveSessionAttachment: handle => registration?.resolveSessionAttachment(handle) ?? null,
      // Plugin hooks are an external boundary. Legacy upload resolution must
      // preserve them for final transcript admission rather than run them here.
      transformSessionInputBeforeCommit: () => { throw new Error('Generic hooks ran before original Pending custody'); },
    });
    registration = registerSessionHandlers(rpc, directory, { sessionId: session.id,
      sessionRuntimeControls: { preparePendingMessageComposerAdmission: transcript.preparePendingMessageComposerAdmission },
    });
    const app = createAuthenticatedTestApp();
    let failCustodyReads = false;
    let failedCustodyReads = 0;
    app.addHook('onRequest', async (request, reply) => {
      request.headers['x-test-user-id'] = owner.id;
      // A failed Promise.all read leaves its sibling transcript request in flight.
      // This finite fixture must close that request's connection during teardown.
      if (failCustodyReads) reply.header('Connection', 'close');
      if (failCustodyReads && request.method === 'GET' && request.url === `/v2/sessions/${session.id}/pending`) {
        failedCustodyReads += 1;
        // An unreadable successful network response is not proof of no custody.
        return reply.send({ error: 'custody_read_unavailable' });
      }
      return undefined;
    });
    registerAccountEncryptionRoutes(app);
    registerSessionListingRoutes(app);
    registerSessionMessageRoutes(app);
    sessionPendingRoutes(app);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    // The socket transport is the only substituted boundary. Registered RPC
    // parsing, issued upload ownership, transcript preparation and HTTP/DB stay real.
    const socket = vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(request => rpc.handleRequest({
      method: request.method.startsWith(`${session.id}:`) ? request.method : `${session.id}:${request.method}`,
      params: request.request,
    }));
    try {
      await runWithServerHttpBaseUrl(origin, async () => {
        const call = (method: string, params: unknown) => rpc.handleRequest({ method: `${session.id}:${method}`, params });
        const files = [
          { name: 'notes.txt', bytes: Buffer.from('First authored attachment\n') },
          { name: 'summary.txt', bytes: Buffer.from('Second authored attachment\n') },
        ];
        const uploads: { handle: ReturnType<typeof SessionAttachmentHandleV1Schema.parse>; path: string }[] = [];
        for (const file of files) {
          const init = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
            t: 'session_attachment_upload_v1', sessionId: session.id, messageLocalId: localId,
            fileName: file.name, sizeBytes: file.bytes.length, uploadLocation: 'workspace',
            workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
          }) as { success: boolean; uploadId: string; recipientPublicKeyBase64: string };
          expect(init.success).toBe(true);
          const encrypted = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
            payload: file.bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
          expect(await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0,
            payloadBase64: encrypted.payloadBase64, encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 }))
            .toEqual({ success: true });
          const finalized = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId }) as {
            success: boolean; path: string; attachmentHandle: unknown;
          };
          expect(finalized.success).toBe(true);
          uploads.push({ handle: SessionAttachmentHandleV1Schema.parse(finalized.attachmentHandle), path: finalized.path });
          expect(await readFile(join(directory, finalized.path))).toEqual(file.bytes);
        }
        const input = { sessionId: session.id, localId, message: 'Review both attachments', reply: 'none',
          requestedAction: { v: 1, kind: 'enqueue' }, structuredInput: RawIngressStructuredInputV1Schema.parse({
            v: 1, sessionAttachments: uploads.map(upload => upload.handle),
          }) };
        const executor = createActionExecutor(createCliActionDeps({ token: 'fixture', credentials: { token: 'fixture', encryption: null },
          sessionId: 'composer', mode: 'plain', ctx: null }));
        const context = { surface: 'ui' as const, authority: 'present_user' as const };
        if (scenario !== 'admitted') {
          await registration!.dispose();
          expect(registration!.resolveSessionAttachment(uploads[0]!.handle)).toBeNull();
          failCustodyReads = scenario === 'lookupFailure';
          const result = await executor.execute('session.message.send', input, context);
          if (scenario === 'stale') {
            expect(result).toMatchObject({ ok: false, errorCode: 'session_attachment_upload_checkpoint_stale' });
            for (const sessionAttachments of [
              [{ ...uploads[0]!.handle, sessionId: 'another-session' }],
              [uploads[0]!.handle, uploads[0]!.handle],
            ]) {
              const invalid = await executor.execute('session.message.send', { ...input,
                structuredInput: { v: 1, sessionAttachments },
              }, context);
              expect(invalid).toMatchObject({ ok: false });
              expect(invalid).not.toMatchObject({ errorCode: 'session_attachment_upload_checkpoint_stale' });
            }
          } else {
            expect(failedCustodyReads).toBeGreaterThan(0);
            expect(result).toMatchObject({ ok: false, errorCode: expect.any(String) });
            expect(result).not.toMatchObject({ errorCode: 'session_attachment_upload_checkpoint_stale' });
          }
          expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
          expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
          return;
        }
        expect(await executor.execute('session.message.send', input, context))
          .toMatchObject({ ok: true, result: { status: 'accepted', localId } });
        const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        const expectedAttachments = uploads.map((upload, index) => ({ attachmentHandle: upload.handle, path: upload.path,
          name: files[index]!.name, sizeBytes: files[index]!.bytes.length,
          sha256: createHash('sha256').update(files[index]!.bytes).digest('hex'),
        }));
        expect(pending.content).toMatchObject({ t: 'plain', v: { content: { type: 'text', text: expect.stringContaining(input.message) }, meta: {
          happierStructuredInputV1: { v: 1 }, happier: { kind: 'attachments.v1', payload: { attachments: expectedAttachments } },
        } } });
        for (const upload of uploads) expect(pending.content).toMatchObject({ v: {
          content: { text: expect.stringContaining(upload.path) },
        } });
        expect(pending.content).not.toHaveProperty('v.meta.happierStructuredInputV1.sessionAttachments');
        await registration!.dispose();
        expect(registration!.resolveSessionAttachment(uploads[0]!.handle)).toBeNull();
        expect(await executor.execute('session.message.send', input, context))
          .toMatchObject({ ok: true, result: { status: 'alreadyAccepted', localId } });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } })).content).toEqual(pending.content);

        const committed = await inTx(async tx => {
          const content = pending.content as Parameters<typeof createSessionMessageFromPending>[1]['content'];
          const result = await createSessionMessageFromPending(tx, { sessionId: session.id, sessionEncryptionMode: 'plain',
            storagePolicy: 'optional', localId, content, messageRole: 'user', requestContentForEquality: content,
            inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt),
            pendingRequestedAction: input.requestedAction });
          if (!result.ok) throw new Error(`Materialization rejected: ${result.error}`);
          await tx.sessionPendingMessage.delete({ where: { id: pending.id } });
          return result.message;
        });
        expect(await executor.execute('session.message.send', input, context))
          .toMatchObject({ ok: true, result: { status: 'alreadyAccepted', localId } });
        for (const changed of [
          { ...input, message: 'Different current instructions' },
          { ...input, displayText: 'Different current metadata' },
          { ...input, requestedAction: { v: 1, kind: 'send_now' } },
          { ...input, structuredInput: { v: 1, sessionAttachments: [...uploads].reverse().map(upload => upload.handle) } },
          { ...input, structuredInput: { v: 1, sessionAttachments: [{ ...uploads[0]!.handle, id: randomUUID() }] } },
        ]) {
          const result = await executor.execute('session.message.send', changed, context);
          expect(result).not.toMatchObject({ ok: true, result: { status: 'accepted' } });
          expect(result).not.toMatchObject({ ok: true, result: { status: 'alreadyAccepted' } });
        }
        socket.mockResolvedValueOnce({ ok: true, text: input.message, structuredInput: { v: 1 }, stagedMediaHandles: [] });
        expect(await executor.execute('session.message.send', { ...input, localId: randomUUID() }, context))
          .toMatchObject({ ok: false, errorCode: 'session_input_target_update_required' });
        socket.mockRejectedValueOnce(Object.assign(new Error('Session temporarily unavailable'), { code: 'session_rpc_failed' }));
        expect(await executor.execute('session.message.send', input, context))
          .toMatchObject({ ok: false, errorCode: 'session_rpc_failed' });
        expect(await db.sessionMessage.findMany({ where: { sessionId: session.id }, select: { id: true } })).toEqual([{ id: committed.id }]);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
      });
    } finally {
      socket.mockRestore();
      await registration?.dispose();
      await app.close();
    }
  });

  it.each(['pending', 'terminal'] as const)('rejoins original %s input with fresh handles and rejects changed authored intent', async custody => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
      encryptionMode: 'plain', metadata: '{}', active: true } });
    const app = createAuthenticatedTestApp();
    app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = owner.id; });
    registerAccountEncryptionRoutes(app);
    registerSessionListingRoutes(app);
    sessionPendingRoutes(app);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      await runWithServerHttpBaseUrl(origin, async () => {
        const localId = randomUUID();
        const structuredInput = RawIngressStructuredInputV1Schema.parse({ v: 1, composerAttachments: [{
          v: 1, instanceId: 'image-instance', attachment: { pluginId: 'acme.media', localId: 'image' },
          key: 'diagram', value: { caption: 'Architecture' }, presentation: { label: 'Diagram', typeLabel: 'Image' },
          content: { kind: 'stagedMedia', handle: { v: 1, id: 'first_stage',
            executionTarget: { serverId: 'home', machineId: 'target' }, owner: { pluginId: 'acme.media', localId: 'image' },
            mediaKind: 'image', mimeType: 'image/png', name: 'diagram.png', sizeBytes: 42, sha256: 'a'.repeat(64),
          } },
        }] });
        const input = { sessionId: session.id, localId, message: 'Review the diagram', reply: 'none',
          requestedAction: { v: 1, kind: 'enqueue' }, structuredInput };
        const executor = createActionExecutor(createCliActionDeps({ token: 'fixture', credentials: { token: 'fixture', encryption: null },
          sessionId: 'composer', mode: 'plain', ctx: null }));
        const context = { surface: 'ui' as const, authority: 'present_user' as const };
        expect(await executor.execute('session.message.send', input, context))
          .toMatchObject({ ok: true, result: { status: 'accepted', localId } });
        const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        const retry = structuredClone(input);
        retry.structuredInput.composerAttachments![0]!.content!.handle.id = 'fresh_stage';
        if (custody === 'pending') expect(await executor.execute('session.message.send', retry, context))
          .toMatchObject({ ok: true, result: { status: 'alreadyAccepted', localId } });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } })).content).toEqual(pending.content);

        const selected = structuredInput.composerAttachments![0]!;
        if (custody === 'terminal') {
        const admitted = admitSessionStructuredInputV1({ text: input.message, meta: {
          happierStructuredInputV1: structuredInput,
          happierMedia: { kind: 'session_media.v1', payload: { media: [{ id: 'durable_image', role: 'input', category: 'attachment',
            mediaKind: 'image', mimeType: 'image/png', name: 'diagram.png', sizeBytes: 42, sha256: 'a'.repeat(64),
            path: '.happier/uploads/messages/input/diagram.png', createdAtMs: 1, origin: { source: 'user-upload' },
          }] } },
        }, preparedComposerAttachments: [{ ...selected, content: { kind: 'sessionMedia', mediaId: 'durable_image' } }] });
        const terminal = await inTx(async tx => {
          const result = await createSessionMessageFromPending(tx, { sessionId: session.id, sessionEncryptionMode: 'plain',
            storagePolicy: 'optional', localId, content: { t: 'plain', v: {
              role: 'user', content: { type: 'text', text: admitted.text }, meta: admitted.meta,
            } }, messageRole: 'user', requestContentForEquality: pending.content as Parameters<typeof createSessionMessageFromPending>[1]['content'],
            inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt),
            pendingRequestedAction: input.requestedAction });
          if (!result.ok) throw new Error(`Materialization rejected: ${result.error}`);
          await tx.sessionPendingMessage.delete({ where: { id: pending.id } });
          return result.message;
        });
        retry.structuredInput.composerAttachments![0]!.content!.handle.id = 'another_fresh_stage';
        expect(await executor.execute('session.message.send', retry, context))
          .toMatchObject({ ok: true, result: { status: 'alreadyAccepted', localId } });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
        expect(await db.sessionMessage.findMany({ where: { sessionId: session.id }, select: { id: true } })).toEqual([{ id: terminal.id }]);
        }

        for (const changed of [
          { ...retry, message: 'Different instructions' },
          { ...retry, requestedAction: { v: 1, kind: 'send_now' } },
          { ...retry, structuredInput: { ...retry.structuredInput, composerAttachments: [{ ...selected, value: { caption: 'Different' } }] } },
        ]) {
          const result = await executor.execute('session.message.send', changed, context);
          expect(result).not.toMatchObject({ ok: true, result: { status: 'accepted' } });
          expect(result).not.toMatchObject({ ok: true, result: { status: 'alreadyAccepted' } });
        }
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(custody === 'terminal' ? 1 : 0);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(custody === 'pending' ? 1 : 0);
      });
    } finally { await app.close(); }
  });
});
