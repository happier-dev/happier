import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('registerSessionHandlers attachments policy', () => {
  let workingDirectory: string;

  beforeEach(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attachments-'));
  });

  afterEach(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('registers attachment policy configuration for os_temp uploads', async () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, workingDirectory);

    const configure = handlers.get(RPC_METHODS.ATTACHMENTS_CONFIGURE);
    if (!configure) {
      throw new Error('expected attachment policy handler to be registered');
    }

    const configureResult: any = await configure({ uploadLocation: 'os_temp' });
    expect(configureResult).toMatchObject({
      success: true,
      uploadLocation: 'os_temp',
    });
    expect(typeof configureResult.uploadBasePath).toBe('string');
    expect(configureResult.uploadBasePath.startsWith('/')).toBe(true);
    expect(handlers.has(RPC_METHODS.READ_FILE)).toBe(false);
  });
});
