import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const { runScmRouteMock } = vi.hoisted(() => ({
  runScmRouteMock: vi.fn(),
}));

vi.mock('@/scm/rpc/dispatch', () => ({
  createNonRepositoryScmSnapshotResponse: vi.fn(),
  notRepositoryResponse: vi.fn(),
  runScmRoute: (...args: unknown[]) => runScmRouteMock(...args),
}));

vi.mock('./scm/registerScmPullRequestHandlers', () => ({
  registerScmPullRequestHandlers: vi.fn(),
}));

vi.mock('./scm/registerScmRepositoryProvisioningHandlers', () => ({
  registerScmRepositoryProvisioningHandlers: vi.fn(),
}));

describe('registerScmHandlers status snapshot coalescing', () => {
  afterEach(() => {
    delete process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS;
    vi.resetModules();
    runScmRouteMock.mockReset();
    vi.restoreAllMocks();
  });

  it('passes the central RPC lifetime signal into SCM route dispatch', async () => {
    process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS = '0';
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };
    const { registerScmHandlers } = await import('./scm');
    registerScmHandlers(registrar, '/workspace');
    const handler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    if (!handler) throw new Error('SCM status handler was not registered');
    const controller = new AbortController();
    runScmRouteMock.mockResolvedValue({ success: true });

    await handler({ cwd: '.' }, { signal: controller.signal });

    expect(runScmRouteMock).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it('shares one in-flight status snapshot for identical requests and refreshes after completion when cache is disabled', async () => {
    process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS = '0';
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };
    const { registerScmHandlers } = await import('./scm');
    registerScmHandlers(registrar, '/workspace');
    const handler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    expect(handler).toBeTypeOf('function');
    if (!handler) throw new Error('SCM status handler was not registered');

    const firstResponse = { success: true, snapshot: { id: 'first' } };
    const pendingResolvers: Array<(response: unknown) => void> = [];
    runScmRouteMock.mockImplementation(
      () => new Promise((resolve) => {
        pendingResolvers.push(resolve);
      }),
    );

    const first = handler({ cwd: '.', includeWorktreeStatus: true });
    const second = handler({ cwd: '.', includeWorktreeStatus: true });
    try {
      expect(runScmRouteMock).toHaveBeenCalledTimes(1);
    } finally {
      for (const resolve of pendingResolvers) {
        resolve(firstResponse);
      }
    }
    await expect(Promise.all([first, second])).resolves.toEqual([firstResponse, firstResponse]);

    const secondResponse = { success: true, snapshot: { id: 'second' } };
    runScmRouteMock.mockReset();
    runScmRouteMock.mockResolvedValueOnce(secondResponse);
    await expect(handler({ cwd: '.', includeWorktreeStatus: true })).resolves.toBe(secondResponse);
    expect(runScmRouteMock).toHaveBeenCalledTimes(1);
  });

  it('returns cached status snapshots inside the configured cache window', async () => {
    process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS = '1000';
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };
    const { registerScmHandlers } = await import('./scm');
    registerScmHandlers(registrar, '/workspace');
    const handler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    expect(handler).toBeTypeOf('function');
    if (!handler) throw new Error('SCM status handler was not registered');

    const firstResponse = { success: true, snapshot: { id: 'first' } };
    const secondResponse = { success: true, snapshot: { id: 'second' } };
    runScmRouteMock
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);

    await expect(handler({ cwd: '.', includeWorktreeStatus: true })).resolves.toBe(firstResponse);
    await expect(handler({ cwd: '.', includeWorktreeStatus: true })).resolves.toBe(firstResponse);
    expect(runScmRouteMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse stale in-flight status snapshots after mutating RPCs', async () => {
    process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS = '1000';
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };
    const { registerScmHandlers } = await import('./scm');
    registerScmHandlers(registrar, '/workspace');
    const statusHandler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    const discardHandler = handlers.get(RPC_METHODS.SCM_CHANGE_DISCARD);
    expect(statusHandler).toBeTypeOf('function');
    expect(discardHandler).toBeTypeOf('function');
    if (!statusHandler || !discardHandler) {
      throw new Error('Expected SCM status and discard handlers to be registered');
    }

    const staleResponse = { success: true, snapshot: { id: 'stale' } };
    const freshResponse = { success: true, snapshot: { id: 'fresh' } };
    const firstStatusResolvers: Array<(response: unknown) => void> = [];
    let statusCallCount = 0;
    runScmRouteMock.mockImplementation(({ request }: { request?: Record<string, unknown> }) => {
      if (request?.includeWorktreeStatus === true) {
        statusCallCount += 1;
        if (statusCallCount === 1) {
          return new Promise((resolve) => {
            firstStatusResolvers.push(resolve);
          });
        }
        return Promise.resolve(freshResponse);
      }
      return Promise.resolve({ success: true });
    });

    const pendingStatus = statusHandler({ cwd: '.', includeWorktreeStatus: true });
    expect(statusCallCount).toBe(1);
    await expect(discardHandler({ cwd: '.', paths: ['file.txt'] })).resolves.toEqual({ success: true });
    const resolveFirstStatus = firstStatusResolvers.at(0);
    if (!resolveFirstStatus) {
      throw new Error('Expected first status snapshot to be pending');
    }
    resolveFirstStatus(staleResponse);
    await expect(pendingStatus).resolves.toBe(staleResponse);

    await expect(statusHandler({ cwd: '.', includeWorktreeStatus: true })).resolves.toBe(freshResponse);
    expect(statusCallCount).toBe(2);
  });
});
