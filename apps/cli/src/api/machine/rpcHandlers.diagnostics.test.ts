import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineDiagnosticsRpcHandlers } from './rpcHandlers.diagnostics';

type Handler = (data: unknown) => Promise<unknown> | unknown;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('registerMachineDiagnosticsRpcHandlers', () => {
  it('dispatches bug-report diagnostics RPCs through ActionSpec when an executor is provided', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      result: { ok: true, diagnostic: 'redacted' },
    }));
    const mgr = createRpcHandlerManager();

    registerMachineDiagnosticsRpcHandlers({
      rpcHandlerManager: mgr as any,
      actionExecutor: { execute },
    } as any);

    const collect = mgr.handlers.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS);
    if (!collect) {
      throw new Error('expected bug-report diagnostics handler');
    }

    await expect(collect({})).resolves.toEqual({ ok: true, diagnostic: 'redacted' });

    expect(execute).toHaveBeenCalledWith(
      'bugreport.collectDiagnostics',
      {},
      expect.objectContaining({ surface: 'rpc' }),
    );
  });
});
