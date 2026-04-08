import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('registerSessionHandlers attachments uploads', () => {
  let workingDirectory: string;

  beforeEach(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attachments-'));
  });

  afterEach(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('does not register bulk transfer attachment uploads in session scope', async () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, workingDirectory);

    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT)).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.init'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.chunk'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.finalize'].join(''))).toBe(false);
  });
});
