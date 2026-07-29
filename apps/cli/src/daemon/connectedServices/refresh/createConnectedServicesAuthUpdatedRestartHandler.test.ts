import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

import type { TrackedSession } from '@/daemon/types';
import { createConnectedServicesAuthUpdatedRestartHandler } from './createConnectedServicesAuthUpdatedRestartHandler';

describe('createConnectedServicesAuthUpdatedRestartHandler', () => {
  function createTrackedSession(input: Readonly<{
    pid: number;
    sessionId: string;
    kill: (signal: string) => unknown;
  }>): TrackedSession {
    return {
      pid: input.pid,
      startedBy: 'daemon',
      happySessionId: input.sessionId,
      childProcess: { kill: input.kill } as ChildProcess,
    };
  }

  it('marks pi spawn targets for restart and SIGTERMs the child process', () => {
    const restartRequestedPids = new Set<number>();
    const kill = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1', kill })],
      [2, createTrackedSession({ pid: 2, sessionId: 's2', kill })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
    });

    handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [
        { pid: 1, agentId: 'pi' },
        { pid: 2, agentId: 'codex' },
      ],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
    expect(restartRequestedPids.has(2)).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('requests restart through the shared signal path with refresh diagnostics when configured', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async () => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1', kill: vi.fn() })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
      requestRestartSignal,
      restartSignalDelayMs: 250,
    });

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      delayMs: 250,
      preferProcessGroup: true,
      restartDiagnostic: expect.objectContaining({
        trigger: 'refresh_triggered_restart',
        sessionId: 's1',
        agentId: 'pi',
        serviceId: 'openai-codex',
        profileId: 'work',
      }),
    }));
  });

  it('uses the shared gated restart path for a surviving reattached runner', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async () => ({ signaled: true }));
    const tracked = {
      pid: 41,
      startedBy: 'daemon' as const,
      happySessionId: 'reattached-session',
      reattachedFromDiskMarker: true,
    } satisfies TrackedSession;
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      restartAgentIds: new Set(['pi']),
      requestRestartSignal,
      restartSignalDelayMs: 0,
    });

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [{ pid: tracked.pid, agentId: 'pi' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledOnce();
    expect(restartRequestedPids).toContain(tracked.pid);
  });

  it('reserves the pid ONLY when the gated restart actually signalled', async () => {
    // A gated restart can resolve successfully WITHOUT signalling (e.g. the deferred restart was
    // superseded by a newer switch — `switch_cancelled`). Reserving the pid unconditionally would
    // leak a reservation that suppresses every later refresh restart for the same process until exit.
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async () => ({ signaled: false }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1', kill: vi.fn() })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
      requestRestartSignal,
      restartSignalDelayMs: 250,
    });

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('does not double-restart the same pid', () => {
    const restartRequestedPids = new Set<number>([1]);
    const kill = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1', kill })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
    });

    handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
    });

    expect(kill).toHaveBeenCalledTimes(0);
  });

  it('does not restart a no-restart service for a daemon target without runtime callback capability', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = vi.fn(async () => ({ signaled: true }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1', kill: vi.fn() })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['claude']),
      noRestartRequiredServiceIdsByAgentId: new Map([
        ['claude', new Set(['claude-subscription'])],
      ]),
      requestRestartSignal,
      restartSignalDelayMs: 250,
    });

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });

  it('does not mark the pid for restart when SIGTERM throws', () => {
    const restartRequestedPids = new Set<number>();
    const kill = vi.fn(() => {
      throw new Error('kill-failed');
    });
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1', kill })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
    });

    expect(() => {
      handler({
        binding: { serviceId: 'openai-codex', profileId: 'work' },
        affectedTargets: [{ pid: 1, agentId: 'pi' }],
      });
    }).not.toThrow();

    expect(restartRequestedPids.size).toBe(0);
  });

  it.each([
    { stopResult: { status: 'stopped' as const }, label: 'stopped' },
    { stopResult: { status: 'not_found' as const }, label: 'not_found' },
  ])('acknowledges credential deletion only after a $label target is positively absent', async ({ stopResult }) => {
    let present = true;
    const stopSession = vi.fn(async () => {
      present = false;
      return stopResult;
    });
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      restartAgentIds: new Set(),
      stopSession,
      isCredentialTargetPresent: () => present,
    });

    await expect(handler({
      binding: { serviceId: 'openai-codex', profileId: 'deleted' },
      credentialPresence: { status: 'absent' },
      affectedTargets: [{ pid: 42, agentId: 'codex', sessionId: 'session-42' }],
    })).resolves.toBeUndefined();
    expect(stopSession).toHaveBeenCalledWith('session-42');
  });

  it.each([
    { status: 'requested' as const },
    { status: 'incomplete' as const, reason: 'runner_exit_timeout' as const },
    { status: 'not_found' as const },
  ])('rejects credential deletion when lifecycle settlement is $status or the exact target survives', async (stopResult) => {
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      restartAgentIds: new Set(),
      stopSession: vi.fn(async () => stopResult),
      isCredentialTargetPresent: () => true,
    });

    await expect(handler({
      binding: { serviceId: 'openai-codex', profileId: 'deleted' },
      credentialPresence: { status: 'absent' },
      affectedTargets: [{ pid: 42, agentId: 'codex', sessionId: 'session-42' }],
    })).rejects.toThrow(`connected_service_credential_deletion_not_settled:${stopResult.status}`);
  });
});
