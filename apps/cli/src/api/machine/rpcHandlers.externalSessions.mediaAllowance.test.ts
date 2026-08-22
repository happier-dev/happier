import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import {
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';
import { createTransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';

const {
  activateAgentRuntimeContributionOnDemandMock,
  acquireAuthoritativePluginRuntimeRegistryLeaseMock,
} = vi.hoisted(() => ({
  activateAgentRuntimeContributionOnDemandMock: vi.fn(
    async (_registry: unknown, _agentId: unknown) => undefined,
  ),
  acquireAuthoritativePluginRuntimeRegistryLeaseMock: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/activationDemand', () => ({
  activateAgentRuntimeContributionOnDemand: (registry: unknown, agentId: unknown) =>
    activateAgentRuntimeContributionOnDemandMock(registry, agentId),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: () =>
    acquireAuthoritativePluginRuntimeRegistryLeaseMock(),
}));

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
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('grants only referenced direct-session media files to daemon file reads without durable adoption', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-media-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-media-provider-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-media-outside-'));
    const providerMediaPath = join(providerDirectory, 'provider-owned.png');
    const siblingMediaPath = join(providerDirectory, 'sibling-secret.png');
    const sensitiveAbsolutePath = join(outsideDirectory, 'sensitive-absolute.png');
    const sensitiveFileUriPath = join(outsideDirectory, 'sensitive-file-uri.png');
    const symlinkEscapePath = join(providerDirectory, 'linked-sensitive.png');
    const providerMediaBytes = Buffer.from('media');
    const siblingMediaBytes = Buffer.from('secret');
    await mkdir(providerDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(providerMediaPath, providerMediaBytes);
    await writeFile(siblingMediaPath, siblingMediaBytes);
    await writeFile(sensitiveAbsolutePath, Buffer.from('absolute-secret'));
    await writeFile(sensitiveFileUriPath, Buffer.from('file-uri-secret'));
    await symlink(sensitiveAbsolutePath, symlinkEscapePath);

    const transientMediaReadAllowance = createTransientSessionMediaReadAllowance();
    const rpcHandlerManager = createRpcHandlerManager();
    const fileSystemHandlers = registerFileSystemHandlers(rpcHandlerManager, workingDirectory, {
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      getAdditionalAllowedReadFiles: () => transientMediaReadAllowance.readAllowedReadFiles(),
    });

    const externalSessions = {
      resolveSource: vi.fn(async ({ source }) => ({
        ok: true as const,
        value: { source, transcriptMediaReadRoots: [providerDirectory] },
      })),
      listCandidates: vi.fn(async () => ({
        ok: true as const,
        value: { candidates: [], nextCursor: null },
      })),
      resolveLinkIdentity: vi.fn(async ({ source, remoteSessionId }) => ({
        ok: true as const,
        value: { source, remoteSessionId, linkData: {} },
      })),
      resolveLinkedIdentity: vi.fn(async ({ source, remoteSessionId, linkData }) => ({
        ok: true as const,
        value: {
          source,
          remoteSessionId,
          linkData,
          transcriptMediaReadRoots: [providerDirectory],
        },
      })),
      pageTranscript: vi.fn(async () => ({
        ok: true as const,
        value: {
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
                      createDirectSessionMediaItem(symlinkEscapePath),
                      createDirectSessionMediaItem(sensitiveAbsolutePath),
                      createDirectSessionMediaItem(pathToFileURL(sensitiveFileUriPath).href),
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
        },
      } as const)),
      readAfterTranscript: vi.fn(async () => ({
        ok: true as const,
        value: { outcome: 'already_current' as const },
      })),
    } satisfies AgentExternalSessionsContribution;
    const agent = {
      id: 'opencode',
      identity: { pluginId: 'happier.opencode', localId: 'opencode' },
      richDefinition: {
        definition: {
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
              }],
            },
          },
        },
      },
    };
    const retirement = new AbortController();
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: {
        contributes: {
          agents: [agent],
          agentDefinitionsById: new Map([['opencode', agent]]),
        },
        agentRuntimesByAgentId: new Map([['opencode', {
          generation: 'plugin-generation-1',
          retirementSignal: retirement.signal,
          isCurrent: () => true,
          externalSessions,
        }]]),
      },
      release: vi.fn(async () => undefined),
    });

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

      const pageResponse = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, {
        machineId: 'machine-1',
        agentId: 'opencode',
        remoteSessionId: 'provider-session-1',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: providerDirectory },
        direction: 'older',
      });
      expect(pageResponse).toMatchObject({ ok: true });
      expect((pageResponse as { transientMediaReadFiles?: readonly string[] }).transientMediaReadFiles).toEqual([
        providerMediaPath,
      ]);

      const allowedAfterGrant = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: providerMediaPath });
      expect(allowedAfterGrant).toEqual({
        success: true,
        content: providerMediaBytes.toString('base64'),
      });
      const recipient = createTransferRecipientKeyPair();
      const transferInit = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_file_download_v1',
        path: providerMediaPath,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(transferInit).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadId = (transferInit as { downloadId: string }).downloadId;
      const transferChunk = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, {
        downloadId,
        index: 0,
      });
      expect(transferChunk).toMatchObject({ success: true, isLast: true });
      expect(decryptEncryptedTransferChunkEnvelope({
        transferId: downloadId,
        sequence: 0,
        payloadBase64: (transferChunk as { payloadBase64: string }).payloadBase64,
        encryptedDataKeyEnvelopeBase64: (transferChunk as { encryptedDataKeyEnvelopeBase64: string }).encryptedDataKeyEnvelopeBase64,
        recipientSecretKeySeed: recipient.recipientSecretKeySeed,
      })).toEqual(providerMediaBytes);
      await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId });
      const deniedSiblingTransfer = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_file_download_v1',
        path: siblingMediaPath,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(deniedSiblingTransfer).toMatchObject({ success: false });
      const deniedSiblingAfterGrant = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: siblingMediaPath });
      expect(deniedSiblingAfterGrant).toMatchObject({ success: false });
      const deniedSymlinkEscapeAfterGrant = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: symlinkEscapePath });
      expect(deniedSymlinkEscapeAfterGrant).toMatchObject({ success: false });
      const deniedSensitiveAbsoluteAfterGrant = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: sensitiveAbsolutePath });
      expect(deniedSensitiveAbsoluteAfterGrant).toMatchObject({ success: false });
      const deniedSensitiveFileUriAfterGrant = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: sensitiveFileUriPath });
      expect(deniedSensitiveFileUriAfterGrant).toMatchObject({ success: false });
      await expect(readFile(providerMediaPath)).resolves.toEqual(providerMediaBytes);
      await expect(readFile(siblingMediaPath)).resolves.toEqual(siblingMediaBytes);

      await rm(providerMediaPath, { force: true });
      await symlink(sensitiveAbsolutePath, providerMediaPath);
      const deniedReplacedGrantAfterGrant = await rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path: providerMediaPath });
      expect(deniedReplacedGrantAfterGrant).toMatchObject({ success: false });

      await expect(stat(join(workingDirectory, '.happier', 'uploads'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fileSystemHandlers.dispose();
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});
