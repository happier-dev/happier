import { randomUUID } from 'node:crypto';

import {
  type ExecutionRunHostRuntime,
} from './executionRunHostRuntime';
import type { ExecutionRunPermissionResponseBridgeResult } from './executionRunBridgeContract';
import type { ACPMessageData, ACPProvider } from '../../../../api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '../../../../api/session/streamedTranscriptWriter';
import type { ExecutionBudgetRegistry } from '../../../../daemon/executionBudget/ExecutionBudgetRegistry';
import {
  buildBackendTargetKey,
  buildBackendTargetKeyV2,
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV1,
  type ConnectedServiceBindingsV1,
  type ExecutionRunBridgeLifecycleHookEventIdV1,
  type ExecutionRunListRequest,
  ExecutionRunPublicStateSchema,
  type ExecutionRunPublicState,
  type ExecutionRunStartRequest,
  readBackendTargetRefV2,
} from '@happier-dev/protocol';

import { VoiceAgentError, VoiceAgentManager } from '../../../voice/agent/VoiceAgentManager';
import { resolveCliVoicePromptStackBlocks } from '../../../prompts/library/resolveCliVoicePromptStackBlocks';
import { configuration } from '../../../../configuration';
import {
  type ExecutionRunActionParams,
  type ExecutionRunActionResult,
  type ExecutionRunManagerStartParams,
  type ExecutionRunStartResult,
  type ExecutionRunState,
} from './executionRunTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import {
  buildExecutionRunProfileCatalog,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import { createExecutionRunBridgeRuntime } from './createExecutionRunBridgeRuntime';
import { resolveExecutionRunResumeBackendOptions } from './resolveExecutionRunResumeBackendOptions';
import { cancelVoiceAgentTurnStream, readVoiceAgentTurnStream, startVoiceAgentTurnStream } from './voiceAgentTurnStreams';
import { sendBackendLongLivedRun } from './send/backendLongLivedPrompt';
import { stopExecutionRun } from './executionRunStop';
import { applyExecutionRunAction } from './executionRunApplyAction';
import { getExecutionRunAvailableActionIds } from './availableActionIds';
import { executeBoundedBackendRun } from './bounded/loop';
import { ensureExecutionRun } from './ensureExecutionRun';
import { finishExecutionRun } from './finishExecutionRun';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunSessionStateTarget } from './sessionStateDelivery';
import { enqueueExecutionRunMarkerWrite, writeExecutionRunActivityMarker } from './activityMarkers';
import type { ExecutionRunHostBridgeContract } from './executionRunBridgeContract';
import { matchesExecutionRunLegacyBackendId } from './backendTargets';
import {
  readExecutionRunPermissionResponseApprovedFromDispatch,
  readExecutionRunPermissionResponseTargetFromDispatch,
  type ExecutionRunParentSessionPermissionResponseTarget,
  type ExecutionRunPermissionRequestStore,
  type ExecutionRunPermissionRequestStoreProvider,
} from './executionRunPermissionResponseTarget';
import type { AgentStateResponseTargetDispatch } from '@/agent/permissions/agentStateRequestStore';
import { emitBridgeLifecycleHookEventBestEffort } from '@/agent/runtime/bridges/_shared/emitBridgeLifecycleHookEventBestEffort';

function readBoundedExternalSendAckTimeoutMs(): number {
  const raw = process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return 20_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 20_000;
  return Math.min(parsed, 120_000);
}

function compareExecutionRunStatesForList(left: ExecutionRunState, right: ExecutionRunState): number {
  if (left.startedAtMs !== right.startedAtMs) {
    return left.startedAtMs - right.startedAtMs;
  }
  return left.runId.localeCompare(right.runId);
}

function normalizeExecutionRunListLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

async function prepareExecutionRunManagerStartParams(
  params: ExecutionRunManagerStartParams,
  cwd: string,
  profileCatalog: ExecutionRunProfileContributionCatalog,
): Promise<ExecutionRunManagerStartParams> {
  const profile = resolveExecutionRunIntentProfileFromCatalog(profileCatalog, params.intent, params.profileId);
  const startProfilePatch = await profile.prepareStartParams?.({
    request: params as unknown as ExecutionRunStartRequest,
    cwd,
  });

  const prepared: Record<string, unknown> = {
    ...(params as unknown as Record<string, unknown>),
    ...(startProfilePatch ?? {}),
  };
  delete prepared.replay;

  return prepared as ExecutionRunManagerStartParams;
}

export type ExecutionRunHostBridgeOptions = Readonly<{
  parentProvider: ACPProvider;
  cwd: string;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  streamedTranscriptSession?: StreamedTranscriptWriterSession;
  transcriptWriter?: Readonly<{
    appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
    appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
    appendUserTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
    appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
  }>;
  onPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
  onVoiceAgentWelcomed?: (run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>;
  getNowMs?: () => number;
  boundedTimeoutMs?: number;
  maxTurns?: number;
  budgetRegistry?: ExecutionBudgetRegistry;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  resolveVoicePromptStackBlocks?: (args: Readonly<{
    settings?: unknown;
    profileId?: string | null;
    sessionId?: string | null;
    workingDirectory?: string | null;
  }>) => Promise<readonly string[]>;
  executionRunProfileCatalog?: ExecutionRunProfileContributionCatalog;
  resolveExecutionRunProfileCatalog?: () => Promise<ExecutionRunProfileContributionCatalog> | ExecutionRunProfileContributionCatalog;
  happyHomeDir?: string;
  parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
}>;

/**
 * Canonical execution-run host-bridge owner. The older March/plan-only
 * `AgentExecutionRunRuntimeBridge` / `createExecutionRunRuntimeBridge.ts` naming is superseded by
 * this class plus the shared execution-run runtime helpers it composes.
 */
export class ExecutionRunHostBridge implements ExecutionRunHostBridgeContract {
  private readonly parentProvider: ACPProvider;
  private readonly cwd: string;
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
  private readonly happyHomeDir: string | null;
  private readonly parentSessionStateTarget: ExecutionRunSessionStateTarget | null;
  private readonly getPermissionRequestStore: ExecutionRunPermissionRequestStoreProvider | null;
  private readonly runs = new Map<string, ExecutionRunState>();
  private readonly controllers = new Map<string, ExecutionRunController>();
  private readonly markerWriteChains = new Map<string, Promise<void>>();
  private readonly terminalMarkerWritePromises = new Map<string, Promise<void>>();
  private readonly voiceAgentManager: VoiceAgentManager;
  private executionRunProfileCatalog: ExecutionRunProfileContributionCatalog;
  private readonly resolveExecutionRunProfileCatalogOption:
    | (() => Promise<ExecutionRunProfileContributionCatalog> | ExecutionRunProfileContributionCatalog)
    | null;
  private executionRunProfileCatalogLoad: Promise<ExecutionRunProfileContributionCatalog> | null = null;
  private readonly onPublicStateUpdated: ((run: ExecutionRunPublicState) => void) | null;
  private readonly onVoiceAgentWelcomed: ((run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>) | null;
  private permissionResponseTargetStore: ExecutionRunPermissionRequestStore | null = null;
  private unregisterPermissionResponseTargetHandler: (() => void) | null = null;
  private disposePromise: Promise<void> | null = null;

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

  private async resolveExecutionRunProfileCatalog(): Promise<ExecutionRunProfileContributionCatalog> {
    const resolver = this.resolveExecutionRunProfileCatalogOption;
    if (!resolver) {
      return this.executionRunProfileCatalog;
    }
    if (!this.executionRunProfileCatalogLoad) {
      this.executionRunProfileCatalogLoad = Promise.resolve(resolver()).then((catalog) => {
        this.executionRunProfileCatalog = catalog;
        return catalog;
      });
    }
    return await this.executionRunProfileCatalogLoad;
  }

  constructor(opts: ExecutionRunHostBridgeOptions) {
    this.parentProvider = opts.parentProvider;
    this.cwd = opts.cwd;
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
    this.getPermissionRequestStore = typeof opts.getPermissionRequestStore === 'function'
      ? opts.getPermissionRequestStore
      : null;
    this.happyHomeDir = typeof opts.happyHomeDir === 'string' && opts.happyHomeDir.trim().length > 0
      ? opts.happyHomeDir.trim()
      : configuration.happyHomeDir;
    this.parentSessionStateTarget = opts.parentSessionStateTarget ?? null;
    this.onPublicStateUpdated = typeof opts.onPublicStateUpdated === 'function' ? opts.onPublicStateUpdated : null;
    this.onVoiceAgentWelcomed = typeof opts.onVoiceAgentWelcomed === 'function' ? opts.onVoiceAgentWelcomed : null;
    this.executionRunProfileCatalog = opts.executionRunProfileCatalog ?? buildExecutionRunProfileCatalog();
    this.resolveExecutionRunProfileCatalogOption = typeof opts.resolveExecutionRunProfileCatalog === 'function'
      ? opts.resolveExecutionRunProfileCatalog
      : null;
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
      createRuntime: ({ agentId, modelId, permissionPolicy, start, connectedServices }) => {
        try {
          return this.createExecutionRunRuntime({
            backendId: agentId,
            backendTarget: { kind: 'builtInAgent', agentId },
            modelId,
            permissionMode: permissionPolicy,
            ...(start ? { start } : {}),
            ...(connectedServices !== undefined ? { connectedServices } : {}),
          });
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

  private ensurePermissionResponseTargetHandlerRegistered(): void {
    const store = this.getPermissionRequestStore?.() ?? null;
    if (!store || this.permissionResponseTargetStore === store) return;

    this.unregisterPermissionResponseTargetHandler?.();
    this.permissionResponseTargetStore = null;
    this.unregisterPermissionResponseTargetHandler = null;

    this.unregisterPermissionResponseTargetHandler = store.registerResponseTargetHandler('execution_run_host_bridge', (
      dispatch: AgentStateResponseTargetDispatch,
    ) => {
      return this.handleExecutionRunPermissionResponseTargetDispatch(dispatch);
    });
    this.permissionResponseTargetStore = store;
  }

  private async handleExecutionRunPermissionResponseTargetDispatch(
    dispatch: AgentStateResponseTargetDispatch,
  ): Promise<void> {
    const responseTarget = readExecutionRunPermissionResponseTargetFromDispatch(dispatch);
    if (!responseTarget) return;

    const approved = readExecutionRunPermissionResponseApprovedFromDispatch(dispatch);
    if (approved === null) return;

    await this.respondToPermissionRequest(responseTarget.runId, {
      requestId: responseTarget.providerRequestId,
      approved,
      responseTarget,
    });
  }

  private resolvePermissionRequestStore(): ExecutionRunPermissionRequestStore | null {
    this.ensurePermissionResponseTargetHandlerRegistered();
    return this.permissionResponseTargetStore ?? this.getPermissionRequestStore?.() ?? null;
  }

  private createExecutionRunRuntime(opts: Readonly<{
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    modelId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    start?: ExecutionRunBackendStartContext;
  }>): ExecutionRunHostRuntime {
    return createExecutionRunBridgeRuntime({
      cwd: this.cwd,
      runId: opts.runId,
      backendId: opts.backendId,
      backendTarget: opts.backendTarget,
      permissionMode: opts.permissionMode,
      modelId: opts.modelId,
      ...(opts.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides }
        : {}),
      accountSettings: opts.accountSettings ?? null,
      ...(opts.connectedServices !== undefined
        ? { connectedServices: opts.connectedServices }
        : {}),
      ...(opts.connectedServicesDefaultServiceIds && opts.connectedServicesDefaultServiceIds.length > 0
        ? { connectedServicesDefaultServiceIds: opts.connectedServicesDefaultServiceIds }
        : {}),
      start: opts.start ?? null,
      happyHomeDir: this.happyHomeDir,
      parentSessionStateTarget: this.parentSessionStateTarget,
    });
  }

  /**
   * ONE resume backend factory (LC-F2): every recreation path rehydrates the run's immutable launch
   * record so the recreated backend re-applies the SAME model, config overrides, and connected-service
   * selection (daemon re-materializes it, fail-closed) instead of falling back to a bare backend on
   * ambient/native auth. Keeps resume symmetric with start.
   */
  private createResumeExecutionRunRuntime(opts: Readonly<{
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }>): ExecutionRunHostRuntime {
    const run = opts.runId ? this.runs.get(opts.runId) ?? null : null;
    const resumeOptions = resolveExecutionRunResumeBackendOptions({ run });
    return this.createExecutionRunRuntime({
      ...(opts.runId ? { runId: opts.runId } : {}),
      backendId: opts.backendId,
      ...(opts.backendTarget ? { backendTarget: opts.backendTarget } : {}),
      permissionMode: opts.permissionMode,
      accountSettings: opts.accountSettings ?? null,
      ...(resumeOptions.modelId ? { modelId: resumeOptions.modelId } : {}),
      ...(resumeOptions.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: resumeOptions.sessionConfigOptionOverrides }
        : {}),
      ...(resumeOptions.connectedServices !== undefined
        ? { connectedServices: resumeOptions.connectedServices }
        : {}),
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

  private buildPublicState(run: ExecutionRunState): ExecutionRunPublicState {
    const ctrl = this.controllers.get(run.runId) ?? null;
    const availableActionIds = getExecutionRunAvailableActionIds(run, ctrl, this.executionRunProfileCatalog);
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

  getPublic(runId: string): ExecutionRunPublicState | null {
    const run = this.runs.get(runId);
    return run ? this.buildPublicState(run) : null;
  }

  listPublic(): readonly ExecutionRunPublicState[] {
    const out: ExecutionRunPublicState[] = [];
    for (const run of this.runs.values()) {
      out.push(this.buildPublicState(run));
    }
    return out;
  }

  listPublicForRequest(request: ExecutionRunListRequest): readonly ExecutionRunPublicState[] {
    const requestedBackendId =
      typeof request.backendId === 'string' && request.backendId.trim().length > 0 ? request.backendId.trim() : null;
    const requestedBackendTargetKey =
      request.backendTarget ? buildBackendTargetKeyV2(readBackendTargetRefV2(request.backendTarget)) : null;
    const requestedStatus =
      typeof request.status === 'string' && request.status.trim().length > 0 ? request.status.trim() : null;
    const requestedLimit = normalizeExecutionRunListLimit(request.limit);

    const selected: ExecutionRunState[] = [];
    for (const run of this.runs.values()) {
      if (requestedBackendTargetKey && buildBackendTargetKeyV2(readBackendTargetRefV2(run.backendTarget)) !== requestedBackendTargetKey) {
        continue;
      }
      if (!requestedBackendTargetKey && requestedBackendId && !matchesExecutionRunLegacyBackendId(run.backendTarget, requestedBackendId)) {
        continue;
      }
      if (requestedStatus && run.status !== requestedStatus) {
        continue;
      }
      selected.push(run);
    }

    const sorted = selected.sort(compareExecutionRunStatesForList);
    const bounded = requestedLimit === null ? sorted : sorted.slice(0, requestedLimit);
    return bounded.map((run) => this.buildPublicState(run));
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
      profileCatalog: this.executionRunProfileCatalog,
    });
    this.emitPublicStateUpdated(runId);
    void this.emitLifecycleHookEvent({
      eventId: 'executionRun.completed',
      runId,
      payload: {
        runId,
        status: next.status,
        finishedAtMs: next.finishedAtMs,
        ...(next.error ? { error: next.error } : {}),
      },
    });
  }

  private async emitLifecycleHookEvent(params: Readonly<{
    eventId: ExecutionRunBridgeLifecycleHookEventIdV1;
    runId: string;
    payload: Record<string, unknown>;
  }>): Promise<void> {
    if (!this.happyHomeDir) return;

    const run = this.runs.get(params.runId);
    if (!run) return;

    await emitBridgeLifecycleHookEventBestEffort({
      happyHomeDir: this.happyHomeDir,
      event: {
        eventId: params.eventId,
        scope: 'session',
        happySessionId: run.sessionId,
        backendTarget: buildBackendTargetKey(run.backendTarget),
        payload: params.payload,
      },
    });
  }

  async start(params: ExecutionRunManagerStartParams): Promise<ExecutionRunStartResult> {
    this.ensurePermissionResponseTargetHandlerRegistered();
    const profileCatalog = await this.resolveExecutionRunProfileCatalog();
    const preparedParams = await prepareExecutionRunManagerStartParams(params, this.cwd, profileCatalog);
    const started = await startExecutionRun({
      params: preparedParams,
      profileCatalog,
      parentProvider: this.parentProvider,
      sendAcp: this.sendAcp,
      streamedTranscriptSession: this.streamedTranscriptSession,
      createRuntime: this.createExecutionRunRuntime.bind(this),
      getNowMs: this.getNowMs,
      budgetRegistry: this.budgetRegistry,
      getPermissionRequestStore: this.resolvePermissionRequestStore.bind(this),
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
    await this.emitLifecycleHookEvent({
      eventId: 'executionRun.started',
      runId: started.runId,
      payload: {
        runId: started.runId,
        intent: preparedParams.intent,
        runClass: preparedParams.runClass,
        ioMode: preparedParams.ioMode,
        retentionPolicy: preparedParams.retentionPolicy,
        permissionMode: preparedParams.permissionMode,
      },
    });
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
      profileCatalog: this.executionRunProfileCatalog,
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
    this.ensurePermissionResponseTargetHandlerRegistered();
    const run = this.runs.get(runId) ?? null;
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };

    let result: { ok: boolean; errorCode?: string; error?: string };

    if (params.resume === true) {
      // Resume semantics are already centralized in the long-lived sender; preserve that behavior for resumable bounded runs.
      result = await sendBackendLongLivedRun({
        runId,
        params,
        runs: this.runs,
        controllers: this.controllers,
        budgetRegistry: this.budgetRegistry,
        createRuntime: ({ runId: resumedRunId, backendId, backendTarget, permissionMode, accountSettings }) =>
          this.createResumeExecutionRunRuntime({ runId: resumedRunId, backendId, backendTarget, permissionMode, accountSettings }),
        maxTurns: this.maxTurns,
        getNowMs: this.getNowMs,
        finishRun: this.finishRun.bind(this),
        sendAcp: this.sendAcp,
        parentProvider: this.parentProvider,
        streamedTranscriptSession: this.streamedTranscriptSession,
        getPermissionRequestStore: this.resolvePermissionRequestStore.bind(this),
        writeActivityMarker: this.writeActivityMarker.bind(this),
        onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
        profileCatalog: this.executionRunProfileCatalog,
      });
      if (result.ok) {
        await this.emitLifecycleHookEvent({
          eventId: 'executionRun.messageSent',
          runId,
          payload: {
            runId,
            resume: true,
            messageLength: params.message.length,
            delivery: params.delivery === undefined ? 'prompt' : params.delivery,
          },
        });
      }
      return result;
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
      result = await new Promise((resolve) => {
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
      if (result.ok) {
        await this.emitLifecycleHookEvent({
          eventId: 'executionRun.messageSent',
          runId,
          payload: {
            runId,
            resume: false,
            messageLength: params.message.length,
            delivery: normalized,
          },
        });
      }
      return result;
    }

    result = await sendBackendLongLivedRun({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createRuntime: ({ runId: resumedRunId, backendId, backendTarget, permissionMode, accountSettings }) =>
        this.createResumeExecutionRunRuntime({ runId: resumedRunId, backendId, backendTarget, permissionMode, accountSettings }),
      maxTurns: this.maxTurns,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      streamedTranscriptSession: this.streamedTranscriptSession,
      getPermissionRequestStore: this.resolvePermissionRequestStore.bind(this),
      writeActivityMarker: this.writeActivityMarker.bind(this),
      onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
      profileCatalog: this.executionRunProfileCatalog,
    });
    if (result.ok) {
      await this.emitLifecycleHookEvent({
        eventId: 'executionRun.messageSent',
        runId,
        payload: {
          runId,
          resume: false,
          messageLength: params.message.length,
          delivery: params.delivery === undefined ? 'prompt' : params.delivery,
        },
      });
    }
    return result;
  }

  async ensure(runId: string, params: Readonly<{ resume?: boolean }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    this.ensurePermissionResponseTargetHandlerRegistered();
    return ensureExecutionRun({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createRuntime: ({ runId: resumedRunId, backendId, backendTarget, permissionMode, accountSettings }) =>
        this.createResumeExecutionRunRuntime({ runId: resumedRunId, backendId, backendTarget, permissionMode, accountSettings }),
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      streamedTranscriptSession: this.streamedTranscriptSession,
      getPermissionRequestStore: this.resolvePermissionRequestStore.bind(this),
      getNowMs: this.getNowMs,
      writeActivityMarker: this.writeActivityMarker.bind(this),
      voiceAgentManager: this.voiceAgentManager,
      onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
      profileCatalog: this.executionRunProfileCatalog,
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
    const result = await stopExecutionRun({
      runId,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
    });
    if (result.ok) {
      await this.emitLifecycleHookEvent({
        eventId: 'executionRun.stopped',
        runId,
        payload: {
          runId,
        },
      });
    }
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }

    this.disposePromise = (async () => {
      const runningRunIds = [...this.runs.values()]
        .filter((run) => run.status === 'running')
        .map((run) => run.runId);

      await Promise.allSettled(runningRunIds.map(async (runId) => {
        await this.stop(runId);
      }));

      const remainingControllers = [...this.controllers.entries()];
      await Promise.allSettled(remainingControllers.map(async ([runId, ctrl]) => {
        if (ctrl.kind === 'backend') {
          try {
            await ctrl.backend.dispose();
          } catch {
            // best effort
          }
        } else {
          try {
            await this.voiceAgentManager.stop({ voiceAgentId: ctrl.voiceAgentId });
          } catch {
            // best effort
          }
        }
        ctrl.resolveTerminal();
        this.controllers.delete(runId);
      }));

      try {
        await this.voiceAgentManager.dispose();
      } catch {
        // best effort
      }

      this.unregisterPermissionResponseTargetHandler?.();
      this.unregisterPermissionResponseTargetHandler = null;
      this.permissionResponseTargetStore = null;
    })();

    return await this.disposePromise;
  }

  async respondToPermissionRequest(
    runId: string,
    params: Readonly<{
      requestId: string;
      approved: boolean;
      responseTarget?: ExecutionRunParentSessionPermissionResponseTarget | null;
    }>,
  ): Promise<ExecutionRunPermissionResponseBridgeResult> {
    const run = this.runs.get(runId) ?? null;
    if (!run) {
      return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
    }
    if (run.status !== 'running') {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
    }

    const ctrl = this.controllers.get(runId) ?? null;
    if (!ctrl || ctrl.kind !== 'backend' || ctrl.cancelled) {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
    }

    const target = params.responseTarget ?? null;
    if (target) {
      if (
        target.runId !== run.runId
        || target.sessionId !== run.sessionId
        || target.callId !== run.callId
        || target.sidechainId !== run.sidechainId
        || target.backendId !== run.backendId
      ) {
        return {
          ok: false,
          errorCode: 'execution_run_invalid_action_input',
          error: 'Permission response target does not match the active execution run',
        };
      }
      if (target.providerRequestId !== params.requestId) {
        return {
          ok: false,
          errorCode: 'execution_run_invalid_action_input',
          error: 'Permission response request id does not match the response target',
        };
      }
    }

    const respondToPermission = ctrl.backend.permissionCapability === 'responds'
      ? ctrl.backend.respondToPermission
      : undefined;
    if (!respondToPermission) {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Unsupported action' };
    }

    const delivery = await respondToPermission(params.requestId, params.approved);
    if (delivery.delivered !== true) {
      return {
        ok: false,
        errorCode: 'execution_run_permission_not_delivered',
        error: 'Permission response was not delivered',
        delivery,
      };
    }
    this.sendAcp(this.parentProvider, {
      type: 'permission-response',
      permissionId: params.requestId,
      approved: params.approved,
      decision: params.approved ? 'approved' : 'denied',
      sidechainId: run.sidechainId,
    });
    await this.writeActivityMarker(runId, this.getNowMs(), { force: true });
    return { ok: true, delivery };
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
      profileCatalog: await this.resolveExecutionRunProfileCatalog(),
      onVoiceAgentWelcomed: async (welcomedRunId, welcomedEpoch) => {
        const callback = this.onVoiceAgentWelcomed;
        if (!callback) return;
        const publicRun = this.getPublic(welcomedRunId);
        if (!publicRun) return;
        await callback(publicRun, welcomedEpoch);
      },
    });
  }
}
