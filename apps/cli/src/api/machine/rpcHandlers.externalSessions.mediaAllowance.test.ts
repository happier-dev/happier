import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@happier-dev/transfers/node';
import { createTransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerOwnerFilesystemRpcHandlers as registerFileSystemHandlers } from '@/rpc/handlers/fileSystem.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

function createRpcHandlerManager(): RpcHandlerManager {
  return new RpcHandlerManager({
    scopePrefix: 'machine-1',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    encryptionMode: 'plain',
    logger: () => undefined,
  });
}

function createDirectSessionMediaItem(providerMediaPath: string) {
  return {
    id: 'provider-media-1',
    role: 'output',
    category: 'generated',
    mediaKind: 'image',
    mimeType: 'image/png',
    name: 'provider-owned.png',
    path: providerMediaPath,
    sizeBytes: 5,
    origin: { source: 'provider-generated' },
  } as const;
}

describe('external session transcript media read allowance', () => {
  afterAll(async () => {
    await pluginReloadController.shutdown();
  });

  it('limits an owner-granted media read to its exact file and retires a replaced file before filesystem or transfer disclosure', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-media-grant-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-media-grant-provider-'));
    const providerMediaPath = join(providerDirectory, 'provider-owned.png');
    const siblingMediaPath = join(providerDirectory, 'sibling-secret.png');
    const providerMediaBytes = Buffer.from('media');
    await writeFile(providerMediaPath, providerMediaBytes);
    await writeFile(siblingMediaPath, Buffer.from('secret'));
    const allowance = createTransientSessionMediaReadAllowance();
    const rpc = createRpcHandlerManager();
    const handlers = registerFileSystemHandlers(rpc, workingDirectory, {
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      getAdditionalAllowedReadFiles: () => allowance.readAllowedReadFiles(),
    });
    const recipient = createTransferRecipientKeyPair();
    const download = (path: string) => rpc.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
      t: 'session_file_download_v1', path, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    });
    try {
      await expect(rpc.invokeLocal(RPC_METHODS.READ_FILE, { path: providerMediaPath })).resolves.toMatchObject({ success: false });
      // Exercise the actual allowance owner independently of transcript schema
      // admission; an arbitrary Agent raw.meta carrier is refused below.
      allowance.grantReadFiles([providerMediaPath]);
      await expect(rpc.invokeLocal(RPC_METHODS.READ_FILE, { path: providerMediaPath })).resolves.toEqual({
        success: true, content: providerMediaBytes.toString('base64'),
      });
      const init = await download(providerMediaPath);
      expect(init).toMatchObject({ success: true, downloadId: expect.any(String) });
      const { downloadId } = init as { downloadId: string };
      const chunk = await rpc.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, { downloadId, index: 0 });
      expect(chunk).toMatchObject({ success: true, isLast: true });
      const encrypted = chunk as { payloadBase64: string; encryptedDataKeyEnvelopeBase64: string };
      expect(decryptEncryptedTransferChunkEnvelope({
        transferId: downloadId, sequence: 0, payloadBase64: encrypted.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64,
        recipientSecretKeySeed: recipient.recipientSecretKeySeed,
      })).toEqual(providerMediaBytes);
      await rpc.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId });
      await expect(rpc.invokeLocal(RPC_METHODS.READ_FILE, { path: siblingMediaPath })).resolves.toMatchObject({ success: false });
      await expect(download(siblingMediaPath)).resolves.toMatchObject({ success: false });
      await rm(providerMediaPath);
      await symlink(siblingMediaPath, providerMediaPath);
      await expect(rpc.invokeLocal(RPC_METHODS.READ_FILE, { path: providerMediaPath })).resolves.toMatchObject({ success: false });
      await expect(download(providerMediaPath)).resolves.toMatchObject({ success: false });
      await expect(stat(join(workingDirectory, '.happier', 'uploads'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await handlers.dispose();
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });

  it('refuses undeclared Agent transcript metadata without granting filesystem or transfer reads', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-media-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-media-provider-'));
    const providerMediaPath = join(providerDirectory, 'provider-owned.png');
    const providerMediaBytes = Buffer.from('media');
    await writeFile(providerMediaPath, providerMediaBytes);

    const transientMediaReadAllowance = createTransientSessionMediaReadAllowance();
    const rpcHandlerManager = createRpcHandlerManager();
    const fileSystemHandlers = registerFileSystemHandlers(rpcHandlerManager, workingDirectory, {
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      getAdditionalAllowedReadFiles: () => transientMediaReadAllowance.readAllowedReadFiles(),
    });

    const transcript = {
          items: [{
            id: 'direct-item-1',
            localId: 'direct-item-1',
            createdAtMs: 123,
            raw: {
              role: 'agent',
              content: { type: 'output', data: { type: 'message', message: 'preview only' } },
              meta: {
                happier: {
                  kind: 'session_media.v1',
                  payload: {
                    media: [
                      createDirectSessionMediaItem(providerMediaPath),
                    ],
                  },
                },
              },
            },
          }],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
    };
    const declaredTranscript = {
      ...transcript,
      items: transcript.items.map(({ raw, ...item }) => ({
        ...item,
        raw: { role: raw.role, content: raw.content },
      })),
    };
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      coldStart: true,
      plugins: [{
        manifest: createPluginManifestV2Fixture({
          id: 'acme.media',
          contributes: { agents: [{
          id: 'media', title: 'Media fixture',
          capabilities: { surfaces: ['externalSessions'] },
          surfaces: {
            externalSession: {
              sources: [{
                sourceKind: 'opencodeServer',
                schema: {
                  fields: [
                    { name: 'kind', kind: 'literal', value: 'opencodeServer' },
                    { name: 'baseUrl', kind: 'string' },
                    { name: 'directory', kind: 'string' },
                  ],
                },
                key: {
                  segments: [
                    { kind: 'literal', value: 'opencodeServer' },
                    { kind: 'field', field: 'baseUrl' },
                    { kind: 'field', field: 'directory' },
                  ],
                },
                instances: [{ kind: 'default', constants: { baseUrl: 'http://127.0.0.1:4096', directory: providerDirectory } }],
              }],
              externalLinkedTakeover: { writerSafety: 'unsupported' },
            },
          },
          }] },
        }),
        files: { 'daemon.mjs': `
          const roots = ${JSON.stringify([providerDirectory])};
          const externalSessions = {
            resolveSource: async ({source}) => ({ok:true,value:{source,transcriptMediaReadRoots:roots}}),
            listCandidates: async () => ({ok:true,value:{candidates:[],nextCursor:null}}),
            resolveLinkIdentity: async ({source,remoteSessionId}) => ({ok:true,value:{source,remoteSessionId,linkData:{}}}),
            resolveLinkedIdentity: async ({source,remoteSessionId,linkData}) => ({ok:true,value:{source,remoteSessionId,linkData,transcriptMediaReadRoots:roots}}),
            pageTranscript: async ({remoteSessionId}) => ({ok:true,value:remoteSessionId === 'declared-row'
              ? ${JSON.stringify(declaredTranscript)} : ${JSON.stringify(transcript)}}),
            readAfterTranscript: async () => ({ok:true,value:{outcome:'already_current'}}),
          };
          export function activate(api) { api.agents.registerExternalSessions('media',externalSessions); }
        ` },
      }],
    });
    const agentId = runtime.registry.contributes.agents.find((agent) => agent.pluginId === 'acme.media')?.id;
    if (!agentId) throw new Error('Expected admitted media fixture Agent');
    expect(runtime.registry.contributes.agentDefinitionsById.get(agentId)?.catalogEntry ?? null).toBeNull();

    try {
      const { registerMachineExternalSessionsRpcHandlers } = await import('./rpcHandlers.externalSessions');
      registerMachineExternalSessionsRpcHandlers({
        rpcHandlerManager,
        transientMediaReadAllowance,
      });

      expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE)).toBe(true);
      expect(rpcHandlerManager.hasHandler(RPC_METHODS.READ_FILE)).toBe(true);

      const deniedBeforeGrant = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: providerMediaPath });
      expect(deniedBeforeGrant).toMatchObject({ success: false });

      const declaredPage = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, {
        machineId: 'machine-1',
        agentId,
        remoteSessionId: 'declared-row',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: providerDirectory },
        direction: 'older',
      });
      expect(declaredPage, JSON.stringify(declaredPage)).toMatchObject({ ok: true });
      expect(transientMediaReadAllowance.readAllowedReadFiles()).toEqual([]);

      const pageResponse = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, {
        machineId: 'machine-1',
        agentId,
        remoteSessionId: 'provider-session-1',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: providerDirectory },
        direction: 'older',
      });
      // Current Agent rows admit role/content only. A declared source root does
      // not authorize an arbitrary raw.meta carrier to grant filesystem access.
      expect(pageResponse, JSON.stringify(pageResponse)).toMatchObject({ ok: false, errorCode: 'agent_error' });
      expect(transientMediaReadAllowance.readAllowedReadFiles()).toEqual([]);

      const deniedReferencedAfterRefusal = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: providerMediaPath });
      expect(deniedReferencedAfterRefusal).toMatchObject({ success: false });
      const recipient = createTransferRecipientKeyPair();
      const transferInit = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_file_download_v1',
        path: providerMediaPath,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(transferInit).toMatchObject({ success: false });
      await expect(readFile(providerMediaPath)).resolves.toEqual(providerMediaBytes);

      // Historical metadata/root filtering remains covered by referencedPaths;
      // this current-ABI refusal must neither expose bytes nor adopt media.
      await expect(stat(join(workingDirectory, '.happier', 'uploads'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runtime.dispose();
      await fileSystemHandlers.dispose();
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });
});
