import { describe, expect, it, vi } from 'vitest';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';

import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from './executionRunTypes';
import { resolveExecutionRunLifecycle } from './resolveExecutionRunLifecycle';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

function run(overrides: Partial<ExecutionRunState> = {}): ExecutionRunState {
  return {
    runId: 'run-1',
    callId: 'call-1',
    sidechainId: 'sidechain-1',
    sessionId: null,
    depth: 0,
    intent: 'agent',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: 'Work.',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'succeeded',
    startedAtMs: 1,
    finishedAtMs: 2,
    resumeHandle: {
      kind: 'provider_session.v1',
      backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'codex' }),
      providerSessionId: 'provider-session-1',
    },
    ...overrides,
  };
}

describe('resolveExecutionRunLifecycle', () => {
  it.each(['failed', 'succeeded', 'cancelled', 'timeout'] as const)('keeps %s recovery explicit while projecting its retained checkpoint', status => {
    const retained = run({ status, runClass: 'long_lived' });
    expect(resolveExecutionRunLifecycle(retained, null).projection.state).toBe('recoverable');
    expect(resolveExecutionRunLifecycle(retained, null, 'input')).toMatchObject({
      projection: { state: 'unavailable' }, unavailableReason: 'explicit_resume_required',
    });
    const controller = { kind: 'backend', cancelled: false } as never as ExecutionRunController;
    expect(resolveExecutionRunLifecycle(retained, controller, 'input').projection.state).toBe('unavailable');
    expect(resolveExecutionRunLifecycle({ ...retained, status: 'running' }, controller, 'input').projection.state).toBe('current');
    expect(resolveExecutionRunLifecycle({ ...retained, status: 'running' }, null, 'input').projection.state).toBe('recoverable');
  });
  it('distinguishes a current controller from controller-less recovery', () => {
    const controller = { kind: 'backend', cancelled: false } as never as ExecutionRunController;
    expect(resolveExecutionRunLifecycle(run({ status: 'running' }), controller).projection)
      .toEqual({ v: 1, state: 'current' });
    expect(resolveExecutionRunLifecycle(run(), null).projection)
      .toEqual({ v: 1, state: 'recoverable_with_input' });
  });

  it('allows open-only recovery only for long-lived runs', () => {
    expect(resolveExecutionRunLifecycle(run({ runClass: 'long_lived' }), null).projection)
      .toEqual({ v: 1, state: 'recoverable' });
  });

  it('does not present a definitively missing provider session as recoverable', () => {
    expect(resolveExecutionRunLifecycle(run({
      error: { code: 'execution_run_provider_state_missing', message: 'Provider session state is missing' },
    }), null)).toEqual({
      projection: { v: 1, state: 'unavailable' },
      unavailableReason: 'provider_state_missing',
    });
    expect(resolveExecutionRunLifecycle(run({
      error: { code: 'execution_run_failed', message: 'Transport unavailable' },
    }), null).projection.state).toBe('recoverable_with_input');
  });

  it('fails closed when retention or the exact backend-bound handle cannot prove recovery', () => {
    expect(resolveExecutionRunLifecycle(run({ retentionPolicy: 'ephemeral' }), null))
      .toMatchObject({ projection: { v: 1, state: 'unavailable' }, unavailableReason: 'not_resumable' });
    expect(resolveExecutionRunLifecycle(run({
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'claude' }),
        providerSessionId: 'provider-session-1',
      },
    }), null)).toMatchObject({
      projection: { v: 1, state: 'unavailable' },
      unavailableReason: 'missing_resume_handle',
    });
  });
});
