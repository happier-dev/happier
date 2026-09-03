import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunUserTranscriptDirective } from '@happier-dev/protocol';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import {
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV1,
  ExecutionRunPublicStateSchema,
  type ExecutionRunPublicState,
} from '@happier-dev/protocol';

import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { VoiceAgentError, VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { resolveCliVoicePromptStackBlocks } from '@/agent/promptLibrary/resolveCliVoicePromptStackBlocks';
import { configuration } from '@/configuration';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type {
  ExecutionRunActionParams,
  ExecutionRunActionResult,
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
} from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';
import {
  cancelVoiceAgentTurnStream,
  commitVoiceAgentUserTranscript,
  readVoiceAgentTurnStream,
  startVoiceAgentTurnStream,
} from '@/agent/executionRuns/runtime/voiceAgentTurnStreams';
import {
  prepareBackendLongLivedRunResume,
  sendBackendLongLivedRun,
  sendPreparedBackendLongLivedRun,
} from '@/agent/executionRuns/runtime/backendLongLivedSend';
import { stopExecutionRun } from '@/agent/executionRuns/runtime/executionRunStop';
import { applyExecutionRunAction } from '@/agent/executionRuns/runtime/executionRunApplyAction';
import { getExecutionRunAvailableActionIds } from '@/agent/executionRuns/runtime/getExecutionRunAvailableActionIds';
import { executeBoundedBackendRun } from '@/agent/executionRuns/runtime/boundedBackendRun';
import { ensureExecutionRun } from '@/agent/executionRuns/runtime/executionRunManager/ensureExecutionRun';
import { finishExecutionRun } from '@/agent/executionRuns/runtime/executionRunManager/finishExecutionRun';
import { startExecutionRun } from '@/agent/executionRuns/runtime/executionRunManager/startExecutionRun';
import {
  resolveExecutionRunResumeBackendOptions,
  type PrepareExecutionRunConnectedServicesForResume,
} from '@/agent/executionRuns/runtime/rehydrateExecutionRunBackendLaunch';
import {
  enqueueExecutionRunMarkerWrite,
  writeExecutionRunActivityMarker,
} from '@/agent/executionRuns/runtime/executionRunManager/activityMarkers';
import { deriveExecutionRunRuntimeActivityContribution } from '@/agent/executionRuns/runtime/executionRunRuntimeActivity';

function readBoundedExternalSendAckTimeoutMs(): number {
  const raw = process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return 20_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 20_000;
  return Math.min(parsed, 120_000);
}

export class ExecutionRunManager {
  private readonly parentProvider: ACPProvider;
  private readonly cwd: string;
  private readonly createBackend: (opts: {
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    modelId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: ExecutionRunBackendStartContext;
    connectedServicesEnv?: Readonly<Record<string, string>> | null;
    connectedServicesCleanup?: (() => Promise<void>) | null;
  }) => AgentBackend;
  private readonly resolveAccountSettings: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  private readonly prepareConnectedServices: PrepareExecutionRunConnectedServicesForResume | null;
  private readonly sendAcp: AcpSendFn;
  private readonly streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  private readonly transcriptWriter:
    | Readonly<{
        appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
        appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
        appendUserTextCommitted?: (
          text: string,
          options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
        ) => Promise<void>;
        appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
      }>
    | null;
  private readonly getNowMs: () => number;
  private readonly boundedTimeoutMs: number | null;
  private readonly maxTurns: number | null;
  private readonly budgetRegistry: ExecutionBudgetRegistry | null;
  private readonly runtimeActivityContributionHandle: SessionRuntimeActivityContributionHandle | null;
  private readonly runs = new Map<string, ExecutionRunState>();
  private readonly controllers = new Map<string, ExecutionRunController>();
  private readonly markerWriteChains = new Map<string, Promise<void>>();
  private readonly terminalMarkerWritePromises = new Map<string, Promise<void>>();
  private readonly terminalRuntimeActivityPromises = new Map<string, Promise<void>>();
  private readonly runLifecycleTails = new Map<string, Promise<void>>();
  private readonly voiceAgentManager: VoiceAgentManager;
  private readonly onPublicStateUpdated: ((run: ExecutionRunPublicState) => void) | null;

  private emitPublicStateUpdated(runId: string): void {
    const callback = this.onPublicStateUpdated;
    if (!callback) return;
    const run = (() => {
      try {
        return this.getPublic(runId);
      } catch {
        return null;
      }
    })();
    if (!run) return;
    try {
      callback(run);
    } catch {
      // Best effort
    }
  }

  resolveStartRequest(params: Readonly<{
    startRequestId?: string | null;
    startRequestFingerprint?: string | null;
  }>): ExecutionRunStartResult | null {
    const startRequestId = params.startRequestId?.trim() ?? '';
    if (!startRequestId) return null;
    const existing = Array.from(this.runs.values()).find((run) => run.startRequestId === startRequestId);
    if (!existing) return null;
    if (
      !params.startRequestFingerprint
      || !existing.startRequestFingerprint
      || params.startRequestFingerprint !== existing.startRequestFingerprint
    ) {
      const error = new Error('Execution run start request conflicts with an existing accepted start');
      Object.assign(error, { code: 'execution_run_start_conflict' });
      throw error;
    }
    return {
      runId: existing.runId,
      callId: existing.callId,
      sidechainId: existing.sidechainId,
    };
  }

  private enqueueMarkerWrite(runId: string, write: () => Promise<void>): Promise<void> {
    return enqueueExecutionRunMarkerWrite({ markerWriteChains: this.markerWriteChains, runId, write });
  }

  private async writeActivityMarker(runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>): Promise<void> {
    await writeExecutionRunActivityMarker({
      runId,
      nowMs,
      opts,
      runs: this.runs,
      controllers: this.controllers,
      enqueueMarkerWrite: this.enqueueMarkerWrite.bind(this),
    });
  }

  private async admitRunRuntimeActivity(runId: string): Promise<void> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    if (this.runtimeActivityContributionHandle) {
      await this.runtimeActivityContributionHandle.report(
        deriveExecutionRunRuntimeActivityContribution(this.runs),
        'execution-run-admitted',
      );
      return;
    }
  }

  private publishRunRuntimeActivityTerminal(
    runId: string,
    reason: string,
    terminalStateOverride?: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return Promise.resolve();
    if (this.runtimeActivityContributionHandle) {
      return this.runtimeActivityContributionHandle.report(
        deriveExecutionRunRuntimeActivityContribution(this.runs),
        reason,
      );
    }
    return Promise.resolve();
  }

  private async rollbackRunRuntimeActivityAfterFailedAdmission(reason: string): Promise<void> {
    if (!this.runtimeActivityContributionHandle) return;
    await this.runtimeActivityContributionHandle.report(
      deriveExecutionRunRuntimeActivityContribution(this.runs),
      reason,
    );
  }

  private trackRunRuntimeActivityTerminal(
    runId: string,
    reason: string,
    terminalStateOverride?: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const terminal = this.publishRunRuntimeActivityTerminal(runId, reason, terminalStateOverride);
    this.terminalRuntimeActivityPromises.set(runId, terminal);
    // The completion/drain APIs observe the original promise. This handler only prevents an
    // unhandled rejection if a caller never waits; it does not convert failure into success.
    void terminal.catch(() => {});
    return terminal;
  }

  private async withRunLifecycleLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runLifecycleTails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentTail = previous.catch(() => {}).then(() => currentGate);
    this.runLifecycleTails.set(runId, currentTail);

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.runLifecycleTails.get(runId) === currentTail) {
        this.runLifecycleTails.delete(runId);
      }
    }
  }

  constructor(opts: Readonly<{
    parentProvider: ACPProvider;
    cwd: string;
    createBackend: (opts: {
      runId?: string;
      backendId: string;
      backendTarget?: BackendTargetRefV1;
      permissionMode: string;
      modelId?: string;
      sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
      accountSettings?: Readonly<Record<string, unknown>> | null;
      start?: ExecutionRunBackendStartContext;
      connectedServicesEnv?: Readonly<Record<string, string>> | null;
      connectedServicesCleanup?: (() => Promise<void>) | null;
    }) => AgentBackend;
    sendAcp: AcpSendFn;
    streamedTranscriptSession?: StreamedTranscriptWriterSession;
    transcriptWriter?: Readonly<{
      appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
      appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
      appendUserTextCommitted?: (
        text: string,
        options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
      ) => Promise<void>;
      appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
    }>;
    onPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
    getNowMs?: () => number;
    boundedTimeoutMs?: number;
    maxTurns?: number;
    budgetRegistry?: ExecutionBudgetRegistry;
    runtimeActivityContributionHandle?: SessionRuntimeActivityContributionHandle | null;
    resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    /**
     * Canonical connected-services owner used to RE-materialize a run's account on resume, driven by
     * the persisted launch selection. Same owner start uses. Absent means resume cannot re-materialize
     * CS — a run with a persisted connected selection then fails closed on resume.
     */
    prepareConnectedServices?: PrepareExecutionRunConnectedServicesForResume;
    resolveVoicePromptStackBlocks?: (args: Readonly<{
      settings?: unknown;
      profileId?: string | null;
      sessionId?: string | null;
      workingDirectory?: string | null;
    }>) => Promise<readonly string[]>;
  }>) {
    this.parentProvider = opts.parentProvider;
    this.cwd = opts.cwd;
    this.createBackend = opts.createBackend;
    this.sendAcp = opts.sendAcp;
    this.streamedTranscriptSession = opts.streamedTranscriptSession ?? null;
    this.transcriptWriter = opts.transcriptWriter ?? null;
    this.getNowMs = opts.getNowMs ?? (() => Date.now());
    this.boundedTimeoutMs =
      typeof opts.boundedTimeoutMs === 'number' && Number.isFinite(opts.boundedTimeoutMs) && opts.boundedTimeoutMs >= 1
        ? Math.floor(opts.boundedTimeoutMs)
        : null;
    this.maxTurns =
      typeof opts.maxTurns === 'number' && Number.isFinite(opts.maxTurns) && opts.maxTurns >= 1
        ? Math.floor(opts.maxTurns)
        : null;
    this.budgetRegistry = opts.budgetRegistry ?? null;
    this.runtimeActivityContributionHandle = opts.runtimeActivityContributionHandle ?? null;
    this.onPublicStateUpdated = typeof opts.onPublicStateUpdated === 'function' ? opts.onPublicStateUpdated : null;
    const resolveAccountSettings = opts.resolveAccountSettings ?? (async () => null);
    this.resolveAccountSettings = resolveAccountSettings;
    this.prepareConnectedServices = opts.prepareConnectedServices ?? null;
    const resolveVoicePromptStackBlocks = opts.resolveVoicePromptStackBlocks
      ?? (async ({
        settings,
        profileId,
      }: Readonly<{
        settings?: unknown;
        profileId?: string | null;
        sessionId?: string | null;
        workingDirectory?: string | null;
      }>) => await resolveCliVoicePromptStackBlocks({ settings, profileId }));

    this.voiceAgentManager = new VoiceAgentManager({
      createBackend: ({ agentId, modelId, permissionPolicy, start, connectedServicesEnv }) => {
        try {
          return this.createBackend({ backendId: agentId, backendTarget: { kind: 'builtInAgent', agentId }, modelId, permissionMode: permissionPolicy, ...(start ? { start } : {}), ...(connectedServicesEnv ? { connectedServicesEnv } : {}) });
        } catch (e) {
          // Backend init failures should surface as "unsupported" so callers can fall back to
          // alternate voice engines. If the backend already classified the error, preserve it.
          if (e instanceof VoiceAgentError) throw e;
          const message = e instanceof Error ? e.message : 'unsupported';
          throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', message);
        }
      },
      resolveSystemAppendBlocks: async ({ profileId, sessionId, workingDirectory }) => {
        const settings = await resolveAccountSettings();
        return await resolveVoicePromptStackBlocks({
          settings,
          profileId,
          sessionId,
          workingDirectory: workingDirectory ?? this.cwd,
        });
      },
      responseTimeoutMs: configuration.voiceAgentResponseTimeoutMs,
      getNowMs: this.getNowMs,
    });
  }

  get(runId: string): ExecutionRunState | null {
    return this.runs.get(runId) ?? null;
  }

  getRunningCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running') count += 1;
    }
    return count;
  }

  getStructuredMeta(runId: string): { kind: string; payload: unknown } | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return run.structuredMeta ?? null;
  }

  getLatestToolResult(runId: string): unknown | null {
    return this.runs.get(runId)?.latestToolResult ?? null;
  }

  async waitForTerminal(runId: string): Promise<void> {
    const ctrl = this.controllers.get(runId);
    if (ctrl) {
      await ctrl.terminalPromise;
      await ctrl.terminalMarkerWritePromise?.catch(() => {});
      await this.terminalMarkerWritePromises.get(runId)?.catch(() => {});
      await this.terminalRuntimeActivityPromises.get(runId);
      return;
    }
    await this.terminalMarkerWritePromises.get(runId)?.catch(() => {});
    await this.terminalRuntimeActivityPromises.get(runId);
    // If there's no controller, the run is either unknown or already terminal.
    return;
  }

  getPublic(runId: string): ExecutionRunPublicState | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const ctrl = this.controllers.get(runId) ?? null;
    const availableActionIds = getExecutionRunAvailableActionIds(run, ctrl);
    return ExecutionRunPublicStateSchema.parse({
      runId: run.runId,
      callId: run.callId,
      sidechainId: run.sidechainId,
      intent: run.intent,
      backendTarget: run.backendTarget,
      ...(run.display ? { display: run.display } : {}),
      ...(run.launch?.launchOrigin ? { launchOrigin: run.launch.launchOrigin } : {}),
      permissionMode: run.permissionMode,
      retentionPolicy: run.retentionPolicy,
      runClass: run.runClass,
      ioMode: run.ioMode,
      status: run.status,
      ...(ctrl?.kind === 'backend' ? { turnInFlight: ctrl.turnInFlight } : {}),
      ...(availableActionIds.length > 0 ? { availableActionIds } : {}),
      ...(run.voiceAgentConfig?.transcript ? { transcript: run.voiceAgentConfig.transcript } : {}),
      startedAtMs: run.startedAtMs,
      ...(run.resumeHandle ? { resumeHandle: run.resumeHandle } : {}),
      ...(typeof run.finishedAtMs === 'number' ? { finishedAtMs: run.finishedAtMs } : {}),
      ...(run.error ? { error: run.error } : {}),
    });
  }

  listPublic(): readonly ExecutionRunPublicState[] {
    const out: ExecutionRunPublicState[] = [];
    for (const run of this.runs.values()) {
      const ctrl = this.controllers.get(run.runId) ?? null;
      const availableActionIds = getExecutionRunAvailableActionIds(run, ctrl);
      const parsed = ExecutionRunPublicStateSchema.parse({
        runId: run.runId,
        callId: run.callId,
        sidechainId: run.sidechainId,
        intent: run.intent,
        backendTarget: run.backendTarget,
        ...(run.display ? { display: run.display } : {}),
        ...(run.launch?.launchOrigin ? { launchOrigin: run.launch.launchOrigin } : {}),
        permissionMode: run.permissionMode,
        retentionPolicy: run.retentionPolicy,
        runClass: run.runClass,
        ioMode: run.ioMode,
        status: run.status,
        ...(ctrl?.kind === 'backend' ? { turnInFlight: ctrl.turnInFlight } : {}),
        ...(availableActionIds.length > 0 ? { availableActionIds } : {}),
        ...(run.voiceAgentConfig?.transcript ? { transcript: run.voiceAgentConfig.transcript } : {}),
        startedAtMs: run.startedAtMs,
        ...(run.resumeHandle ? { resumeHandle: run.resumeHandle } : {}),
        ...(typeof run.finishedAtMs === 'number' ? { finishedAtMs: run.finishedAtMs } : {}),
        ...(run.error ? { error: run.error } : {}),
      });
      out.push(parsed);
    }
    return out;
  }

  getDepthByRunId(runId: string): number | null {
    const run = this.runs.get(runId);
    return run ? run.depth : null;
  }

  getDepthByCallId(callId: string): number | null {
    for (const run of this.runs.values()) {
      if (run.callId === callId) return run.depth;
    }
    return null;
  }

  private finishRun(
    runId: string,
    next: Omit<
      ExecutionRunState,
      | 'runId'
      | 'callId'
      | 'sidechainId'
      | 'sessionId'
      | 'depth'
      | 'intent'
      | 'backendTarget'
      | 'backendId'
      | 'instructions'
      | 'permissionMode'
      | 'retentionPolicy'
      | 'runClass'
      | 'ioMode'
      | 'startedAtMs'
      | 'resumeHandle'
    > & {
      status: ExecutionRunState['status'];
      finishedAtMs: number;
    },
    toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> },
    structuredMeta?: ExecutionRunStructuredMeta,
  ): void {
    const wasRunning = this.runs.get(runId)?.status === 'running';
    finishExecutionRun({
      runId,
      next,
      toolResult,
      structuredMeta,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      parentProvider: this.parentProvider,
      sendAcp: this.sendAcp,
      enqueueMarkerWrite: this.enqueueMarkerWrite.bind(this),
      terminalMarkerWritePromises: this.terminalMarkerWritePromises,
    });
    const current = this.runs.get(runId);
    if (wasRunning && current?.status !== 'running') {
      this.trackRunRuntimeActivityTerminal(runId, `execution_run_${current?.status ?? 'terminal'}`);
    }
    this.emitPublicStateUpdated(runId);
  }

  async start(params: ExecutionRunManagerStartParams): Promise<ExecutionRunStartResult> {
    const existing = this.resolveStartRequest(params);
    if (existing) return existing;
    const started = await startExecutionRun({
      params,
      parentProvider: this.parentProvider,
      sendAcp: this.sendAcp,
      streamedTranscriptSession: this.streamedTranscriptSession,
      createBackend: this.createBackend,
      getNowMs: this.getNowMs,
      budgetRegistry: this.budgetRegistry,
      admitRuntimeActivity: this.admitRunRuntimeActivity.bind(this),
      rollbackRuntimeActivityAfterFailedAdmission: this.rollbackRunRuntimeActivityAfterFailedAdmission.bind(this),
      waitForRuntimeActivityTerminal: async (runId) => {
        await this.terminalRuntimeActivityPromises.get(runId);
      },
      runs: this.runs,
      controllers: this.controllers,
      enqueueMarkerWrite: this.enqueueMarkerWrite.bind(this),
      writeActivityMarker: this.writeActivityMarker.bind(this),
      finishRun: this.finishRun.bind(this),
      executeBoundedRun: this.executeBoundedRun.bind(this),
      send: this.send.bind(this),
      voiceAgentManager: this.voiceAgentManager,
      getDepthByCallId: this.getDepthByCallId.bind(this),
      onPublicStateUpdated: (runId) => this.emitPublicStateUpdated(runId),
    });
    this.emitPublicStateUpdated(started.runId);
    return started;
  }

  private resolveBoundedTimeoutMs(params: ExecutionRunManagerStartParams): number | null {
    if (typeof params.boundedTimeoutMs === 'number' && Number.isFinite(params.boundedTimeoutMs) && params.boundedTimeoutMs >= 1) {
      return Math.floor(params.boundedTimeoutMs);
    }
    return this.boundedTimeoutMs;
  }

  private async executeBoundedRun(args: {
    runId: string;
    callId: string;
    sidechainId: string;
    startedAtMs: number;
    params: ExecutionRunManagerStartParams;
  }): Promise<void> {
    return executeBoundedBackendRun({
      ...args,
      controllers: this.controllers,
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      getNowMs: this.getNowMs,
      boundedTimeoutMs: this.resolveBoundedTimeoutMs(args.params),
      finishRun: this.finishRun.bind(this),
    });
  }

  /**
   * ONE resume backend factory: on every recreation path, rehydrate the run's immutable launch record
   * (re-resolve account settings, re-materialize connected services from the persisted selection —
   * fail-closed) and construct the backend with the run's runId isolation, model, and config
   * overrides. This is the single owner that keeps resume symmetric with start.
   */
  private buildResumeBackendFactory(run: ExecutionRunState): () => Promise<AgentBackend> {
    return async () => {
      const resumeOptions = await resolveExecutionRunResumeBackendOptions({
        run,
        resolveAccountSettings: this.resolveAccountSettings,
        ...(this.prepareConnectedServices ? { prepareConnectedServices: this.prepareConnectedServices } : {}),
      });
      try {
        return this.createBackend({
          runId: run.runId,
          backendId: run.backendId,
          backendTarget: run.backendTarget,
          permissionMode: run.permissionMode,
          start: { retentionPolicy: run.retentionPolicy, intent: run.intent },
          ...(resumeOptions.modelId ? { modelId: resumeOptions.modelId } : {}),
          ...(resumeOptions.sessionConfigOptionOverrides
            ? { sessionConfigOptionOverrides: resumeOptions.sessionConfigOptionOverrides }
            : {}),
          ...(typeof resumeOptions.accountSettings !== 'undefined' ? { accountSettings: resumeOptions.accountSettings } : {}),
          ...(resumeOptions.connectedServicesEnv ? { connectedServicesEnv: resumeOptions.connectedServicesEnv } : {}),
          ...(resumeOptions.connectedServicesCleanup
            ? { connectedServicesCleanup: resumeOptions.connectedServicesCleanup }
            : {}),
        });
      } catch (error) {
        // Re-materialization and backend construction form one acquisition boundary. Cleanup is a
        // shared idempotent promise, so this awaits an already-started factory cleanup when present.
        await resumeOptions.connectedServicesCleanup?.();
        throw error;
      }
    };
  }

  async send(
    runId: string,
    params: Readonly<{ message: string; resume?: boolean; delivery?: unknown }>,
  ): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    const run = this.runs.get(runId) ?? null;
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };

    if (params.resume === true) {
      const sendArgs = {
        runId,
        params,
        runs: this.runs,
        controllers: this.controllers,
        budgetRegistry: this.budgetRegistry,
        createBackend: this.buildResumeBackendFactory(run),
        maxTurns: this.maxTurns,
        getNowMs: this.getNowMs,
        finishRun: this.finishRun.bind(this),
        sendAcp: this.sendAcp,
        parentProvider: this.parentProvider,
        streamedTranscriptSession: this.streamedTranscriptSession,
        writeActivityMarker: this.writeActivityMarker.bind(this),
        admitRuntimeActivity: this.admitRunRuntimeActivity.bind(this),
        rollbackRuntimeActivityAfterFailedAdmission: this.rollbackRunRuntimeActivityAfterFailedAdmission.bind(this),
        terminalRuntimeActivityAfterFailedAdmission: (runId2, reason) => (
          this.trackRunRuntimeActivityTerminal(runId2, reason, 'failed')
        ),
        onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
      } satisfies Parameters<typeof prepareBackendLongLivedRunResume>[0];
      // Serialize only occurrence admission and controller installation. Provider prompt admission
      // is intentionally outside this queue so stop can reach cancellation when sendPrompt stalls.
      const prepared = await this.withRunLifecycleLock(
        runId,
        async () => await prepareBackendLongLivedRunResume(sendArgs),
      );
      if (!prepared.ok) return prepared;
      return sendPreparedBackendLongLivedRun(sendArgs, prepared.controller);
    }

    if (run.runClass === 'bounded') {
      const ctrl = this.controllers.get(runId) ?? null;
      if (!ctrl || ctrl.kind !== 'backend' || !ctrl.childSessionId) {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      }
      if (ctrl.cancelled) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      if (!ctrl.turnInFlight) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not in flight' };

      const delivery = params.delivery;
      const normalized = delivery === undefined ? 'prompt' : delivery;
      if (normalized === 'prompt') {
        return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
      }
      // enqueue: bounded runner will implement delivery semantics while the turn is running
      return new Promise((resolve) => {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        const finish = (result: { ok: boolean; errorCode?: string; error?: string }) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          resolve(result);
        };
        const queuedMessage = {
          message: params.message,
          delivery: (normalized === 'prompt' || normalized === 'steer_if_supported' || normalized === 'interrupt')
            ? normalized
            : 'prompt',
          resolve: () => finish({ ok: true }),
          reject: (e: Error) => finish({ ok: false, errorCode: 'execution_run_failed', error: e.message }),
        } as const;
        ctrl.pendingExternalMessages.push(queuedMessage);
        if (ctrl.pendingExternalMessagesSignal) {
          ctrl.pendingExternalMessagesSignal.resolve();
          ctrl.pendingExternalMessagesSignal = null;
        }
        const timeoutMs = readBoundedExternalSendAckTimeoutMs();
        timeoutHandle = setTimeout(() => {
          const index = ctrl.pendingExternalMessages.indexOf(queuedMessage);
          if (index >= 0) {
            ctrl.pendingExternalMessages.splice(index, 1);
          }
          finish({
            ok: false,
            errorCode: 'execution_run_busy',
            error: 'Run is busy',
          });
        }, timeoutMs);
      });
    }

    return sendBackendLongLivedRun({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createBackend: this.buildResumeBackendFactory(run),
      maxTurns: this.maxTurns,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      streamedTranscriptSession: this.streamedTranscriptSession,
      writeActivityMarker: this.writeActivityMarker.bind(this),
      admitRuntimeActivity: this.admitRunRuntimeActivity.bind(this),
      rollbackRuntimeActivityAfterFailedAdmission: this.rollbackRunRuntimeActivityAfterFailedAdmission.bind(this),
      terminalRuntimeActivityAfterFailedAdmission: (runId2, reason) => (
        this.trackRunRuntimeActivityTerminal(runId2, reason, 'failed')
      ),
      onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
    });
  }

  async ensure(runId: string, params: Readonly<{ resume?: boolean }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    const run = this.runs.get(runId) ?? null;
    const ensure = async () => await ensureExecutionRun({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createBackend: run
        ? this.buildResumeBackendFactory(run)
        : async () => {
            throw new Error('Execution run not found');
          },
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      streamedTranscriptSession: this.streamedTranscriptSession,
      getNowMs: this.getNowMs,
      writeActivityMarker: this.writeActivityMarker.bind(this),
      admitRuntimeActivity: this.admitRunRuntimeActivity.bind(this),
      rollbackRuntimeActivityAfterFailedAdmission: this.rollbackRunRuntimeActivityAfterFailedAdmission.bind(this),
      terminalRuntimeActivityAfterFailedAdmission: (runId2, reason) => (
        this.trackRunRuntimeActivityTerminal(runId2, reason, 'failed')
      ),
      voiceAgentManager: this.voiceAgentManager,
      onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
    });
    return params.resume === true
      ? this.withRunLifecycleLock(runId, ensure)
      : ensure();
  }

  async ensureOrStart(params: Readonly<{
    runId?: string | null;
    start?: ExecutionRunManagerStartParams;
    resume?: boolean;
  }>): Promise<
    | { ok: true; runId: string; created: boolean }
    | { ok: false; errorCode?: string; error: string }
  > {
    const runId = typeof params.runId === 'string' ? params.runId.trim() : '';
    if (runId) {
      const ensured = await this.ensure(runId, { resume: params.resume });
      if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Ensure failed', ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}) };
      return { ok: true, runId, created: false };
    }

    if (!params.start) return { ok: false, error: 'Missing start params', errorCode: 'execution_run_invalid_action_input' };
    const started = await this.start(params.start);
    return { ok: true, runId: started.runId, created: true };
  }

  async startTurnStream(
    runId: string,
    params: Readonly<{
      message: string;
      displayMessage?: string;
      resume?: boolean;
      userTranscript?: ExecutionRunUserTranscriptDirective;
    }>,
  ): Promise<{ ok: true; streamId: string } | { ok: false; errorCode: string; error: string }> {
    if (params.resume === true) {
      const ensured = await this.ensure(runId, { resume: true });
      if (!ensured.ok) return { ok: false, errorCode: ensured.errorCode ?? 'execution_run_failed', error: ensured.error ?? 'Ensure failed' };
    }
    return startVoiceAgentTurnStream({
      runId,
      params: {
        message: params.message,
        ...(typeof params.displayMessage === 'string' ? { displayMessage: params.displayMessage } : {}),
        ...(params.userTranscript ? { userTranscript: params.userTranscript } : {}),
      },
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      transcriptWriter: this.transcriptWriter
        ? {
            appendUserText: this.transcriptWriter.appendUserText,
            ...(this.transcriptWriter.appendUserTextCommitted
              ? { appendUserTextCommitted: this.transcriptWriter.appendUserTextCommitted }
              : {}),
          }
        : null,
    });
  }

  async commitUserTranscript(
    runId: string,
    params: Readonly<{ message: string; displayMessage?: string; localId: string }>,
  ): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }> {
    return await commitVoiceAgentUserTranscript({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      transcriptWriter: this.transcriptWriter
        ? {
            appendUserText: this.transcriptWriter.appendUserText,
            ...(this.transcriptWriter.appendUserTextCommitted
              ? { appendUserTextCommitted: this.transcriptWriter.appendUserTextCommitted }
              : {}),
          }
        : null,
    });
  }

  async readTurnStream(
    runId: string,
    params: Readonly<{ streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<
    | { ok: true; streamId: string; events: any[]; nextCursor: number; done: boolean }
    | { ok: false; errorCode: string; error: string }
  > {
    return readVoiceAgentTurnStream({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      transcriptWriter: this.transcriptWriter
        ? {
            appendAssistantText: this.transcriptWriter.appendAssistantText,
            ...(this.transcriptWriter.appendAssistantTextCommitted
              ? { appendAssistantTextCommitted: this.transcriptWriter.appendAssistantTextCommitted }
              : {}),
          }
        : null,
      writeActivityMarker: this.writeActivityMarker.bind(this),
      getNowMs: this.getNowMs,
    });
  }

  async cancelTurnStream(
    runId: string,
    params: Readonly<{ streamId: string }>,
  ): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }> {
    return cancelVoiceAgentTurnStream({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
    });
  }

  async stop(runId: string): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    return this.withRunLifecycleLock(runId, async () => {
      const result = await stopExecutionRun({
      runId,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
      });
      if (!result.ok) return result;
      try {
        await this.terminalRuntimeActivityPromises.get(runId);
        return result;
      } catch (error) {
        return {
          ok: false,
          errorCode: 'execution_run_runtime_activity_unavailable',
          error: error instanceof Error ? error.message : 'Runtime activity terminal publication failed',
        };
      }
    });
  }

  async applyAction(runId: string, params: ExecutionRunActionParams): Promise<ExecutionRunActionResult> {
    return applyExecutionRunAction({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      startRun: this.start.bind(this),
      sendAcp: this.sendAcp,
      sendCommittedAcp: this.streamedTranscriptSession?.sendAgentMessageCommitted,
      parentProvider: this.parentProvider,
    });
  }
}
