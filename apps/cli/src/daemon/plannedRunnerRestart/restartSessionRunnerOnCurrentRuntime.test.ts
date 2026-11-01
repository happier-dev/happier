import { describe, expect, it, vi } from 'vitest';

import { RestartAllSessionRunnersResultV1Schema, RestartSessionRunnerResultV1Schema } from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

import { createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import { resolveSessionRunnerActivityDisabledReason } from '../sessionRunnerRuntime/resolveActivityDisabledReason';
import {
  restartAllSessionRunnersOnCurrentRuntime,
  restartSessionRunnerOnCurrentRuntime,
} from './restartSessionRunnerOnCurrentRuntime';

function currentIdentity(version: string): SessionRunnerEntrypointIdentity {
  return {
    status: 'known',
    source: 'launch_spec',
    comparableId: `version:${version}`,
    entrypointVersion: version,
  };
}

function unknownCurrentIdentity(): SessionRunnerEntrypointIdentity {
  return { status: 'unknown', source: 'unknown', reason: 'entrypoint_not_found' };
}

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
    vendorResumeId: 'claude-thread-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
    ...overrides,
  };
}

describe('restartSessionRunnerOnCurrentRuntime', () => {
  it('requests a version runtime refresh for stale eligible runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'restarted',
      sessionId: 'sess-1',
    }));
    expect(RestartSessionRunnerResultV1Schema.parse(result)).toEqual(result);
    expect(requestRestart).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      tracked: expect.objectContaining({ pid: 4242 }),
      reason: 'version_runtime_refresh',
    });
  });

  it('includes the replacement runner summary when respawn completion is reported', async () => {
    const requestRestart = vi.fn(async () => ({
      signaled: true,
      completion: {
        ok: true as const,
        next: {
          pid: 5252,
          cliVersion: '0.2.11',
          entrypointVersion: '0.2.11',
          processCommandHash: 'hash-new',
        },
      },
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'restarted',
      previous: expect.objectContaining({ pid: 4242, processCommandHash: 'hash-1' }),
      next: expect.objectContaining({ pid: 5252, processCommandHash: 'hash-new' }),
    }));
    expect(RestartSessionRunnerResultV1Schema.parse(result)).toEqual(result);
  });

  it('returns a typed failure when respawn completion reports a terminal failure', async () => {
    const requestRestart = vi.fn(async () => ({
      signaled: true,
      completion: {
        ok: false as const,
        status: 'spawn_failed' as const,
        reasonCode: 'missing_credentials' as const,
        diagnostics: { respawnTerminalReason: 'not_authenticated' },
      },
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'spawn_failed',
      reasonCode: 'missing_credentials',
      previous: expect.objectContaining({ pid: 4242 }),
      diagnostics: { respawnTerminalReason: 'not_authenticated' },
    }));
    expect(RestartSessionRunnerResultV1Schema.parse(result)).toEqual(result);
  });

  it('does not restart unknown runner identity in if_stale mode', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({ processCommand: 'node --happy-starting-mode remote' }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'version_unknown',
      reasonCode: 'runner_entrypoint_unknown',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('only force-restarts unknown runner identity when explicitly requested and current identity is known', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({ processCommand: 'node --happy-starting-mode remote' }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('restarted');
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('does not restart when the runner starting mode cannot be proven remote', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --started-by daemon',
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'not_remote_started',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not signal while the runner has in-flight activity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      resolveActivityDisabledReason: () => 'turn_in_progress',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'busy',
      reasonCode: 'turn_in_progress',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not signal an unconfirmed restart while the server projects background activity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      readServerRuntimeActivity: async () => ({ runtimeActivityState: 'active', runtimeActivityActiveCount: 2 }),
    });

    expect(result).toEqual({
      ok: false,
      status: 'busy',
      sessionId: 'sess-1',
      reasonCode: 'turn_in_progress',
    });
    expect(RestartSessionRunnerResultV1Schema.parse(result)).toEqual(result);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('previews an unconfirmed dry run as busy while the server projects background activity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
        dryRun: true,
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      readServerRuntimeActivity: async () => ({ runtimeActivityState: 'active', runtimeActivityActiveCount: 1 }),
    });

    expect(result).toEqual({ ok: false, status: 'busy', sessionId: 'sess-1', reasonCode: 'turn_in_progress' });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('restarts an unconfirmed request when the server projects no background activity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'doctor_repair',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      readServerRuntimeActivity: async () => ({ runtimeActivityState: 'idle', runtimeActivityActiveCount: 0 }),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'restarted' }));
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('lets the UI-confirmed stale-runner banner restart through background activity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const readServerRuntimeActivity = vi.fn(async () => ({
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      readServerRuntimeActivity,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'restarted' }));
    expect(readServerRuntimeActivity).not.toHaveBeenCalled();
  });

  it('does not signal an unconfirmed restart when the server activity read fails', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      readServerRuntimeActivity: async () => {
        throw new Error('server unavailable');
      },
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, status: 'busy', reasonCode: 'turn_in_progress' }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not force-restart when the current daemon entrypoint is unknown', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: unknownCurrentIdentity(),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'version_unknown',
      reasonCode: 'current_entrypoint_unknown',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not restart daemon-started local mode runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode local --started-by daemon',
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'not_remote_started',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not restart Windows-hosted runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const base = trackedSession();
    if (!base.spawnOptions) throw new Error('Expected spawn options fixture');

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({
        spawnOptions: {
          ...base.spawnOptions,
          windowsRemoteSessionLaunchMode: 'windows_terminal',
        },
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'windows_hosted_runner',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('returns typed unsupported for terminal-host refresh without a bound attachment identity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const base = trackedSession();
    if (!base.spawnOptions) throw new Error('Expected spawn options fixture');

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedSession({
        spawnOptions: {
          ...base.spawnOptions,
          terminal: { mode: 'tmux', tmux: { sessionName: 'happy' } },
        },
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      readTerminalAttachmentInfo: async () => ({
        version: 1,
        sessionId: 'sess-1',
        terminal: { mode: 'tmux', tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'non_destructive_refresh_unsupported',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('allows manual refresh only when the terminal host exposes bound non-destructive identity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const base = trackedSession();
    if (!base.spawnOptions) throw new Error('Expected spawn options fixture');
    const handle = {
      attachmentId: 'attachment-refresh-1' as NonNullable<TerminalHostHandle['attachmentId']>,
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'owned-window',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    } satisfies TerminalHostHandle;

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedSession({
        spawnOptions: {
          ...base.spawnOptions,
          terminal: { mode: 'tmux', tmux: { sessionName: 'happy' } },
        },
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId!,
        sessionId: 'sess-1',
        handle: handle as TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> },
        terminal: { mode: 'tmux', tmux: { target: 'happy:owned-window' } },
        updatedAt: 1,
      }),
    });

    expect(result.status).toBe('restarted');
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('fails idempotently when expected PID or command hash no longer matches', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'ui_stale_runner_banner',
        expectedRunnerPid: 9999,
        expectedProcessCommandHash: 'hash-1',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('runner_identity_changed');
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('reports runner identity changed when the planned restart signal guard rejects the current pid', async () => {
    const requestRestart = vi.fn(async () => ({
      signaled: false,
      notSignaledReason: 'unsafe_process' as const,
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'runner_identity_changed',
    }));
  });

  it('reports the exact busy reason when the planned restart signal guard rejects for activity', async () => {
    const requestRestart = vi.fn(async () => ({
      signaled: false,
      notSignaledReason: 'activity_in_progress' as const,
      activityDisabledReason: 'approval_pending' as const,
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'busy',
      reasonCode: 'approval_pending',
    }));
  });

  it('rolls a stale idle pinned-snapshot runner onto the current snapshot generation', async () => {
    // 2026-07-10 zero-roll defect shape (live-observed): runner on snapshot 2ee2ef1b…,
    // daemon pinned to snapshot 30bb29f6…. if_stale must restart, not skip version_unknown.
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_dist_generation_rollout',
      },
      tracked: trackedSession({
        processCommand:
          'node --no-warnings --no-deprecation /Users/alice/dev/happier/apps/cli/.runner-snapshots/2ee2ef1b2f776a89/index.mjs claude --happy-starting-mode remote --started-by daemon',
      }),
      currentIdentity: {
        status: 'known',
        source: 'launch_spec',
        comparableId: 'snapshot:30bb29f6afae521d',
        entrypointVersion: null,
      },
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'restarted', sessionId: 'sess-1' }));
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('classifies a frozen tsx source-mode runner as stale and rolls it onto the current snapshot', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_dist_generation_rollout',
      },
      tracked: trackedSession({
        processCommand:
          'node --import /Users/alice/dev/happier/node_modules/tsx/dist/esm/index.mjs /Users/alice/dev/happier/apps/cli/src/index.ts codex --happy-starting-mode remote --started-by daemon',
      }),
      currentIdentity: {
        status: 'known',
        source: 'launch_spec',
        comparableId: 'snapshot:30bb29f6afae521d',
        entrypointVersion: null,
      },
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'restarted' }));
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('never reports already_current for equal mutable source paths in if_stale mode', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_dist_generation_rollout',
      },
      tracked: trackedSession({
        processCommand:
          'node --import /Users/alice/dev/happier/node_modules/tsx/dist/esm/index.mjs /Users/alice/dev/happier/apps/cli/src/index.ts codex --happy-starting-mode remote --started-by daemon',
      }),
      currentIdentity: {
        status: 'known',
        source: 'launch_spec',
        comparableId: 'path:/users/alice/dev/happier/apps/cli',
        entrypointVersion: null,
      },
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'version_unknown',
      reasonCode: 'runner_generation_unattested',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('treats a session whose last turn lifecycle event is terminal as NOT busy and rolls it', async () => {
    // Interlock with the stuck-thinking latch: busyness must come from genuine turn-in-flight
    // lifecycle state (terminal event wins), never from a latched presence flag.
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_dist_generation_rollout',
      },
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/dev/happier/apps/cli/.runner-snapshots/2ee2ef1b2f776a89/index.mjs claude --happy-starting-mode remote --started-by daemon',
      }),
      currentIdentity: {
        status: 'known',
        source: 'launch_spec',
        comparableId: 'snapshot:30bb29f6afae521d',
        entrypointVersion: null,
      },
      requestRestart,
      resolveActivityDisabledReason: (sessionId) =>
        resolveSessionRunnerActivityDisabledReason(sessionId, {
          isTurnInProgress: (id) => queue.isTurnInFlight(id),
        }),
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'restarted' }));
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('skips a genuinely mid-turn stale runner as busy with the turn_in_progress reason', async () => {
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_dist_generation_rollout',
      },
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/dev/happier/apps/cli/.runner-snapshots/2ee2ef1b2f776a89/index.mjs claude --happy-starting-mode remote --started-by daemon',
      }),
      currentIdentity: {
        status: 'known',
        source: 'launch_spec',
        comparableId: 'snapshot:30bb29f6afae521d',
        entrypointVersion: null,
      },
      requestRestart,
      resolveActivityDisabledReason: (sessionId) =>
        resolveSessionRunnerActivityDisabledReason(sessionId, {
          isTurnInProgress: (id) => queue.isTurnInFlight(id),
        }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'busy',
      reasonCode: 'turn_in_progress',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('supports dry-run without signalling the runner', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        dryRun: true,
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('dry_run_restartable');
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('refreshes a missing tracked resume identity before deciding restart eligibility', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const tracked = trackedSession({
      vendorResumeId: undefined,
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      },
    });
    const refreshTrackedSessionRuntimeSnapshot = vi.fn(async () => {
      tracked.vendorResumeId = 'codex-thread-from-persisted-metadata';
    });

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        dryRun: true,
        reason: 'daemon_restart_session_runners_command',
      },
      tracked,
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      refreshTrackedSessionRuntimeSnapshot,
    });

    expect(refreshTrackedSessionRuntimeSnapshot).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'sess-1',
      tracked,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'dry_run_restartable',
      sessionId: 'sess-1',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });
});

describe('restartAllSessionRunnersOnCurrentRuntime', () => {
  it('threads bulk dry-run into each per-session restart check without signaling runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartAllSessionRunnersOnCurrentRuntime({
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
      dryRun: true,
      currentIdentity: currentIdentity('0.2.11'),
      trackedSessions: [
        trackedSession({ happySessionId: 'sess-1', pid: 4242 }),
        trackedSession({ happySessionId: 'sess-2', pid: 4243 }),
      ],
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      requestedCount: 2,
      restartedCount: 2,
      skippedCount: 0,
      failedCount: 0,
    }));
    expect(result.results.map((entry) => entry.status)).toEqual(['dry_run_restartable', 'dry_run_restartable']);
    expect(RestartAllSessionRunnersResultV1Schema.parse(result)).toEqual(result);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('omits tracked runners without session ids from the protocol aggregate', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartAllSessionRunnersOnCurrentRuntime({
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
      dryRun: true,
      currentIdentity: currentIdentity('0.2.11'),
      trackedSessions: [
        trackedSession({ happySessionId: 'sess-1', pid: 4242 }),
        trackedSession({ happySessionId: undefined, pid: 4243 }),
      ],
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      requestedCount: 1,
      restartedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual(expect.objectContaining({ sessionId: 'sess-1' }));
    expect(RestartAllSessionRunnersResultV1Schema.parse(result)).toEqual(result);
    expect(requestRestart).not.toHaveBeenCalled();
  });
});
