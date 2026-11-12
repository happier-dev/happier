import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import type {
  ExecutionRunInteractionV1,
  SessionInputAdmissionResultV1,
} from '@happier-dev/protocol';
import { waitForExecutionRunTerminal } from '@happier-dev/protocol';

import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

import { finishExecutionRun } from './finishExecutionRun';
import { startExecutionRun } from './startExecutionRun';
import { stopExecutionRun } from './executionRunStop';
import { sendBackendLongLivedRun } from './send/backendLongLivedPrompt';
import type { ExecutionRunState } from './executionRunTypes';
import { createTestExecutionRunHostRuntime } from './testkit';
import { ExecutionRunConnectedServicesError } from './runtime/connectedServicesEnv';
import { observeWorkflowDetachedExecutionRunInput } from '@/daemon/workflows/stepExecution';
import { projectExecutionRunPublicState } from './publicState';
import { ExecutionRunGetResponseSchema, isExecutionRunActive } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createExecutionRunOccurrenceWitnessRegistry, projectExecutionRunInputTurns } from './runOccurrenceWitness';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { createDeferred } from '@/testkit/async/deferred';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { admitDaemonExecutionRunStart } from '@/daemon/controlClient';
import { deriveConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/runs/capabilityToken';
import { createDaemonAdmissionDrain, EXECUTION_RUN_ADMISSION_PATH } from '@/daemon/lifecycle/admissionDrain';
import { createManagedActivityInventory, readMachineMaintenanceAdmission } from '@/daemon/lifecycle/managedActivity';

// Retained lifecycle and marker publication exercise real isolated filesystem custody.
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-start-custody-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
});
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

describe('execution run start transcript custody', () => {
  it('keeps pending daemon admission visible to maintenance without consuming run capacity', async () => {
    const drain = createDaemonAdmissionDrain();
    const requestReceived = createDeferred();
    const admissionReply = createDeferred();
    const controlToken = 'pending-admission-test';
    const app = createDaemonControlApp({
      getChildren: () => [], stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => { throw new Error('Run admission cannot spawn a Session'); },
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      controlToken, machineId: 'machine', admissionDrain: drain,
      verifyRunMaterializeToken: token => token === deriveConnectedServiceRunMaterializeToken(controlToken),
    });
    // Hold only the HTTP boundary; the actual client, route and drain decide admission.
    app.addHook('onRequest', async request => {
      if (request.url === EXECUTION_RUN_ADMISSION_PATH) {
        requestReceived.resolve();
        await admissionReply.promise;
      }
    });
    const budgetRegistry = new ExecutionBudgetRegistry();
    const inventory = createManagedActivityInventory({ producers: [budgetRegistry.getLiveWorkProducer()] });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => {
      throw new Error('Refused admission cannot create a native runtime');
    } });
    let releaseDrain: (() => void) | undefined;
    let rejected: Promise<void> | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected daemon control listener');
      expect(await readMachineMaintenanceAdmission(inventory)).toEqual({ kind: 'eligible' });
      rejected = expect(startExecutionRun({
        params: { sessionId: 'session-1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Pending work', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
          runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => { throw new Error('Refused admission cannot launch'); }, getNowMs: Date.now,
        admitStart: () => admitDaemonExecutionRunStart({ target: { pid: process.pid, httpPort: address.port, controlToken } }),
        budgetRegistry, runs, controllers, enqueueMarkerWrite: async (_id, write) => { await write(); },
        writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'daemon_draining', details: { executionRunStart: { runCreation: 'noRunCreated' } } });
      await requestReceived.promise;
      releaseDrain = drain.beginTemporaryDrain();
      expect(await readMachineMaintenanceAdmission(inventory)).toEqual({ kind: 'blocked', reasons: ['execution_run'] });
      expect(budgetRegistry.getInFlightSnapshot()).toEqual({ executionRuns: 0, oneShotTasks: 0 });
      expect(runs.size).toBe(0);
      expect(await listExecutionRunMarkers()).toEqual([]);
      admissionReply.resolve();
      await rejected;
      expect(await readMachineMaintenanceAdmission(inventory)).toEqual({ kind: 'eligible' });
      expect(runs.size).toBe(0);
      expect(controllers.size).toBe(0);
      expect(await listExecutionRunMarkers()).toEqual([]);
      expect(drain.isQuiescing()).toBe(true);
    } finally {
      releaseDrain ??= drain.beginTemporaryDrain();
      admissionReply.resolve();
      try { await rejected; }
      finally {
        releaseDrain();
        inventory.dispose();
        await app.close();
        await voiceAgentManager.dispose();
      }
    }
  });
  it.each(['bob', 'carol', null])('retains requester %s and the exact detached initial input before native admission', async accountId => {
    const attribution = materializeActionRequestAttributionV1({ requestRef: 'workflow-initial',
      requester: accountId ? { serverId: 'home', accountId } : null,
      persona: { serverId: 'home', sessionId: 'bot-session' }, origin: null });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const occurrences = createExecutionRunOccurrenceWitnessRegistry(controllers);
    let firstFailureObservation: ReturnType<typeof observeWorkflowDetachedExecutionRunInput> | undefined;
    const runtime = {
      ...createTestExecutionRunHostRuntime(),
      readResumeSupport: async () => { throw new ExecutionRunConnectedServicesError(
        'Execution-run connected services runner identity is not current',
        'connected_service_run_materialization_blocked',
      ); },
    };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
    const createRuntime = vi.fn<Parameters<typeof startExecutionRun>[0]['createRuntime']>(() => runtime);
    try {
      const started = await startExecutionRun({
        params: { sessionId: null, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Background work', localInputId: 'workflow-initial', resultContract: { kind: 'text' }, actionRequestAttributionV1: attribution,
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response' },
        parentProvider: 'daemon.executionRuns', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime, getNowMs: () => 100, budgetRegistry: null, runs, controllers,
        registerRunOccurrence: ({ runId, sidechainId, controller }) => occurrences.register({ runId, sidechainId, controller,
          runtimeLifetimeSignal: runtime.getRuntimeLifetimeSignal(), readActiveTurnAdmissionWitness: () => null }).dispose,
        enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {},
        finishRun: async (runId, next, toolResult) => { await finishExecutionRun({ runId, next, toolResult,
          runs, controllers, budgetRegistry: null, parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
          enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map() });
          const failed = runs.get(runId);
          if (!failed) throw new Error('Missing refused Run');
          const inputTurns = projectExecutionRunInputTurns({ runId, retained: failed.inputTurns,
            controller: controllers.get(runId), reader: occurrences.reader });
          firstFailureObservation = observeWorkflowDetachedExecutionRunInput({ runId, localInputId: 'workflow-initial',
            get: async () => ({ run: projectExecutionRunPublicState({ ...failed, inputTurns }) }) });
        },
        executeBoundedRun: async () => {}, send: async () => { throw new Error('Refused launch must not send'); },
        voiceAgentManager,
      });
      const controller = controllers.get(started.runId);
      if (controller?.kind === 'backend') await controller.provisioningPromise;
      expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
        actionRequestAttributionV1: attribution,
      });
      expect(await firstFailureObservation).toEqual({ kind: 'failed', code: 'connected_service_run_materialization_blocked',
        message: 'Execution-run connected services runner identity is not current' });
      const run = runs.get(started.runId);
      if (!run) throw new Error('Missing admitted Run');
      const response = ExecutionRunGetResponseSchema.parse({ run: projectExecutionRunPublicState(run) });
      expect(response.run.error?.code).toBe('connected_service_run_materialization_blocked');
      expect(await observeWorkflowDetachedExecutionRunInput({ runId: started.runId, localInputId: 'workflow-initial',
        get: async () => response })).toEqual({ kind: 'failed', code: 'connected_service_run_materialization_blocked',
          message: 'Execution-run connected services runner identity is not current' });
    } finally { await voiceAgentManager.dispose(); }
  });
  it.each(['terminal', 'terminal_or_needs_attention'] as const)(
    'holds an initial %s match behind real terminal transcript custody and re-reads publication failure', async (condition) => {
      const run: ExecutionRunState = {
        runId: 'custody-run', callId: 'custody-call', sidechainId: 'custody-sidechain', sessionId: 'session-1',
        depth: 0, intent: 'delegate', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: '', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
        ioMode: 'request_response', status: 'running', startedAtMs: 1,
      };
      const runs = new Map([[run.runId, run]]);
      let releasePublication = () => {};
      let publicationStarted = () => {};
      const publishing = new Promise<void>((resolve) => { publicationStarted = resolve; });
      const publication = new Promise<void>((resolve) => { releasePublication = resolve; });
      // Only durable transcript I/O is held; terminalization and sealed state writes are real.
      const finish = finishExecutionRun({
        runId: run.runId, next: { status: 'succeeded', finishedAtMs: 2 }, toolResult: { output: 'Done' },
        runs, controllers: new Map(), budgetRegistry: null, parentProvider: 'claude',
        sendAcp: async () => { publicationStarted(); await publication; throw new Error('storage unavailable'); },
        enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map(),
      });
      const completed = finish.catch(() => {});
      let settled = false;
      try {
        await publishing;
        expect(runs.get(run.runId)?.status).toBe('succeeded');
        const wait = waitForExecutionRunTerminal({
          runId: run.runId, timeoutMs: null, condition,
          readRun: async ({ runId }) => ({ ok: true as const, data: { run: runs.get(runId) } }),
          waitForTerminal: async () => { await completed; },
        }).then((result) => { settled = true; return result; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        releasePublication();
        await expect(wait).resolves.toMatchObject({ ok: true, status: 'failed', result: { run: {
          status: 'failed', error: { code: 'execution_run_transcript_custody_unavailable' },
        } } });
        expect((await listExecutionRunMarkers()).find((marker) => marker.runId === run.runId)?.status).toBe('failed');
      } finally { releasePublication(); await completed; }
    },
  );

  const retainedInteraction = {
    kind: 'retained_agent_session.v1',
    capabilities: {
      open: ['create', 'resume'],
      delivery: ['newTurn'],
      cancel: true,
    },
  } satisfies ExecutionRunInteractionV1;

  it('admits attached initial input before returning while backend provisioning remains pending', async () => {
    let releaseProvision!: () => void;
    let markProvisionStarted!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const runtime = Object.freeze({
      ...createTestExecutionRunHostRuntime({
        runtimeId: 'provider-session-1',
        resumeSupported: true,
        onProvisionRuntime: async () => {
          markProvisionStarted();
          await provisionGate;
        },
      }),
      interaction: retainedInteraction,
    });
    const enqueueRetainedRunInitialInput = vi.fn(async (input: { localId: string }): Promise<SessionInputAdmissionResultV1> => ({
      status: 'accepted' as const,
      localId: input.localId,
    }));
    const attachRetainedRunSessionInput = vi.fn(() => ({
      release: async () => {},
      awaitInputAdmission: async () => 'accepted' as const,
    }));
    const directSend = vi.fn(async () => ({ ok: true }));
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
    const startPromise = startExecutionRun({
      params: {
        sessionId: 'session-1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Initial work.',
        localInputId: 'workflow-input-1',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      },
      parentProvider: 'claude',
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => runtime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite: async (_runId, write) => { await write(); },
      writeActivityMarker: async () => {},
      finishRun: async (runId, next) => {
        const current = runs.get(runId);
        if (current) runs.set(runId, { ...current, ...next });
      },
      executeBoundedRun: async () => { throw new Error('retained run must not execute bounded work'); },
      send: directSend,
      enqueueRetainedRunInitialInput,
      attachRetainedRunSessionInput,
      voiceAgentManager,
    });

    try {
      await provisionStarted;
      const startOutcome = await Promise.race([
        startPromise.then((started) => ({ kind: 'started' as const, started })),
        new Promise<{ kind: 'still_waiting' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'still_waiting' }), 30);
        }),
      ]);
      const initialAdmissionCountBeforeProvision = enqueueRetainedRunInitialInput.mock.calls.length;
      releaseProvision();
      const started = await startPromise;

      expect(startOutcome).toMatchObject({ kind: 'started', started: { runId: started.runId } });
      expect(initialAdmissionCountBeforeProvision).toBe(1);
      expect(enqueueRetainedRunInitialInput).toHaveBeenCalledExactlyOnceWith({
        runId: started.runId,
        text: 'Initial work.',
        localId: 'workflow-input-1',
        requestedAction: { v: 1, kind: 'enqueue' },
      });
      expect(directSend).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(attachRetainedRunSessionInput).toHaveBeenCalledOnce());
    } finally {
      releaseProvision();
      for (const controller of controllers.values()) {
        if (controller.kind === 'backend') await controller.backend.dispose();
      }
      await voiceAgentManager.dispose();
    }
  });

  it('admits attached retained initial instructions through exact Run Pending once', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const runtime = Object.freeze({
      ...createTestExecutionRunHostRuntime({
        runtimeId: 'provider-session-1',
        resumeSupported: true,
      }),
      interaction: retainedInteraction,
    });
    const enqueueRetainedRunInitialInput = vi.fn(async (input: { localId: string }): Promise<SessionInputAdmissionResultV1> => ({
      status: 'accepted' as const,
      localId: input.localId,
    }));
    const directSend = vi.fn(async () => ({ ok: true }));
    const attachRetainedRunSessionInput = vi.fn(() => ({
      release: async () => {},
      awaitInputAdmission: async () => 'accepted' as const,
    }));
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
    const args: Parameters<typeof startExecutionRun>[0] = {
      params: {
        sessionId: 'session-1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: '  Continue through durable custody.  ',
        localInputId: 'workflow-input-1',
        resultContract: { kind: 'text' },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      },
      parentProvider: 'claude',
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => runtime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite: async (_runId, write) => { await write(); },
      writeActivityMarker: async () => {},
      finishRun: async (runId, next) => {
        const current = runs.get(runId);
        if (current) runs.set(runId, { ...current, ...next });
      },
      executeBoundedRun: async () => { throw new Error('retained run must not execute bounded work'); },
      send: directSend,
      enqueueRetainedRunInitialInput,
      attachRetainedRunSessionInput,
      voiceAgentManager,
    };
    const result = await startExecutionRun(args);

    expect(enqueueRetainedRunInitialInput).toHaveBeenCalledExactlyOnceWith({
      runId: result.runId,
      text: '  Continue through durable custody.  ',
      localId: 'workflow-input-1',
      requestedAction: { v: 1, kind: 'enqueue' },
    });
    expect(directSend).not.toHaveBeenCalled();
    const firstController = controllers.get(result.runId);
    if (!firstController || firstController.kind !== 'backend') {
      throw new Error('first retained backend controller missing');
    }
    await firstController.provisioningPromise;
    enqueueRetainedRunInitialInput.mockClear();
    attachRetainedRunSessionInput.mockClear();
    directSend.mockClear();

    let resolveRecoveredAdmission!: (outcome: 'accepted') => void;
    const recoveredAdmission = new Promise<'accepted'>((resolve) => {
      resolveRecoveredAdmission = resolve;
    });
    let resolveRetryDisposition!: (outcome: SessionInputAdmissionResultV1) => void;
    const retryDisposition = new Promise<SessionInputAdmissionResultV1>((resolve) => {
      resolveRetryDisposition = resolve;
    });
    attachRetainedRunSessionInput.mockImplementationOnce(() => ({
      release: async () => {},
      awaitInputAdmission: async () => await recoveredAdmission,
    }));
    enqueueRetainedRunInitialInput
      .mockRejectedValueOnce(new Error('pending admission outcome unknown'))
      .mockImplementationOnce(async () => await retryDisposition);
    const existingRunIds = new Set(runs.keys());
    const unresolvedStart = await startExecutionRun(args);
    const unresolvedRunId = [...runs.keys()].find((runId) => !existingRunIds.has(runId));
    expect(unresolvedRunId).toBeTruthy();
    expect(unresolvedStart).toMatchObject({
      runId: unresolvedRunId,
      callId: runs.get(unresolvedRunId!)?.callId,
      sidechainId: runs.get(unresolvedRunId!)?.sidechainId,
    });
    expect(runs.get(unresolvedRunId!)?.status).toBe('running');
    expect(controllers.has(unresolvedRunId!)).toBe(true);
    const unresolvedController = controllers.get(unresolvedRunId!);
    if (!unresolvedController || unresolvedController.kind !== 'backend') {
      throw new Error('unresolved backend controller missing');
    }
    await vi.waitFor(() => expect(enqueueRetainedRunInitialInput).toHaveBeenCalledTimes(2));
    expect(unresolvedController.runtimeId).toBe('provider-session-1');
    expect(attachRetainedRunSessionInput).toHaveBeenCalledOnce();
    // Provisioning has produced a runtime, but the accepted initial Pending input
    // has not reached the provider. A planned refresh must still retain this host.
    expect(isExecutionRunActive(projectExecutionRunPublicState(runs.get(unresolvedRunId!)!, unresolvedController))).toBe(true);
    expect(runs.get(unresolvedRunId!)).toMatchObject({
      status: 'running',
      error: {
        code: 'execution_run_initial_input_outcome_unknown',
        message: 'pending admission outcome unknown',
      },
    });
    expect(directSend).not.toHaveBeenCalled();

    resolveRecoveredAdmission('accepted');
    await expect(unresolvedController.initialPendingInputAdmission).resolves.toBe('accepted');
    expect(runs.get(unresolvedRunId!)?.error).toBeUndefined();
    resolveRetryDisposition({
      status: 'outcomeUnknown',
      localId: 'workflow-input-1',
      code: 'session_input_admission_outcome_unknown',
    });
    await unresolvedController.provisioningPromise;
    expect(runs.get(unresolvedRunId!)?.error).toBeUndefined();

    await expect(sendBackendLongLivedRun({
      runId: unresolvedRunId!,
      params: { message: 'Follow-up after exact admission recovery.' },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 1_700_000_000_001,
      finishRun: async () => {},
      sendAcp: async () => {},
      parentProvider: 'claude',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => {},
    })).resolves.toEqual({ ok: true });

    enqueueRetainedRunInitialInput.mockResolvedValueOnce({
      status: 'rejected',
      code: 'session_input_unauthorized',
    });
    const idsBeforeRejected = new Set(runs.keys());
    const rejectedStart = await startExecutionRun(args);
    const rejectedRunId = [...runs.keys()].find((runId) => !idsBeforeRejected.has(runId));
    expect(rejectedRunId).toBeTruthy();
    expect(rejectedStart.runId).toBe(rejectedRunId);
    expect(runs.get(rejectedRunId!)).toMatchObject({
      status: 'failed',
      error: { code: 'session_input_unauthorized' },
    });
    expect(controllers.has(rejectedRunId!)).toBe(false);

    for (const controller of controllers.values()) {
      if (controller.kind === 'backend') await controller.backend.dispose();
    }
    await voiceAgentManager.dispose();
  });

  it('keeps a lazy retained run recoverable when post-handle initial admission is outcome-unknown', async () => {
    let releaseResumeSupport!: () => void;
    const resumeSupport = new Promise<void>((resolve) => {
      releaseResumeSupport = resolve;
    });
    let interactionKnown = false;
    const provisionRuntime = vi.fn();
    const baseRuntime = createTestExecutionRunHostRuntime({
      onProvisionRuntime: provisionRuntime,
      resumeSupported: true,
      replayResumeSupported: true,
    });
    const runtime = Object.freeze({
      ...baseRuntime,
      get interaction() {
        return interactionKnown ? retainedInteraction : undefined;
      },
      async readResumeSupport() {
        await resumeSupport;
        interactionKnown = true;
        return true;
      },
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const enqueueRetainedRunInitialInput = vi.fn(async () => {
      throw new Error('pending admission outcome unknown');
    });
    const attachRetainedRunSessionInput = vi.fn(() => ({
      release: async () => {},
      awaitInputAdmission: async () => 'unknown' as const,
    }));
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session-1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Initial lazy work.',
          localInputId: 'workflow-input-lazy',
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
        parentProvider: 'claude',
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async (_runId, write) => { await write(); },
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun: async () => { throw new Error('retained run must not execute bounded work'); },
        send: async () => ({ ok: true }),
        enqueueRetainedRunInitialInput,
        attachRetainedRunSessionInput,
        voiceAgentManager,
      });

      const startOutcome = await Promise.race([
        startPromise.then((started) => ({ kind: 'started' as const, started })),
        new Promise<{ kind: 'still_waiting' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'still_waiting' }), 30);
        }),
      ]);
      expect(startOutcome).toMatchObject({ kind: 'started' });
      if (startOutcome.kind !== 'started') throw new Error('run handle was withheld');

      releaseResumeSupport();
      const controller = controllers.get(startOutcome.started.runId);
      if (!controller || controller.kind !== 'backend') throw new Error('backend controller missing');
      await (controller as typeof controller & { provisioningPromise?: Promise<void> }).provisioningPromise;

      expect(enqueueRetainedRunInitialInput).toHaveBeenCalledTimes(2);
      expect(enqueueRetainedRunInitialInput).toHaveBeenNthCalledWith(1, {
        runId: startOutcome.started.runId,
        text: 'Initial lazy work.',
        localId: 'workflow-input-lazy',
        requestedAction: { v: 1, kind: 'enqueue' },
      });
      expect(enqueueRetainedRunInitialInput).toHaveBeenNthCalledWith(2, {
        runId: startOutcome.started.runId,
        text: 'Initial lazy work.',
        localId: 'workflow-input-lazy',
        requestedAction: { v: 1, kind: 'enqueue' },
      });
      expect(provisionRuntime).toHaveBeenCalledOnce();
      expect(attachRetainedRunSessionInput).toHaveBeenCalledOnce();
      expect(controller.runtimeId).toBe('child_runtime_1');
      expect(runs.get(startOutcome.started.runId)).toMatchObject({
        status: 'running',
        error: {
          code: 'execution_run_initial_input_outcome_unknown',
          message: 'pending admission outcome unknown',
        },
      });
      expect(controllers.has(startOutcome.started.runId)).toBe(true);
    } finally {
      releaseResumeSupport();
      for (const controller of controllers.values()) {
        if (controller.kind === 'backend') await controller.backend.dispose();
      }
      await voiceAgentManager.dispose();
    }
  });

  it('settles a materialized run and releases capacity when its initial durable publication rejects', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const budgetRegistry = new ExecutionBudgetRegistry();
    // Agent execution and durable transcript I/O are the external boundaries.
    const createRuntime = vi.fn(() => createTestExecutionRunHostRuntime());
    const sendAcp = vi.fn(async (): Promise<void> => { throw new Error('execution_run_transcript_custody_unavailable'); });
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const terminalMarkerWritePromises = new Map<string, Promise<void>>();
    const enqueueMarkerWrite = async (_runId: string, write: () => Promise<void>) => { await write(); };
    const args: Parameters<typeof startExecutionRun>[0] = {
      params: {
        sessionId: 'session-1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
      parentProvider: 'claude',
      sendAcp,
      streamedTranscriptSession: null,
      createRuntime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry,
      runs,
      controllers,
      enqueueMarkerWrite,
      writeActivityMarker: async () => {},
      finishRun: async (runId, next, toolResult, structuredMeta) => {
        await finishExecutionRun({
          runId, next, toolResult, structuredMeta, runs, controllers, budgetRegistry,
          parentProvider: 'claude', sendAcp, enqueueMarkerWrite, terminalMarkerWritePromises,
        });
      },
      executeBoundedRun: async () => { throw new Error('Long-lived start must not execute bounded work'); },
      send: async () => { throw new Error('No initial instructions were supplied'); },
      voiceAgentManager,
    };
    try {
      const failedStart = await startExecutionRun(args);
      expect([...runs.values()]).toEqual([expect.objectContaining({
        runId: failedStart.runId,
        callId: failedStart.callId,
        sidechainId: failedStart.sidechainId,
        status: 'failed',
        error: expect.objectContaining({ code: 'execution_run_transcript_custody_unavailable' }),
      })]);
      expect(controllers.size).toBe(0);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(budgetRegistry.getInFlightSnapshot().executionRuns).toBe(0);
      expect((await listExecutionRunMarkers()).find((marker) => runs.has(marker.runId)))
        .toMatchObject({ status: 'failed' });

      sendAcp.mockResolvedValue(undefined);
      const successor = await startExecutionRun(args);
      expect(runs.get(successor.runId)?.status).toBe('running');
      expect(createRuntime).toHaveBeenCalledOnce();
      await stopExecutionRun({ ...args, runId: successor.runId });
      expect(budgetRegistry.getInFlightSnapshot().executionRuns).toBe(0);
    } finally {
      for (const controller of controllers.values()) {
        if (controller.kind === 'backend') await controller.backend.dispose();
      }
      await voiceAgentManager.dispose();
    }
  });
});
