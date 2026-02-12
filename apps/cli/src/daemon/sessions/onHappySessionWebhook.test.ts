import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';

import { createOnHappySessionWebhook } from './onHappySessionWebhook';

function createMetadata(pid: number, startedBy: 'daemon' | 'terminal'): Metadata {
  return {
    path: '/tmp',
    host: 'test-host',
    homeDir: '/tmp/home',
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: '/tmp/lib',
    happyToolsDir: '/tmp/tools',
    hostPid: pid,
    startedBy,
    machineId: 'machine-test',
  };
}

describe('createOnHappySessionWebhook', () => {
  it('registers an externally started session when PID is unknown', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('PID-123', createMetadata(123, 'terminal'));

    const tracked = pidToTrackedSession.get(123);
    expect(tracked).toBeDefined();
    expect(tracked?.startedBy).toBe('happy directly - likely by user from terminal');
    expect(tracked?.happySessionId).toBe('PID-123');
  });

  it('updates an already tracked external session when a new session id is reported', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [
        456,
        {
          pid: 456,
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: 'PID-456',
        },
      ],
    ]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-real-456', createMetadata(456, 'terminal'));

    expect(pidToTrackedSession.get(456)?.happySessionId).toBe('session-real-456');
  });

  it('updates daemon-spawned session id and resolves spawn awaiter', () => {
    const tracked: TrackedSession = {
      pid: 789,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[789, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[789, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-daemon-789', createMetadata(789, 'daemon'));

    expect(pidToTrackedSession.get(789)?.happySessionId).toBe('session-daemon-789');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(789)).toBe(false);
  });
});
