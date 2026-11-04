import { describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { PluginError } from '@happier-dev/plugin-sdk';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';

import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '@/daemon/types';

import {
  awaitTrackedRunnerAgentSessionOpen,
  recordTrackedRunnerAgentSessionOpenAttestation,
} from './runnerAgentSessionOpenAttestation';

function createFixture() {
  const runner = {
    pid: 4321,
    processStartTimeMs: 1_717_171_717_000,
    processCommandHash: 'a'.repeat(64),
    snapshotIdentity: 'snapshot:runner-open',
  };
  const binding = createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'acme.plugin',
    pluginVersion: '1.2.3',
    agentId: 'acme-agent',
    localAgentId: 'acme-agent',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: `sha256:${'1'.repeat(64)}`,
      installSource: 'localPath',
    },
    locator: {
      module: './runtime.mjs',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: '/immutable/acme/runtime.mjs',
    loadMode: 'immutable-js',
  });
  const tracked: TrackedSession = {
    startedBy: 'daemon',
    pid: runner.pid,
    happySessionId: 'session-child',
    runnerAgentSourceCustodyV1: binding.sourceCustody,
    processStartTimeMs: runner.processStartTimeMs,
    processCommandHash: runner.processCommandHash,
    agentRuntimeDaemonServiceAuthorityFilePath:
      '/private/current-authority.json',
  };
  return { runner, binding, tracked };
}

describe('runner-owned Agent session-open attestation', () => {
  it.each(['current', 'predecessor', 'malformed'] as const)('retains only the %s runner startup cause', async kind => {
    const { tracked, runner } = createFixture();
    tracked.childProcess = new ChildProcess();
    Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
    const failureCause = { code: 'agent_startup_failed', phase: 'client_start', failureReason: 'unclassified_provider_error' } as const;
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: new PluginError({ code: 'agent_startup_failed', message: 'PRIVATE_NATIVE_BODY', details: {
        failureCause: kind === 'malformed' ? { ...failureCause, path: '/PRIVATE_NATIVE_HOME' } : failureCause,
      } }), occurredAt: runner.processStartTimeMs + (kind === 'predecessor' ? -1 : 1) });
    const result = await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'session-child',
      getTrackedSessions: () => [tracked], readStartupFailure: async () => issue, timeoutMs: null,
    });
    expect(result).toEqual(kind === 'predecessor' ? { status: 'runner_exited' }
      : { status: 'runner_exited', code: 'agent_startup_failed', ...(kind === 'current' ? { failureCause } : {}) });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
  });
  it.each(['current', 'predecessor'] as const)('attributes a broker startup cause only to its %s runner birth', async age => {
    const { tracked, runner } = createFixture();
    tracked.pid = runner.pid - 1;
    tracked.sessionRunnerPid = runner.pid;
    tracked.processStartTimeMs = runner.processStartTimeMs - 100;
    tracked.runnerProcessIdentity = runner;
    // The OS child-exit fact is the only substituted boundary.
    tracked.childProcess = new ChildProcess();
    Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: new SessionTeamCredentialLaunchUnavailableError('broker_unavailable'),
      occurredAt: runner.processStartTimeMs + (age === 'current' ? 1 : -1) });
    expect(await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'session-child',
      getTrackedSessions: () => [tracked], readStartupFailure: async () => issue, timeoutMs: null,
    })).toEqual(age === 'current' ? { status: 'runner_exited', code: 'broker_unavailable' } : { status: 'runner_exited' });
  });

  it('keeps a native fork attestation owned until a slow provider lifecycle commits it', async () => {
    vi.useFakeTimers();
    try {
      const { tracked } = createFixture();
      const request = {
        kind: 'fork' as const,
        sessionId: 'session-child',
        cwd: '/child',
        source: {
          sessionId: 'session-parent',
          providerSessionId: 'provider-parent',
          cwd: '/parent',
        },
      };
      const opened = awaitTrackedRunnerAgentSessionOpen({
        getTrackedSessions: () => [tracked],
        sessionId: 'session-child',
        // Native fork completion belongs to the provider-owned lifecycle. It
        // must not inherit the generic outer attestation deadline.
        timeoutMs: null,
      });

      setTimeout(() => {
        tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
          request,
          providerSessionId: 'provider-child',
        };
      }, 15_050);

      await vi.advanceTimersByTimeAsync(15_100);

      await expect(opened).resolves.toEqual({ status: 'opened', request });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an unbounded native-fork waiter when its previously tracked runner exits before attesting', async () => {
    vi.useFakeTimers();
    try {
      const { tracked } = createFixture();
      let trackedSessions: readonly TrackedSession[] = [tracked];
      let settled: unknown;
      void awaitTrackedRunnerAgentSessionOpen({
        getTrackedSessions: () => trackedSessions,
        sessionId: 'session-child',
        timeoutMs: null,
      }).then((result) => {
        settled = result;
      });

      await vi.advanceTimersByTimeAsync(25);
      trackedSessions = [];
      await vi.advanceTimersByTimeAsync(25);

      expect(settled).toEqual({ status: 'runner_exited' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an unbounded native-fork waiter with the operation abort reason without stopping the runner', async () => {
    vi.useFakeTimers();
    try {
      const { tracked } = createFixture();
      const controller = new AbortController();
      const abortError = Object.assign(new Error('Action operation cancelled'), {
        name: 'AbortError',
      });
      let outcome: unknown = 'pending';
      void awaitTrackedRunnerAgentSessionOpen({
        getTrackedSessions: () => [tracked],
        sessionId: 'session-child',
        timeoutMs: null,
        signal: controller.signal,
      }).then(
        (value) => { outcome = { kind: 'resolved', value }; },
        (error: unknown) => { outcome = { kind: 'rejected', error }; },
      );

      controller.abort(abortError);
      await vi.advanceTimersByTimeAsync(25);

      expect(outcome).toEqual({ kind: 'rejected', error: abortError });
      expect(tracked.childProcess?.exitCode).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a captured runner behind its wrapper out of opened currentness until commit', async () => {
    const { runner, binding, tracked } = createFixture();
    tracked.pid = runner.pid - 1;
    tracked.sessionRunnerPid = runner.pid;
    tracked.processStartTimeMs = runner.processStartTimeMs - 1;
    tracked.processCommandHash = 'b'.repeat(64);
    tracked.runnerProcessIdentity = { ...runner };
    const updateMarker = vi.fn(async () => true);
    const request = {
      kind: 'create' as const,
      sessionId: 'session-child',
      cwd: '/child',
    };

    await expect(recordTrackedRunnerAgentSessionOpenAttestation({
      tracked,
      runner,
      retainedAgent: binding,
      phase: 'prepare',
      request,
      providerSessionId: null,
      updateMarker,
    })).resolves.toEqual({
      request,
      providerSessionId: null,
    });
    expect(updateMarker).not.toHaveBeenCalled();
    await expect(awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => [tracked],
      sessionId: 'session-child',
      timeoutMs: 0,
    })).resolves.toEqual({ status: 'timeout' });

    await expect(recordTrackedRunnerAgentSessionOpenAttestation({
      tracked,
      runner,
      retainedAgent: binding,
      phase: 'commit',
      request,
      providerSessionId: null,
      updateMarker,
    })).resolves.toEqual({
      request,
      providerSessionId: null,
    });
    expect(updateMarker).toHaveBeenCalledOnce();
    expect(updateMarker).toHaveBeenCalledWith(expect.objectContaining({ pid: runner.pid }));
    await expect(awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => [tracked],
      sessionId: 'session-child',
      timeoutMs: 0,
    })).resolves.toEqual({
      status: 'opened',
      request,
    });
  });

  it('records and returns only the exact completed open under current runner/retained-Agent custody', async () => {
    const { runner, binding, tracked } = createFixture();
    const updateMarker = vi.fn(async () => true);
    const request = {
      kind: 'fork' as const,
      sessionId: 'session-child',
      cwd: '/child',
      source: {
        sessionId: 'session-parent',
        providerSessionId: 'provider-parent',
        cwd: '/parent',
        target: {
          turnId: 'turn-7',
          providerCheckpoint: {
            kind: 'prompt_index',
            promptIndex: 7,
          },
        },
      },
    };

    const attestation =
      await recordTrackedRunnerAgentSessionOpenAttestation({
        tracked,
        runner,
        retainedAgent: binding,
        request,
        providerSessionId: 'provider-child',
        updateMarker,
      });

    expect(attestation).toEqual({
      request,
      providerSessionId: 'provider-child',
    });
    expect(updateMarker).toHaveBeenCalledWith({
      pid: 4321,
      sessionId: 'session-child',
      authorityFilePath: '/private/current-authority.json',
      attestation,
    });
    await expect(awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => [tracked],
      sessionId: 'session-child',
      timeoutMs: 0,
    })).resolves.toEqual({
      status: 'opened',
      request,
    });
  });

  it('projects transient open fields away while retaining state-sharing policy in durable marker custody', async () => {
    const { runner, binding, tracked } = createFixture();
    const updateMarker = vi.fn(async () => true);
    const request = {
      kind: 'resume' as const,
      sessionId: 'session-child',
      cwd: '/child',
      providerSessionId: 'provider-child',
      strictNativeResumeIdentity: true,
      skills: {
        pluginRoot: 'C:\\happier\\skills\\session-child',
        skillsRoot: 'C:\\happier\\skills\\session-child\\skills',
        items: [],
        nativeDisables: [{ name: 'native-review', path: 'C:\\native\\review\\SKILL.md' }],
      },
      startupInstructions: {
        v: 1 as const,
        id: 'happier.bootstrap',
        revision: 1,
        instructions: 'Use the owner-provided startup instructions.',
      },
      stateSharing: {
        configMode: 'isolated' as const,
        stateMode: 'isolated' as const,
      },
    };
    const expectedRequest = {
      kind: request.kind,
      sessionId: request.sessionId,
      cwd: request.cwd,
      providerSessionId: request.providerSessionId,
      stateSharing: request.stateSharing,
    };

    await expect(recordTrackedRunnerAgentSessionOpenAttestation({
      tracked,
      runner,
      retainedAgent: binding,
      request,
      providerSessionId: 'provider-child',
      updateMarker,
    })).resolves.toEqual({
      request: expectedRequest,
      providerSessionId: 'provider-child',
    });
    expect(updateMarker).toHaveBeenCalledWith({
      pid: runner.pid,
      sessionId: request.sessionId,
      authorityFilePath: '/private/current-authority.json',
      attestation: {
        request: expectedRequest,
        providerSessionId: 'provider-child',
      },
    });
  });

  it.each(['current', 'foreign-runner', 'foreign-source', 'marker-refused'] as const)(
    'observes a refused native open only after exact runner custody is recorded (%s)', async mode => {
    const { runner, binding, tracked } = createFixture();
    const updateMarker = vi.fn(async () => mode !== 'marker-refused');
    const request = { kind: 'create' as const, sessionId: 'session-child', cwd: '/child' };
    if (mode === 'foreign-source') tracked.runnerAgentSourceCustodyV1 = {
      kind: 'managed', immutableGenerationId: `sha256:${'2'.repeat(64)}`, installSource: 'localPath' };
    const recorded = await recordTrackedRunnerAgentSessionOpenAttestation({ tracked, retainedAgent: binding,
      runner: mode === 'foreign-runner' ? { ...runner, pid: runner.pid + 1 } : runner,
      phase: 'refused', request, providerSessionId: null, updateMarker });
    expect(recorded).toEqual(mode === 'current' ? { request, providerSessionId: null,
      refusal: { code: 'native_agent_session_mode_unavailable' } } : null);
    expect(await awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked],
      sessionId: 'session-child', timeoutMs: 0 })).toEqual(mode === 'current'
      ? { status: 'refused', code: 'native_agent_session_mode_unavailable', expectedTrackedRunner: {
          tracked, sessionRunnerPid: tracked.sessionRunnerPid,
          processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash,
        } } : { status: 'timeout' });
  });

  it('fails closed before marker mutation on session or resume-provider mismatch', async () => {
    const { runner, binding, tracked } = createFixture();
    const updateMarker = vi.fn(async () => true);
    await expect(
      recordTrackedRunnerAgentSessionOpenAttestation({
        tracked,
        runner,
        retainedAgent: binding,
        request: {
          kind: 'resume',
          sessionId: 'session-child',
          cwd: '/child',
          providerSessionId: 'provider-expected',
        },
        providerSessionId: 'provider-foreign',
        updateMarker,
      }),
    ).resolves.toBeNull();
    await expect(
      recordTrackedRunnerAgentSessionOpenAttestation({
        tracked,
        runner,
        retainedAgent: binding,
        request: {
          kind: 'create',
          sessionId: 'session-foreign',
          cwd: '/child',
        },
        providerSessionId: null,
        updateMarker,
      }),
    ).resolves.toBeNull();
    expect(updateMarker).not.toHaveBeenCalled();
  });
});
