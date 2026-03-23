import { randomUUID } from 'node:crypto';

import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import {
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
import {
  cancelVoiceAgentTurnStream,
  readVoiceAgentTurnStream,
  startVoiceAgentTurnStream,
} from '@/agent/executionRuns/runtime/voiceAgentTurnStreams';
import { sendBackendLongLivedRun } from '@/agent/executionRuns/runtime/backendLongLivedSend';
import { stopExecutionRun } from '@/agent/executionRuns/runtime/executionRunStop';
import { applyExecutionRunAction } from '@/agent/executionRuns/runtime/executionRunApplyAction';
import { getExecutionRunAvailableActionIds } from '@/agent/executionRuns/runtime/getExecutionRunAvailableActionIds';
import { executeBoundedBackendRun } from '@/agent/executionRuns/runtime/boundedBackendRun';
import { ensureExecutionRun } from '@/agent/executionRuns/runtime/executionRunManager/ensureExecutionRun';
import { finishExecutionRun } from '@/agent/executionRuns/runtime/executionRunManager/finishExecutionRun';
import { startExecutionRun } from '@/agent/executionRuns/runtime/executionRunManager/startExecutionRun';
import {
  enqueueExecutionRunMarkerWrite,
  writeExecutionRunActivityMarker,
} from '@/agent/executionRuns/runtime/executionRunManager/activityMarkers';

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
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    modelId?: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: ExecutionRunBackendStartContext;
  }) => AgentBackend;
  private readonly sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  private readonly streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  private readonly transcriptWriter:
    | Readonly<{
        appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
        appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
        appendUserTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
        appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
      }>
    | null;
  private readonly getNowMs: () => number;
  private readonly boundedTimeoutMs: number | null;
  private readonly maxTurns: number | null;
  private readonly budgetRegistry: ExecutionBudgetRegistry | null;
  private readonly runs = new Map<string, ExecutionRunState>();
  private readonly controllers = new Map<string, ExecutionRunController>();
  private readonly markerWriteChains = new Map<string, Promise<void>>();
  private readonly terminalMarkerWritePromises = new Map<string, Promise<void>>();
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

  constructor(opts: Readonly<{
    parentProvider: ACPProvider;
    cwd: string;
    createBackend: (opts: {
      runId?: string;
      backendId: string;
      backendTarget?: BackendTargetRefV1;
      permissionMode: string;
      modelId?: string;
      accountSettings?: Readonly<Record<string, unknown>> | null;
      start?: ExecutionRunBackendStartContext;
    }) => AgentBackend;
    sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
    streamedTranscriptSession?: StreamedTranscriptWriterSession;
    transcriptWriter?: Readonly<{
      appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
      appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
      appendUserTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
      appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
    }>;
    onPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
    getNowMs?: () => number;
    boundedTimeoutMs?: number;
    maxTurns?: number;
    budgetRegistry?: ExecutionBudgetRegistry;
    resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
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
    this.onPublicStateUpdated = typeof opts.onPublicStateUpdated === 'function' ? opts.onPublicStateUpdated : null;
    const resolveAccountSettings = opts.resolveAccountSettings ?? (async () => null);
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
      createBackend: ({ agentId, modelId, permissionPolicy, start }) => {
        try {
          return this.createBackend({ backendId: agentId, backendTarget: { kind: 'builtInAgent', agentId }, modelId, permissionMode: permissionPolicy, ...(start ? { start } : {}) });
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
      return;
    }
    await this.terminalMarkerWritePromises.get(runId)?.catch(() => {});
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
    this.emitPublicStateUpdated(runId);
  }

  async start(params: ExecutionRunManagerStartParams): Promise<ExecutionRunStartResult> {
    const started = await startExecutionRun({
      params,
      parentProvider: this.parentProvider,
      sendAcp: this.sendAcp,
      streamedTranscriptSession: this.streamedTranscriptSession,
      createBackend: this.createBackend,
      getNowMs: this.getNowMs,
      budgetRegistry: this.budgetRegistry,
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

  async send(
    runId: string,
    params: Readonly<{ message: string; resume?: boolean; delivery?: unknown }>,
  ): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    const run = this.runs.get(runId) ?? null;
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };

    if (params.resume === true) {
      // Resume semantics are already centralized in the long-lived sender; preserve that behavior for resumable bounded runs.
      return sendBackendLongLivedRun({
        runId,
        params,
        runs: this.runs,
        controllers: this.controllers,
        budgetRegistry: this.budgetRegistry,
        createBackend: ({ backendId, backendTarget, permissionMode }) => this.createBackend({ backendId, backendTarget, permissionMode }),
        maxTurns: this.maxTurns,
        getNowMs: this.getNowMs,
        finishRun: this.finishRun.bind(this),
        sendAcp: this.sendAcp,
        parentProvider: this.parentProvider,
        streamedTranscriptSession: this.streamedTranscriptSession,
        writeActivityMarker: this.writeActivityMarker.bind(this),
        onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
      });
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
      createBackend: ({ backendId, backendTarget, permissionMode }) => this.createBackend({ backendId, backendTarget, permissionMode }),
      maxTurns: this.maxTurns,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      streamedTranscriptSession: this.streamedTranscriptSession,
      writeActivityMarker: this.writeActivityMarker.bind(this),
      onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
    });
  }

  async ensure(runId: string, params: Readonly<{ resume?: boolean }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    return ensureExecutionRun({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createBackend: ({ backendId, backendTarget, permissionMode }) => this.createBackend({ backendId, backendTarget, permissionMode }),
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      streamedTranscriptSession: this.streamedTranscriptSession,
      getNowMs: this.getNowMs,
      writeActivityMarker: this.writeActivityMarker.bind(this),
      voiceAgentManager: this.voiceAgentManager,
      onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
    });
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
    params: Readonly<{ message: string; displayMessage?: string; resume?: boolean }>,
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
    return stopExecutionRun({
      runId,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
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
