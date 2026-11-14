import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES, createGitScmCapabilities, type ScmWorkingEntry, type ScmWorkingSnapshot } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';

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

  const readStatusHandler = async (): Promise<RpcHandler> => {
    const handler = (await registerHandlers()).get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    if (!handler) throw new Error('SCM status handler was not registered');
    return handler;
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

  const serializedSize = (entry: ScmWorkingEntry): number =>
    estimateJsonUtf8BytesBounded(entry, SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES);

  it('ships every entry of a snapshot within the budget and reports the changed-file count', async () => {
    const handler = await readStatusHandler();
    runScmRouteMock.mockResolvedValue(buildSnapshotResponse([buildEntry('a.txt'), buildEntry('b.txt')]));

    const snapshot = ((await handler({ cwd: '.' })) as { snapshot?: ScmWorkingSnapshot }).snapshot;

    expect(snapshot?.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    expect(snapshot?.entriesPresentation).toBeUndefined();
    expect(snapshot?.totals.changedFiles).toBe(2);
  });

  it('truncates entries by serialized bytes and never ships a partial entry', async () => {
    const handler = await readStatusHandler();
    // ~60KB per entry, 80 entries: deterministically over the budget.
    const longPath = 'x'.repeat(60_000);
    const mockEntries = Array.from({ length: 80 }, (_, index) => buildEntry(`${longPath}-${index}.txt`));
    runScmRouteMock.mockResolvedValue(buildSnapshotResponse(mockEntries));

    const snapshot = ((await handler({ cwd: '.' })) as { snapshot?: ScmWorkingSnapshot }).snapshot;
    expect(snapshot?.entriesPresentation).toBe('truncated');
    const shipped = snapshot?.entries ?? [];
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.length).toBeLessThan(mockEntries.length);

    let cumulative = 0;
    for (let index = 0; index < shipped.length; index += 1) {
      cumulative += (index > 0 ? 1 : 0) + serializedSize(shipped[index]!);
    }
    expect(cumulative).toBeLessThanOrEqual(SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES);
    const firstDropped = mockEntries[shipped.length]!;
    expect(cumulative + 1 + serializedSize(firstDropped)).toBeGreaterThan(SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES);

    // Totals stay the backend's full-set truth; the changed-file count survives truncation.
    expect(snapshot?.totals).toMatchObject({
      untrackedFiles: mockEntries.length,
      pendingFiles: mockEntries.length,
      changedFiles: mockEntries.length,
    });
    expect(shipped.map((entry) => entry.path)).toEqual(mockEntries.slice(0, shipped.length).map((entry) => entry.path));
  });

  it('terminates as an empty prefix when the first entry alone exceeds the budget', async () => {
    const handler = await readStatusHandler();
    const hugeEntry = buildEntry(`${'y'.repeat(SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES + 1)}.txt`);
    runScmRouteMock.mockResolvedValue(buildSnapshotResponse([hugeEntry, buildEntry('b.txt')]));

    const snapshot = ((await handler({ cwd: '.' })) as { snapshot?: ScmWorkingSnapshot }).snapshot;
    expect(snapshot?.entriesPresentation).toBe('truncated');
    expect(snapshot?.entries).toEqual([]);
    expect(snapshot?.totals).toMatchObject({ untrackedFiles: 2, pendingFiles: 2, changedFiles: 2 });
  });
});
