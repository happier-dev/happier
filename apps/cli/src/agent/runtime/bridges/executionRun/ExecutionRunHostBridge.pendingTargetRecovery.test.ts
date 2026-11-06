import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fastify from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';

import type { ExecutionRunState } from './executionRunTypes';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createEmptyBackendExecutionSurfaces, type EngineAdapterResolution } from '@/agent/runtime/registry/engineRegistryTypes';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import { createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createLazyExecutionRunHostRuntime } from './hostRuntime/lazy';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildReviewEngineInventoryItems } from '@/session/actions/inventory/buildReviewEngineInventoryItems';
import type { ExecutionRunAdmittedPendingInputV1, ExecutionRunPendingInputBinding } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { ScmComparisonSchema, SessionInputAdmissionResultV1Schema, ScmDiffSummaryRefineInputSchema, ExecutionRunGetResponseSchema,
  type SessionInputAdmissionResultV1, type ScmActionExecute } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { ReviewProfile } from '@/agent/executionRuns/profiles/review/ReviewProfile';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutionRunRoleV1 } from '@/agent/executionRuns/profiles/review/reviewRole';
import { createExecutionRunRpcActionDeps } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { decodeBase64, decrypt, encodeBase64, encryptLegacy } from '@/api/encryption';
import { UserMessageSchema } from '@/api/types';
import { createActionExecutor, ExternalActionRequestEnvelopeV2Schema, openExternalActionRequestV2, prepareExternalActionResponseV2,
  type ActionExecutorContext } from '@happier-dev/protocol';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ReviewWalkthroughResponseSchema } from '@happier-dev/protocol/reviews/reviewNarration';
import { readRetainedExecutionRunRecords, reconcileRetainedExecutionRunRecords } from '@/daemon/executionRunRegistry';
import { restartSessionRunnerOnCurrentRuntime } from '@/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import type { TrackedSession } from '@/daemon/types';
import { runSessionLoopLifecycle } from '@/agent/runtime/session/loop/lifecycle';
import { createLifecycleParams } from '@/agent/runtime/session/loop/lifecycle.testkit';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';

const nativeOpen = vi.hoisted(() => vi.fn<(request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>>());
const nativeModule = vi.hoisted(() => ({ ready: undefined as Promise<void> | undefined }));
const retainedReadFailure = vi.hoisted(() => ({ armed: false, failed: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    if (retainedReadFailure.armed && !retainedReadFailure.failed
      && String(args[0]).endsWith('daemon-execution-runs')) {
      retainedReadFailure.failed = true;
      throw Object.assign(new Error('Transient retained-state read failure'), { code: 'EIO' });
    }
    return actual.readdir(...args);
  } };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

vi.mock('./createExecutionRunBridgeRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./createExecutionRunBridgeRuntime')>();
  return {
    createExecutionRunBridgeRuntime: (options: Parameters<typeof actual.createExecutionRunBridgeRuntime>[0]) => createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => {
        await nativeModule.ready;
        const registry = options.engineRegistry ?? await resolveCliEngineRegistry();
        // The external Agent factory supplies native open/send. Keep the real
        // launch owner, including model/configuration and credential assembly.
        const agent: EngineAdapterResolution['agent'] = {
          id: options.backendId, provenance: 'external', source: { kind: 'path' },
          definition: { kindVersion: 1, id: options.backendId, ownedBackendIds: [] },
        };
        const resolveNativeEngine = async (): Promise<EngineAdapterResolution> => ({
          backendId: options.backendId, agentId: options.backendId, provenance: 'external',
          runtimeOwner: { backendId: options.backendId, selected: {
            kind: 'plugin_engine', ownerId: 'test.agent', provenance: 'external',
          }, candidates: [] },
          backend: projectEngineRuntimeContributionFromAgent(agent, agent.id),
          agent,
          engineAdapter: { runtimeCore: {
            createSessionRuntime: () => { throw new Error('Unexpected parent Session runtime in native child-Run fixture'); },
            createExecutionRunBackend: nativeOptions => createNativeAgentSessionInteractionHostRuntime({
            runtime: { sessions: { open: nativeOpen } }, options: nativeOptions,
            lease: { pluginId: 'test.agent', pluginVersion: '1.0.0', agentId: 'test.agent', localAgentId: 'agent',
              occurrenceId: 'native-test-occurrence', isCurrent: () => true },
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
          }) } },
          executionSurfaces: createEmptyBackendExecutionSurfaces(), diagnostics: [],
        });
        return actual.createExecutionRunBridgeRuntime({ ...options, engineRegistry: {
          ...registry, resolveForBackendId: resolveNativeEngine, resolveForAgentTarget: resolveNativeEngine,
        } });
      },
    }),
  };
});

const TEST_BACKEND_ID = `${'test'}.${'agent'}` as never;
let directory: string;
const bridges: ExecutionRunHostBridge[] = [];
let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtimeFixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
});
afterAll(async () => { await runtimeFixture?.dispose(); });
beforeEach(() => {
  nativeOpen.mockReset();
  nativeModule.ready = undefined;
  retainedReadFailure.armed = false;
  retainedReadFailure.failed = false;
  directory = mkdtempSync(join(tmpdir(), 'happier-pending-target-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  // Native startup is the mocked boundary; model admission uses the real offered catalog.
  vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
  vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  reloadConfiguration();
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((manager) => manager.dispose()));
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});


function runState(overrides: Partial<ExecutionRunState> = {}): ExecutionRunState {
  return {
    runId: 'run-1',
    callId: 'call-1',
    sidechainId: 'sidechain-1',
    sessionId: 'session-1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
    backendId: TEST_BACKEND_ID,
    instructions: 'Continue.',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'streaming',
    status: 'running',
    startedAtMs: 1,
    resumeHandle: {
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: TEST_BACKEND_ID, sourceKind: 'built_in' },
      providerSessionId: 'provider-session-1',
    },
    ...overrides,
  };
}

function createHarness(detached = false, reviewerRole = false, sendAcp: ExecutionRunTranscriptPublisher = async () => {}, sessionId = 'session-1') {
  const reviewer = reviewerRole ? resolveExecutionRunRoleV1({ roleId: 'reviewer',
    accountRoleOverrides: { status: 'ready', overrides: {} } }) : undefined;
  if (reviewerRole && !reviewer) throw new Error('Expected the reviewer role');
  // A bound, admitted Session has readable metadata. Missing metadata cannot
  // prove that the Session is free of an explicit Stop hold.
  const metadata = createTestMetadata(reviewer ? { work: { sessionRolesV1: {
    overrides: {}, notes: '', sessionRoles: { reviewer },
  } } } : {});
  let consume: ExecutionRunPendingInputBinding['consume'] | undefined;
  const acceptedInputs = new Set<string>();
  const inputOutcomes: SessionProviderInputOutcome[] = [];
  const pendingInputs: ExecutionRunAdmittedPendingInputV1[] = [];
  const enqueueSessionUserMessageWithDisposition = vi.fn<(input: { text: string; localId: string }) => Promise<SessionInputAdmissionResultV1>>(
    async (input) => ({ status: 'accepted', localId: input.localId }));
  let observeFirstEnqueuedInput: () => void = () => undefined;
  const firstEnqueuedInput = new Promise<void>(resolve => { observeFirstEnqueuedInput = resolve; });
  const listExecutionRunPendingDeliveryStatuses = vi.fn(async () => [
    { localId: 'queued-1', status: 'queued' as const, deliveryStatus: { status: 'queued' as const } },
    { localId: 'blocked-1', status: 'blocked' as const, deliveryStatus: { status: 'blocked' as const, reason: 'session_input_target_unavailable' as const } },
  ]);
  const blockExecutionRunPendingDelivery = vi.fn(async () => true);
  // This online Session boundary acknowledges the publication before the host
  // admits another input; use the same publisher for held-publication scenarios.
  const enqueueAgentMessageCommitted = vi.fn(async (...args: Parameters<ExecutionRunTranscriptPublisher>) => {
    await sendAcp(...args);
    return { persisted: true, delivered: true };
  });
  const manager = new ExecutionRunHostBridge({
    // External Account preference input for this recovery fixture.
    resolveRunReportPolicy: async () => ({ preset: 'important' }),
    parentProvider: TEST_BACKEND_ID,
    resolveAccountSettings: async () => ({}),
    cwd: detached || reviewerRole ? directory : process.cwd(),
    sendAcp,
    ...(!detached ? { sessionInteractionHost: {
      // Parent Agent configuration is an external runtime observation; child selection stays real.
      readAppliedChildSelection: async () => ({ status: 'applied' as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
        modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id, connectedServices: null }),
      session: {
        sessionId,
        getMetadataSnapshot: () => metadata,
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        enqueueAgentMessageCommitted,
        enqueueSessionUserMessageWithDisposition: async input => {
          const disposition = await enqueueSessionUserMessageWithDisposition(input);
          observeFirstEnqueuedInput();
          return disposition;
        },
        bindExecutionRunPendingInput: (binding: ExecutionRunPendingInputBinding) => {
          consume = input => {
            const admitted = binding.consume(input);
            binding.wake?.();
            return admitted;
          };
          return { getMetadataSnapshot: () => metadata, waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
            shouldAttemptPendingMaterialization: () => pendingInputs.length > 0, reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
            materializeNextPendingMessageSafely: async () => {
              const input = pendingInputs.shift();
              if (!input) return { type: 'no_pending' as const };
              binding.consume(input);
              return { type: 'materialized' as const, localId: input.localId!, seq: null, content: null };
            },
            observeProviderInputSettlement: async (outcome: SessionProviderInputOutcome) => {
              inputOutcomes.push(outcome);
              if (outcome.kind === 'accepted') acceptedInputs.add(outcome.localId);
              return true;
            },
            readDurableProviderInputAcceptanceV1: async (localId: string) => acceptedInputs.has(localId) ? 'accepted' as const : 'unknown' as const,
            dispose() {} };
        },
        listExecutionRunPendingDeliveryStatuses,
        blockExecutionRunPendingDelivery,
      },
      machineId: 'machine-1',
      permissionHandler: { handleToolCall: vi.fn() },
    } } : {}),
  });
  bridges.push(manager);
  const runs = (manager as unknown as { runs: Map<string, ExecutionRunState> }).runs;
  const controllers = (manager as unknown as { controllers: Map<string, unknown> }).controllers;
  return {
    manager,
    runs,
    controllers,
    listExecutionRunPendingDeliveryStatuses,
    blockExecutionRunPendingDelivery,
    enqueueAgentMessageCommitted,
    enqueueSessionUserMessageWithDisposition,
    firstEnqueuedInput,
    inputOutcomes,
    pendingInputs,
    consume: (input: ExecutionRunAdmittedPendingInputV1) => consume?.(input),
  };
}

describe('ExecutionRunHostBridge pending target recovery', () => {
  it.each([
    { outcome: 'complete', operation: 'retire', holdPublication: false, narration: false },
    { outcome: 'complete', operation: 'retire', holdPublication: true, narration: false },
    { outcome: 'complete', operation: 'stop', holdPublication: false, narration: false },
    { outcome: 'failed', operation: 'retire', holdPublication: false, narration: false },
    { outcome: 'complete', operation: 'retire', holdPublication: false, narration: true },
    { outcome: 'complete', operation: 'restart', holdPublication: false, narration: true },
  ] as const)('resumes a completed idle retained review after runner disposal and replacement ($outcome, $operation, publication held=$holdPublication, narration=$narration)', async ({ outcome, operation, holdPublication, narration }) => {
    execFileSync('git', ['init', directory], { stdio: 'ignore' });
    writeFileSync(join(directory, 'code.ts'), 'export const enabled = true;\n');
    const comparison = narration ? await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' } }) : null;
    let sequence = 0;
    const requests: AgentSessionOpenRequest[] = [];
    const disposedThreads: AgentSessionOpenRequest[] = [];
    nativeOpen.mockImplementation(async request => {
      requests.push(request);
      let nativeTurns = 0;
      let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      const base = () => ({ sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence });
      return {
        watch(listener) {
          emit = listener;
          emit({ ...base(), kind: 'provider-session-id', providerSessionId: 'retained-review-thread' });
          return { dispose() { emit = undefined; } };
        },
        async send(input) {
          const turnId = input.delivery.turnId;
          emit?.({ ...base(), kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
          emit?.({ ...base(), kind: 'turn-start', turnId, startedBy: 'host' });
          emit?.({ ...base(), kind: 'message-delta', turnId, channel: 'assistant', text: JSON.stringify(
            request.kind === 'resume' ? { answerMarkdown: 'The condition controls authorization.', updatedFindings: [], questions: [], assumptions: [] }
              : ++nativeTurns === 1 ? { summary: 'Reviewed the changes.', reviewOutcome: outcome, findings: [] }
                : { walkthrough: { title: 'Condition update', intro: 'One changed condition',
                  stops: [{ id: 'condition', title: 'Condition', explanationMarkdown: 'The flag changed', changeRefs: ['c1'] }], otherChangeRefs: [] } },
          ) });
          emit?.({ ...base(), kind: 'turn-complete', turnId });
          return { status: 'admitted' as const };
        },
        async dispose() { disposedThreads.push(request); emit = undefined; },
      };
    });
    let releasePublication!: () => void;
    const publication = new Promise<void>(resolve => { releasePublication = resolve; });
    let publicationEntered!: () => void;
    const publishing = new Promise<void>(resolve => { publicationEntered = resolve; });
    let retiringCallId: string | undefined;
    const original = createHarness(false, true, async (_provider, body, options) => {
      if (operation === 'restart' && body.type === 'tool-result' && body.callId === retiringCallId) {
        publicationEntered();
        await publication;
      }
      const meta = options?.meta?.happier;
      if (holdPublication && meta && typeof meta === 'object' && 'kind' in meta && meta.kind === 'review_findings.v2') {
        publicationEntered();
        await publication;
      }
    });
    const started = await original.manager.start({ sessionId: 'session-1', cwd: directory, intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelSelection: null,
      instructions: 'Review.', permissionMode: 'read_only',
      ...(comparison ? { intentInput: { comparisonId: comparison.comparison.id, outputs: ['walkthrough'] } } : {}),
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', localInputId: 'review-initial' });
    await original.firstEnqueuedInput;
    const initialController = original.controllers.get(started.runId) as ExecutionRunBackendController;
    await initialController.provisioningPromise;
    expect(original.manager.getPublic(started.runId)).toMatchObject({ turnInFlight: true });
    await vi.waitFor(() => expect(original.consume({ role: 'user', content: { type: 'text', text: 'Review.' },
      localId: 'review-initial', authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true));
    if (narration) {
      await vi.waitFor(() => expect(original.enqueueSessionUserMessageWithDisposition.mock.calls).toHaveLength(2));
      await initialController.pendingHostBarrier;
      // Native findings have finished, but their admitted walkthrough has not
      // reached the provider. A capability refresh must retain this host.
      expect.soft(original.manager.getPublic(started.runId)).toMatchObject({ turnInFlight: true });
      const input = original.enqueueSessionUserMessageWithDisposition.mock.calls[1]![0];
      expect(original.consume({ role: 'user', content: { type: 'text', text: input.text }, localId: input.localId,
        authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    }
    let retiring: Promise<void> | undefined;
    if (holdPublication) {
      await publishing;
      // Host publication is part of the admitted work, including the gap after
      // native turn-complete. It must hold the same canonical restart gate.
      expect.soft(original.manager.getPublic(started.runId)).toMatchObject({ turnInFlight: true });
      retiring = original.manager.dispose();
      releasePublication();
    }
    await vi.waitFor(() => {
      expect(original.manager.getStructuredMeta(started.runId)?.kind).toBe(narration ? 'scm_diff_summary.v1' : 'review_findings.v2');
      if (!holdPublication) expect(original.manager.getPublic(started.runId)).toMatchObject({ status: 'running', turnInFlight: false,
        inputTurns: { last: { state: 'completed' } } });
    });
    const findings = original.manager.getStructuredMeta(started.runId);
    if (operation === 'stop') expect(await original.manager.stop(started.runId)).toMatchObject({ ok: true });
    if (operation === 'restart') {
      retiringCallId = started.callId;
      // The daemon signals a real runner lifecycle, whose process boundary is
      // in-process here. A non-replying Home publisher is the network boundary.
      const processEvents = new EventEmitter();
      let runnerReady!: () => void;
      const ready = new Promise<void>(resolve => { runnerReady = resolve; });
      let runnerExited!: () => void;
      const exited = new Promise<void>(resolve => { runnerExited = resolve; });
      let releaseLoop!: () => void;
      const promptLoop = new Promise<void>(resolve => { releaseLoop = resolve; });
      let childrenDisposed!: () => void;
      const disposed = new Promise<void>(resolve => { childrenDisposed = resolve; });
      const base = createLifecycleParams();
      const session = Object.assign(base.session, {
        disposeExecutionRuns: async () => { await original.manager.dispose(); childrenDisposed(); },
      });
      const running = runSessionLoopLifecycle({ ...base, session,
        runtimeDirectory: directory,
        deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
          runPermissionModePromptLoopFn: async () => { await promptLoop; },
          registerRunnerTerminationHandlersFn: input => {
            const handlers = registerRunnerTerminationHandlers({ ...input, process: processEvents,
              sessionExitReport: null, exit: () => { runnerExited(); releaseLoop(); } });
            runnerReady();
            return handlers;
          },
        },
      });
      const tracked: TrackedSession = { startedBy: 'daemon', pid: 4242, happySessionId: 'session-1',
        processStartTimeMs: 1, processCommandHash: 'runner-hash', vendorResumeId: 'parent-native-thread',
        processCommand: '/runtime/cli-dev/versions/0.3.0/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
        spawnOptions: { directory, backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, resume: 'parent-native-thread' },
      };
      const realKill = process.kill.bind(process);
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid !== tracked.pid) return realKill(pid, signal);
        expect(signal).toBe('SIGTERM');
        processEvents.emit('SIGTERM');
        return true;
      });
      try {
        await ready;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        expect(await restartSessionRunnerOnCurrentRuntime({
          request: { sessionId: 'session-1', mode: 'force_current_cli', reason: 'ui_stale_runner_banner' },
          tracked, currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.3.0', entrypointVersion: '0.3.0' },
          requestRestart: async input => await requestPlannedRunnerRestart({
            sessionId: input.sessionId, tracked, reason: input.reason, canSignal: input.canSignal,
            deferral: { kind: 'none' }, restartRequestedPids: new Set(), pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            isProcessSafeToSignal: async () => true,
            requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
              shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure,
              onProcessAlreadyMissing: request.onProcessAlreadyMissing }),
          }),
        })).toMatchObject({ ok: true, status: 'restarted' });
        const publicationBlocked = await Promise.race([publishing.then(() => true), disposed.then(() => false)]);
        // Exercise the runner's own existing termination budget only when the
        // network stalls disposal. Do not invent another completion timeout.
        if (publicationBlocked) await vi.runOnlyPendingTimersAsync();
        await exited;
        vi.useRealTimers();
        await reconcileRetainedExecutionRunRecords({ nowMs: Date.now(), isPidAlive: () => false });
        const record = (await readRetainedExecutionRunRecords()).find(record => record.state.runId === started.runId);
        expect(record, 'Completed narrated Review must survive runner exit and host-loss reconciliation').toMatchObject({ state: { status: 'succeeded' } });
        expect(disposedThreads).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        releasePublication();
        releaseLoop();
        kill.mockRestore();
        await original.manager.dispose();
        await running;
      }
    } else await (retiring ?? original.manager.dispose());
    const replacement = createHarness(false, true);
    const followUp = await replacement.manager.applyAction(started.runId, {
      actionId: 'review.follow_up', input: { findingIds: [], messageMarkdown: 'Why does this matter?' },
    });
    if (operation === 'stop' || outcome === 'failed') {
      expect(followUp, JSON.stringify(followUp)).toMatchObject({ ok: false, errorCode: 'review_follow_up_ended' });
      expect(requests.map(request => request.kind)).toEqual(['create']);
      return;
    }
    expect(followUp, JSON.stringify(followUp)).toMatchObject({ ok: true });
    expect(replacement.manager.getStructuredMeta(started.runId)).toEqual(findings);
    if (!followUp.ok || !followUp.result || typeof followUp.result !== 'object' || !('runId' in followUp.result)
      || typeof followUp.result.runId !== 'string') throw new Error('Expected follow-up Run identity');
    await replacement.manager.waitForTerminal(followUp.result.runId);
    expect(requests).toMatchObject([{ kind: 'create' }, { kind: 'resume', providerSessionId: 'retained-review-thread' }]);
    expect(replacement.manager.getStructuredMeta(followUp.result.runId)?.kind).toBe('review_follow_up.v1');
  });

  it.each([
    { recovered: false, settlement: 'complete' },
    { recovered: false, settlement: 'stop-child' },
    { recovered: true, settlement: 'stop-parent' },
    { recovered: false, settlement: 'complete', readFailure: true },
    { recovered: false, settlement: 'fail-child', readFailure: true },
    { recovered: true, settlement: 'stop-parent', readFailure: true },
    { recovered: false, settlement: 'complete', missingHandle: true },
  ])('keeps follow-up, ordinary recipient and narration input in the retained reviewer turn custody (recovered=$recovered, $settlement, readFailure=$readFailure, missingHandle=$missingHandle)', async ({ recovered, settlement, readFailure, missingHandle }) => {
    let releasePublication!: () => void;
    const publication = new Promise<void>(resolve => { releasePublication = resolve; });
    let publicationStarted = false;
    let followUpCallId: string | undefined;
    let verified = false;
    try {
      execFileSync('git', ['init', directory], { stdio: 'ignore' });
      const emitters: ((event: AgentSessionRuntimeEvent) => void)[] = [];
      const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
      nativeOpen.mockImplementation(async () => ({
        watch(next) { emitters.push(next); next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1,
          sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
        send: sent, async dispose() {},
      }));
      const harness = createHarness(false, true, async (_provider, body) => {
        if (readFailure && body.type === 'tool-call') retainedReadFailure.armed = true;
        if (body.type === 'tool-result' && body.callId === followUpCallId) {
          publicationStarted = true;
          await publication;
        }
      });
      const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
      const findings = { runRef: { runId: 'run-1', callId: 'call-1', backendId: 'claude' },
        summary: 'Retained review', overviewMarkdown: '', findings: [], questions: [], assumptions: [], generatedAtMs: 2 };
      harness.runs.set('run-1', runState({ intent: 'review', status: 'succeeded', finishedAtMs: 2,
        ...(recovered ? { runClass: 'bounded' as const } : {}),
        backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        intentInput: { cwd: directory, comparisonId: captured.comparison.id },
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'provider-session-1' }, structuredMeta: { kind: 'review_findings.v2', payload: findings },
      }));
      if (!recovered) {
        expect(await harness.manager.ensure('run-1', { resume: true })).toMatchObject({ ok: true });
        expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: false, lifecycle: { state: 'current' } });
        if (missingHandle) harness.runs.set('run-1', { ...harness.runs.get('run-1')!, resumeHandle: null });
      }
      const input = { messageMarkdown: 'First?', findingIds: [], threadId: 'finding-thread' };
      const first = await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input });
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { threadId: input.threadId } });
      if (!first.ok) throw new Error('Follow-up was refused');
      const childId = (first.result as { runId: string }).runId;
      followUpCallId = (first.result as { callId: string }).callId;
      await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
      // The child uses the incumbent native conversation, including when no
      // provider resume identity was published. Reopening it is a different path.
      expect(nativeOpen).toHaveBeenCalledOnce();
      if (readFailure) {
        // Local terminal observation must not depend on this global discovery.
        // The old observer consumes the EIO itself; a local join leaves it for
        // this independent discovery, which still reports the real read failure.
        if (!retainedReadFailure.failed) {
          await expect(harness.manager.recoverRetainedRuns()).rejects.toMatchObject({ code: 'EIO' });
        }
        expect(retainedReadFailure.failed).toBe(true);
      }
      expect(await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input: { ...input, messageMarkdown: 'Second?' } }))
        .toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: true });
      expect(await harness.manager.send('run-1', { message: 'Ordinary prompt' })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(await harness.manager.send('run-1', { message: 'Intervention', delivery: 'interrupt' })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(harness.consume({ role: 'user', content: { type: 'text', text: 'Ordinary recipient' }, localId: 'ordinary-during-follow-up',
        authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
      await vi.waitFor(() => expect(harness.inputOutcomes).toContainEqual(expect.objectContaining({
        kind: 'rejected_before_effect', localId: 'ordinary-during-follow-up', diagnostic: expect.objectContaining({ code: 'execution_run_busy' }),
      })));
      expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
        reviewRunIds: ['run-1'], comparisonId: captured.comparison.id,
      } })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(sent).toHaveBeenCalledOnce();
      let stopping: ReturnType<ExecutionRunHostBridge['stop']> | undefined;
      if (settlement === 'complete' || settlement === 'fail-child') {
        const delivery = sent.mock.calls[0]![0];
        if (delivery.delivery.kind !== 'newTurn') throw new Error('Follow-up must be a native turn');
        const emit = emitters.at(-1)!;
        const turnId = delivery.delivery.turnId;
        emit({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2, inputIds: delivery.inputIds, delivery: delivery.delivery });
        emit({ kind: 'turn-start', sessionId: 'session-parent', sequence: 3, emittedAtMs: 3, turnId, startedBy: 'host' });
        if (settlement === 'fail-child') {
          emit({ kind: 'turn-failed', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId,
            diagnostic: { code: 'native_turn_failed', message: 'Native turn failed', severity: 'error' } });
        } else {
          emit({ kind: 'message-delta', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId, channel: 'assistant', text: JSON.stringify({ answerMarkdown: 'Answer.' }) });
          emit({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 5, emittedAtMs: 5, turnId });
        }
      } else {
        stopping = harness.manager.stop(settlement === 'stop-parent' ? 'run-1' : childId);
      }
      let parentStopped = false;
      if (stopping) void stopping.then(() => { parentStopped = true; });
      await vi.waitFor(() => expect(publicationStarted).toBe(true));
      // Terminal projection precedes durable transcript settlement. Custody is still exclusive.
      expect(await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input }))
        .toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: true });
      expect(parentStopped).toBe(false);
      releasePublication();
      if (stopping) expect(await stopping).toMatchObject({ ok: true });
      await harness.manager.waitForTerminal(childId);
      if (settlement === 'complete') {
        expect(harness.runs.get(childId)).toMatchObject({ status: 'succeeded', structuredMeta: { kind: 'review_follow_up.v1',
          payload: { parentRunRef: findings.runRef, threadId: input.threadId, answerMarkdown: 'Answer.' } } });
        const signal = new AbortController().signal;
        // Important keeps successful reports for a natural parent turn. The
        // same inbox retains the full Run pointer without waking the parent.
        expect(await harness.manager.takeWorkerUpdate('session-1', signal)).toBeNull();
        const reports = await harness.manager.prepareWorkerUpdates('session-1', { signal });
        const report = reports.find(({ update }) => update.workerId === childId);
        expect(report?.update).toMatchObject({
          ownerState: 'succeeded', result: 'Answer.', canInspect: true,
          transcriptPointer: { kind: 'execution_run', sessionId: 'session-1', runId: childId },
        });
        expect(await harness.manager.prepareWorkerUpdates('foreign-session', { signal })).toEqual([]);
        report!.acknowledgeAccepted();
        expect((await harness.manager.prepareWorkerUpdates('session-1', { signal }))
          .some(({ update }) => update.workerId === childId)).toBe(false);
      } else expect(harness.runs.get(childId)).toMatchObject({ status: settlement === 'fail-child' ? 'failed' : 'cancelled' });
      expect(harness.runs.get('run-1')?.structuredMeta).toEqual({ kind: 'review_findings.v2', payload: findings });
      if (settlement === 'stop-parent') {
        expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'cancelled' });
      } else {
        await vi.waitFor(() => expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: false }));
        expect(await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input: { ...input, messageMarkdown: 'After settlement?' } }))
          .toMatchObject({ ok: true });
        await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
        expect(nativeOpen).toHaveBeenCalledOnce();
      }
      verified = true;
    } finally {
      releasePublication();
      if (!verified) {
        // A failed custody assertion must not strand teardown of this disposable fixture.
        for (const manager of bridges) {
          const controller = (manager as unknown as { controllers: Map<string, ExecutionRunBackendController> }).controllers.get('run-1');
          if (controller) controller.delegatedTurn = undefined;
        }
      }
    }
  });
  it.each(['present_user', 'account_automation'] as const)('admits automatic refinement through CLI credentials before the original native recipient finishes recovery (%s)', async authority => {
    const sessionId = 'c123456789012345678901234';
    const origin = 'http://refinement-home.test';
    const secret = new Uint8Array(32).fill(21);
    const tokenPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${tokenPart({ alg: 'none' })}.${tokenPart({ sub: 'account-1', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
    const credentials = { token, credentialProvenance: 'stored_session' as const, encryption: { type: 'legacy' as const, secret } };
    const rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'e2ee',
      metadata: encodeBase64(encryptLegacy({ machineId: 'machine-1', path: directory }, secret)) });
    let releaseNative!: () => void;
    nativeModule.ready = new Promise<void>(resolve => { releaseNative = resolve; });
    const nativeSend = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({
      watch(next) { next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1,
        sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      send: nativeSend, async dispose() {},
    }));
    const harness = createHarness(false, false, async () => {}, sessionId);
    const comparison = ScmComparisonSchema.parse({ id: 'recovered-comparison', source: { kind: 'workingTree' },
      repository: { rootPath: directory }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
    const saved = await scmDiffSummaryResultStore.create({ cwd: directory, sessionId, output: {
      success: true, sourceKey: comparison.id, comparison, runId: 'run-1', requestedOutputs: ['walkthrough'],
      metadata: { source: comparison.source, sourceKey: comparison.id },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
      outputs: { walkthrough: { state: 'complete', value: { title: 'Saved', intro: '', stops: [], otherChangeRefs: [] } } },
    } });
    harness.runs.set('run-1', runState({ sessionId, status: 'failed', finishedAtMs: 2, intent: 'scm_diff_summary',
      launch: { cwd: directory }, intentInput: { cwd: directory, comparisonId: comparison.id, resultId: saved.resultId,
        comparison, metadata: saved.output.metadata, sourceKey: comparison.id, outputs: ['walkthrough'] },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: saved.output },
      error: { code: 'execution_run_host_lost', message: 'Host lost' },
    }));
    const app = fastify();
    const admitted: string[] = [];
    const boundaryFailures: unknown[] = [];
    const receivedAuthorities: ActionExecutorContext['authority'][] = [];
    let recovery: Promise<void> | undefined;
    harness.listExecutionRunPendingDeliveryStatuses.mockImplementation(async () => harness.pendingInputs.map(input => ({
      localId: input.localId!, status: 'queued' as const, deliveryStatus: { status: 'queued' as const },
    })));
    const deps = (machineAdmissionTransport?: Parameters<typeof createCliActionDeps>[0]['machineAdmissionTransport']) => createCliActionDeps({
      token, credentials, sessionId, mode: 'e2ee', ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, rawSession,
      serverId: 'cloud', serverHttpBaseUrl: origin, serverIdentityId: 'srv_refinement',
      resolveServerFeaturesSnapshot: () => undefined,
      ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}),
    });
    const daemonDeps = deps(async request => {
      try {
        expect(request).toMatchObject({ v: 2, sessionId, targetMachineId: 'machine-1', recipient: { kind: 'execution_run', runId: 'run-1' } });
        if (request.content.t !== 'encrypted') throw new Error('Expected encrypted Pending input');
        const message = UserMessageSchema.parse(decrypt(secret, 'legacy', decodeBase64(request.content.c)));
        expect(message.meta).toMatchObject({ happierProvenanceV1: { kind: 'cli' },
          happierInputRequestV1: { producer: 'cli', caller: { kind: 'host' } } });
        harness.pendingInputs.push({ ...message, localId: request.localId, authorAccountId: 'account-1', inputAdmissionReceipt: null,
          pendingProviderAction: 'send' });
        admitted.push(request.localId);
        // The Session pending-change boundary schedules reconciliation after durable admission.
        recovery = harness.manager.reconcilePendingExecutionRunTarget('run-1');
        return { status: 'accepted', localId: request.localId };
      } catch (error) { boundaryFailures.push(error); throw error; }
    });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'e2ee', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 1 }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: rawSession }));
    app.post('/v1/actions/session.message.send', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const receivedAuthority = request.headers['x-happier-authority-ceiling'] === 'account_automation' ? 'account_automation' : 'present_user';
      const envelope = ExternalActionRequestEnvelopeV2Schema.parse(request.body);
      const binding = { serverIdentityId: 'srv_refinement', accountId: 'account-1',
        authentication: { kind: 'account' as const, tokenEpoch: 1 }, actionId: 'session.message.send',
        requestId: envelope.requestId, target: { kind: 'session' as const, sessionId } };
      const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
      const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material });
      if (!opened) throw new Error('Expected current original Account request');
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSendMessage: async input => {
        receivedAuthorities.push(input.context?.authority);
        return await daemonDeps.sessionSendMessage(input);
      } });
      const execution = await executor.execute('session.message.send', opened.input, { surface: 'cli', authority: receivedAuthority });
      return prepareExternalActionResponseV2({ request: envelope, binding, material, executedMachineId: 'machine-1', execution,
        randomBytes: length => new Uint8Array(length).fill(5) }).response;
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    let response: unknown;
    let settled = false;
    let action: Promise<void> | undefined;
    try {
      const caller = deps(); // Exact standalone CLI composition: no Machine socket transport.
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSendMessage: caller.sessionSendMessage,
        executionRunGet: async () => ({ run: harness.manager.getPublic('run-1') }),
        executionRunEnsure: async () => await harness.manager.ensure('run-1', { resume: true }),
        scmActionExecute: async ({ actionId, input, executeCanonicalAction }) => executeScmActionOperation({ actionId, input,
          workingDirectory: directory, sessionId, authorizeSession: async id => id === sessionId, executeCanonicalAction }),
      });
      action = runWithServerHttpBaseUrl(origin, () => executor.execute('scm.diffSummary.refine', {
        cwd: directory, resultId: saved.resultId, expectedRevision: saved.revision, output: 'walkthrough', instructions: 'Shorten it.',
      }, { surface: 'cli', authority, serverIdentityId: 'srv_refinement' })).then(result => {
        response = result;
        settled = true;
      });
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(boundaryFailures).toEqual([]);
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { success: true, runId: 'run-1' } });
      expect(admitted).toHaveLength(1);
      expect(receivedAuthorities).toEqual([authority]);
      expect(nativeOpen).not.toHaveBeenCalled();
      expect(nativeSend).not.toHaveBeenCalled();
      const refused = await runWithServerHttpBaseUrl(origin, () => caller.sessionSendMessage({
        sessionId, message: 'Wrong target', recipient: { kind: 'execution_run', runId: 'run-1' }, localId: 'wrong-target',
        requestedAction: { v: 1, kind: 'send_now' },
        callerSurface: 'cli', actionCaller: { kind: 'host' }, context: { surface: 'cli', authority,
          externalActionTarget: { kind: 'machine', machineId: 'other-machine' } },
      }));
      expect(refused).toEqual({ status: 'rejected', code: 'session_input_target_unavailable' });
      expect(admitted).toHaveLength(1);
      releaseNative();
      await action;
      await recovery;
      await vi.waitFor(() => expect(nativeSend, JSON.stringify({ run: harness.manager.getPublic('run-1'),
        outcomes: harness.inputOutcomes })).toHaveBeenCalledOnce());
      expect(nativeSend.mock.calls[0]![0].inputIds).toEqual(admitted);
      expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
      expect(harness.runs.size).toBe(1);
      expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'running', lifecycle: { state: 'current' } });
    } finally {
      releaseNative();
      await action;
      await recovery;
      restore();
      await app.close();
    }
  });

  it.each([false, true])('reads retained original review findings after narration without disclosing them across Run scope (detached=%s)', async detached => {
    const harness = createHarness(detached);
    const sessionId = detached ? null : 'session-1';
    const finding = { runRef: { runId: 'run-1', callId: 'call-1', backendId: TEST_BACKEND_ID },
      generatedAtMs: 2, summary: 'Original review', overviewMarkdown: 'Original review', findings: [{ id: 'f1', title: 'Original finding',
        category: 'correctness', severity: 'high', summary: 'Original diagnosis' }] };
    harness.runs.set('run-1', runState({ sessionId, intent: 'review', status: 'succeeded',
      launch: { cwd: directory }, intentInput: { reviewNarration: { reviewFindings: [finding] } },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: {} } }));
    const rpc = createExecutionRunRpcActionDeps({ manager: harness.manager, context: { sessionId, cwd: directory },
      isExecutionRunsEnabled: () => true, policy: { maxConcurrentRuns: null, boundedTimeoutMs: null,
        reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
    const observed = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!(sessionId, { runId: 'run-1', includeStructured: true }));
    expect(observed).toMatchObject({ structuredMeta: { kind: 'scm_diff_summary.v1' },
      reviewFindings: { runRef: finding.runRef, findings: [{ id: 'f1' }] } });
    expect(await rpc.executionRunGet!(sessionId, { runId: 'run-1' })).not.toHaveProperty('reviewFindings');
    expect(await rpc.executionRunGet!(detached ? 'private-session' : null, { runId: 'run-1', includeStructured: true }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_scope_mismatch' });
    harness.runs.set('run-1', { ...harness.runs.get('run-1')!, intentInput: {
      reviewNarration: { reviewFindings: [{ ...finding, runRef: { ...finding.runRef, runId: 'other-run' } }] } } });
    expect(await rpc.executionRunGet!(sessionId, { runId: 'run-1', includeStructured: true })).not.toHaveProperty('reviewFindings');
  });
  it.each([
    { walkthrough: false }, { walkthrough: true }, { walkthrough: true, modelId: 'claude-haiku-5-5' },
  ])('admits a Review with its native default or explicit model through composed Action admission (walkthrough=$walkthrough, model=$modelId)', async ({ walkthrough, modelId }) => {
    execFileSync('git', ['init', directory], { stdio: 'ignore' });
    writeFileSync(join(directory, 'code.ts'), 'export const enabled = false;\n');
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const nativeSend = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({ watch() { return { dispose() {} }; }, send: nativeSend, async dispose() {} }));
    const harness = createHarness(false, true);
    const rpc = createExecutionRunRpcActionDeps({ manager: harness.manager, context: { sessionId: 'session-1', cwd: directory },
      isExecutionRunsEnabled: () => true, policy: { maxConcurrentRuns: null, boundedTimeoutMs: null,
        reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...rpc,
      reviewEnginesList: async () => ({ items: await buildReviewEngineInventoryItems({}) }),
    });
    const input = ReviewStartInputSchema.parse({ sessionId: 'session-1', engineIds: ['claude'], instructions: 'Review these changes.',
      comparisonId: captured.comparison.id,
      ...(modelId ? { modelId } : {}), ...(walkthrough ? { outputs: ['walkthrough'] } : {}),
    });
    const result = await executor.execute('review.start', input, { surface: 'cli', authority: 'present_user' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { results: [{ ok: true }] } });
    await vi.waitFor(() => expect(harness.runs.size).toBe(1));
    const run = [...harness.runs.values()][0]!;
    expect(run.backendId).toBe('claude');
    expect(run.launch?.modelId).toBe(modelId);
    await vi.waitFor(() => expect(nativeOpen).toHaveBeenCalledOnce());
    expect(nativeOpen.mock.calls[0]![0].configuration?.model?.value ?? null).toBe(modelId ?? null);
    if (walkthrough) expect(harness.enqueueSessionUserMessageWithDisposition).toHaveBeenCalledOnce();
    else await vi.waitFor(() => expect(nativeSend).toHaveBeenCalledOnce());
  });

  it('delivers attached Review JSON guidance and prepares a findings-first detached review using the same runtime fixture', async () => {
    {
      execFileSync('git', ['init', directory], { stdio: 'ignore' });
      execFileSync('git', ['-C', directory, 'config', 'user.name', 'Review fixture']);
      execFileSync('git', ['-C', directory, 'config', 'user.email', 'review@example.invalid']);
      writeFileSync(join(directory, 'code.ts'), 'export const enabled = false;\n');
      execFileSync('git', ['-C', directory, 'add', 'code.ts']);
      execFileSync('git', ['-C', directory, 'commit', '-m', 'fixture'], { stdio: 'ignore' });
      // An added line has an unambiguous after-side location. A replacement
      // at line one would correctly remain unmapped without a side anchor.
      writeFileSync(join(directory, 'code.ts'), 'export const enabled = false;\nexport const additional = true;\n');
      const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' } });
      const prepared = await ReviewProfile.prepareStartParams!({ cwd: directory, sessionId: null, request: {
        intent: 'review', instructions: 'Review.', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        intentInput: { cwd: '/untrusted-root', comparisonId: captured.comparison.id, outputs: ['walkthrough'] },
      } });
      expect(prepared).toMatchObject({ intentInput: { cwd: directory, comparison: captured.comparison, outputs: ['walkthrough'] } });
      let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
      nativeOpen.mockImplementation(async () => ({
        watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-review', sequence: 1,
          sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; }, send: sent, async dispose() {},
      }));
      const harness = createHarness(true);
      const started = await harness.manager.start({ sessionId: null, cwd: directory, intent: 'review',
        resolvedRole: resolveExecutionRunRoleV1({ roleId: 'reviewer', accountRoleOverrides: { status: 'ready', overrides: {} } }),
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id,
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', instructions: 'Review.',
        intentInput: { comparisonId: captured.comparison.id, outputs: ['walkthrough'] } });
      await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
      let sequence = 1;
      const finishTurn = (request: Parameters<AgentSessionRuntime['send']>[0], text: string) => {
        if (request.delivery.kind !== 'newTurn') throw new Error('Expected native review turn');
        const turnId = request.delivery.turnId;
        emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, inputIds: request.inputIds, delivery: request.delivery });
        emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, turnId, startedBy: 'host' });
        emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, turnId, channel: 'assistant', text });
        emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, turnId });
      };
      finishTurn(sent.mock.calls[0]![0], JSON.stringify({ summary: 'A changed condition', findings: [
        { id: 'f1', title: 'Changed condition', category: 'correctness', severity: 'high', summary: 'Check the changed condition', filePath: 'code.ts', startLine: 2 },
      ] }));
      await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
      finishTurn(sent.mock.calls[1]![0], JSON.stringify({ walkthrough: { title: 'Condition update', intro: 'One changed condition',
        stops: [{ id: 'condition', title: 'Condition', explanationMarkdown: 'The flag changed', changeRefs: ['c1'] }], otherChangeRefs: [] } }));
      const input = harness.runs.get(started.runId)!.intentInput as { resultId: string };
      await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: directory, resultId: input.resultId })).toMatchObject({ success: true,
        result: { output: { runId: started.runId, producer: { kind: 'review' }, outputs: { walkthrough: { value: { title: 'Condition update' } } } } } }));
      const saved = await scmDiffSummaryResultStore.read({ cwd: directory, resultId: input.resultId });
      if (!saved.success) throw new Error('Detached review result was not saved');
      const rpc = createExecutionRunRpcActionDeps({ manager: harness.manager, context: { sessionId: null, cwd: directory },
        isExecutionRunsEnabled: () => true, policy: { maxConcurrentRuns: null, boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
      const observed = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!(null, { runId: started.runId, includeStructured: true }));
      expect(observed).toMatchObject({ structuredMeta: { kind: 'scm_diff_summary.v1' },
        reviewFindings: { runRef: { runId: started.runId }, findings: [{ id: 'f1' }] } });
      const explanation = await harness.manager.applyAction(started.runId, { actionId: 'review.explain_findings', input: {
        reviewRunIds: [started.runId], cwd: directory, resultId: input.resultId, expectedRevision: saved.result.revision,
        findingIds: [{ runId: started.runId, findingId: 'f1' }],
      } });
      expect(explanation, JSON.stringify(explanation)).toMatchObject({ ok: true, result: { refinement: { input: { stopIds: ['condition'] } } } });
      expect(harness.runs.size).toBe(1);
      expect(harness.runs.get(started.runId)?.sessionId).toBeNull();
      expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
      // Exercise attached Pending after the exact repository comparison has
      // published, so the attached Run's activity files cannot enter that diff.
      const attachedSent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
      nativeOpen.mockImplementation(async () => ({ watch() { return { dispose() {} }; }, send: attachedSent, async dispose() {} }));
      const attached = createHarness();
      await attached.manager.start({ sessionId: 'session-1', cwd: directory, intent: 'review',
        resolvedRole: resolveExecutionRunRoleV1({ roleId: 'reviewer', accountRoleOverrides: { status: 'ready', overrides: {} } }),
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        instructions: 'Inspect the changed condition.' });
      await attached.firstEnqueuedInput;
      const pending = attached.enqueueSessionUserMessageWithDisposition.mock.calls[0]![0];
      await vi.waitFor(() => expect(attached.consume({ role: 'user', content: { type: 'text', text: pending.text },
        localId: pending.localId, authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true));
      await vi.waitFor(() => expect(attachedSent).toHaveBeenCalledOnce());
      const text = attachedSent.mock.calls[0]![0].input.text;
      expect(text).toContain('Inspect the changed condition.');
      expect(text).toContain('"findings": Array<');
      expect(text).toContain('"overviewMarkdown": string');
    }
  });
  it.each(['continued_review', 'seeded_narrator'] as const)('admits a detached %s walkthrough from exact captured evidence through native Run input custody', async mode => {
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({
      watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1,
        sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      send: sent, async dispose() {},
    }));
    const harness = createHarness(true);
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration)!;
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]!.id;
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' } });
    const review = runState({ sessionId: null, intent: 'review', status: 'succeeded', runClass: 'bounded', finishedAtMs: 2,
      requesterWorkAttributionV1: { serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1', installationId: 'installation-1' },
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: narrator.backendId, sourceKind: 'built_in' }, providerSessionId: 'provider-session-1' },
      ...(mode === 'seeded_narrator' ? { retentionPolicy: 'ephemeral' as const, resumeHandle: undefined } : {}),
      backendId: narrator.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator.backendId },
      launch: { cwd: directory, modelId }, intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator.backendId },
        summary: 'Findings', overviewMarkdown: 'Completed review', findings: [], questions: [], assumptions: [], generatedAtMs: 2 } } });
    harness.runs.set('run-1', review);
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id, narrator: { engineId: narrator.engineId },
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true });
    if (!acted.ok) throw new Error('Detached narration was refused');
    const response = ReviewWalkthroughResponseSchema.parse(acted.result);
    expect(response).toMatchObject({ mode, comparison: captured.comparison });
    const runId = response.runId;
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
    expect(harness.runs.get(runId)).toMatchObject({ sessionId: null, launch: { cwd: directory },
      requesterWorkAttributionV1: review.requesterWorkAttributionV1 });
    const delivery = sent.mock.calls[0]![0];
    expect(JSON.stringify(delivery)).toContain(mode === 'continued_review' ? 'Do not repeat the review' : 'reading the diffs, not reviewing them');
    if (delivery.delivery.kind !== 'newTurn') throw new Error('Detached narration must be a native turn');
    const turnId = delivery.delivery.turnId;
    emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2, inputIds: delivery.inputIds, delivery: delivery.delivery });
    emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 3, emittedAtMs: 3, turnId, startedBy: 'host' });
    emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId, channel: 'assistant',
      text: JSON.stringify({ walkthrough: { title: 'Detached narration', intro: '', stops: [], otherChangeRefs: [] } }) });
    emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 5, emittedAtMs: 5, turnId });
    const input = harness.runs.get(runId)!.intentInput as { resultId: string };
    await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: directory, resultId: input.resultId })).toMatchObject({ success: true,
      result: { output: { runId, producer: { kind: 'review' }, outputs: { walkthrough: { value: { title: 'Detached narration' } } } } } }));
    const savedScope = await scmDiffSummaryResultStore.readStoredScope({ cwd: directory, resultId: input.resultId });
    expect(savedScope).toMatchObject({ cwd: directory });
    expect(savedScope?.sessionId).toBeUndefined();
    const privateCapture = await captureScmComparison({ cwd: directory, source: { kind: 'session', sessionId: 'private-session' }, sessionId: 'private-session' });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: privateCapture.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'comparison_unavailable' });
    harness.runs.set('foreign-root', { ...review, runId: 'foreign-root', launch: { cwd: join(directory, 'other') }, intentInput: { cwd: join(directory, 'other') } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'foreign-root'], comparisonId: captured.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    harness.runs.set('foreign-home', { ...review, runId: 'foreign-home', requesterWorkAttributionV1: { ...review.requesterWorkAttributionV1!, serverId: 'home-2' } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'foreign-home'], comparisonId: captured.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    harness.runs.set('legacy-owner', { ...review, runId: 'legacy-owner', requesterWorkAttributionV1: undefined });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'legacy-owner'], comparisonId: captured.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    const privateResult = await scmDiffSummaryResultStore.create({ cwd: directory, sessionId: 'private-session', output: {
      success: true, sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'pending' } },
      analysis: { suppliedChangeRefs: captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id)),
        analysedChangeRefs: [], remainingChangeRefs: captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id)) },
    } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input: {
      reviewRunIds: ['run-1'], cwd: directory, resultId: privateResult.resultId, expectedRevision: privateResult.revision,
      findingIds: [{ runId: 'run-1', findingId: 'finding-1' }],
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
  });
  it.each([false, true])('explains only exact current host findings in their matching saved stops (detached=%s)', async detached => {
    const harness = createHarness(detached);
    const sessionScope = detached ? {} : { sessionId: 'session-1' };
    const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'workingTree' }, repository: { rootPath: directory },
      endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{ path: 'new.ts', previousPath: 'old.ts', changeKind: 'renamed',
        binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '@@ -20,2 +10,2 @@' },
        occurrences: [{ id: 'change-1', alias: 'c1', path: 'new.ts', position: 0, before: { startLine: 20, lineCount: 2 }, after: { startLine: 10, lineCount: 2 } },
          { id: 'change-2', alias: 'c2', path: 'new.ts', position: 1, before: { startLine: 40, lineCount: 2 }, after: { startLine: 30, lineCount: 2 } }] }] } });
    const saved = await scmDiffSummaryResultStore.create({ cwd: directory, ...sessionScope, output: { success: true,
      sourceKey: comparison.id, comparison, runId: 'run-1', metadata: { source: comparison.source, sourceKey: comparison.id }, requestedOutputs: ['walkthrough'],
      analysis: { suppliedChangeRefs: ['change-1', 'change-2'], analysedChangeRefs: ['change-1', 'change-2'], remainingChangeRefs: [] },
      outputs: { walkthrough: { state: 'complete', value: { title: 'Changes', intro: '', stops: [
        { id: 'target', title: 'Target', explanationMarkdown: 'Original', changeRefs: ['change-1'], findingRefs: ['run-1:f1'] },
        { id: 'unrelated', title: 'Keep me', explanationMarkdown: 'Unrelated prose', changeRefs: ['change-2'] }], otherChangeRefs: [] } } } } });
    const runRef = { runId: 'run-1', callId: 'call-1', backendId: TEST_BACKEND_ID };
    await scmDiffSummaryResultStore.beginInput({ cwd: directory, ...sessionScope, resultId: saved.resultId,
      inputId: 'published-narration', outputs: ['walkthrough'], reviewFindingCitations: [{ alias: 'F1', runId: 'run-1', findingId: 'f1' }] });
    await scmDiffSummaryResultStore.abandonInput({ cwd: directory, ...sessionScope, resultId: saved.resultId, inputId: 'published-narration' });
    const finding = { id: 'f1', title: 'Issue', category: 'correctness', severity: 'high', summary: 'Old diagnosis', filePath: 'new.ts', startLine: 10 };
    const review = runState({ sessionId: detached ? null : 'session-1', intent: 'review', launch: { cwd: directory },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: saved.output },
      intentInput: { cwd: directory, comparisonId: comparison.id, reviewNarration: { reviewStatus: 'succeeded', reviewFindings: [{ runRef,
        summary: 'Findings', overviewMarkdown: 'Findings', findings: [finding], questions: [], assumptions: [], generatedAtMs: 1 }] } } });
    harness.runs.set('run-1', review);
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', status: 'succeeded', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: runRef, threadId: 'thread', findingIds: ['f1'], requestMarkdown: 'Clarify',
        answerMarkdown: 'Clarified', generatedAtMs: 2, updatedFindings: [{ ...finding, summary: 'Current diagnosis' }] } } });
    const input = { reviewRunIds: ['run-1'], cwd: directory, resultId: saved.resultId, expectedRevision: saved.revision,
      findingIds: [{ runId: 'run-1', findingId: 'f1' }], instructions: 'Keep this human request unchanged.' };
    const privateSource = await scmDiffSummaryResultStore.create({ cwd: directory, ...sessionScope, output: {
      ...saved.output,
      success: true, sourceKey: comparison.id, comparison: { ...comparison, source: { kind: 'session', sessionId: 'private-session' } },
      metadata: { source: { kind: 'session', sessionId: 'private-session' }, sourceKey: comparison.id },
    } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input: {
      ...input, resultId: privateSource.resultId, expectedRevision: privateSource.revision,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input });
    expect(acted).toMatchObject({ ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: { output: 'walkthrough', stopIds: ['target'] } } } });
    expect(JSON.stringify(acted)).toContain('Current diagnosis');
    expect(JSON.stringify(acted)).not.toContain('Old diagnosis');
    if (!acted.ok) throw new Error('Finding explanation preparation failed');
    const refinement = ScmDiffSummaryRefineInputSchema.parse((acted.result as { refinement: { input: unknown } }).refinement.input);
    expect(refinement.instructions).toContain('"id":"F1"');
    expect(refinement.instructions).not.toContain('"id":"f1"');
    expect(refinement.instructions).toContain(input.instructions);
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input: { ...input,
      findingIds: [{ runId: 'foreign-run', findingId: 'f1' }] } })).toMatchObject({ ok: false, errorCode: 'review_finding_unmapped' });
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, ...sessionScope, resultId: saved.resultId })).toMatchObject({ success: true,
      result: { revision: saved.revision, output: { outputs: { walkthrough: { value: { stops: [{ id: 'target', explanationMarkdown: 'Original' },
        { id: 'unrelated', explanationMarkdown: 'Unrelated prose' }] } } } } } });
    let sent: { message: string; localId: string } | undefined;
    // RPC transport is the boundary; the generic Action's prompt, admission and saved writer remain real.
    const executeCanonicalAction: Parameters<ScmActionExecute>[0]['executeCanonicalAction'] = async (actionId, actionInput) => {
      if (actionId === 'execution.run.get') return { ok: true, result: ExecutionRunGetResponseSchema.parse({ run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'review', status: 'running', startedAtMs: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', lifecycle: { v: 1, state: 'current' },
        interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
      } }) };
      if (actionId !== (detached ? 'execution.run.send' : 'session.message.send')) throw new Error('Explanation must target the saved generator');
      const message = actionInput as { message: string; localId?: string; localInputId?: string };
      sent = { message: message.message, localId: (message.localId ?? message.localInputId)! };
      if (detached) return { ok: true, result: { ok: true } };
      return { ok: true, result: { status: 'accepted', localId: sent.localId } };
    };
    expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.refine', input: refinement, workingDirectory: directory,
      ...sessionScope, authorizeSession: async id => !detached && id === 'session-1', executeCanonicalAction, actionContext: { surface: 'rpc', authority: 'present_user',
        ...(detached ? { externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory } } } : {}) } }))
      .toMatchObject({ success: true, runId: 'run-1' });
    expect(sent?.message).toContain('"id":"F1"');
    expect(sent?.message).not.toContain('"id":"f1"');
    expect(await scmDiffSummaryResultStore.publish({ cwd: directory, ...sessionScope, resultId: saved.resultId, inputId: sent!.localId,
      modelOutput: { reviewExplanations: [{ stopId: 'target', markdown: '[current](finding:F1)' }] } }))
      .toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
        { explanationMarkdown: 'Original', reviewExplanations: [{ markdown: '[current](finding:run-1:f1)' }] },
        { id: 'unrelated', explanationMarkdown: 'Unrelated prose' },
      ] } } } } } });
  });
  it.each(['collect', 'cancel', 'rejected', 'outcomeUnknown'] as const)('returns one deferred narrator identity immediately and owns %s through its existing lifetime', async (outcome) => {
    nativeOpen.mockImplementation(async () => ({
      watch(next) { next({ kind: 'provider-session-id', providerSessionId: 'narrator-session', sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; }, async dispose() {},
    }));
    const harness = createHarness();
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration);
    expect(narrator).toBeDefined();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    expect(modelId).toBeDefined();
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const finding = { id: 'finding-1', title: 'Original', severity: 'high', category: 'correctness', summary: 'Original diagnosis' };
    const review = runState({ intent: 'review', status: 'succeeded', runClass: 'bounded', retentionPolicy: 'ephemeral', finishedAtMs: 2,
      backendId: narrator!.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator!.backendId },
      launch: { cwd: directory, modelId },
      intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        summary: 'One finding', overviewMarkdown: 'Review completed.', findings: [finding], questions: [], assumptions: [], generatedAtMs: 2,
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'], materialization: { kind: 'complete' } } } });
    harness.runs.set('run-1', review);
    harness.runs.set('run-2', { ...review, runId: 'run-2', callId: 'call-2', sidechainId: 'sidechain-2', status: 'running', structuredMeta: undefined });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'run-2'], comparisonId: captured.comparison.id, narrator: { engineId: narrator!.engineId },
      launchFailures: [{ engineId: 'failed-engine', errorCode: 'engine_unavailable', error: 'Engine never started' }],
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true, result: { mode: 'seeded_narrator', state: 'collecting' } });
    if (!acted.ok) throw new Error('Narrator admission failed');
    const result = acted.result as { runId: string };
    await vi.waitFor(() => expect(nativeOpen).toHaveBeenCalledOnce());
    expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
    if (outcome === 'cancel') {
      await harness.manager.stop(result.runId);
      await harness.manager.stop('run-2');
      expect(harness.manager.get(result.runId)).toMatchObject({ status: 'cancelled' });
      expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
      expect(harness.manager.get('run-1')?.structuredMeta).toEqual(review.structuredMeta);
      return;
    }
    if (outcome === 'rejected' || outcome === 'outcomeUnknown') harness.enqueueSessionUserMessageWithDisposition.mockImplementation(async ({ localId }) => (
      SessionInputAdmissionResultV1Schema.parse(outcome === 'rejected'
        ? { status: 'rejected', code: 'session_input_target_unavailable' }
        : { status: 'outcomeUnknown', localId, code: 'narrator_transport_failure' })
    ));
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId }, threadId: 'thread-1',
        findingIds: ['finding-1'], requestMarkdown: 'Clarify', answerMarkdown: 'Latest answer', generatedAtMs: 3,
        updatedFindings: [{ ...finding, title: 'Current', summary: 'Current diagnosis' }] },
    } });
    await harness.manager.stop('run-2');
    await harness.firstEnqueuedInput;
    expect(harness.enqueueSessionUserMessageWithDisposition).toHaveBeenCalledOnce();
    if (outcome === 'rejected' || outcome === 'outcomeUnknown') {
      await vi.waitFor(() => expect(harness.manager.get(result.runId)).toMatchObject({ error: {
        code: outcome === 'outcomeUnknown' ? 'execution_run_send_outcome_unknown' : 'admission_failed' } }));
      if (outcome === 'rejected') await vi.waitFor(() => expect(harness.manager.get(result.runId)?.structuredMeta).toMatchObject({
        kind: 'scm_diff_summary.v1', payload: { outputs: { walkthrough: { state: 'failed' } } } }));
      await harness.manager.waitForOutput(result.runId, { kind: 'review_walkthrough', comparisonId: captured.comparison.id });
      expect(harness.manager.get('run-1')?.structuredMeta).toEqual(review.structuredMeta);
      expect(nativeOpen.mock.calls.map(([request]) => request.kind)).toEqual(['create']);
      return;
    }
    const input = harness.enqueueSessionUserMessageWithDisposition.mock.calls[0]![0];
    expect(input).toMatchObject({ recipient: { kind: 'execution_run', runId: result.runId } });
    expect(input.text).toContain('reading the diffs, not reviewing them');
    expect(input.text).toContain('Current diagnosis');
    expect(input.text).not.toContain('Original diagnosis');
    expect(nativeOpen.mock.calls.map(([request]) => request.kind)).toEqual(['create']);
    expect(harness.manager.get(result.runId)?.intentInput).toMatchObject({ reviewNarration: { provenance: {
      narrationMode: 'seeded_narrator', reviewedRuns: [{ runId: 'run-1', status: 'succeeded',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'], materialization: { kind: 'complete' } },
        { runId: 'run-2', status: 'cancelled', hasOutput: false }],
      launchFailures: [{ engineId: 'failed-engine', errorCode: 'engine_unavailable', error: 'Engine never started' }],
    } } });
    expect(acted).toMatchObject({ result: { comparison: captured.comparison } });
  });

  it.each(['succeeded', 'failed'] as const)('continues a finished %s bounded review with an explicitly requested walkthrough and keeps later chat from rewriting it', async (reviewStatus) => {
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({
      watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      send: sent, async dispose() {},
    }));
    const harness = createHarness();
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration);
    expect(narrator).toBeDefined();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    expect(modelId).toBeDefined();
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const review = runState({ intent: 'review', status: reviewStatus, runClass: 'bounded', finishedAtMs: 2,
      ...(reviewStatus === 'failed' ? { error: { code: 'review_comment_materialization_failed', message: 'Finding retained despite materialization failure' } } : {}),
      backendId: narrator!.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator!.backendId },
      launch: { cwd: directory, modelId },
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: narrator!.backendId, sourceKind: 'built_in' }, providerSessionId: 'provider-session-1' },
      intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        summary: 'One finding', overviewMarkdown: 'Review completed.', findings: [{ id: 'finding-1', title: 'Original finding', severity: 'high', category: 'correctness', summary: 'Original diagnosis' }],
        questions: [], assumptions: [], generatedAtMs: 2, reviewOutcome: reviewStatus === 'failed' ? 'partial' : 'complete',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'],
        materialization: reviewStatus === 'failed' ? { kind: 'partial', errorCode: 'review_comment_materialization_failed' } : { kind: 'complete' } } } });
    harness.runs.set('run-1', review);
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', status: 'succeeded', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        threadId: 'thread-1', findingIds: ['finding-1'], requestMarkdown: 'Clarify', answerMarkdown: 'Latest answer', generatedAtMs: 3,
        updatedFindings: [{ id: 'finding-1', title: 'Current finding', severity: 'high', category: 'correctness', summary: 'Current diagnosis' }] },
    } });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id,
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true, result: { runId: 'run-1', mode: 'continued_review', state: 'writing' } });
    expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
    expect(harness.runs.size).toBe(2);
    expect(harness.runs.get('run-1')).toMatchObject({ runClass: 'long_lived', intent: 'review', intentInput: { reviewNarration: { phase: 'writing' } } });
    const pending = harness.enqueueSessionUserMessageWithDisposition.mock.calls[0]?.[0];
    expect(pending).toMatchObject({ recipient: { kind: 'execution_run', runId: 'run-1' }, requestedAction: { kind: 'enqueue' } });
    expect(pending?.text).toContain('Do not repeat the review');
    expect(pending?.text).toContain('Current diagnosis');
    expect(pending?.text).not.toContain('Original diagnosis');
    expect(pending?.text).toContain('"id":"F1"');
    expect(pending?.text).not.toContain('finding-1');
    const input = harness.runs.get('run-1')?.intentInput as { resultId: string };
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId })).toMatchObject({ success: true, result: { output: { runId: 'run-1' } } });
    expect(harness.consume({ role: 'user', content: { type: 'text', text: pending!.text }, localId: pending!.localId,
      authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    expect(JSON.stringify(sent.mock.calls)).toContain('Current diagnosis');
    expect(JSON.stringify(sent.mock.calls)).not.toContain('Original diagnosis');
    expect(JSON.stringify(sent.mock.calls)).not.toContain('finding-1');
    expect(harness.runs.get('run-1')?.intentInput).toMatchObject({ reviewNarration: { reviewStatus, provenance: { reviewedRuns: [
      { runId: 'run-1', status: reviewStatus, reviewOutcome: reviewStatus === 'failed' ? 'partial' : 'complete',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'],
        materialization: reviewStatus === 'failed' ? { kind: 'partial', errorCode: 'review_comment_materialization_failed' } : { kind: 'complete' } }] } } });
    expect(acted).toMatchObject({ result: { comparison: captured.comparison } });
    const delivery = sent.mock.calls[0]![0].delivery;
    if (delivery.kind !== 'newTurn') throw new Error('The narration was not admitted as a new native turn');
    emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2,
      inputIds: sent.mock.calls[0]![0].inputIds, delivery });
    emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 3, emittedAtMs: 3, turnId: delivery.turnId, startedBy: 'host' });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id } })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    const controller = harness.controllers.get('run-1') as ExecutionRunBackendController;
    emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId: delivery.turnId,
      channel: 'assistant', text: JSON.stringify({ walkthrough: { title: 'Saved narration', intro: 'No captured readable changes', stops: [], otherChangeRefs: [] } }) });
    emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 5, emittedAtMs: 5, turnId: delivery.turnId });
    let publicationBeforeNextDelivery: unknown;
    sent.mockImplementationOnce(async request => {
      publicationBeforeNextDelivery = await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId });
      if (request.delivery.kind !== 'newTurn') throw new Error('The next narration was not a new native turn');
      emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 6, emittedAtMs: 6,
        inputIds: request.inputIds, delivery: request.delivery });
      emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 7, emittedAtMs: 7, turnId: request.delivery.turnId, startedBy: 'host' });
      emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 8, emittedAtMs: 8, turnId: request.delivery.turnId,
        channel: 'assistant', text: JSON.stringify({ walkthrough: { title: 'Next narration', intro: '', stops: [], otherChangeRefs: [] } }) });
      emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 9, emittedAtMs: 9, turnId: request.delivery.turnId });
      return { status: 'admitted' };
    });
    expect(harness.consume({ role: 'user', content: { type: 'text', text: 'Why keep these findings?' }, localId: 'next-narration',
      authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(publicationBeforeNextDelivery).toMatchObject({ success: true,
      result: { output: { outputs: { walkthrough: { value: { title: 'Saved narration' } } } } } }));
    await controller.pendingHostBarrier;
    await vi.waitFor(() => expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: false }));
    // Chat has no admitted output scope. Even unsolicited structured model output
    // cannot grant itself permission to replace the saved walkthrough.
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId }))
      .toEqual(publicationBeforeNextDelivery);
    expect(harness.manager.get('run-1')).toMatchObject({ status: 'running' });
    const again = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id } });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true, result: { runId: 'run-1', mode: 'continued_review' } });
    expect(nativeOpen).toHaveBeenCalledOnce();
    expect(harness.runs.size).toBe(2);
  });
  it('reopens a terminal recoverable exact target through real ensure and its native provider session', async () => {
    nativeOpen.mockReset();
    nativeOpen.mockImplementation(async () => {
      let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      return { watch(next) { listener = next; listener({ kind: 'provider-session-id', providerSessionId: 'provider-session-1',
        sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() { listener = undefined; } }; },
        async send() { return { status: 'admitted' as const }; }, async dispose() {} };
    });
    const harness = createHarness();
    harness.runs.set('run-1', runState({ status: 'succeeded', finishedAtMs: 2 }));
    try {
      await harness.manager.reconcilePendingExecutionRunTarget('run-1');
      expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
      expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'running', lifecycle: { state: 'current' } });
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    } finally { await harness.manager.dispose(); }
  });
  it('leaves an unknown target queued without ensure or block', async () => {
    const harness = createHarness();
    const ensure = vi.spyOn(harness.manager, 'ensure');

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
  });

  it('keeps the accepted target queued while its native module is still loading', async () => {
    let releaseModule!: () => void;
    nativeModule.ready = new Promise<void>(resolve => { releaseModule = resolve; });
    nativeOpen.mockImplementation(async () => ({
      watch(next) { next({ kind: 'provider-session-id', providerSessionId: 'new-provider-session', sequence: 1,
        sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; }, async dispose() {},
    }));
    const harness = createHarness();
    try {
      const started = await harness.manager.start({ sessionId: 'session-1', cwd: directory, intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', instructions: '' });
      expect(nativeOpen).not.toHaveBeenCalled();
      await harness.manager.reconcilePendingExecutionRunTarget(started.runId);
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
      releaseModule();
      await (harness.controllers.get(started.runId) as ExecutionRunBackendController).provisioningPromise;
      expect(nativeOpen).toHaveBeenCalledOnce();
      expect(harness.manager.getPublic(started.runId)).toMatchObject({ lifecycle: { state: 'current' } });
      await harness.manager.reconcilePendingExecutionRunTarget(started.runId);
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    } finally {
      releaseModule();
      await harness.manager.dispose();
    }
  });

  it.each(['indeterminate', 'permanent'] as const)('classifies a native %s resume failure through real ensure', async (failureKind) => {
    const error = new Error('Native provider cannot currently resume this exact session');
    if (failureKind === 'permanent') Object.assign(error, { code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
    nativeOpen.mockRejectedValue(error);
    const harness = createHarness();
    harness.runs.set('run-1', runState({ status: 'succeeded', finishedAtMs: 2 }));

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
    expect(harness.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    if (failureKind === 'permanent') {
      expect(harness.manager.getPublic('run-1')).toMatchObject({ lifecycle: { state: 'unavailable' }, error: { code: 'execution_run_provider_state_missing' } });
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledOnce();
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    } else {
      expect(harness.manager.getPublic('run-1')).toMatchObject({ lifecycle: { state: 'recoverable' } });
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    }
  });

  it('does not block when a concurrent resume installs the target controller', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState());
    vi.spyOn(harness.manager, 'ensure').mockImplementation(async () => {
      harness.controllers.set('run-1', {
        kind: 'backend',
        cancelled: false,
        backend: { interaction: {} },
      });
      return {
        ok: false,
        errorCode: 'execution_run_not_allowed',
        error: 'Resume already in progress',
        resumeFailureKind: 'indeterminate',
      };
    });

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    harness.controllers.clear();
    harness.runs.clear();
  });

  it('keeps a superseded resume queued after its provisional controller has retired', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState());
    vi.spyOn(harness.manager, 'ensure').mockResolvedValue({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Resume was superseded',
      resumeFailureKind: 'indeterminate',
    });

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.controllers.has('run-1')).toBe(false);
    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    harness.runs.clear();
  });

  it('blocks a Voice target whose canonical lifecycle has no retained Voice configuration', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState({ intent: 'voice_agent' }));

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    harness.runs.clear();
  });

  it.each([
    ['permanently failed', { status: 'failed' as const, error: { code: 'execution_run_provider_state_missing', message: 'Native provider state is missing' } }],
    ['wrong Session', { sessionId: 'session-2' }],
    ['noninteractive', { runClass: 'bounded' as const, retentionPolicy: 'ephemeral' as const }],
    ['permanently unavailable', { resumeHandle: null }],
  ])('blocks only the queued exact row for a proven %s target', async (_label, overrides) => {
    const harness = createHarness();
    harness.runs.set('run-1', runState(overrides));
    const ensure = vi.spyOn(harness.manager, 'ensure');

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(harness.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledTimes(1);
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    harness.runs.clear();
  });
});
