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

describe('registerScmHandlers status snapshot entry budget and delivery facts', () => {
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

  it('keeps distinct snapshot cache entries for the new request fields', async () => {
    const handlers = await registerHandlers();
    const handler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    expect(handler).toBeTypeOf('function');
    if (!handler) throw new Error('SCM status handler was not registered');

    const responsesByShape = new Map<string, unknown>([
      ['all-entries', buildSnapshotResponse([buildEntry('a.txt')])],
      ['normal-entries', buildSnapshotResponse([buildEntry('D/'), buildEntry('b.txt')])],
      ['all-summary', { ...buildSnapshotResponse([buildEntry('a.txt')]), summaryOnly: true }],
    ]);
    runScmRouteMock.mockImplementation(({ request }: { request?: Record<string, unknown> }) => {
      const key = [
        request?.untrackedFiles ?? 'all',
        request?.includeEntries === undefined ? 'entries' : (request.includeEntries ? 'entries' : 'summary'),
      ].join('-');
      return Promise.resolve(responsesByShape.get(key));
    });
    // Same cwd, four different new-field shapes → four distinct runs.
    const allEntries = await handler({ cwd: '.' });
    const normalEntries = await handler({ cwd: '.', untrackedFiles: 'normal' });
    const summary = await handler({ cwd: '.', includeEntries: false });
    const explicitAll = await handler({ cwd: '.', untrackedFiles: 'all' });
    expect(runScmRouteMock).toHaveBeenCalledTimes(4);
    expect(allEntries).not.toBe(normalEntries);
    expect(allEntries).not.toBe(summary);
    // 'all' explicit and default share the same cache entry.
    const again = await handler({ cwd: '.', untrackedFiles: 'all' });
    expect(again).toBe(explicitAll);
    expect(runScmRouteMock).toHaveBeenCalledTimes(4);
    // Cached replies keep their own shape (no wrong-shape cache hits).
    expect(normalEntries).toMatchObject({ snapshot: { entries: [{ path: 'D/' }, { path: 'b.txt' }] } });
    expect(summary).toMatchObject({ summaryOnly: true });
  });

  it('truncates entries by serialized bytes and never ships a partial entry', async () => {
    const handlers = await registerHandlers();
    const handler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    if (!handler) throw new Error('SCM status handler was not registered');

    // ~60KB per entry → ~80 entries ≈ 4.8MB, deterministically over the budget.
    const longPath = 'x'.repeat(60_000);
    const mockEntries = Array.from({ length: 80 }, (_, index) => buildEntry(`${longPath}-${index}.txt`));
    runScmRouteMock.mockResolvedValue(buildSnapshotResponse(mockEntries));

    const response = await handler({ cwd: '.' });
    const snapshot = (response as { snapshot?: ScmWorkingSnapshot }).snapshot;
    expect(snapshot?.entriesPresentation).toBe('truncated');
    const shipped = snapshot?.entries ?? [];
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.length).toBeLessThan(mockEntries.length);

    // Every shipped entry is whole: the cumulative serialized size (with
    // array separators) stays within the budget.
    let cumulative = 0;
    for (let index = 0; index < shipped.length; index += 1) {
      cumulative += (index > 0 ? 1 : 0) + serializedSize(shipped[index]!);
    }
    expect(cumulative).toBeLessThanOrEqual(SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES);

    // The first dropped entry would have exceeded the budget.
    const firstDropped = mockEntries[shipped.length]!;
    expect(cumulative + 1 + serializedSize(firstDropped)).toBeGreaterThan(SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES);

    // Totals are backend truth from the full set — never recomputed down.
    expect(snapshot?.totals).toMatchObject({ untrackedFiles: mockEntries.length, pendingFiles: mockEntries.length });
    // Shipped entries are the untouched prefix of the backend's entries.
    expect(shipped.map((entry) => entry.path)).toEqual(mockEntries.slice(0, shipped.length).map((entry) => entry.path));
  });

  it('terminates as an empty prefix when the first entry alone exceeds the budget', async () => {
    const handlers = await registerHandlers();
    const handler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    if (!handler) throw new Error('SCM status handler was not registered');

    const hugeEntry = buildEntry(`${'y'.repeat(4_300_000)}.txt`);
    runScmRouteMock.mockResolvedValue(buildSnapshotResponse([hugeEntry, buildEntry('b.txt')]));

    const response = await handler({ cwd: '.' });
    const snapshot = (response as { snapshot?: ScmWorkingSnapshot }).snapshot;
    expect(snapshot?.entriesPresentation).toBe('truncated');
    expect(snapshot?.entries).toEqual([]);
    expect(snapshot?.totals).toMatchObject({ untrackedFiles: 2, pendingFiles: 2 });
  });

  it('omits entries when the request asks for a summary but keeps totals intact', async () => {
    const handlers = await registerHandlers();
    const handler = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
    if (!handler) throw new Error('SCM status handler was not registered');

    runScmRouteMock.mockResolvedValue(buildSnapshotResponse([buildEntry('a.txt'), buildEntry('b.txt')]));
    const response = await handler({ cwd: '.', includeEntries: false });
    const snapshot = (response as { snapshot?: ScmWorkingSnapshot }).snapshot;
    expect(snapshot?.entries).toEqual([]);
    expect(snapshot?.entriesPresentation).toBe('omitted');
    expect(snapshot?.totals).toMatchObject({ untrackedFiles: 2, pendingFiles: 2 });
  });
});
