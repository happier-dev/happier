import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import type { PlannedRunnerRestartSignalGateResult } from './types';
import {
  restartAllSessionRunnersOnCurrentRuntime,
  restartSessionRunnerOnCurrentRuntime,
} from './restartSessionRunnerOnCurrentRuntime';

const CURRENT_CLI_IDENTITY = {
  status: 'known',
  source: 'launch_spec',
  comparableId: 'version:0.2.10',
  entrypointVersion: '0.2.10',
} satisfies SessionRunnerEntrypointIdentity;

function trackedRunner(): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    processStartTimeMs: 12_345,
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon',
    vendorResumeId: 'codex-thread-1',
    runnerAgentImmutableGenerationId: 'generation-g',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      resume: 'codex-thread-1',
    } satisfies SpawnSessionOptions,
  };
}

describe('restartSessionRunnerOnCurrentRuntime retained Agent generation gate', () => {
  it('safe-restarts same-CLI older Agent code instead of reporting already current', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedRunner(),
      currentIdentity: CURRENT_CLI_IDENTITY,
      agentRuntimeVersionState: 'stale',
      requestRestart,
    });

    expect(result.status).toBe('restarted');
    expect(requestRestart).toHaveBeenCalledOnce();
  });

  it('keeps same-CLI stale state busy without signaling or queueing a restart', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedRunner(),
      currentIdentity: CURRENT_CLI_IDENTITY,
      agentRuntimeVersionState: 'stale',
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

  it('keeps retained runtime custody alive when an Agent or required Provider is unavailable for restart-to-current', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedRunner(),
      currentIdentity: CURRENT_CLI_IDENTITY,
      agentRuntimeVersionState: 'stale',
      agentRuntimeRestartUnavailableReason: 'unsupported_backend',
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'unsupported_backend',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('rechecks combined Agent/Provider currentness at the signal gate and does not terminate retained code after contribution removal', async () => {
    const signal = vi.fn();
    const requestRestart = vi.fn(async (input: Readonly<{
      canSignal?: () => PlannedRunnerRestartSignalGateResult | Promise<PlannedRunnerRestartSignalGateResult>;
    }>) => {
      const gate = await input.canSignal?.();
      if (gate === true) {
        signal();
        return { signaled: true };
      }
      return {
        signaled: false,
        notSignaledReason:
          typeof gate === 'string' ? gate : 'activity_in_progress',
      } as const;
    });
    const resolveAgentRuntimeCurrentness = vi.fn(async () => ({
      versionState: 'stale' as const,
      restartUnavailableReason: 'unsupported_backend' as const,
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedRunner(),
      currentIdentity: CURRENT_CLI_IDENTITY,
      agentRuntimeVersionState: 'stale',
      requestRestart,
      resolveAgentRuntimeCurrentness,
    });

    expect(resolveAgentRuntimeCurrentness).toHaveBeenCalledOnce();
    expect(signal).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'unsupported_backend',
    }));
  });

  it('applies the same Agent currentness gate to bulk restart', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const resolveAgentRuntimeCurrentness = vi.fn(async () => ({
      versionState: 'stale' as const,
      restartUnavailableReason: null,
    }));

    const result = await restartAllSessionRunnersOnCurrentRuntime({
      mode: 'if_stale',
      reason: 'daemon_restart_session_runners_command',
      dryRun: false,
      currentIdentity: CURRENT_CLI_IDENTITY,
      trackedSessions: [trackedRunner()],
      requestRestart,
      resolveAgentRuntimeCurrentness,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ status: 'restarted', sessionId: 'sess-1' }),
    ]);
    expect(resolveAgentRuntimeCurrentness).toHaveBeenCalledOnce();
    expect(requestRestart).toHaveBeenCalledOnce();
  });
});
