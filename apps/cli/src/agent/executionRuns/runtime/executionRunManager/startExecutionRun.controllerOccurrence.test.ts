import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { ExecutionRunManager } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import { settleExecutionRunControllerOccurrence } from './startExecutionRun';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createProvisioningBackend(provision: Promise<{ sessionId: SessionId }>, dispose: () => Promise<void>): AgentBackend {
  return {
    startSession: () => provision,
    async sendPrompt() {},
    async cancel() {},
    onMessage() {},
    dispose,
    async waitForResponseComplete() {},
  };
}

function readControllers(manager: ExecutionRunManager): Map<string, ExecutionRunController> {
  return (manager as unknown as { controllers: Map<string, ExecutionRunController> }).controllers;
}

async function waitForController(manager: ExecutionRunManager): Promise<[string, ExecutionRunController]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = readControllers(manager).entries().next().value;
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('controller was not installed');
}

describe('settleExecutionRunControllerOccurrence', () => {
  it('settles an old occurrence without deleting the successor for the same logical run', () => {
    const oldController = { resolveTerminal: vi.fn() };
    const successorController = { resolveTerminal: vi.fn() };
    const controllers = new Map([['run-1', successorController]]);

    settleExecutionRunControllerOccurrence(controllers, 'run-1', oldController);

    expect(oldController.resolveTerminal).toHaveBeenCalledOnce();
    expect(successorController.resolveTerminal).not.toHaveBeenCalled();
    expect(controllers.get('run-1')).toBe(successorController);
  });

  it('provisioning rejection disposes and settles only its captured bounded occurrence', async () => {
    const provision = createDeferred<{ sessionId: SessionId }>();
    const oldDispose = vi.fn(async () => {});
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createProvisioningBackend(provision.promise, oldDispose),
      sendAcp: () => {},
    });

    const started = await manager.start({
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const controllers = readControllers(manager);
    const oldController = controllers.get(started.runId)!;
    const oldResolveTerminal = vi.fn(oldController.resolveTerminal);
    oldController.resolveTerminal = oldResolveTerminal;
    const successorDispose = vi.fn(async () => {});
    const successorResolveTerminal = vi.fn();
    const successor = {
      ...oldController,
      ...(oldController.kind === 'backend'
        ? { backend: { ...oldController.backend, dispose: successorDispose } }
        : {}),
      resolveTerminal: successorResolveTerminal,
    } as ExecutionRunController;
    controllers.set(started.runId, successor);

    provision.reject(new Error('old occurrence provision failed'));
    for (let attempt = 0; attempt < 50 && manager.get(started.runId)?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(manager.get(started.runId)?.status).toBe('failed');
    expect(oldDispose).toHaveBeenCalledOnce();
    expect(oldResolveTerminal).toHaveBeenCalledOnce();
    expect(successorDispose).not.toHaveBeenCalled();
    expect(successorResolveTerminal).not.toHaveBeenCalled();
    expect(controllers.get(started.runId)).toBe(successor);
  });

  it('long-lived start rejection disposes and settles only its captured occurrence', async () => {
    const provision = createDeferred<{ sessionId: SessionId }>();
    const oldDispose = vi.fn(async () => {});
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createProvisioningBackend(provision.promise, oldDispose),
      sendAcp: () => {},
    });

    const start = manager.start({
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    const [runId, oldController] = await waitForController(manager);
    const controllers = readControllers(manager);
    const oldResolveTerminal = vi.fn(oldController.resolveTerminal);
    oldController.resolveTerminal = oldResolveTerminal;
    const successorDispose = vi.fn(async () => {});
    const successorResolveTerminal = vi.fn();
    const successor = {
      ...oldController,
      ...(oldController.kind === 'backend'
        ? { backend: { ...oldController.backend, dispose: successorDispose } }
        : {}),
      resolveTerminal: successorResolveTerminal,
    } as ExecutionRunController;
    controllers.set(runId, successor);

    provision.reject(new Error('old occurrence start failed'));

    await expect(start).rejects.toThrow('old occurrence start failed');
    expect(oldDispose).toHaveBeenCalledOnce();
    expect(oldResolveTerminal).toHaveBeenCalledOnce();
    expect(successorDispose).not.toHaveBeenCalled();
    expect(successorResolveTerminal).not.toHaveBeenCalled();
    expect(controllers.get(runId)).toBe(successor);
  });

  it('stopping during bounded provisioning cancels and disposes a late-created backend session without sending work', async () => {
    const provision = createDeferred<{ sessionId: SessionId }>();
    const cancel = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const sendPrompt = vi.fn(async () => {});
    const backend: AgentBackend = {
      startSession: () => provision.promise,
      sendPrompt,
      cancel,
      onMessage() {},
      dispose,
      async waitForResponseComplete() {},
    };
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
    });

    const started = await manager.start({
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Do work.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await expect(manager.stop(started.runId)).resolves.toEqual({ ok: true });

    provision.resolve({ sessionId: 'late-child-session' as SessionId });
    for (let attempt = 0; attempt < 50 && cancel.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(manager.get(started.runId)?.status).toBe('cancelled');
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith('late-child-session');
    expect(dispose).toHaveBeenCalled();
  });
});
