import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionSendRequestV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createExternalContributionFixtures } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionMessageContentV1StoredSchema, type DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import { readSessionAttachmentDescriptorsV1 } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { sealResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { admitSessionStructuredInputV1 } from '@/session/services/admitSessionStructuredInputV1';
import { prepareSessionInputForProviderDispatch, readStructuredInputPreparationFailure } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { configuration } from '@/configuration';
import { createDiscussionActionDeps } from './discussionActionDeps';
import { materializeDiscussionInputAttachments } from './materializeDiscussionInputAttachments';

const http = vi.hoisted(() => ({ request: vi.fn() }));
// Only the Home HTTP boundary is replaced; resource crypto, cutoff
// selection, Session transfer/issuance and provider projection stay real.
vi.mock('axios', () => ({ default: http }));

describe('Discussion source at actual provider preparation', () => {
  it.each([
    { mode: 'plain', source: 'addressed' }, { mode: 'e2ee', source: 'addressed' },
    { mode: 'plain', source: 'workflow-selected' }, { mode: 'e2ee', source: 'workflow-selected' },
  ] as const)('materializes only the original $mode $source question and ancestors independently on each Machine', async ({ mode, source }) => {
    const credentials = mode === 'plain' ? { token: 'fixture', encryption: null }
      : { token: 'fixture', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(3) } };
    const key = await createResourceDataKey({ credentials, mode });
    const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? { mode: 'plain', ctx: null }
      : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
    const sessionIds = ['session-1', 'session-2'];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
    const bytes = [Buffer.from('ancestor evidence'), png, Buffer.from('folder evidence'), Buffer.from('future peer file')];
    const references = bytes.map((file, index) => ({ blobId: `7578de54-3f59-4d6d-8293-ff6e4682fd1${index}`,
      mime: index === 1 ? 'image/png' : 'text/plain', sizeBytes: file.length, sha256: createHash('sha256').update(file).digest('hex') }));
    const contents: DiscussionMessageContentV1[] = [
      { v: 1, parts: [{ t: 'attachment', attachment: { kind: 'file', id: references[0]!.blobId, name: 'ancestor.txt', file: references[0]! } }] },
      { v: 1, parts: [{ t: 'text', text: 'Inspect the admitted files' },
        { t: 'attachment', attachment: { kind: 'file', id: references[1]!.blobId, name: 'pixel.png', file: references[1]! } },
        { t: 'attachment', attachment: { kind: 'folder', id: '7578de54-3f59-4d6d-8293-ff6e4682fd19', name: 'project',
          entries: [{ relativePath: 'nested/notes.txt', file: references[2]! }], directories: ['empty', 'cafe\u0301/empty'] } } ] },
      { v: 1, parts: [{ t: 'attachment', attachment: { kind: 'file', id: references[3]!.blobId, name: 'future.txt', file: references[3]! } }] },
    ];
    const messages = contents.map((content, index) => ({ id: ['ancestor', 'question', 'future'][index]!, discussionId: 'discussion',
      localId: `message-${index}`, seq: index + 1, authorAccountId: 'owner', accountActor: { v: 1, accountId: 'owner', profile: null },
      producerV1: null, mentionedAccountIds: [], content: sealSessionStoredContent({ ...crypto,
        payload: DiscussionMessageContentV1StoredSchema.parse(content) }), createdAt: 1,
      ...(index === 1 ? { addressingV1: { throughSeq: 2, participantSessionIds: source === 'addressed' ? sessionIds : [] }, replyTarget: { kind: 'message', messageId: 'ancestor' } } : {}),
    }));
    const summary = DiscussionSummaryV1Schema.parse({ id: 'discussion', ownerAccountId: 'owner', encryptionMode: mode,
      dataEncryptionKey: key.dataEncryptionKey, keyReadiness: true, anchor: null, access: 'owner', creationLocalId: 'creation',
      titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Evidence' } }),
      latestMessage: { id: 'future', localId: 'message-2', seq: 3, authorAccountId: 'owner',
        accountActor: { v: 1, accountId: 'owner', profile: null }, producerV1: null, createdAt: 1 },
      messageSeq: 3, lastReadSeq: 0, unreadCount: 3, unreadMentionCount: 1, recentAuthorAccountIds: ['owner'], archivedAt: null,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    });
    let revoked = false;
    let revokeAfterFirstByteRead = false;
    const demanded: string[] = [];
    http.request.mockImplementation(async (request: { url: string }) => {
      if (revoked) return { status: 403, data: { error: 'discussion_read_denied' } };
      const url = new URL(request.url);
      if (url.pathname.endsWith('/messages')) return { status: 200, data: {
        messages: messages.filter(message => message.id === url.searchParams.get('messageId') && message.seq <= Number(url.searchParams.get('throughSeq'))),
        messageSeq: 2, hasMoreOlder: false,
      } };
      if (url.pathname.includes('/attachments/')) {
        expect(url.searchParams.get('throughSeq')).toBe('2');
        const blobId = url.pathname.split('/').at(-1)!;
        const index = references.findIndex(reference => reference.blobId === blobId);
        expect(index).toBeLessThan(3);
        expect(url.pathname).toContain(`/messages/${index === 0 ? 'ancestor' : 'question'}/`);
        demanded.push(blobId);
        if (revokeAfterFirstByteRead) { revoked = true; revokeAfterFirstByteRead = false; }
        return { status: 200, data: { blobId, content: await sealResourceBinaryContent(key, bytes[index]!) } };
      }
      return { status: 200, data: { discussion: summary } };
    });
    const discussion = createDiscussionActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, conversations: { enabled: true } },
          sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
      }) }) });
    const retained: { workspace: string; store: TransferSessionStore }[] = [];
    try {
      for (const sessionId of sessionIds) {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-discussion-machine-'));
        const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
        retained.push({ workspace, store });
        const rpc = registerTransferUploadRpcHandlers({ registerHandler: () => {} }, { workingDirectory: workspace, store,
          sessionAttachment: { sessionId }, attachmentUpload: { resolveSessionWorkingDirectory: async id => id === sessionId ? workspace : null } });
        const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: sessionId };
        let files: ReturnType<typeof readSessionAttachmentDescriptorsV1> = [];
        const prepare = () => prepareSessionInputForProviderDispatch({ prompt: { text: 'Inspect', localId: 'original', discussionAddressing: addressing },
          transformedUserText: 'Inspect', providerNativeCommand: false, signal: new AbortController().signal, localId: 'original', services: {
            sessionId, materializeDiscussionAttachmentsForDispatch: async input => {
              const projected = await materializeDiscussionInputAttachments({ serverId: 'home', discussion, addressing: input.addressing,
                signal: input.signal, target: { sessionId, messageLocalId: input.localId, rpc, resolveSessionAttachment: handle => store.getIssuedAttachment(handle) } });
              if (!projected) return null;
              const admitted = admitSessionStructuredInputV1({ ...projected, admissionPolicy: { allowedLocalImagePaths: projected.allowedLocalImagePaths } });
              files = readSessionAttachmentDescriptorsV1(admitted.meta);
              return { structuredInput: admitted.structuredInput, attachments: files };
            },
          } });
        const prepared = await prepare();
        expect(prepared.requiredPrompt).toContain('ancestor.txt');
        expect(prepared.requiredPrompt).toContain('project');
        expect(prepared.requiredPrompt).not.toContain('future.txt');
        expect(prepared.structuredInput).toMatchObject({ imageInputs: [{ mimeType: 'image/png' }] });
        // The external Agent is the native boundary. Both input sources use the
        // real dispatch preparation and strict native new-Turn adapter.
        const sent: ReturnType<typeof AgentSessionSendRequestV1Schema.parse>[] = [];
        const native: AgentSessionRuntime = {
          async send(request) { sent.push(AgentSessionSendRequestV1Schema.parse(request)); return { status: 'admitted' }; },
          watch: () => ({ dispose() {} }), dispose() {},
        };
        const lifetime = new AbortController();
        const contribution = createExternalContributionFixtures('acme.answerer');
        const services = createUnavailablePluginServices();
        const context = createAcpSessionRuntimeContextFixture({ agent: contribution.agent.richDefinition.definition,
          pluginId: contribution.agent.pluginId, sessionId, directory: workspace, signal: lifetime.signal, services,
          protocols: createPublicAcpRuntimeProtocols({ pluginId: contribution.agent.pluginId, agentId: contribution.agent.id,
            signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, services }) });
        const runtime = createNativeAgentSessionOperations(native, sessionId, () => context.dispose(), undefined, undefined,
          undefined, undefined, { context: context.context, cwd: workspace, connectedAccounts: [],
            capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
        try {
          await runtime.sendTurnPrompt(prepared.renderPrompt(), { localId: 'original', turnId: 'answer-turn',
            ...(prepared.structuredInput ? { structuredInput: prepared.structuredInput } : {}) });
          expect(sent).toMatchObject([{ inputIds: ['original'], delivery: { kind: 'newTurn', turnId: 'answer-turn' },
            input: { text: expect.stringContaining('ancestor.txt'), structuredInput: { imageInputs: [{ mimeType: 'image/png' }] } } }]);
        } finally { await runtime.resetOrDisposeRuntime('session_closed'); }
        const folder = files.find(file => file.mimeType === 'inode/directory')!;
        expect(await readFile(join(workspace, folder.path, 'nested/notes.txt'))).toEqual(bytes[2]);
        expect((await stat(join(workspace, folder.path, 'empty'))).isDirectory()).toBe(true);
        expect((await stat(join(workspace, folder.path, 'cafe\u0301/empty'))).isDirectory()).toBe(true);
        expect(await readFile(join(workspace, files.find(file => file.name === 'pixel.png')!.path))).toEqual(png);
        const before = demanded.length;
        revoked = true;
        const failure = await prepare().catch(error => error);
        expect(readStructuredInputPreparationFailure(failure)).toMatchObject({ code: 'discussion_attachment_preparation_unavailable', retryable: true });
        expect(demanded).toHaveLength(before);
        revoked = false;
        revokeAfterFirstByteRead = true;
        const interrupted = await prepare().catch(error => error);
        expect(readStructuredInputPreparationFailure(interrupted)).toMatchObject({ code: 'discussion_attachment_preparation_unavailable', retryable: true });
        expect(demanded).toHaveLength(before + 1);
        revoked = false;
      }
      expect(demanded).toEqual([...references.slice(0, 3), references[0]!, ...references.slice(0, 3), references[0]!].map(reference => reference.blobId));
    } finally {
      for (const { workspace, store } of retained) { await store.dispose(); await rm(workspace, { recursive: true, force: true }); }
    }
  });
});
