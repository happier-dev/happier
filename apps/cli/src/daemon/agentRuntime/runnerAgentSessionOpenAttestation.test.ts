import { describe, expect, it, vi } from 'vitest';

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
    immutableGenerationId: `sha256:${'1'.repeat(64)}`,
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
    runnerAgentImmutableGenerationId:
      binding.immutableGenerationId,
    processStartTimeMs: runner.processStartTimeMs,
    processCommandHash: runner.processCommandHash,
    agentRuntimeDaemonServiceAuthorityFilePath:
      '/private/current-authority.json',
  };
  return { runner, binding, tracked };
}

describe('runner-owned Agent session-open attestation', () => {
  it('keeps a validated prepare out of opened currentness until commit', async () => {
    const { runner, binding, tracked } = createFixture();
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
