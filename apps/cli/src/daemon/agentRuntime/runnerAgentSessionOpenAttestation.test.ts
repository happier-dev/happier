import { describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { PluginError } from '@happier-dev/plugin-sdk';

import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '@/daemon/types';

import {
  awaitTrackedRunnerAgentSessionOpen,
  recordTrackedRunnerAgentSessionOpenAttestation,
} from './runnerAgentSessionOpenAttestation';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';

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
    trackingKey: legacyPidSessionTrackingKey(runner.pid), startedBy: 'daemon',
    pid: runner.pid,
    happySessionId: 'session-child',
    runnerAgentSourceCustodyV1: binding.sourceCustody,
    processStartTimeMs: runner.processStartTimeMs,
    processCommandHash: runner.processCommandHash,
    agentRuntimeDaemonServiceAuthorityFilePath:
      '/private/current-authority.json',
  };
  const changes = createSessionLiveWorkProducer({ readSessions: () => [tracked],
    readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
  return { runner, binding, tracked, changes,
    subscribeChanges: (listener: () => void) => changes.subscribe(listener, 'session-child') };
}

describe('runner-owned Agent session-open attestation', () => {
  it('observes a committed native open without recurring inventory reads while the provider is pending', async () => {
    vi.useFakeTimers();
    try {
      const { tracked, runner, binding } = createFixture();
      const source = createSessionLiveWorkProducer({ readSessions: () => [tracked],
        readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
      const getTrackedSessions = vi.fn(() => [tracked]);
      const request = { kind: 'create' as const, sessionId: 'session-child', cwd: '/child' };
      const opened = awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions,
        subscribeChanges: listener => source.subscribe(listener, 'session-child'), sessionId: 'session-child', timeoutMs: null });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(getTrackedSessions).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      for (let index = 0; index < 20; index += 1) source.notifySessionChanged(`unrelated-${index}`);
      await Promise.resolve();
      expect(getTrackedSessions).toHaveBeenCalledTimes(1);
      await recordTrackedRunnerAgentSessionOpenAttestation({ tracked, runner, retainedAgent: binding,
        request, providerSessionId: 'provider-child', updateMarker: async () => true,
        onRecorded: () => source.notifySessionChanged('session-child') });
      await expect(opened).resolves.toEqual({ status: 'opened', request });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['current', 'predecessor', 'malformed'] as const)('retains only the %s runner startup cause', async kind => {
    const { tracked, runner, subscribeChanges } = createFixture();
    tracked.childProcess = new ChildProcess();
    Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
    const failureCause = { code: 'agent_startup_failed', phase: 'client_start', failureReason: 'unclassified_provider_error' } as const;
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: new PluginError({ code: 'agent_startup_failed', message: 'PRIVATE_NATIVE_BODY', details: {
        failureCause: kind === 'malformed' ? { ...failureCause, path: '/PRIVATE_NATIVE_HOME' } : failureCause,
      } }), occurredAt: runner.processStartTimeMs + (kind === 'predecessor' ? -1 : 1) });
    const result = await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'session-child',
      getTrackedSessions: () => [tracked], subscribeChanges, readStartupFailure: async () => issue, timeoutMs: null,
    });
    expect(result).toEqual(kind === 'predecessor' ? { status: 'runner_exited' }
      : { status: 'runner_exited', code: 'agent_startup_failed', ...(kind === 'current' ? { failureCause } : {}) });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
  });
  it.each([
    ['broker_unavailable', 'current'], ['broker_unavailable', 'predecessor'],
    ['update_required', 'current'], ['team_credential_usage_limit', 'current'],
    ['team_credential_provider_selection_not_current', 'current'],
    ['provider_endpoint_unavailable', 'current'], ['provider_endpoint_unavailable', 'predecessor'],
    ['connected_service_credential_reconnect_required', 'current'],
    ['connected_service_credential_reconnect_required', 'predecessor'],
    ['provider_compatibility_unverified', 'current'], ['provider_compatibility_unverified', 'predecessor'],
    ['plugin_services_managed_provider_authority_unavailable', 'current'],
    ['agent_startup_transport_failed', 'current'],
    ['agent_isolation_unavailable', 'current'], ['agent_isolation_unavailable', 'predecessor'],
  ] as const)('attributes %s only to its %s runner birth', async (code, age) => {
    const { tracked, runner, subscribeChanges } = createFixture();
    tracked.pid = runner.pid - 1;
    tracked.sessionRunnerPid = runner.pid;
    tracked.processStartTimeMs = runner.processStartTimeMs - 100;
    tracked.runnerProcessIdentity = runner;
    // The OS child-exit fact is the only substituted boundary.
    tracked.childProcess = new ChildProcess();
    Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: code === 'plugin_services_managed_provider_authority_unavailable' || code === 'agent_startup_transport_failed'
        ? { code } : new SessionTeamCredentialLaunchUnavailableError(code),
      occurredAt: runner.processStartTimeMs + (age === 'current' ? 1 : -1) });
    expect(await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'session-child',
      getTrackedSessions: () => [tracked], subscribeChanges, readStartupFailure: async () => issue, timeoutMs: null,
    })).toEqual(age === 'current' ? { status: 'runner_exited', code,
      ...(issue?.failureCause ? { failureCause: issue.failureCause } : {}) } : { status: 'runner_exited' });
  });

  it.each([
    ['broker_unavailable', 'agent_session_error'],
    ['broker_unavailable', 'dependency_failure'],
    ['connected_service_credential_reconnect_required', 'auth_error'],
    ['provider_compatibility_unverified', 'team_credential'],
    ['provider_compatibility_unverified', 'auth_error'],
    ['agent_startup_transport_failed', 'team_credential'],
    ['agent_isolation_unavailable', 'team_credential'],
  ] as const)('does not attribute %s from foreign source %s to runner startup', async (code, source) => {
    const { tracked, runner, subscribeChanges } = createFixture();
    tracked.childProcess = new ChildProcess();
    Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: code === 'agent_startup_transport_failed' ? { code } : new SessionTeamCredentialLaunchUnavailableError(code),
      occurredAt: runner.processStartTimeMs + 1 });
    expect(issue).toMatchObject({ code });
    expect(await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'session-child',
      getTrackedSessions: () => [tracked], subscribeChanges, readStartupFailure: async () => ({ ...issue, source }), timeoutMs: null,
    })).toEqual({ status: 'runner_exited' });
  });

  it.each(['current', 'predecessor'] as const)('attributes a legitimate Provider reconnect only to its %s runner birth', async age => {
    const { tracked, runner, subscribeChanges } = createFixture();
    tracked.childProcess = new ChildProcess();
    Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
    const code = 'connected_service_credential_reconnect_required';
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: Object.assign(new Error(code), createProviderErrorV1(code)),
      occurredAt: runner.processStartTimeMs + (age === 'current' ? 1 : -1) });
    expect(issue).toMatchObject({ code, source: 'agent_session_error' });
    expect(await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'session-child',
      getTrackedSessions: () => [tracked], subscribeChanges, readStartupFailure: async () => issue, timeoutMs: null,
    })).toEqual(age === 'current' ? { status: 'runner_exited', code } : { status: 'runner_exited' });
  });

  it('does not attribute a failure after the tracked runner is rebound to a foreign Session', async () => {
    const { tracked, runner, subscribeChanges } = createFixture();
    tracked.childProcess = new ChildProcess();
    Object.defineProperty(tracked.childProcess, 'exitCode', { value: 1 });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: new SessionTeamCredentialLaunchUnavailableError('connected_service_credential_reconnect_required'),
      occurredAt: runner.processStartTimeMs + 1 });
    expect(await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'session-child',
      getTrackedSessions: () => [tracked], subscribeChanges, readStartupFailure: async () => {
        tracked.happySessionId = 'session-foreign';
        return issue;
      }, timeoutMs: null,
    })).toEqual({ status: 'runner_exited' });
  });

  it('keeps a native fork attestation owned until a slow provider lifecycle commits it', async () => {
    vi.useFakeTimers();
    try {
      const { tracked, subscribeChanges, changes } = createFixture();
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
        getTrackedSessions: () => [tracked], subscribeChanges,
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
        changes.notifySessionChanged('session-child');
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
      const { tracked, subscribeChanges, changes } = createFixture();
      let trackedSessions: readonly TrackedSession[] = [tracked];
      let settled: unknown;
      void awaitTrackedRunnerAgentSessionOpen({
        getTrackedSessions: () => trackedSessions, subscribeChanges,
        sessionId: 'session-child',
        timeoutMs: null,
      }).then((result) => {
        settled = result;
      });

      await vi.advanceTimersByTimeAsync(25);
      trackedSessions = [];
      changes.notifyChanged();
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toEqual({ status: 'runner_exited' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an unbounded native-fork waiter with the operation abort reason without stopping the runner', async () => {
    vi.useFakeTimers();
    try {
      const { tracked, subscribeChanges } = createFixture();
      const controller = new AbortController();
      const abortError = Object.assign(new Error('Action operation cancelled'), {
        name: 'AbortError',
      });
      let outcome: unknown = 'pending';
      void awaitTrackedRunnerAgentSessionOpen({
        getTrackedSessions: () => [tracked], subscribeChanges,
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
    const { runner, binding, tracked, subscribeChanges } = createFixture();
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
      getTrackedSessions: () => [tracked], subscribeChanges,
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
    expect(updateMarker).toHaveBeenCalledWith(expect.objectContaining({ trackingKey: tracked.trackingKey }));
    await expect(awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => [tracked], subscribeChanges,
      sessionId: 'session-child',
      timeoutMs: 0,
    })).resolves.toEqual({
      status: 'opened',
      request,
    });
  });

  it('records and returns only the exact completed open under current runner/retained-Agent custody', async () => {
    const { runner, binding, tracked, subscribeChanges } = createFixture();
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
      trackingKey: legacyPidSessionTrackingKey(4321),
      sessionId: 'session-child',
      authorityFilePath: '/private/current-authority.json',
      attestation,
    });
    await expect(awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => [tracked], subscribeChanges,
      sessionId: 'session-child',
      timeoutMs: 0,
    })).resolves.toEqual({
      status: 'opened',
      request,
    });
  });

  it('projects transient open fields away while retaining state-sharing policy in durable marker custody', async () => {
    const { runner, binding, tracked, subscribeChanges } = createFixture();
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
      trackingKey: legacyPidSessionTrackingKey(runner.pid),
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
    const { runner, binding, tracked, subscribeChanges } = createFixture();
    const updateMarker = vi.fn(async () => mode !== 'marker-refused');
    const request = { kind: 'create' as const, sessionId: 'session-child', cwd: '/child' };
    if (mode === 'foreign-source') tracked.runnerAgentSourceCustodyV1 = {
      kind: 'managed', immutableGenerationId: `sha256:${'2'.repeat(64)}`, installSource: 'localPath' };
    const recorded = await recordTrackedRunnerAgentSessionOpenAttestation({ tracked, retainedAgent: binding,
      runner: mode === 'foreign-runner' ? { ...runner, pid: runner.pid + 1 } : runner,
      phase: 'refused', request, providerSessionId: null, updateMarker });
    expect(recorded).toEqual(mode === 'current' ? { request, providerSessionId: null,
      refusal: { code: 'native_agent_session_mode_unavailable' } } : null);
    expect(await awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], subscribeChanges,
      sessionId: 'session-child', timeoutMs: 0 })).toEqual(mode === 'current'
      ? { status: 'refused', code: 'native_agent_session_mode_unavailable', expectedTrackedRunner: {
          tracked, sessionRunnerPid: tracked.sessionRunnerPid,
          processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash,
        } } : { status: 'timeout' });
  });

  it('fails closed before marker mutation on session or resume-provider mismatch', async () => {
    const { runner, binding, tracked, subscribeChanges } = createFixture();
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
