import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import os from 'node:os';
import path from 'node:path';

import { createOnHappySessionWebhook } from './onHappySessionWebhook';

function createMetadata(pid: number, startedBy: 'daemon' | 'terminal', rootPath = '/tmp'): Metadata {
  return {
    path: rootPath,
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
      getParentPidFn: () => null,
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
      getParentPidFn: () => null,
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
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-daemon-789', createMetadata(789, 'daemon'));

    expect(pidToTrackedSession.get(789)?.happySessionId).toBe('session-daemon-789');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(789)).toBe(false);
  });

  it('stores vendorResumeId from session metadata when available', () => {
    const tracked: TrackedSession = {
      pid: 444,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[444, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-daemon-444', {
      ...createMetadata(444, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-444',
    });

    expect(pidToTrackedSession.get(444)?.vendorResumeId).toBe('vendor-session-444');
  });

  it('preserves a previously discovered provider session id when a later webhook metadata payload is stale', async () => {
    const tracked: TrackedSession = {
      pid: 445,
      startedBy: 'daemon',
      happySessionId: 'session-daemon-445',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[445, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [
        {
          pid: 445,
          happySessionId: 'session-daemon-445',
          happyHomeDir: configuration.happyHomeDir,
          createdAt: 1,
          updatedAt: 2,
          flavor: 'ohMyPi',
          metadata: {
            flavor: 'ohMyPi',
            hostPid: 445,
            path: '/tmp',
            ohMyPiSessionId: 'omp-session-existing',
          },
        },
      ],
      writeSessionMarkerFn: async (args: Record<string, unknown>) => {
        markerArgs = args;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-445', {
      ...createMetadata(445, 'daemon'),
      flavor: 'ohMyPi',
    });
    await markerWritten;

    expect(markerArgs.metadata).toEqual(expect.objectContaining({
      flavor: 'ohMyPi',
      hostPid: 445,
      ohMyPiSessionId: 'omp-session-existing',
    }));
  });

  it('does not resolve daemon awaiter on PID placeholder and resolves on canonical id', () => {
    const tracked: TrackedSession = {
      pid: 9001,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[9001, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[9001, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('PID-9001', createMetadata(9001, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(0);
    expect(pidToAwaiter.has(9001)).toBe(true);
    expect(pidToTrackedSession.get(9001)?.happySessionId).toBe('PID-9001');

    onWebhook('session-real-9001', createMetadata(9001, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(9001)).toBe(false);
    expect(pidToTrackedSession.get(9001)?.happySessionId).toBe('session-real-9001');
  });

  it('expands tilde paths before writing the session marker', async () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (args) => {
        markerArgs = args;
        resolveMarker();
      },
    });

    onWebhook('PID-321', createMetadata(321, 'terminal', '~/Documents/Development/happier/dev'));
    await markerWritten;

    const expected = path.join(os.homedir(), 'Documents', 'Development', 'happier', 'dev');
    expect(markerArgs.cwd).toBe(expected);
    expect(markerArgs.metadata.path).toBe(expected);
  });

  it('includes safe and sealed respawn env continuity for daemon-spawned sessions with spawnOptions', async () => {
    const credentials = {
      token: 't',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32).fill(3),
        machineKey: new Uint8Array(32).fill(9),
      },
    };

    const tracked: TrackedSession = {
      pid: 555,
      startedBy: 'daemon',
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        transcriptStorage: 'direct',
        token: 'secret-token-should-not-be-persisted',
        initialPrompt: 'secret prompt should not be persisted',
        resume: 'vendor-resume-id',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CODEX_HOME: '/tmp/codex-home',
          ANTHROPIC_AUTH_TOKEN: 'secret-provider-token',
          FOO: 'bar',
        },
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'happy', isolated: true, tmpDir: '/tmp/tmux' },
        },
      } as any,
    };

    const pidToTrackedSession = new Map<number, TrackedSession>([[555, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readCredentialsFn: async () => credentials,
      writeSessionMarkerFn: async (args: Record<string, unknown>) => {
        markerArgs = args;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-555', createMetadata(555, 'daemon', '/tmp/workspace'));
    await markerWritten;

    expect(markerArgs.respawn).toEqual({
      version: 1,
      directory: '/tmp/workspace',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      resume: 'vendor-resume-id',
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'happy', isolated: true, tmpDir: '/tmp/tmux' },
      },
      transcriptStorage: 'direct',
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
      },
      sealedEnvironmentVariables: {
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      },
    });
    expect(markerArgs.respawn?.token).toBeUndefined();
    expect(markerArgs.respawn?.environmentVariables).not.toMatchObject({
      ANTHROPIC_AUTH_TOKEN: expect.any(String),
      FOO: expect.any(String),
    });
    expect(markerArgs.respawn?.initialPrompt).toBeUndefined();
  });

  it('matches an unknown webhook PID to a daemon-tracked wrapper PID via PPID and resolves awaiter', () => {
    const wrapperPid = 111;
    const runnerPid = 222;
    const tracked: TrackedSession = { pid: wrapperPid, startedBy: 'daemon' };
    const pidToTrackedSession = new Map<number, TrackedSession>([[wrapperPid, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[wrapperPid, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-real-222', createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    expect(pidToTrackedSession.get(wrapperPid)?.happySessionId).toBe('session-real-222');
    expect(pidToTrackedSession.get(wrapperPid)?.sessionRunnerPid).toBe(runnerPid);
  });

  it('defers wrapper awaiter resolution on PID placeholder and resolves on canonical id', () => {
    const wrapperPid = 111;
    const runnerPid = 222;
    const tracked: TrackedSession = { pid: wrapperPid, startedBy: 'daemon' };
    const pidToTrackedSession = new Map<number, TrackedSession>([[wrapperPid, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[wrapperPid, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook(`PID-${runnerPid}`, createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(0);
    expect(pidToAwaiter.has(wrapperPid)).toBe(true);

    onWebhook('session-real-222', createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(wrapperPid)).toBe(false);
  });

  it('falls back to daemon child spawn arguments when process discovery cannot resolve command identity', async () => {
    const sessionPid = 777;
    const spawnArgs = [
      '/usr/bin/node',
      '/repo/.project/tmp/cli-dist-snapshot/src/index.ts',
      'claude',
      '--happy-starting-mode',
      'remote',
      '--started-by',
      'daemon',
    ];
    const tracked: TrackedSession = {
      pid: sessionPid,
      startedBy: 'daemon',
      childProcess: { pid: sessionPid, spawnargs: spawnArgs } as any,
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[sessionPid, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (args) => {
        markerArgs = args;
        resolveMarker();
      },
    });

    onWebhook('session-daemon-777', createMetadata(sessionPid, 'daemon', '/tmp/workspace'));
    await markerWritten;

    const expectedCommand = spawnArgs.join(' ');
    expect(markerArgs.processCommand).toBe(expectedCommand);
    expect(markerArgs.processCommandHash).toBeDefined();
    expect(pidToTrackedSession.get(sessionPid)?.processCommand).toBe(expectedCommand);
    expect(pidToTrackedSession.get(sessionPid)?.processCommandHash).toBe(markerArgs.processCommandHash);
  });
});
