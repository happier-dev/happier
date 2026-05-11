import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { ExternalSessionProviderOps } from '@/session/external/providerOps';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';

const { resolveBackendExecutionSurfacesMock } = vi.hoisted(() => ({
  resolveBackendExecutionSurfacesMock: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces: resolveBackendExecutionSurfacesMock,
}));

function createRpcHandlerManager(): {
  handlers: Map<string, (params: unknown) => Promise<unknown>>;
  registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => void;
} {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
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

  it('grants direct-session media directories to daemon file reads without durable adoption', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-media-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-media-provider-'));
    const providerMediaPath = join(providerDirectory, 'provider-owned.png');
    const providerMediaBytes = Buffer.from('media');
    await mkdir(providerDirectory, { recursive: true });
    await writeFile(providerMediaPath, providerMediaBytes);

    const allowedReadDirs = { current: [] as string[] };
    const rpcHandlerManager = createRpcHandlerManager();
    registerFileSystemHandlers(rpcHandlerManager, workingDirectory, {
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      getAdditionalAllowedReadDirs: () => allowedReadDirs.current,
    });

    const externalSessions = {
      validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      listCandidates: vi.fn(async () => ({ candidates: [], nextCursor: null })),
      getActivity: vi.fn(async () => ({ lastActivityAtMs: null, isRunning: false })),
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
                payload: { media: [createDirectSessionMediaItem(providerMediaPath)] },
              },
            },
          },
        }],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: false,
      })),
      readAfterTranscript: vi.fn(async () => ({ items: [], nextCursor: null, truncated: false })),
      resolveTakeoverSpawnOptions: vi.fn(async () => null),
    } satisfies ExternalSessionProviderOps;

    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      externalSessions,
      attach: null,
      sessionHandoff: null,
    } satisfies BackendExecutionSurfaces);

    try {
      const { registerMachineExternalSessionsRpcHandlers } = await import('./rpcHandlers.externalSessions');
      registerMachineExternalSessionsRpcHandlers({
        rpcHandlerManager,
        transientMediaReadAllowance: {
          grantReadDirs: (dirs: readonly string[]) => {
            allowedReadDirs.current = [...dirs];
          },
        },
      } as never);

      const page = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE);
      const read = rpcHandlerManager.handlers.get(RPC_METHODS.READ_FILE);
      if (!page || !read) throw new Error('expected transcript and file read handlers');

      const deniedBeforeGrant = await read({ path: providerMediaPath });
      expect(deniedBeforeGrant).toMatchObject({ success: false });

      const pageResponse = await page({
        machineId: 'machine-1',
        providerId: 'opencode',
        remoteSessionId: 'provider-session-1',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: workingDirectory },
        direction: 'older',
      });
      expect(pageResponse).toMatchObject({ ok: true });
      expect(allowedReadDirs.current).toEqual([dirname(providerMediaPath)]);

      const allowedAfterGrant = await read({ path: providerMediaPath });
      expect(allowedAfterGrant).toEqual({
        success: true,
        content: providerMediaBytes.toString('base64'),
      });
      await expect(readFile(providerMediaPath)).resolves.toEqual(providerMediaBytes);
      await expect(stat(join(workingDirectory, '.happier', 'uploads'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });
});
