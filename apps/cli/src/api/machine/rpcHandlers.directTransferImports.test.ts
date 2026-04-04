import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<unknown>;

function createRpcHandlerManager(): {
  handlers: Map<string, Handler>;
  registerHandler: (method: string, handler: Handler) => void;
} {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('rpcHandlers (direct transfer imports)', () => {
  it('registers daemon.directTransfer.import.prepare and forwards the request to the direct transfer service', async () => {
    const mgr = createRpcHandlerManager();
    const prepareImportSession = vi.fn(async () => ({
      uploadId: 'upload-1',
      destDisplayPath: 'payload.bin',
      expectedSizeBytes: 4,
      chunkSizeBytes: 8,
      recipientPublicKeyBase64: 'recipient-key',
      expiresAt: 5_000,
      endpointCandidates: [
        {
          kind: 'http' as const,
          url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1',
          expiresAt: 5_000,
        },
      ],
    }));

    registerMachineRpcHandlers({
      rpcHandlerManager: mgr as never,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as never,
        stopSession: async () => true,
        requestShutdown: () => {},
        directTransferImport: {
          prepareImportSession,
        },
      },
    });

    const handler = mgr.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE);
    expect(handler).toEqual(expect.any(Function));

    const request = {
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    };
    await expect(handler?.(request)).resolves.toEqual({
      success: true,
      uploadId: 'upload-1',
      destDisplayPath: 'payload.bin',
      expectedSizeBytes: 4,
      chunkSizeBytes: 8,
      recipientPublicKeyBase64: 'recipient-key',
      expiresAt: 5_000,
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1',
          expiresAt: 5_000,
        },
      ],
    });
    expect(prepareImportSession).toHaveBeenCalledWith(request);
  });
});
