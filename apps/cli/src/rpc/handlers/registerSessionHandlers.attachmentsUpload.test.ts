import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('registerSessionHandlers attachments upload', () => {
  let workingDirectory: string;

  beforeEach(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attachments-'));
  });

  afterEach(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('registers attachments upload RPCs and allows reading from os_temp uploads', async () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, workingDirectory);

    const configure = handlers.get('attachments.configure');
    const init = handlers.get('attachments.upload.init');
    const chunk = handlers.get('attachments.upload.chunk');
    const finalize = handlers.get('attachments.upload.finalize');
    if (!configure || !init || !chunk || !finalize) {
      throw new Error('expected attachments upload RPC handlers to be registered');
    }

    const configureResult = await configure({ uploadLocation: 'os_temp' });
    expect(configureResult).toEqual({ success: true });

    const initResult = await init({ name: 'note.txt', sizeBytes: 3, messageLocalId: 'm1' });
    expect(initResult).toMatchObject({ success: true });
    const { uploadId } = initResult as { uploadId: string };

    const chunkResult = await chunk({ uploadId, index: 0, contentBase64: Buffer.from('hey').toString('base64') });
    expect(chunkResult).toEqual({ success: true });

    const finalizeResult = await finalize({ uploadId });
    expect(finalizeResult).toMatchObject({ success: true, sizeBytes: 3 });
    const { path } = finalizeResult as { path: string };
    expect(path).toMatch(/^\/.+/);

    const read = handlers.get(RPC_METHODS.READ_FILE);
    if (!read) throw new Error('expected readFile handler to be registered');
    const readResult = await read({ path });
    expect(readResult).toMatchObject({ success: true });
    const content = (readResult as { content?: string }).content;
    expect(Buffer.from(String(content ?? ''), 'base64').toString('utf8')).toBe('hey');
  });
});

