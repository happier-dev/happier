import { describe, expect, it, vi } from 'vitest';

import { createDaemonMemoryActionDeps } from './createDaemonMemoryActionDeps';

describe('createDaemonMemoryActionDeps', () => {
  it('routes memory actions through one typed daemon RPC adapter', async () => {
    // Replace only the daemon RPC boundary; request projection and result parsing remain real.
    const invoke = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method === 'daemon.memory.search') return { v: 1, ok: true, hits: [] };
      if (method === 'daemon.memory.getWindow') return { v: 1, snippets: [], citations: [] };
      return { ok: true };
    });
    const deps = createDaemonMemoryActionDeps({ invoke });

    await expect(deps.daemonMemorySearch({
      machineId: 'machine-1',
      query: { v: 1, query: 'bridge', scope: { type: 'global' }, mode: 'hints' },
    })).resolves.toEqual({ v: 1, ok: true, hits: [] });
    await expect(deps.daemonMemoryGetWindow({
      machineId: 'machine-1',
      sessionId: 'historical-session',
      seqFrom: 4,
      seqTo: 8,
    })).resolves.toEqual({ v: 1, snippets: [], citations: [] });
    await expect(deps.daemonMemoryEnsureUpToDate({
      machineId: 'machine-1',
      sessionId: 'historical-session',
    })).resolves.toEqual({ ok: true });

    expect(invoke).toHaveBeenNthCalledWith(1, {
      machineId: 'machine-1',
      method: 'daemon.memory.search',
      request: { v: 1, query: 'bridge', scope: { type: 'global' }, mode: 'hints' },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      machineId: 'machine-1',
      method: 'daemon.memory.getWindow',
      request: { v: 1, sessionId: 'historical-session', seqFrom: 4, seqTo: 8 },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, {
      machineId: 'machine-1',
      method: 'daemon.memory.ensureUpToDate',
      request: { sessionId: 'historical-session' },
    });
  });
});
