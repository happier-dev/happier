import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { UserMessageSchema } from '../../../../apps/cli/src/api/types';
import { projectRawIngressSessionAttachmentsV1 } from '../../../../apps/cli/src/session/attachments/projectRawIngressSessionAttachmentsV1';
import { admitSessionStructuredInputV1 } from '../../../../apps/cli/src/session/services/admitSessionStructuredInputV1';
import { prepareSessionInputForProviderDispatch } from '../../../../apps/cli/src/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { registerPermissionModeMessageQueueBinding } from '../../../../apps/cli/src/agent/runtime/permissions/bindModeQueue';
import { MessageQueue2 } from '../../../../apps/cli/src/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt,
  type PermissionModeQueuedPromptMode } from '../../../../apps/cli/src/agent/runtime/permissions/queuedPrompt';
import type { SessionProviderInputConsumer } from '../../../../apps/cli/src/api/session/sessionClientPort';
import { SessionPendingMessageComposerAdmissionPrepareResponseV1Schema,
  SessionPendingMessageComposerAdmissionPrepareRequestV1Schema } from '@happier-dev/protocol/sessions/userMessageRpc';
import { SessionAttachmentsMessageMetaV1Schema } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { MENTION_KIND_V1, buildMentionRefForKindV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../apps/ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture, standardCleanup } from '../../../../apps/ui/sources/dev/testkit';
import { createPlainSessionByIdResponseFixture } from '../../../../apps/ui/sources/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '../../../../apps/ui/sources/dev/testkit/harness/syncSingletonLoader';
import { currentPendingEnqueueAck } from '../../../../apps/ui/sources/sync/engine/pending/pendingQueueV2.testHelpers';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '../../../../apps/ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { serverScopedRpcSocketPool } from '../../../../apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { storage } from '../../../../apps/ui/sources/sync/domains/state/storage';
import { enqueuePendingMessageV2 } from '../../../../apps/ui/sources/sync/engine/pending/pendingQueueV2';

vi.mock('socket.io-client', async importOriginal =>
  (await import('../../../../apps/ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let serverId: string;
let directory: string;
let store: TransferSessionStore;
const sessionId = 'FIX15-ATTACH-session';

beforeEach(async () => {
  await homes.reset();
  await loadSyncSingletonForTests();
  serverId = await homes.addHome({ name: 'Attachment Home', serverUrl: 'https://attachment-dispatch.test', accountId: 'attachment-owner' });
  const scope = { serverId, accountId: 'attachment-owner' };
  storage.getState().activateProfileScope(scope);
  await storage.getState().activateSettingsScope(scope);
  storage.getState().activateSessionLocalStateScope(scope);
  directory = await mkdtemp(join(tmpdir(), 'FIX15-ATTACH-'));
  store = new TransferSessionStore({ ttlMs: 30_000 });
});
afterEach(async () => {
  await store?.dispose();
  await serverScopedRpcSocketPool.stopAll();
  serverScopedRpcSocketPool.resetForTests();
  await standardCleanup();
  await homes.reset();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('issued attachments from Pending enqueue to shared provider dispatch', () => {
  it.each(['text-and-file', 'reference-only', 'multiple', 'workspace-reference'] as const)('%s retains the issued path exactly once', async scenario => {
    const uploads = await Promise.all(Array.from({ length: scenario === 'workspace-reference' ? 0 : scenario === 'multiple' ? 2 : 1 }, async (_, index) => {
      const id = `tray-${index}`;
      const name = `notes-${index}.txt`;
      const displayPath = `.happier/uploads/messages/input/issued-${name}`;
      const bytes = Buffer.from(`FIX15-ATTACH sentinel ${index}\n`);
      const filePath = join(directory, displayPath);
      await mkdir(join(directory, '.happier/uploads/messages/input'), { recursive: true });
      await writeFile(filePath, bytes);
      const handle = store.issueAttachment({ uploadId: `upload-${index}`, attachmentId: id, sessionId,
        filePath, displayPath, name, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      return { id, name, displayPath, bytes, handle };
    }));
    const fileRef = buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/main.ts');
    const text = scenario === 'workspace-reference' ? `[main](happier-ref:${fileRef})`
      : `${scenario === 'reference-only' ? '' : 'Read these files: '}${uploads.map(upload => `[${upload.name}](happier-ref:attachment:${upload.id})`).join(' ')}`;
    let preparations = 0;
    // Only the cross-process RPC transport is substituted. The real issued-store
    // projection and admission produce the response read by the UI's strict codec.
    installDisconnectedServerSocketBoundary(socket => {
      configureConnectedServerSocketBoundary(socket);
      socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
      socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object') throw new Error('Missing RPC request');
        const method: unknown = Reflect.get(payload, 'method');
        if (typeof method !== 'string') throw new Error('Missing RPC method');
        if (!method.endsWith(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1)) return { ok: true, result: { ok: true } };
        preparations++;
        const request = SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.parse(Reflect.get(payload, 'params'));
        const projected = projectRawIngressSessionAttachmentsV1({ sessionId, text: request.text,
          meta: { happierStructuredInputV1: request.structuredInput }, resolveSessionAttachment: handle => store.getIssuedAttachment(handle) });
        const admitted = admitSessionStructuredInputV1({ ...projected,
          admissionPolicy: { allowedLocalImagePaths: projected.allowedLocalImagePaths } });
        return { ok: true, result: SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.parse({ ok: true, text: admitted.text,
          structuredInput: admitted.structuredInput, stagedMediaHandles: [], sessionAttachmentMetadata: {
            key: 'happier', envelope: SessionAttachmentsMessageMetaV1Schema.parse(admitted.meta.happier),
          } }) };
      });
    });
    const session = createSessionFixture({ id: sessionId, serverId, encryptionMode: 'plain', active: true,
      metadata: { path: directory, host: 'test', machineId: 'machine', flavor: 'codex' } });
    storage.setState({ sessions: { [sessionId]: session } });
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, { body: createPlainSessionByIdResponseFixture(session) });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'mode', {
      batcher: combinePermissionModeQueuedPrompts,
    });
    let receive: SessionProviderInputConsumer | undefined;
    registerPermissionModeMessageQueueBinding({ session: { sessionId, onUserMessage: callback => { receive = callback; }, updateMetadata() {} },
      queue, getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {} });
    let enqueues = 0;
    const sibling = { kind: 'context.v1', payload: { source: 'preserved' } };
    const result = await enqueuePendingMessageV2({ sessionId, session, localId: 'input', text, encryption: null,
      outboxScope: { serverId, accountId: 'attachment-owner' }, serverWireMode: 'pending_input_v5',
      metaOverrides: { ...(scenario === 'multiple' ? { happier: sibling } : {}), happierStructuredInputV1: scenario === 'workspace-reference'
        ? { v: 1, mentions: [{ kind: MENTION_KIND_V1.file, ref: fileRef, label: 'main', token: text }] }
        : { v: 1, sessionAttachments: uploads.map(upload => upload.handle) } },
      request: async (_path, init) => {
        enqueues++;
        const body: unknown = JSON.parse(String(init?.body));
        if (!body || typeof body !== 'object' || !('content' in body)) throw new Error('Missing Pending content');
        const content = body.content;
        if (!content || typeof content !== 'object' || !('t' in content) || content.t !== 'plain' || !('v' in content)) throw new Error('Expected Plain fixture');
        const message = UserMessageSchema.parse(content.v);
        if (scenario === 'multiple') expect(message.meta?.happier).toEqual(sibling);
        receive?.({ ...message, localId: 'input' });
        return currentPendingEnqueueAck(init);
      },
    });
    expect(result.accepted).toBe(true);
    expect(queue.size()).toBe(1);
    const batch = await queue.waitForMessagesAndGetAsString();
    if (!batch) throw new Error('Missing provider input');
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: batch.message, transformedUserText: batch.message.text,
      providerNativeCommand: false, signal: new AbortController().signal, localId: 'input' });
    for (const upload of uploads) {
      expect(prepared.requiredPrompt.split(upload.displayPath)).toHaveLength(2);
      expect(await readFile(join(directory, upload.displayPath))).toEqual(upload.bytes);
    }
    expect(prepared.requiredPrompt).not.toContain('happier-ref:');
    if (!uploads.length) expect(prepared.requiredPrompt).toContain('path="src/main.ts"');
    expect(preparations).toBe(uploads.length ? 1 : 0);
    expect(enqueues).toBe(1);
  });
});
