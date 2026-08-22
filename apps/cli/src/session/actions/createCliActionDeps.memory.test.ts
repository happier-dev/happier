import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const { callMachineRpc } = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc,
}));

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps memory bindings', () => {
  it('routes the three canonical memory actions through the authenticated machine RPC owner', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const searchResult = { v: 1 as const, ok: true as const, hits: [] };
    const windowResult = { v: 1 as const, snippets: [], citations: [] };
    const ensureResult = { ok: true as const };
    callMachineRpc
      .mockResolvedValueOnce(searchResult)
      .mockResolvedValueOnce(windowResult)
      .mockResolvedValueOnce(ensureResult)
      .mockResolvedValueOnce(ensureResult);

    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });
    const query = {
      v: 1 as const,
      query: 'canonical owner',
      scope: { type: 'global' as const },
      mode: 'hints' as const,
    };

    await expect(deps.daemonMemorySearch({
      machineId: 'machine-1',
      query,
      serverId: null,
    })).resolves.toEqual(searchResult);
    await expect(deps.daemonMemoryGetWindow({
      machineId: 'machine-1',
      sessionId: 'session-1',
      seqFrom: 12,
      seqTo: 18,
      serverId: null,
    })).resolves.toEqual(windowResult);
    await expect(deps.daemonMemoryEnsureUpToDate({
      machineId: 'machine-1',
      sessionId: 'session-1',
      serverId: null,
    })).resolves.toEqual(ensureResult);
    await expect(deps.daemonMemoryEnsureUpToDate({
      machineId: 'machine-1',
      serverId: null,
    })).resolves.toEqual(ensureResult);

    expect(callMachineRpc.mock.calls).toEqual([
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
        request: query,
      }],
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        request: { v: 1, sessionId: 'session-1', seqFrom: 12, seqTo: 18 },
      }],
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: { sessionId: 'session-1' },
      }],
      [{
        credentials,
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: {},
      }],
    ]);
  });
});
