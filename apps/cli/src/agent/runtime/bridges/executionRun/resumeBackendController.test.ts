import { describe, expect, it, vi } from 'vitest';

// The publication fixture imports fs; load it before replacing that OS boundary.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
  import('@/plugins/projection/registry/builtIn/locators.testkit')
));

import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { captureExecutionRunResumeMaterialization, resumeBackendControllerForResumableRun,
  type ExecutionRunResumeMaterializationAuthority } from '@/agent/runtime/bridges/executionRun/resumeBackendController';
import { createTestExecutionRunHostRuntime } from './testkit/runtime';
import { startExecutionRun } from './startExecutionRun';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { resolveExecutionRunLifecycle } from './resolveExecutionRunLifecycle';
import { ExecutionRunConnectedServicesError } from './runtime/connectedServicesEnv';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return createBundledPluginPublicationFsFixture(actual);
});

describe('resumeBackendControllerForResumableRun', () => {
  it('admits only one concurrent resume occurrence for the same run', async () => {
    let releaseResumeSupport!: () => void;
    const resumeSupportGate = new Promise<void>((resolve) => {
      releaseResumeSupport = resolve;
    });
    let runtimeCount = 0;
    let provisionCount = 0;
    const run: ExecutionRunState = {
      runId: 'run_concurrent',
      callId: 'call_concurrent',
      sidechainId: 'sidechain_concurrent',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'failed',
      startedAtMs: 1,
      error: { code: 'provider_usage_exhausted', runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed',
        code: 'usage_limit', source: 'usage_limit', occurredAt: 1,
        usageLimit: { v: 1, resetAtMs: 42_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } } },
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
    };
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();
    const materializationAuthorities: ExecutionRunResumeMaterializationAuthority[] = [];
    const common = {
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => {
        runtimeCount += 1;
        return createTestExecutionRunHostRuntime({
          readResumeSupport: async () => {
            await resumeSupportGate;
            return true;
          },
          provisionRuntime: async () => {
            provisionCount += 1;
            const controller = controllers.get(run.runId);
            const authority = captureExecutionRunResumeMaterialization({ runId: run.runId,
              occurrenceId: controller.controllerOccurrenceId, controllers });
            expect(authority).not.toBeNull();
            if (authority) materializationAuthorities.push(authority);
            return { runtimeId: `runtime_${runtimeCount}` };
          },
        }).runtime;
      },
      sendAcp: async () => undefined,
      parentProvider: 'codex' as const,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    };

    const first = resumeBackendControllerForResumableRun(common);
    await Promise.resolve();
    const second = resumeBackendControllerForResumableRun(common);
    releaseResumeSupport();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ ok: true });
    expect(secondResult).toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      resumeFailureKind: 'indeterminate',
    });
    expect(runtimeCount).toBe(1);
    expect(provisionCount).toBe(1);
    expect(controllers.get(run.runId)?.kind).toBe('backend');
    expect(runs.get(run.runId)?.error).toBeUndefined();
    const authority = materializationAuthorities[0];
    expect(captureExecutionRunResumeMaterialization({ runId: run.runId,
      occurrenceId: authority.occurrenceId, controllers })).toBeNull();
    expect(authority.isCurrent()).toBe(true);
    controllers.get(run.runId)!.cancelled = true;
    expect(authority.isCurrent()).toBe(false);
  });

  it('retires a provisioned runtime when the exact resume occurrence was stopped before provisioning settled', async () => {
    let releaseProvision!: () => void;
    let provisionStarted!: () => void;
    const provisionStartedPromise = new Promise<void>((resolve) => {
      provisionStarted = resolve;
    });
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const cancelledRuntimeIds: string[] = [];
    const runtimeHarness = createTestExecutionRunHostRuntime({
      readResumeSupport: async () => true,
      provisionRuntime: async () => {
        provisionStarted();
        await provisionGate;
        return { runtimeId: 'late_runtime' };
      },
      cancel: async (runtimeId) => {
        cancelledRuntimeIds.push(runtimeId);
      },
    });
    const run: ExecutionRunState = {
      runId: 'run_stopped',
      callId: 'call_stopped',
      sidechainId: 'sidechain_stopped',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'running',
      startedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
    };
    const stoppedRun = { ...run, status: 'cancelled' as const, finishedAtMs: 2 };
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();
    const publicUpdates: string[] = [];

    const resultPromise = resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtimeHarness.runtime,
      sendAcp: async () => undefined,
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
      onPublicStateUpdated: (runId) => publicUpdates.push(runId),
    });
    await provisionStartedPromise;
    const provisionalController = controllers.get(run.runId);
    expect(provisionalController?.kind).toBe('backend');
    if (!provisionalController) throw new Error('resume controller was not registered');
    provisionalController.cancelled = true;
    controllers.delete(run.runId);
    runs.set(run.runId, stoppedRun);
    releaseProvision();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      resumeFailureKind: 'indeterminate',
    });
    expect(runs.get(run.runId)).toBe(stoppedRun);
    expect(cancelledRuntimeIds).toEqual(['late_runtime']);
    expect(publicUpdates).toEqual([]);
  });

  it('releases only the superseded resume occurrence budget after late provisioning settles', async () => {
    let releaseProvision!: () => void;
    let provisionStarted!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStartedPromise = new Promise<void>((resolve) => {
      provisionStarted = resolve;
    });
    const cancelledRuntimeIds: string[] = [];
    const runtime = createTestExecutionRunHostRuntime({
      readResumeSupport: async () => true,
      provisionRuntime: async () => {
        provisionStarted();
        await provisionGate;
        return { runtimeId: 'superseded_runtime' };
      },
      cancel: async (runtimeId) => {
        cancelledRuntimeIds.push(runtimeId);
      },
    }).runtime;
    const run: ExecutionRunState = {
      runId: 'run_superseded_budget',
      callId: 'call_superseded_budget',
      sidechainId: 'sidechain_superseded_budget',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'cancelled',
      startedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
    };
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();
    const budgetRegistry = new ExecutionBudgetRegistry();

    const resultPromise = resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry,
      createRuntime: () => runtime,
      sendAcp: async () => undefined,
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    });
    await provisionStartedPromise;
    expect(budgetRegistry.getInFlightSnapshot().executionRuns).toBe(1);

    runs.set(run.runId, { ...run, summary: 'superseded occurrence' });
    releaseProvision();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      resumeFailureKind: 'indeterminate',
    });
    expect(cancelledRuntimeIds).toEqual(['superseded_runtime']);
    expect(controllers.has(run.runId)).toBe(false);
    expect(budgetRegistry.getInFlightSnapshot().executionRuns).toBe(0);
  });

  it.each(['native', 'materialized'] as const)('distinguishes a %s permanent resume refusal from a transient provision failure', async (source) => {
    const run: ExecutionRunState = {
      runId: 'run_resume_classification',
      callId: 'call_resume_classification',
      sidechainId: 'sidechain_resume_classification',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      status: 'running',
      startedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
    };
    const common = {
      runId: run.runId,
      run,
      budgetRegistry: null,
      sendAcp: async () => undefined,
      parentProvider: 'codex' as const,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    };

    const permanentlyUnsupported = await resumeBackendControllerForResumableRun({
      ...common,
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      createRuntime: () => createTestExecutionRunHostRuntime({
        readResumeSupport: async () => false,
      }).runtime,
    });
    expect(permanentlyUnsupported).toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      resumeFailureKind: 'permanent',
    });

    const transientFailure = await resumeBackendControllerForResumableRun({
      ...common,
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      createRuntime: () => createTestExecutionRunHostRuntime({
        readResumeSupport: async () => true,
        provisionRuntime: async () => {
          throw new ExecutionRunConnectedServicesError('transport unavailable', 'connected_service_run_materialization_blocked');
        },
      }).runtime,
    });
    expect(transientFailure).toMatchObject({
      ok: false,
      errorCode: 'connected_service_run_materialization_blocked',
      resumeFailureKind: 'indeterminate',
    });

    const missingRuns = new Map([[run.runId, run]]);
    const missingControllers = new Map();
    const missingProviderState = await resumeBackendControllerForResumableRun({
      ...common,
      runs: missingRuns,
      controllers: missingControllers,
      createRuntime: () => createTestExecutionRunHostRuntime({
        readResumeSupport: async () => true,
        provisionRuntime: async (opts) => {
          expect(opts?.resumeRuntimeId).toBe('vendor_session_1');
          if (source === 'materialized') throw new ExecutionRunConnectedServicesError(
            'Restore the native conversation or start a new conversation from the saved result.',
            'provider_session_state_unavailable_for_resume',
          );
          throw Object.assign(new Error('Provider session state is missing'), {
            code: 'AGENT_RESUME_PROVIDER_STATE_MISSING',
          });
        },
      }).runtime,
    });
    expect(missingProviderState).toMatchObject({
      ok: false,
      errorCode: 'execution_run_provider_state_missing',
      resumeFailureKind: 'permanent',
    });
    expect(missingControllers.has(run.runId)).toBe(false);
    expect(missingRuns.get(run.runId)?.resumeHandle).toEqual(run.resumeHandle);
    expect(missingRuns.get(run.runId)?.error?.code).toBe('execution_run_provider_state_missing');
    expect(resolveExecutionRunLifecycle(missingRuns.get(run.runId)!, null).projection.state).toBe('unavailable');
  });

  it('persists a cloned runtime account settings snapshot when starting a run', async () => {
    const runtime = createTestExecutionRunHostRuntime().runtime;
    const accountSettings: Record<string, unknown> = {
      customExecutionRunRuntimeSettings: {
        mode: 'start-time',
      },
    };
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by this test');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          accountSettings,
          instructions: '',
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: 'codex',
        sendAcp: async () => undefined,
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers: new Map(),
        enqueueMarkerWrite: async () => undefined,
        writeActivityMarker: async () => undefined,
        finishRun: async () => undefined,
        executeBoundedRun: async () => undefined,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      (accountSettings.customExecutionRunRuntimeSettings as Record<string, unknown>).mode = 'current-settings';

      expect(runs.get(started.runId)?.runtimeSettings?.accountSettings).toEqual({
        customExecutionRunRuntimeSettings: {
          mode: 'start-time',
        },
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('resumes through the runtime provisioner when replay capture is not requested', async () => {
    let disposed = false;
    const runtime = createTestExecutionRunHostRuntime({
      async provisionRuntime(opts) {
        return { runtimeId: opts?.resumeRuntimeId ? 'runtime_2' : 'runtime_1' };
      },
      async dispose() {
        disposed = true;
      },
    }).runtime;

    const run: ExecutionRunState = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'sidechain_1',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'cancelled',
      startedAtMs: 1_700_000_000_000,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
    };

    const controllers = new Map();
    const runs = new Map([[run.runId, run]]);
    const res = await resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: (_opts) => runtime,
      sendAcp: async () => undefined,
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    });

    expect(res).toEqual({ ok: true });
    expect(disposed).toBe(false);
    expect(runs.get(run.runId)?.status).toBe('running');
    expect(controllers.has(run.runId)).toBe(true);
  });

  it('attaches a retained Session input consumer after a resumed backend is provisioned', async () => {
    const harness = createTestExecutionRunHostRuntime({
      provisionRuntime: async (opts) => ({
        runtimeId: opts?.resumeRuntimeId ? 'runtime_resumed' : 'runtime_started',
      }),
    });
    const interaction: NonNullable<ExecutionRunHostRuntime['interaction']> = {
      kind: 'retained_agent_session.v1',
      capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
    };
    const runtime: ExecutionRunHostRuntime = Object.freeze({
      ...harness.runtime,
      interaction,
    });
    const run: ExecutionRunState = {
      runId: 'run_attach',
      callId: 'call_attach',
      sidechainId: 'sidechain_attach',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'cancelled',
      startedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
    };
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();
    const attached: Array<{ runId: string; sidechainId: string; controller: unknown }> = [];

    const result = await resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      sendAcp: async () => undefined,
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
      attachRetainedRunSessionInput: ({ runId, sidechainId, controller }) => {
        attached.push({ runId, sidechainId, controller });
        return null;
      },
    });

    expect(result).toEqual({ ok: true });
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ runId: run.runId, sidechainId: run.sidechainId });
    expect(attached[0]?.controller).toBe(controllers.get(run.runId));
  });

  it('passes persisted runtime account settings to the recreated backend runtime', async () => {
    const runtime = createTestExecutionRunHostRuntime({
      provisionRuntime: async (opts) => ({ runtimeId: opts?.resumeRuntimeId ? 'runtime_2' : 'runtime_1' }),
    }).runtime;
    const runtimeOptions: Array<Readonly<Record<string, unknown>>> = [];

    const run: ExecutionRunState & {
      runtimeSettings: {
        accountSettings: Readonly<Record<string, unknown>>;
      };
    } = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'sidechain_1',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'cancelled',
      startedAtMs: 1_700_000_000_000,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
      runtimeSettings: {
        accountSettings: {
          customExecutionRunRuntimeSettings: {
            mode: 'start-time',
          },
        },
      },
    };

    const controllers = new Map();
    const runs = new Map([[run.runId, run]]);
    const res = await resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: (opts) => {
        runtimeOptions.push({ ...opts });
        return runtime;
      },
      sendAcp: async () => undefined,
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    });

    expect(res).toEqual({ ok: true });
    expect(runtimeOptions[0]?.accountSettings).toEqual({
      customExecutionRunRuntimeSettings: {
        mode: 'start-time',
      },
    });
  });
});
