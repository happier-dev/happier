import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { createGitScmCapabilities, type ScmWorkingEntry, type ScmWorkingSnapshot } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_DEFAULT_RESPONSE_MAX_BYTES } from '@happier-dev/protocol/socketRpc';

const { runScmProvisioningRouteMock, runScmRouteMock } = vi.hoisted(() => ({
  runScmProvisioningRouteMock: vi.fn(),
  runScmRouteMock: vi.fn(),
}));

vi.mock('@/scm/rpc/dispatch', () => ({
  createNonRepositoryScmSnapshotResponse: vi.fn(),
  notRepositoryResponse: vi.fn(),
  runScmProvisioningRoute: (...args: unknown[]) => runScmProvisioningRouteMock(...args),
  runScmRoute: (...args: unknown[]) => runScmRouteMock(...args),
}));

describe('registerScmHandlers status snapshot coalescing', () => {
  afterEach(() => {
    vi.resetModules();
    runScmProvisioningRouteMock.mockReset();
    runScmRouteMock.mockReset();
  });

  const registerHandlers = async (): Promise<Map<string, RpcHandler>> => {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };
    const { registerScmHandlers } = await import('./scm');
    registerScmHandlers(registrar, '/workspace');
    return handlers;
  };

  const expectStaleInFlightStatusToBeSuppressedAfterMutation = async (
    mutationMethod: string,
    mutationRequest: Record<string, unknown>,
    expectedRunCounts: Readonly<{
      route: number;
      provisioning: number;
    }>,
  ): Promise<void> => {
    const handlers = await registerHandlers();
    const statusHandler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    const mutationHandler = handlers.get(mutationMethod);
    expect(statusHandler).toBeTypeOf('function');
    expect(mutationHandler).toBeTypeOf('function');
    if (!statusHandler || !mutationHandler) throw new Error('SCM handlers were not registered');

    const staleResponse = { success: true, snapshot: { id: 'stale' } };
    const freshResponse = { success: true, snapshot: { id: 'fresh' } };
    const staleStatusResolvers: Array<(response: unknown) => void> = [];

    runScmRouteMock.mockImplementation(({ request }: { request?: Record<string, unknown> }) => {
      if (request?.includeWorktreeStatus === true) {
        return new Promise((resolve) => {
          staleStatusResolvers.push(resolve);
        });
      }
      return Promise.resolve({ success: true });
    });
    runScmProvisioningRouteMock.mockResolvedValue({ success: true });

    const staleStatus = statusHandler({ cwd: '.', includeWorktreeStatus: true });
    await mutationHandler(mutationRequest);
    expect(runScmRouteMock).toHaveBeenCalledTimes(expectedRunCounts.route);
    expect(runScmProvisioningRouteMock).toHaveBeenCalledTimes(expectedRunCounts.provisioning);

    const resolveStaleStatus = staleStatusResolvers.at(0);
    if (!resolveStaleStatus) {
      throw new Error('Expected first status snapshot to be pending');
    }
    resolveStaleStatus(staleResponse);
    await expect(staleStatus).resolves.toBe(staleResponse);

    runScmRouteMock.mockReset();
    runScmProvisioningRouteMock.mockReset();
    runScmRouteMock.mockResolvedValueOnce(freshResponse);
    await expect(statusHandler({ cwd: '.', includeWorktreeStatus: true })).resolves.toBe(freshResponse);
    expect(runScmRouteMock).toHaveBeenCalledTimes(1);
    expect(runScmProvisioningRouteMock).not.toHaveBeenCalled();
  };

  it('shares one in-flight status snapshot for identical requests and reuses the fresh cached result', async () => {
    const handlers = await registerHandlers();
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
    await expect(handler({ cwd: '.', includeWorktreeStatus: true })).resolves.toBe(firstResponse);
    expect(runScmRouteMock).not.toHaveBeenCalled();
  });

  it('does not reuse stale in-flight status snapshots after mutating RPCs', async () => {
    const handlers = await registerHandlers();
    const statusHandler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    const discardHandler = handlers.get(RPC_METHODS.SCM_CHANGE_DISCARD);
    expect(statusHandler).toBeTypeOf('function');
    expect(discardHandler).toBeTypeOf('function');
    if (!statusHandler || !discardHandler) throw new Error('SCM handlers were not registered');

    const staleResponse = { success: true, snapshot: { id: 'stale' } };
    const freshResponse = { success: true, snapshot: { id: 'fresh' } };
    const staleStatusResolvers: Array<(response: unknown) => void> = [];

    runScmRouteMock.mockImplementation(({ request }: { request?: Record<string, unknown> }) => {
      if (request?.includeWorktreeStatus === true) {
        return new Promise((resolve) => {
          staleStatusResolvers.push(resolve);
        });
      }
      return Promise.resolve({ success: true });
    });

    const staleStatus = statusHandler({ cwd: '.', includeWorktreeStatus: true });
    await discardHandler({ cwd: '.', changes: [{ path: 'file.txt' }] });
    expect(runScmRouteMock).toHaveBeenCalledTimes(2);

    const resolveStaleStatus = staleStatusResolvers.at(0);
    if (!resolveStaleStatus) {
      throw new Error('Expected first status snapshot to be pending');
    }
    resolveStaleStatus(staleResponse);
    await expect(staleStatus).resolves.toBe(staleResponse);

    runScmRouteMock.mockReset();
    runScmRouteMock.mockResolvedValueOnce(freshResponse);
    await expect(statusHandler({ cwd: '.', includeWorktreeStatus: true })).resolves.toBe(freshResponse);
    expect(runScmRouteMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse stale in-flight status snapshots after split pull-request mutations', async () => {
    await expectStaleInFlightStatusToBeSuppressedAfterMutation(
      RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
      { cwd: '.', title: 'Fix cache invalidation' },
      { route: 2, provisioning: 0 },
    );
  });

  it('does not reuse stale in-flight status snapshots after split repository provisioning mutations', async () => {
    await expectStaleInFlightStatusToBeSuppressedAfterMutation(
      RPC_METHODS.SCM_REPOSITORY_INIT,
      { cwd: '.' },
      { route: 1, provisioning: 1 },
    );
  });
});

describe('registerScmHandlers status snapshot entry budget', () => {
  afterEach(() => {
    vi.resetModules();
    runScmProvisioningRouteMock.mockReset();
    runScmRouteMock.mockReset();
  });

  const registerHandlers = async (): Promise<Map<string, RpcHandler>> => {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };
    const { registerScmHandlers } = await import('./scm');
    registerScmHandlers(registrar, '/workspace');
    return handlers;
  };

  const encryptionKey = new Uint8Array(32).fill(7);

  /** Registers the SCM handlers on a real encrypted RPC manager, so replies cross the real reply guard. */
  const createEncryptedRpc = async (): Promise<RpcHandlerManager> => {
    const { registerScmHandlers } = await import('./scm');
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionKey,
      encryptionVariant: 'dataKey',
      logger: () => {},
    });
    registerScmHandlers(rpc, '/workspace');
    return rpc;
  };

  const requestStatus = async (rpc: RpcHandlerManager): Promise<unknown> => {
    const response = await rpc.handleRequest({
      method: `machine-1:${RPC_METHODS.SCM_STATUS_SNAPSHOT}`,
      params: encodeBase64(encrypt(encryptionKey, 'dataKey', { cwd: '.' })),
    });
    expect(typeof response).toBe('string');
    expect((response as string).length).toBeLessThanOrEqual(SOCKET_RPC_DEFAULT_RESPONSE_MAX_BYTES);
    return decrypt(encryptionKey, 'dataKey', decodeBase64(response as string));
  };

  const buildEntry = (path: string): ScmWorkingEntry => ({
    path,
    previousPath: null,
    kind: 'untracked',
    includeStatus: '?',
    pendingStatus: '?',
    hasIncludedDelta: false,
    hasPendingDelta: true,
    stats: {
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 0,
      pendingRemoved: 0,
      isBinary: false,
    },
  });

  const buildSnapshotResponse = (entries: ScmWorkingEntry[]) => ({
    success: true,
    snapshot: {
      projectKey: 'test:/repo',
      fetchedAt: 1,
      repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
      capabilities: createGitScmCapabilities(),
      branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: true },
      hasConflicts: false,
      entries,
      totals: {
        includedFiles: 0,
        pendingFiles: entries.length,
        untrackedFiles: entries.length,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 0,
        pendingRemoved: 0,
      },
    } satisfies ScmWorkingSnapshot,
  });

  /**
   * A backend reply whose JSON is exactly `targetBytes`: 1 MB-path entries, with the last path
   * padded to land on the target.
   */
  const buildSnapshotResponseOfJsonBytes = (targetBytes: number) => {
    const entryCount = Math.ceil(targetBytes / 1_000_000);
    const entries = Array.from({ length: entryCount }, (_, index) => buildEntry(`${index}-${'p'.repeat(900_000)}`));
    const baseBytes = Buffer.byteLength(JSON.stringify(buildSnapshotResponse(entries)), 'utf8');
    const last = entries[entries.length - 1]!;
    entries[entries.length - 1] = buildEntry(`${last.path}${'q'.repeat(targetBytes - baseBytes)}`);
    const response = buildSnapshotResponse(entries);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBe(targetBytes);
    return response;
  };

  /** Raw bytes the reply limit can carry once base64-encoded, before any envelope or cipher overhead. */
  const replyBase64Capacity = Math.floor(SOCKET_RPC_DEFAULT_RESPONSE_MAX_BYTES / 4) * 3;

  it('ships every entry of a snapshot within the budget and reports the changed-file count', async () => {
    const handler = (await registerHandlers()).get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    if (!handler) throw new Error('SCM status handler was not registered');
    runScmRouteMock.mockResolvedValue(buildSnapshotResponse([buildEntry('a.txt'), buildEntry('b.txt')]));

    const snapshot = ((await handler({ cwd: '.' })) as { snapshot?: ScmWorkingSnapshot }).snapshot;

    expect(snapshot?.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    expect(snapshot?.entriesPresentation).toBeUndefined();
    expect(snapshot?.totals.changedFiles).toBe(2);
  });

  it('keeps the full entry list when the encrypted reply fits just under the transport limit', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const backendResponse = buildSnapshotResponseOfJsonBytes(replyBase64Capacity - 1_000);
      runScmRouteMock.mockResolvedValue(backendResponse);

      const reply = (await requestStatus(await createEncryptedRpc())) as { snapshot?: ScmWorkingSnapshot; errorCode?: string };

      expect(reply.errorCode).toBeUndefined();
      expect(reply.snapshot?.entriesPresentation).toBeUndefined();
      expect(reply.snapshot?.entries.length).toBe(backendResponse.snapshot.entries.length);
      expect(reply.snapshot?.totals.changedFiles).toBe(backendResponse.snapshot.entries.length);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('truncates the entry list, with full-set totals, when the whole reply would exceed the transport limit', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const backendResponse = buildSnapshotResponseOfJsonBytes(replyBase64Capacity + 1_000);
      const backendEntries = backendResponse.snapshot.entries;
      runScmRouteMock.mockResolvedValue(backendResponse);

      const reply = (await requestStatus(await createEncryptedRpc())) as { snapshot?: ScmWorkingSnapshot; errorCode?: string };

      expect(reply.errorCode).toBeUndefined();
      expect(reply.snapshot?.entriesPresentation).toBe('truncated');
      const shipped = reply.snapshot?.entries ?? [];
      expect(shipped.length).toBeGreaterThan(0);
      expect(shipped.length).toBeLessThan(backendEntries.length);
      // A whole-entry prefix of the backend's list, never a partial entry.
      expect(shipped.map((entry) => entry.path)).toEqual(backendEntries.slice(0, shipped.length).map((entry) => entry.path));
      expect(reply.snapshot?.totals).toMatchObject({
        untrackedFiles: backendEntries.length,
        pendingFiles: backendEntries.length,
        changedFiles: backendEntries.length,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
