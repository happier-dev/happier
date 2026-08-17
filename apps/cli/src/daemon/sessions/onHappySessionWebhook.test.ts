import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import type { ChildProcess } from 'node:child_process';
import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import os from 'node:os';
import path from 'node:path';

import { createOnHappySessionWebhook } from './onHappySessionWebhook';

type SessionMarkerWriteFn = NonNullable<Parameters<typeof createOnHappySessionWebhook>[0]['writeSessionMarkerFn']>;
type SessionMarkerWriteArgs = Parameters<SessionMarkerWriteFn>[0];
type SessionMarkerWriteOptions = Parameters<SessionMarkerWriteFn>[1];

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

function expectSessionMarkerWriteArgs(args: SessionMarkerWriteArgs | null): SessionMarkerWriteArgs {
  expect(args).not.toBeNull();
  if (args === null) {
    throw new Error('expected session marker write args');
  }
  return args;
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

  it('matches a Windows Terminal child webhook to the pending daemon launch pid', () => {
    const windowsTerminalPid = 13764;
    const runnerPid = 5500;
    const tracked: TrackedSession = {
      pid: windowsTerminalPid,
      startedBy: 'daemon',
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid: windowsTerminalPid,
          windowId: 'happier-qa-claude-unified',
        },
      },
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[windowsTerminalPid, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[windowsTerminalPid, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-windows-terminal-1', {
      ...createMetadata(runnerPid, 'daemon'),
      terminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier-qa-claude-unified',
        },
      },
    });

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(awaiter).toHaveBeenCalledWith(expect.objectContaining({
      pid: windowsTerminalPid,
      sessionRunnerPid: runnerPid,
      happySessionId: 'session-windows-terminal-1',
    }));
    expect(pidToAwaiter.has(windowsTerminalPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    expect(pidToTrackedSession.get(windowsTerminalPid)?.sessionRunnerPid).toBe(runnerPid);
    expect(pidToTrackedSession.get(windowsTerminalPid)?.happySessionId).toBe('session-windows-terminal-1');
  });

  it('matches concurrent Windows Terminal child webhooks by unique tab title inside a shared window', () => {
    const firstWindowsTerminalPid = 13764;
    const secondWindowsTerminalPid = 13765;
    const runnerPid = 5501;
    const firstAwaiter = vi.fn();
    const secondAwaiter = vi.fn();
    const firstTracked: TrackedSession = {
      pid: firstWindowsTerminalPid,
      startedBy: 'daemon',
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid: firstWindowsTerminalPid,
          windowId: 'happier-qa-claude-unified',
          title: 'Happier claude spawn-a',
        },
      },
    };
    const secondTracked: TrackedSession = {
      pid: secondWindowsTerminalPid,
      startedBy: 'daemon',
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid: secondWindowsTerminalPid,
          windowId: 'happier-qa-claude-unified',
          title: 'Happier claude spawn-b',
        },
      },
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [firstWindowsTerminalPid, firstTracked],
      [secondWindowsTerminalPid, secondTracked],
    ]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([
      [firstWindowsTerminalPid, firstAwaiter],
      [secondWindowsTerminalPid, secondAwaiter],
    ]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-windows-terminal-2', {
      ...createMetadata(runnerPid, 'daemon'),
      terminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier-qa-claude-unified',
          title: 'Happier claude spawn-b',
        },
      },
    });

    expect(firstAwaiter).not.toHaveBeenCalled();
    expect(secondAwaiter).toHaveBeenCalledTimes(1);
    expect(secondAwaiter).toHaveBeenCalledWith(expect.objectContaining({
      pid: secondWindowsTerminalPid,
      sessionRunnerPid: runnerPid,
      happySessionId: 'session-windows-terminal-2',
    }));
    expect(pidToAwaiter.has(firstWindowsTerminalPid)).toBe(true);
    expect(pidToAwaiter.has(secondWindowsTerminalPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    expect(pidToTrackedSession.get(secondWindowsTerminalPid)?.sessionRunnerPid).toBe(runnerPid);
  });

  it('notifies when a tracked daemon session reports provider context', () => {
    const tracked: TrackedSession = {
      pid: 790,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[790, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const onTrackedSessionReported = vi.fn();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported,
    });

    onWebhook('session-daemon-790', createMetadata(790, 'daemon'));

    expect(onTrackedSessionReported).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-daemon-790',
      pid: 790,
    }));
  });

  it('notifies when a terminal-started session reports provider context', () => {
    const onTrackedSessionReported = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      pidToAwaiter: new Map<number, (session: TrackedSession) => void>(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported,
    });

    onWebhook('session-terminal-793', {
      ...createMetadata(793, 'terminal'),
      flavor: 'opencode',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
          },
        },
      },
      connectedServiceBrokerSelectionIdentityV1:
        'opencode|connected|broker:1|openai-codex:work:acct-1',
    } as Metadata);

    expect(onTrackedSessionReported).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-terminal-793',
      pid: 793,
      startedBy: 'happy directly - likely by user from terminal',
    }));
  });

  it('does not acknowledge daemon readiness until the strict tracked-session callback settles', async () => {
    const tracked: TrackedSession = { pid: 792, startedBy: 'daemon' };
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const onTrackedSessionReported = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>([[792, tracked]]),
      pidToAwaiter: new Map<number, (session: TrackedSession) => void>(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReady: async () => await ready,
      onTrackedSessionReported,
    });

    let acknowledged = false;
    const report = Promise.resolve(onWebhook('session-daemon-792', createMetadata(792, 'daemon')))
      .then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(onTrackedSessionReported).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-daemon-792',
      pid: 792,
    }));
    releaseReady();
    await report;
    expect(acknowledged).toBe(true);
  });

  it('does not fail session registration when a best-effort tracked-session observer throws synchronously', () => {
    const tracked: TrackedSession = {
      pid: 791,
      startedBy: 'daemon',
    };
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>([[791, tracked]]),
      pidToAwaiter: new Map<number, (session: TrackedSession) => void>(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported: () => {
        throw new ReferenceError('optional observer is unavailable');
      },
    });

    expect(() => onWebhook('session-daemon-791', createMetadata(791, 'daemon'))).not.toThrow();
    expect(tracked.happySessionId).toBe('session-daemon-791');
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

  it('does not preserve stale connected-service restart intent when refreshing a daemon marker from webhook metadata', async () => {
    const tracked: TrackedSession = {
      pid: 445,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[445, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerOptions: SessionMarkerWriteOptions | undefined;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (_args, options) => {
        markerOptions = options;
        resolveMarker();
      },
    });

    onWebhook('session-daemon-445', {
      ...createMetadata(445, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-445',
    });
    await markerWritten;

    expect(markerOptions).toBeUndefined();
  });

  it('does not preserve stale connected-service restart intent through routine marker refreshes', async () => {
    const tracked: TrackedSession = {
      pid: 446,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[446, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerOptions: SessionMarkerWriteOptions | undefined;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (_args, options) => {
        markerOptions = options;
        resolveMarker();
      },
    });

    onWebhook('session-daemon-446', {
      ...createMetadata(446, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-446',
    });
    await markerWritten;

    expect(markerOptions).toBeUndefined();
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

    let markerArgs: SessionMarkerWriteArgs | null = null;
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
    const marker = expectSessionMarkerWriteArgs(markerArgs);
    expect(marker.cwd).toBe(expected);
    expect(marker.metadata.path).toBe(expected);
  });

  it('includes a safe respawn descriptor for daemon-spawned sessions with spawnOptions', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
    };
    const spawnOptionsWithLegacySecret = {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      transcriptStorage: 'direct',
      token: 'secret-token-should-not-be-persisted',
      pendingFirstInput: { text: 'secret prompt should not be persisted', localId: 'spawn-first:nonce' },
      resume: 'vendor-resume-id',
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
        ANTHROPIC_AUTH_TOKEN: 'secret-provider-token',
        OPENAI_API_KEY: 'secret-openai-key',
        FOO: 'bar',
      },
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'happy', isolated: true, tmpDir: '/tmp/tmux' },
      },
    } satisfies SpawnSessionOptions & { token: string };
    const tracked: TrackedSession = {
      pid: 555,
      startedBy: 'daemon',
      spawnOptions: spawnOptionsWithLegacySecret,
    };

    const pidToTrackedSession = new Map<number, TrackedSession>([[555, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: SessionMarkerWriteArgs | null = null;
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
      writeSessionMarkerFn: async (args) => {
        markerArgs = args;
        resolveMarker();
      },
    });

    onWebhook('session-daemon-555', createMetadata(555, 'daemon', '/tmp/workspace'));
    await markerWritten;

    const marker = expectSessionMarkerWriteArgs(markerArgs);
    expect(marker.respawn).toEqual({
      version: 1,
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
    expect(marker.respawn?.token).toBeUndefined();
    expect(marker.respawn?.environmentVariables).not.toMatchObject({
      ANTHROPIC_AUTH_TOKEN: expect.any(String),
      OPENAI_API_KEY: expect.any(String),
      FOO: expect.any(String),
    });
    expect(marker.respawn?.pendingFirstInput).toBeUndefined();
  });

  it('persists the learned vendorResumeId into the respawn descriptor for fresh daemon sessions started without --resume', async () => {
    const tracked: TrackedSession = {
      pid: 557,
      startedBy: 'daemon',
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      } satisfies SpawnSessionOptions,
    };

    const pidToTrackedSession = new Map<number, TrackedSession>([[557, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: SessionMarkerWriteArgs | null = null;
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

    onWebhook('session-daemon-557', {
      ...createMetadata(557, 'daemon', '/tmp/workspace'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-557',
    });
    await markerWritten;

    expect(pidToTrackedSession.get(557)?.vendorResumeId).toBe('vendor-session-557');
    const marker = expectSessionMarkerWriteArgs(markerArgs);
    expect(marker.respawn?.vendorResumeId).toBe('vendor-session-557');
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
      childProcess: { pid: sessionPid, spawnargs: spawnArgs } as Pick<ChildProcess, 'pid' | 'spawnargs'> as ChildProcess,
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[sessionPid, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: SessionMarkerWriteArgs | null = null;
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
    const marker = expectSessionMarkerWriteArgs(markerArgs);
    expect(marker.processCommand).toBe(expectedCommand);
    expect(marker.processCommandHash).toBeDefined();
    expect(pidToTrackedSession.get(sessionPid)?.processCommand).toBe(expectedCommand);
    expect(pidToTrackedSession.get(sessionPid)?.processCommandHash).toBe(marker.processCommandHash);
  });
});
