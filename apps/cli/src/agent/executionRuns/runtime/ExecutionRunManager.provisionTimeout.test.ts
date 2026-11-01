import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';

import { ExecutionRunManager } from './ExecutionRunManager';
import type {
  SessionRuntimeActivityContribution,
  SessionRuntimeActivityContributionHandle,
} from '@/session/runtimeActivity/types';

const PROVISION_TIMEOUT_ENV_KEY = 'HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS';

function createNeverProvisioningBackend(): AgentBackend {
  return {
    // Hangs forever: the live QA2-F04 shape — no backend process ever appears, no error is thrown,
    // and without a bound the run sits "running" indefinitely.
    startSession(): Promise<{ sessionId: SessionId }> {
      return new Promise(() => {});
    },
    async sendPrompt(): Promise<void> {},
    async cancel(): Promise<void> {},
    onMessage(): void {},
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

async function waitForStatus(
  read: () => string | undefined,
  wanted: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = read();
    if (status === wanted) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read();
}

describe('ExecutionRunManager backend provisioning bound (QA2-F04)', () => {
  afterEach(() => {
    delete process.env[PROVISION_TIMEOUT_ENV_KEY];
    vi.useRealTimers();
  });

  it('does not terminate an admitted run at the obsolete five minute provisioning cutoff', async () => {
    vi.useFakeTimers();
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createNeverProvisioningBackend(),
      sendAcp: () => {},
    });

    const started = await manager.start({
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Do the thing.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

    expect(manager.getPublic(started.runId)?.status).toBe('running');
  });

  it('fails a bounded run whose backend session provisioning never settles', async () => {
    process.env[PROVISION_TIMEOUT_ENV_KEY] = '200';
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createNeverProvisioningBackend(),
      sendAcp: () => {},
    });

    const started = await manager.start({
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Do the thing.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const status = await waitForStatus(
      () => manager.getPublic(started.runId)?.status,
      'failed',
      5_000,
    );
    expect(status).toBe('failed');
    const run = manager.getPublic(started.runId);
    expect(run?.error?.code).toBe('execution_run_backend_provision_timeout');
  });

  it('does not re-enter a disposed backend when its session appears after the provisioning timeout', async () => {
    process.env[PROVISION_TIMEOUT_ENV_KEY] = '200';
    let resolveSession!: (value: { sessionId: SessionId }) => void;
    const session = new Promise<{ sessionId: SessionId }>((resolve) => {
      resolveSession = resolve;
    });
    const cancel = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => ({
        startSession: () => session,
        async sendPrompt() {},
        cancel,
        onMessage() {},
        dispose,
        async waitForResponseComplete() {},
      }),
      sendAcp: () => {},
    });
    const started = await manager.start({
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Do the thing.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await manager.waitForTerminal(started.runId);

    resolveSession({ sessionId: 'late-provider-session' as SessionId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.get(started.runId)?.status).toBe('failed');
  });

  it('returns a long-lived run handle before provisioning times out, then fails the admitted run', async () => {
    process.env[PROVISION_TIMEOUT_ENV_KEY] = '200';
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createNeverProvisioningBackend(),
      sendAcp: () => {},
    });

    const started = await manager.start({
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Do the thing.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(manager.get(started.runId)?.status).toBe('running');
    await manager.waitForTerminal(started.runId);

    // The asynchronously provisioning run must eventually be terminal, not leaked as running.
    const runs = manager.listPublic();
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error?.code).toBe('execution_run_backend_provision_timeout');
  });

  it('terminalizes only the timed-out run and retains a working sibling contribution', async () => {
    process.env[PROVISION_TIMEOUT_ENV_KEY] = '200';
    const reports: SessionRuntimeActivityContribution[] = [];
    const contributionHandle = {
      report: vi.fn(async (snapshot: SessionRuntimeActivityContribution) => { reports.push(snapshot); }),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies SessionRuntimeActivityContributionHandle;
    let backendCount = 0;
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => {
        backendCount += 1;
        if (backendCount === 2) return createNeverProvisioningBackend();
        let complete!: () => void;
        const response = new Promise<void>((resolve) => { complete = resolve; });
        return {
          async startSession() { return { sessionId: 'sibling' as SessionId }; },
          async sendPrompt() {}, async cancel() { complete(); }, onMessage() {}, async dispose() {},
          async waitForResponseComplete() { await response; },
        };
      },
      sendAcp: () => {},
      runtimeActivityContributionHandle: contributionHandle,
    });
    const sibling = await manager.start({
      sessionId: 'session-1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Keep working until cancelled.',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
    });

    const timedOut = await manager.start({
      sessionId: 'session-1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
    });
    await manager.waitForTerminal(timedOut.runId);

    expect(manager.get(sibling.runId)?.status).toBe('running');
    expect(reports).toContainEqual({ state: 'active', activeCount: 2 });
    expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
    await manager.stop(sibling.runId);
  });
});
