import { describe, expect, it } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('registerSessionHandlers (file system)', () => {
  it('keeps direct filesystem browsing/mutation machine-scoped but exposes the canonical bulk-transfer RPCs', () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, process.cwd());

    expect(handlers.has(RPC_METHODS.READ_FILE)).toBe(false);
    expect(handlers.has(RPC_METHODS.WRITE_FILE)).toBe(false);
    expect(handlers.has(RPC_METHODS.CREATE_DIRECTORY)).toBe(false);
    expect(handlers.has(RPC_METHODS.LIST_DIRECTORY)).toBe(false);
    expect(handlers.has(RPC_METHODS.GET_DIRECTORY_TREE)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT)).toBe(true);
    expect(handlers.has(['daemon.sessionFiles.', 'upload.init'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionFiles.', 'upload.chunk'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionFiles.', 'upload.finalize'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionFiles.', 'download.init'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionFiles.', 'download.chunk'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionFiles.', 'download.finalize'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.init'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.chunk'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.finalize'].join(''))).toBe(false);
  });
});
