import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { ExternalSessionProviderOps } from '@/session/external/providerOps';
import { createTransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';

const { resolveBackendExecutionSurfacesMock } = vi.hoisted(() => ({
  resolveBackendExecutionSurfacesMock: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces: resolveBackendExecutionSurfacesMock,
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

function createDirectSessionMediaItem(providerMediaPath: string): Record<string, unknown> {
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
  };
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
    registerFileSystemHandlers(rpcHandlerManager, workingDirectory, {
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      getAdditionalAllowedReadFiles: () => transientMediaReadAllowance.readAllowedReadFiles(),
    });

    const externalSessions = {
      validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      listCandidates: vi.fn(async () => ({ candidates: [], nextCursor: null })),
      resolveTranscriptMediaReadRoots: vi.fn(async () => [providerDirectory]),
      pageTranscript: vi.fn(async () => ({
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
      })),
      readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
    } satisfies ExternalSessionProviderOps;

    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      externalSession: externalSessions,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    } satisfies BackendExecutionSurfaces);

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
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});
