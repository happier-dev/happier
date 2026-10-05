import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionExecutorDeps, ApprovalRequestV1 } from '@happier-dev/protocol';
import * as persistence from '@/persistence';

import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

// Socket.IO is the external transport boundary. The socket factory, managed
// supervisor, Account observer and approval coordinator all remain real.
const wire = vi.hoisted(() => {
  const sockets: Array<{ connected: boolean; listenerCount: () => number }> = [];
  return { sockets, io: vi.fn(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    };
    const socket = {
      connected: false,
      io: { timeout() {}, on() {}, off() {} },
      on(event: string, listener: (...args: unknown[]) => void) {
        const group = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
        group.add(listener); listeners.set(event, group);
      },
      off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); },
      connect() { socket.connected = true; emit('connect'); },
      disconnect() { socket.connected = false; emit('disconnect', 'client disconnect'); },
      removeAllListeners() { listeners.clear(); },
      offAny() {},
      listenerCount: () => [...listeners.values()].reduce((total, group) => total + group.size, 0),
    };
    sockets.push(socket);
    return socket;
  }) };
});
vi.mock('socket.io-client', () => ({ io: wire.io }));

function createApprovalRequest(overrides: Partial<ApprovalRequestV1> = {}): ApprovalRequestV1 {
  return {
    v: 1,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'sess_1' },
    requestedSurface: 'agent',
    actionId: 'session.list',
    actionArgs: { limit: 10 },
    summary: 'Approve listing sessions',
    preview: { actionId: 'session.list', actionArgs: { limit: 10 } },
    ...overrides,
  } as ApprovalRequestV1;
}

async function expectPromiseStillPending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  expect(settled).toBe(false);
}

describe('createCliActionExecutorHarness', () => {
  beforeEach(() => { wire.sockets.length = 0; wire.io.mockClear(); });
  it('places default browser actions on the authenticated daemon and consumes its result', async () => {
    // Daemon discovery reads the filesystem, and fetch crosses the local HTTP boundary.
    const state = vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({
      pid: 123, httpPort: 12345, controlToken: 'browser-control-token',
      startedAt: 1, startedWithCliVersion: '0.3.0',
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      result: { v: 1, machineId: 'machine_browser', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [] },
    }), { status: 200 }));
    const harness = createCliActionExecutorHarness({
      token: 'token', sessionId: 'session_browser', mode: 'plain', ctx: null,
    });
    try {
      const result = await harness.executor.execute('browser.diagnostics.snapshot', {
        browserSessionId: 'session_browser', viewId: 'view_browser',
      }, { surface: 'agent', defaultSessionId: 'session_browser' });
      expect(result).toEqual({ ok: true, result: {
        v: 1, machineId: 'machine_browser', generatedAt: 1, refreshState: 'idle', events: [], diagnostics: [],
      } });
    } finally {
      fetch.mockRestore();
      state.mockRestore();
    }
  });

  it('lets callers override action approval policy for a specific runtime surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_1' }));
    const sessionTitleSet = vi.fn(async () => ({ ok: true, sessionId: 'sess_1', title: 'Updated' }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        serverId: 'server-1',
        serverHttpBaseUrl: 'https://server-1.example.test',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsCreate,
        sessionTitleSet,
        isActionApprovalRequired: (id, ctx) => id === 'session.title.set' && ctx.surface === 'agent',
      },
    );

    const result = await harness.executor.execute(
      'session.title.set',
      { sessionId: 'sess_1', title: 'Updated' },
      { surface: 'agent', defaultSessionId: 'sess_1', actionRequestId: 'request-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval_1',
        actionId: 'session.title.set',
      },
    });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
    expect(sessionTitleSet).not.toHaveBeenCalled();
  });

  it('installs a fail-closed runtime action executor bridge', async () => {
    const harness = createCliActionExecutorHarness({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'e2ee',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
    });

    expect(harness.deps.runtimeActionExecute).toBeDefined();
    await expect(harness.deps.runtimeActionExecute?.({
      actionId: 'devices.simulator.input.tap',
      input: {},
      context: {},
    })).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:devices.simulator:runtime_family_unimplemented',
    });
  });

  it('wires blocking approval waiters to rejection artifact updates', async () => {
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        serverHttpBaseUrl: 'https://approval-home.example.test',
        serverId: 'approval-home',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsUpdate,
      },
    );

    const waitForDecision = harness.deps.approvalsWaitForDecision;
    expect(waitForDecision).toBeDefined();
    if (!waitForDecision) throw new Error('expected approvalsWaitForDecision');

    const abort = new AbortController();
    const pending = waitForDecision({
      artifactId: 'approval_1',
      request: createApprovalRequest(),
      signal: abort.signal,
    });
    try {
      await harness.deps.approvalsUpdate?.({
        artifactId: 'approval_1',
        request: createApprovalRequest({
          status: 'rejected',
          decision: { kind: 'reject', decidedAtMs: 2 },
        }),
        serverId: null,
      });
      await expect(pending).resolves.toMatchObject({ decision: 'reject' });
      expect(approvalsUpdate).toHaveBeenCalledTimes(1);
      expect(wire.sockets.every((socket) => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
    }
  });

  it('keeps approved blocking waiters claimed by the explicit approval decision seam', async () => {
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        serverHttpBaseUrl: 'https://approval-home.example.test',
        serverId: 'approval-home',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsUpdate,
      },
    );

    const waitForDecision = harness.deps.approvalsWaitForDecision;
    const resolveBlockingDecision: ActionExecutorDeps['approvalsResolveBlockingDecision'] =
      harness.deps.approvalsResolveBlockingDecision;
    expect(waitForDecision).toBeDefined();
    expect(resolveBlockingDecision).toBeDefined();
    if (!waitForDecision || !resolveBlockingDecision) {
      throw new Error('expected blocking approval hooks');
    }

    const abort = new AbortController();
    const pending = waitForDecision({
      artifactId: 'approval_approved_1',
      request: createApprovalRequest(),
      signal: abort.signal,
    });
    try {
      const approvedRequest = createApprovalRequest({
        status: 'approved',
        decision: { kind: 'approve', decidedAtMs: 2 },
      });
      await harness.deps.approvalsUpdate?.({
        artifactId: 'approval_approved_1',
        request: approvedRequest,
        serverId: null,
      });
      await expectPromiseStillPending(pending);
      await expect(resolveBlockingDecision({
        artifactId: 'approval_approved_1',
        decision: 'approve',
        request: approvedRequest,
        serverId: null,
      })).resolves.toEqual({ resolved: true });
      await expect(pending).resolves.toMatchObject({ decision: 'approve' });
      expect(wire.sockets.every((socket) => !socket.connected && socket.listenerCount() === 0)).toBe(true);
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
    }
  });
});
