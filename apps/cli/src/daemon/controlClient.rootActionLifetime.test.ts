import { stubUndiciFetch } from '@/testkit/http/stubUndiciFetch';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubIssuedFetch } from '@/testkit/http/stubIssuedFetch';
import { requestDaemonSignedRootActionExecution } from './controlClient';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowRunWaitRequestV1Schema, WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import { SignedRootActionExecuteRequestSchema } from './externalActions/signedRootActionControl';

const contributedActionInput = { action: { pluginId: 'qa.collection-detail', localId: 'set-complete' }, input: { rowId: 'release-guide', completed: true } };
const pluginInstallInput = { path: '/plugin', kind: 'path', dev: true };
const spawnInput = SessionSpawnNewInputV2Schema.parse({
  creationKey: 'root-create-ack', executionTarget: { serverId: 'server-local', machineId: 'machine-local' },
  directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
});
const pluginControlActions = [
  'plugins.install', 'plugins.uninstall', 'plugins.dev.submit', 'plugins.dev.unregister',
  'plugins.reload', 'plugins.change.status', 'plugins.list',
] as const;

describe('signed root Action acknowledgement', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('preserves every strict Action error facet without disclosing daemon-private fields', async () => {
    const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'goal_unavailable', error: 'goal_unavailable',
      details: { reason: 'not_ready' }, goalControlFailure: { phase: 'native_effect' } });
    stubUndiciFetch(async () => Response.json({ ...failure, daemonPrivate: 'not-public' }));
    await expect(requestDaemonSignedRootActionExecution({ actionId: 'session.goal.get', input: { sessionId: 'created-session' } }, {
      target: { pid: process.pid, httpPort: 1 },
    })).resolves.toEqual(failure);
  });

  it('omits malformed Goal diagnostics while retaining the refusal and opaque details', async () => {
    stubUndiciFetch(async () => Response.json({ ok: false, errorCode: 'goal_unavailable', error: 'goal_unavailable',
      details: { reason: 'not_ready' }, goalControlFailure: { phase: 'native_effect', objective: 'private' } }));
    await expect(requestDaemonSignedRootActionExecution({ actionId: 'session.goal.get', input: { sessionId: 'created-session' } }, {
      target: { pid: process.pid, httpPort: 1 },
    })).resolves.toEqual({ ok: false, errorCode: 'goal_unavailable', error: 'goal_unavailable', details: { reason: 'not_ready' } });
  });

  it.each(['session.spawn_new', 'session.wait.idle', 'session.stop', 'session.runtime.refresh', 'ui.find', 'action.invoke', ...pluginControlActions, 'daemon.filesystem.upload', 'daemon.filesystem.download', 'daemon.filesystem.copy', 'workflow.run.wait', 'execution.run.wait', 'wait', 'action.operations.get'] as const)('lets %s return after the generic transport deadline', async (actionId) => {
    vi.useFakeTimers();
    // Clock and HTTP are system boundaries; native AbortSignal timers use a separate clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const issued = stubIssuedFetch((_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ ok: true, result: actionId === 'session.spawn_new'
        ? { type: 'success', sessionId: 'created-session' } : { idle: true, observedAt: 301000 } })), 301000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
    }));
    const result = requestDaemonSignedRootActionExecution({ actionId, input: actionId === 'session.spawn_new'
      ? spawnInput : actionId === 'ui.find'
      ? { op: 'read' } : actionId === 'action.invoke' ? contributedActionInput : actionId === 'plugins.install' ? pluginInstallInput
        : actionId === 'daemon.filesystem.copy' ? { kind: 'prepared_transfer' }
        : actionId === 'action.operations.get' ? { operationId: 'operation-1', waitForTerminal: true }
        : { sessionId: 'created-session', timeoutSeconds: 600 } }, {
      target: { pid: process.pid, httpPort: 1 },
    });
    const observed = result.then((value) => value);
    await issued;
    await vi.advanceTimersByTimeAsync(301000);
    expect(await observed).toMatchObject({ ok: true, result: actionId === 'session.spawn_new'
      ? { type: 'success', sessionId: 'created-session' } : { idle: true } });
  });

  it('returns the real Workflow wait owner result after five minutes through the root client', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const run = WorkflowRunSummaryV1Schema.parse({
      failureUnseen: false, invocationAttentionRequired: true, attentionSeenFailureAt: null, finishedAt: null,
      id: '11111111-1111-4111-8111-111111111111', sourceArtifactId: null,
      ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' },
      state: 'waiting_for_review', revision: 2, machineId: 'machine-1',
      workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      attentionRequired: true, heldCount: 1,
      availability: { pause: true, resumeBoundary: false, restoreWorkspace: false,
        cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1',
      // Persistent storage and HTTP are the boundaries; the wait owner and root client stay real.
      storage: { execute: async (operation) => {
        expect(operation).toEqual({ operation: 'wait', runId: run.id, conditions: ['attention'] });
        return await new Promise((resolve) => setTimeout(() => resolve({
          run, observation: 'needs_attention', matchedCondition: 'attention',
        }), 301_000));
      } },
      definitions: { get: async () => { throw new Error('Unexpected definition read'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => { throw new Error('Unexpected workspace preparation'); },
    });
    const input = { runId: run.id, conditions: ['attention'] as const };
    const issued = stubIssuedFetch(async (url: unknown, options: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/actions/root/execute');
      const request = SignedRootActionExecuteRequestSchema.parse(JSON.parse(String(options.body)));
      expect(request.actionId).toBe('workflow.run.wait');
      const output = await owner.execute({ actionId: 'workflow.run.wait',
        input: WorkflowRunWaitRequestV1Schema.parse(request.input), context: { signal: options.signal ?? undefined } });
      return Response.json({ ok: true, result: output });
    });
    const pending = requestDaemonSignedRootActionExecution({ actionId: 'workflow.run.wait', input }, {
      target: { pid: process.pid, httpPort: 1 },
    });
    await issued;
    await vi.advanceTimersByTimeAsync(301_000);
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    expect(WorkflowRunWaitResultV1Schema.parse(result.result)).toEqual({
      run, observation: 'needs_attention', matchedCondition: 'attention',
    });
  });

  it.each([false, undefined])('retains the bounded operation read when waitForTerminal is %s', async (waitForTerminal) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const issued = stubIssuedFetch((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const pending = requestDaemonSignedRootActionExecution({ actionId: 'action.operations.get',
      input: { operationId: 'operation-1', ...(waitForTerminal === undefined ? {} : { waitForTerminal }) } }, {
      target: { pid: process.pid, httpPort: 1 },
    });
    await issued;
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'timeout' });
  });

  it.each(['deadline', 'abort'] as const)('preserves a Workflow observer caller %s over real HTTP', async (ending) => {
    let accepted!: () => void;
    const received = new Promise<void>((resolve) => { accepted = resolve; });
    const server = createServer((request) => {
      request.resume();
      request.on('end', accepted);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const controller = new AbortController();
    try {
      const pending = requestDaemonSignedRootActionExecution({ actionId: 'workflow.run.wait',
        input: { runId: '11111111-1111-4111-8111-111111111111' } }, {
        target: { pid: process.pid, httpPort: address.port }, signal: controller.signal,
        ...(ending === 'deadline' ? { timeoutMs: 100 } : {}),
      });
      await received;
      if (ending === 'abort') controller.abort();
      await expect(pending).resolves.toMatchObject({ ok: false,
        errorCode: ending === 'deadline' ? 'timeout' : 'cancelled' });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each(['session.spawn_new', 'session.stop', 'session.runtime.refresh', 'action.invoke', 'plugins.install'] as const)('preserves an explicit %s deadline without retrying the uncertain effect', async (actionId) => {
    const acceptedRequests: string[] = [];
    const server = createServer((request) => {
      request.resume();
      request.on('end', () => { acceptedRequests.push('effect-accepted'); });
      // Real HTTP loss after the write committed: no response is sent.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      const result = await requestDaemonSignedRootActionExecution({ actionId,
        input: actionId === 'action.invoke' ? contributedActionInput : actionId === 'plugins.install' ? pluginInstallInput : spawnInput }, {
        target: { pid: process.pid, httpPort: address.port }, timeoutMs: 100,
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
      expect(acceptedRequests).toEqual(['effect-accepted']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps an ordinary bounded root Action under its existing transport deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const issued = stubIssuedFetch((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const pending = requestDaemonSignedRootActionExecution({ actionId: 'session.goal.get', input: { sessionId: 'created-session' } }, {
      target: { pid: process.pid, httpPort: 1 },
    });
    await issued;
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'timeout' });
  });

  it.each(['session.spawn_new', 'session.stop', 'session.runtime.refresh', 'action.invoke', 'plugins.install'] as const)('cancels %s observation when its caller aborts', async (actionId) => {
    let accepted!: () => void;
    const requestAccepted = new Promise<void>((resolve) => { accepted = resolve; });
    const server = createServer((request) => {
      request.resume();
      request.on('end', accepted);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const controller = new AbortController();
    try {
      const pending = requestDaemonSignedRootActionExecution({ actionId, input: actionId === 'session.spawn_new'
        ? spawnInput
        : actionId === 'action.invoke' ? contributedActionInput : pluginInstallInput }, {
        target: { pid: process.pid, httpPort: address.port }, signal: controller.signal,
      });
      await requestAccepted;
      controller.abort();
      await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports an idle observation deadline as timeout, not a daemon outage', async () => {
    const server = createServer((request) => request.resume());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      await expect(requestDaemonSignedRootActionExecution({ actionId: 'session.wait.idle', input: { sessionId: 'created-session' } }, {
        target: { pid: process.pid, httpPort: address.port }, timeoutMs: 100,
      })).resolves.toMatchObject({ ok: false, errorCode: 'timeout' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
