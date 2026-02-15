import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import {
  ExecutionRunPublicStateSchema,
  type ExecutionRunPublicState,
  type ExecutionRunDisplay,
  type ExecutionRunIntent,
  type ExecutionRunResumeHandle,
} from '@happier-dev/protocol';

import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import { VoiceAgentError, VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type {
  ExecutionRunBackendController,
  ExecutionRunController,
  ExecutionRunVoiceAgentController,
} from '@/agent/executionRuns/runtime/executionRunControllers';
import { readBackendChildSessionId } from '@/agent/executionRuns/runtime/executionRunControllers';
import {
  cancelVoiceAgentTurnStream,
  readVoiceAgentTurnStream,
  startVoiceAgentTurnStream,
} from '@/agent/executionRuns/runtime/voiceAgentTurnStreams';
import { sendBackendLongLivedRun } from '@/agent/executionRuns/runtime/backendLongLivedSend';
import { resumeBackendControllerForResumableRun } from '@/agent/executionRuns/runtime/resumeBackendController';
import { stopExecutionRun } from '@/agent/executionRuns/runtime/executionRunStop';
import { applyExecutionRunAction } from '@/agent/executionRuns/runtime/executionRunApplyAction';
import { executeBoundedBackendRun } from '@/agent/executionRuns/runtime/boundedBackendRun';

export type ExecutionRunManagerStartParams = Readonly<{
  sessionId: string;
  intent: ExecutionRunIntent;
  backendId: string;
  instructions?: string;
  /**
   * Intent-scoped configuration. The execution-run substrate treats this as opaque,
   * but backends/engines may interpret it (e.g. native review CLIs like CodeRabbit).
   */
  intentInput?: unknown;
  display?: ExecutionRunDisplay;
  permissionMode: string;
  retentionPolicy: 'ephemeral' | 'resumable';
  runClass: 'bounded' | 'long_lived';
  ioMode: 'request_response' | 'streaming';
  resumeHandle?: ExecutionRunResumeHandle | null;
  parentRunId?: string;
  parentCallId?: string;
  // voice_agent-specific configuration (used when intent='voice_agent').
  chatModelId?: string;
  commitModelId?: string;
  idleTtlSeconds?: number;
  initialContext?: string;
  verbosity?: 'short' | 'balanced';
  transcript?: Readonly<{ persistenceMode?: 'ephemeral' | 'persistent'; epoch?: number }>;
}>;

export type ExecutionRunStartResult = Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
}>;

export type ExecutionRunState = Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  sessionId: string;
  depth: number;
  intent: ExecutionRunManagerStartParams['intent'];
  backendId: string;
  instructions: string;
  display?: ExecutionRunDisplay;
  permissionMode: string;
  retentionPolicy: ExecutionRunManagerStartParams['retentionPolicy'];
  runClass: ExecutionRunManagerStartParams['runClass'];
  ioMode: ExecutionRunManagerStartParams['ioMode'];
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  startedAtMs: number;
  finishedAtMs?: number;
  error?: { code: string; message?: string };
  summary?: string;
  structuredMeta?: ExecutionRunStructuredMeta;
  latestToolResult?: unknown;
  resumeHandle?: ExecutionRunResumeHandle | null;
  voiceAgentConfig?: Readonly<{
    chatModelId: string;
    commitModelId: string;
    permissionPolicy: 'no_tools' | 'read_only';
    idleTtlSeconds: number;
    initialContext: string;
    verbosity: 'short' | 'balanced';
    transcript: Readonly<{ persistenceMode: 'ephemeral' | 'persistent'; epoch: number }>;
  }>;
}>;

export type ExecutionRunActionParams = Readonly<{
  actionId: string;
  input?: unknown;
}>;

export type ExecutionRunActionResult = Readonly<{
  ok: boolean;
  errorCode?: string;
  error?: string;
  updatedToolResult?: unknown;
  result?: unknown;
}>;

export class ExecutionRunManager {
  private readonly parentProvider: string;
  private readonly cwd: string;
  private readonly createBackend: (opts: {
    backendId: string;
    permissionMode: string;
    modelId?: string;
    start?: ExecutionRunManagerStartParams;
  }) => AgentBackend;
  private readonly sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  private readonly transcriptWriter:
    | Readonly<{
        appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
        appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
      }>
    | null;
  private readonly getNowMs: () => number;
  private readonly boundedTimeoutMs: number | null;
  private readonly maxTurns: number | null;
  private readonly budgetRegistry: ExecutionBudgetRegistry | null;
  private readonly runs = new Map<string, ExecutionRunState>();
  private readonly controllers = new Map<string, ExecutionRunController>();
  private readonly voiceAgentManager: VoiceAgentManager;

  private async writeActivityMarker(runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>): Promise<void> {
    const run = this.runs.get(runId);
    const ctrl = this.controllers.get(runId);
    if (!run || !ctrl) return;
    if (run.status !== 'running') return;

    // Avoid noisy disk writes when models stream deltas or long-lived chats are active.
    // This is best-effort telemetry for machine-wide visibility only.
    const throttleMs = 1_000;
    if (opts?.force !== true && nowMs - ctrl.lastMarkerWriteAtMs < throttleMs) return;
    ctrl.lastMarkerWriteAtMs = nowMs;

    await writeExecutionRunMarker({
      pid: process.pid,
      happySessionId: run.sessionId,
      runId: run.runId,
      callId: run.callId,
      sidechainId: run.sidechainId,
      intent: run.intent,
      backendId: run.backendId,
      ...(run.display ? { display: run.display } : {}),
      runClass: run.runClass,
      ioMode: run.ioMode,
      retentionPolicy: run.retentionPolicy,
      status: run.status,
      startedAtMs: run.startedAtMs,
      updatedAtMs: nowMs,
      lastActivityAtMs: nowMs,
      ...(typeof run.summary === 'string' && run.summary.trim().length > 0 ? { summary: run.summary } : {}),
      ...(run.error?.code ? { errorCode: run.error.code } : {}),
      resumeHandle: (() => {
        const vendorSessionId = readBackendChildSessionId(this.controllers.get(runId) ?? null);
        if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
          return { kind: 'vendor_session.v1', backendId: run.backendId, vendorSessionId };
        }
        return run.resumeHandle ?? null;
      })(),
    }).catch(() => {});
  }

  constructor(opts: Readonly<{
    parentProvider: string;
    cwd: string;
    createBackend: (opts: { backendId: string; permissionMode: string; modelId?: string; start?: ExecutionRunManagerStartParams }) => AgentBackend;
    sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
    transcriptWriter?: Readonly<{
      appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
      appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
    }>;
    getNowMs?: () => number;
    boundedTimeoutMs?: number;
    maxTurns?: number;
    budgetRegistry?: ExecutionBudgetRegistry;
  }>) {
    this.parentProvider = opts.parentProvider;
    this.cwd = opts.cwd;
    this.createBackend = opts.createBackend;
    this.sendAcp = opts.sendAcp;
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

    this.voiceAgentManager = new VoiceAgentManager({
      createBackend: ({ agentId, modelId, permissionPolicy }) => {
        try {
          return this.createBackend({ backendId: agentId, modelId, permissionMode: permissionPolicy });
        } catch (e) {
          // Preserve legacy voice-agent semantics: non-Claude backends that fail to initialize
          // should surface as "unsupported" so clients can fall back to alternate voice engines.
          if (agentId !== 'claude') {
            const message = e instanceof Error ? e.message : 'unsupported';
            throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', message);
          }
          throw e;
        }
      },
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
      return;
    }
    // If there's no controller, the run is either unknown or already terminal.
    return;
  }

  getPublic(runId: string): ExecutionRunPublicState | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return ExecutionRunPublicStateSchema.parse({
      runId: run.runId,
      callId: run.callId,
      sidechainId: run.sidechainId,
      intent: run.intent,
      backendId: run.backendId,
      ...(run.display ? { display: run.display } : {}),
      permissionMode: run.permissionMode,
      retentionPolicy: run.retentionPolicy,
      runClass: run.runClass,
      ioMode: run.ioMode,
      status: run.status,
      startedAtMs: run.startedAtMs,
      ...(typeof run.finishedAtMs === 'number' ? { finishedAtMs: run.finishedAtMs } : {}),
      ...(run.error ? { error: run.error } : {}),
    });
  }

  listPublic(): readonly ExecutionRunPublicState[] {
    const out: ExecutionRunPublicState[] = [];
    for (const run of this.runs.values()) {
      const parsed = ExecutionRunPublicStateSchema.parse({
        runId: run.runId,
        callId: run.callId,
        sidechainId: run.sidechainId,
        intent: run.intent,
        backendId: run.backendId,
        ...(run.display ? { display: run.display } : {}),
        permissionMode: run.permissionMode,
        retentionPolicy: run.retentionPolicy,
        runClass: run.runClass,
        ioMode: run.ioMode,
        status: run.status,
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
    const existing = this.runs.get(runId);
    if (!existing) return;
    if (existing.status !== 'running') return;

    const resumeHandle: ExecutionRunResumeHandle | null = (() => {
      if (existing.retentionPolicy !== 'resumable') return null;
      const vendorSessionId = readBackendChildSessionId(this.controllers.get(runId) ?? null);
      if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
        return { kind: 'vendor_session.v1', backendId: existing.backendId, vendorSessionId };
      }
      return existing.resumeHandle ?? null;
    })();

    const updated: ExecutionRunState = {
      ...existing,
      status: next.status,
      summary: next.summary ?? existing.summary,
      finishedAtMs: next.finishedAtMs,
      ...(next.error ? { error: next.error } : {}),
      ...(structuredMeta ? { structuredMeta } : {}),
      latestToolResult: toolResult.output,
      ...(existing.retentionPolicy === 'resumable' ? { resumeHandle } : {}),
    };
    this.runs.set(runId, updated);
    if (updated.status !== 'running') {
      this.budgetRegistry?.releaseExecutionRun(runId);
    }

    // Best-effort: update daemon-visible marker for machine-wide run visibility.
    void writeExecutionRunMarker({
      pid: process.pid,
      happySessionId: existing.sessionId,
      runId: updated.runId,
      callId: updated.callId,
      sidechainId: updated.sidechainId,
      intent: updated.intent,
      backendId: updated.backendId,
      ...(updated.display ? { display: updated.display } : {}),
      runClass: updated.runClass,
      ioMode: updated.ioMode,
      retentionPolicy: updated.retentionPolicy,
      status: updated.status,
      startedAtMs: updated.startedAtMs,
      updatedAtMs: next.finishedAtMs,
      finishedAtMs: next.finishedAtMs,
      ...(typeof updated.summary === 'string' && updated.summary.trim().length > 0 ? { summary: updated.summary } : {}),
      ...(updated.error?.code ? { errorCode: updated.error.code } : {}),
      resumeHandle,
    }).catch(() => {});

    const mergedMeta = (() => {
      const base = toolResult.meta ? { ...toolResult.meta } : {};
      if (resumeHandle) {
        (base as any).happierExecutionRun = {
          resumeHandle,
        };
      }
      return base;
    })();

    if (existing.intent !== 'voice_agent') {
      this.sendAcp(
        this.parentProvider,
        { type: 'tool-result', callId: existing.callId, output: toolResult.output, id: randomUUID(), ...(toolResult.isError ? { isError: true } : {}) },
        Object.keys(mergedMeta).length > 0 ? { meta: mergedMeta } : undefined,
      );
    }
  }

  async start(params: ExecutionRunManagerStartParams): Promise<ExecutionRunStartResult> {
    const runId = `run_${randomUUID()}`;
    const callId = `subagent_run_${randomUUID()}`;
    const sidechainId = callId;

    const depth = (() => {
      const parentRunId = typeof params.parentRunId === 'string' ? params.parentRunId.trim() : '';
      if (parentRunId) {
        const parent = this.runs.get(parentRunId);
        return parent ? parent.depth + 1 : 0;
      }
      const parentCallId = typeof params.parentCallId === 'string' ? params.parentCallId.trim() : '';
      if (parentCallId) {
        const parentDepth = this.getDepthByCallId(parentCallId);
        return typeof parentDepth === 'number' ? parentDepth + 1 : 0;
      }
      return 0;
    })();

    if (this.budgetRegistry && !this.budgetRegistry.tryAcquireExecutionRun(runId, params.intent)) {
      const err: any = new Error('Execution run budget exceeded');
      err.code = 'execution_run_budget_exceeded';
      throw err;
    }

    const startedAtMs = this.getNowMs();
    this.runs.set(runId, {
      runId,
      callId,
      sidechainId,
      sessionId: params.sessionId,
      depth,
      intent: params.intent,
      backendId: params.backendId,
      instructions: params.instructions ?? '',
      ...(params.display ? { display: params.display } : {}),
      permissionMode: params.permissionMode,
      retentionPolicy: params.retentionPolicy,
      runClass: params.runClass,
      ioMode: params.ioMode,
      status: 'running',
      startedAtMs,
      resumeHandle: null,
    });

    // Persist a daemon-visible marker so machine-wide UIs can see the run immediately.
    await writeExecutionRunMarker({
      pid: process.pid,
      happySessionId: params.sessionId,
      runId,
      callId,
      sidechainId,
      intent: params.intent,
      backendId: params.backendId,
      ...(params.display ? { display: params.display } : {}),
      runClass: params.runClass,
      ioMode: params.ioMode,
      retentionPolicy: params.retentionPolicy,
      status: 'running',
      startedAtMs,
      updatedAtMs: startedAtMs,
      resumeHandle: null,
    }).catch(() => {});

    // Materialize the run in transcript (tool-call).
    // For the global voice agent, we intentionally avoid injecting tool-call/tool-result messages
    // into the carrier session transcript; voice persistence is handled via structured meta turns.
    if (params.intent !== 'voice_agent') {
      this.sendAcp(this.parentProvider, {
        type: 'tool-call',
        callId,
        name: 'SubAgentRun',
        input: {
          intent: params.intent,
          backendId: params.backendId,
          instructions: params.instructions ?? '',
          ...(params.display ? { display: params.display } : {}),
          permissionMode: params.permissionMode,
          retentionPolicy: params.retentionPolicy,
          runClass: params.runClass,
          ioMode: params.ioMode,
        },
        id: randomUUID(),
      });
    }

    try {
      if (params.intent === 'voice_agent' && params.ioMode === 'streaming') {
        let resolveTerminal!: () => void;
        const terminalPromise = new Promise<void>((resolve) => {
          resolveTerminal = resolve;
        });

        const epochRaw = Number(params.transcript?.epoch ?? 0);
        const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
        const persistenceMode = params.transcript?.persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';

        const permissionPolicy = params.permissionMode === 'no_tools' ? 'no_tools' : 'read_only';
        const initialContext = [String(params.initialContext ?? '').trim(), String(params.instructions ?? '').trim()]
          .filter((t) => t.length > 0)
          .join('\n\n');

        const chatModelId = String(params.chatModelId ?? 'default');
        const commitModelId = String(params.commitModelId ?? 'default');
        const idleTtlSeconds = typeof params.idleTtlSeconds === 'number' ? params.idleTtlSeconds : 600;
        const verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';

        const startedVoice = await this.voiceAgentManager.start({
          agentId: params.backendId as any,
          chatModelId,
          commitModelId,
          permissionPolicy,
          idleTtlSeconds,
          initialContext,
          verbosity,
        });

        const resumeHandle = this.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId);
        const existing = this.runs.get(runId);
        if (existing) {
          this.runs.set(runId, {
            ...existing,
            resumeHandle: resumeHandle ?? existing.resumeHandle ?? null,
            voiceAgentConfig: {
              chatModelId,
              commitModelId,
              permissionPolicy,
              idleTtlSeconds,
              initialContext,
              verbosity,
              transcript: { persistenceMode, epoch },
            },
          });
        }

        const ctrl: ExecutionRunVoiceAgentController = {
          kind: 'voice_agent',
          voiceAgentId: startedVoice.voiceAgentId,
          cancelled: false,
          lastMarkerWriteAtMs: 0,
          terminalPromise,
          resolveTerminal,
          transcript: { persistenceMode, epoch },
          externalStreamIdByInternal: new Map(),
          internalStreamIdByExternal: new Map(),
          persistedDoneByExternalStreamId: new Set(),
        };
        this.controllers.set(runId, ctrl);
        await this.writeActivityMarker(runId, this.getNowMs(), { force: true }).catch(() => {});
        return { runId, callId, sidechainId };
      }

      const backend = this.createBackend({ backendId: params.backendId, permissionMode: params.permissionMode, start: params });
      let resolveTerminal!: () => void;
      const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      const ctrl: ExecutionRunBackendController = {
        kind: 'backend',
        backend,
        childSessionId: null,
        buffer: '',
        cancelled: false,
        turnCount: 0,
        lastMarkerWriteAtMs: 0,
        terminalPromise,
        resolveTerminal,
      };
      this.controllers.set(runId, ctrl);

      const onMessage: AgentMessageHandler = (msg) => {
        if (msg.type === 'event' && msg.name === 'vendor_session_id') {
          const vendorSessionId = (msg.payload as any)?.sessionId;
          if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
            ctrl.childSessionId = vendorSessionId as SessionId;
            const run = this.runs.get(runId);
            if (run?.retentionPolicy === 'resumable') {
              this.runs.set(runId, {
                ...run,
                resumeHandle: { kind: 'vendor_session.v1', backendId: run.backendId, vendorSessionId },
              });
            }
          }
          return;
        }
        if (msg.type !== 'model-output') return;
        if (typeof (msg as any).fullText === 'string') {
          ctrl.buffer = String((msg as any).fullText);
        } else if (typeof (msg as any).textDelta === 'string') {
          ctrl.buffer += String((msg as any).textDelta);
        }

        // Best-effort: reflect activity for machine-wide run listing.
        void this.writeActivityMarker(runId, this.getNowMs());
      };

      backend.onMessage(onMessage);

      // Start the backend session eagerly so long-lived runs can accept follow-up sends.
      const childSessionId = await (async () => {
        const handle = params.retentionPolicy === 'resumable' ? (params.resumeHandle ?? null) : null;
        const wantsResume =
          handle?.kind === 'vendor_session.v1' && handle.backendId === params.backendId
            ? handle.vendorSessionId
            : null;
        if (wantsResume) {
          if (!backend.loadSession) {
            const err: any = new Error('Backend does not support resume');
            err.code = 'execution_run_not_allowed';
            throw err;
          }
          const loaded = await backend.loadSession(wantsResume as any);
          return loaded.sessionId;
        }
        const started = await backend.startSession();
        return started.sessionId;
      })();
      ctrl.childSessionId = childSessionId;

      const existing = this.runs.get(runId);
      if (existing && params.retentionPolicy === 'resumable') {
        this.runs.set(runId, {
          ...existing,
          resumeHandle: { kind: 'vendor_session.v1', backendId: params.backendId, vendorSessionId: childSessionId },
        });
        await this.writeActivityMarker(runId, this.getNowMs(), { force: true }).catch(() => {});
      }

      if (params.runClass === 'long_lived') {
        if (typeof params.instructions === 'string' && params.instructions.trim().length > 0) {
          const start = {
            sessionId: params.sessionId,
            runId,
            callId,
            sidechainId,
            intent: params.intent,
            backendId: params.backendId,
            instructions: params.instructions ?? '',
            permissionMode: params.permissionMode,
            retentionPolicy: params.retentionPolicy,
            runClass: params.runClass,
            ioMode: params.ioMode,
            startedAtMs,
          } as const;
          const profile = resolveExecutionRunIntentProfile(params.intent);
          await this.send(runId, { message: profile.buildPrompt(start) });
        }
        return { runId, callId, sidechainId };
      }

      void this.executeBoundedRun({ runId, callId, sidechainId, startedAtMs, params }).finally(() => {
        // Ensure terminal promise resolves even if executeBoundedRun throws unexpectedly.
        const ctrl = this.controllers.get(runId);
        ctrl?.resolveTerminal();
        this.controllers.delete(runId);
      });

      return { runId, callId, sidechainId };
    } catch (e: any) {
      const message = e instanceof Error ? e.message : 'Execution failed';
      const finishedAtMs = this.getNowMs();
      const code = e instanceof VoiceAgentError ? e.code : 'execution_run_failed';
      try {
        this.finishRun(
          runId,
          { status: 'failed', summary: message, finishedAtMs, error: { code, message } },
          {
            output: {
              status: 'failed',
              summary: message,
              runId,
              callId,
              sidechainId,
              backendId: params.backendId,
              intent: params.intent,
              startedAtMs,
              finishedAtMs,
              error: { code, message },
            },
            isError: true,
          },
        );
      } catch {
        // best effort
      }
      const ctrl = this.controllers.get(runId) ?? null;
      if (ctrl) {
        try {
          if (ctrl.kind === 'backend') await ctrl.backend.dispose();
        } catch {
          // best effort
        }
        ctrl.resolveTerminal();
        this.controllers.delete(runId);
      }
      throw e;
    }
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
      boundedTimeoutMs: this.boundedTimeoutMs,
      finishRun: this.finishRun.bind(this),
    });
  }

  async send(runId: string, params: Readonly<{ message: string; resume?: boolean }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    return sendBackendLongLivedRun({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createBackend: ({ backendId, permissionMode }) => this.createBackend({ backendId, permissionMode }),
      maxTurns: this.maxTurns,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      writeActivityMarker: this.writeActivityMarker.bind(this),
    });
  }

  async ensure(runId: string, params: Readonly<{ resume?: boolean }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };

    const wantsResume = params.resume === true;
    const ctrl = this.controllers.get(runId) ?? null;
    if (run.status === 'running' && ctrl) return { ok: true };

    if (!wantsResume) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
    if (run.retentionPolicy !== 'resumable') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not resumable' };
    if (ctrl && ctrl.kind === 'voice_agent' && run.intent !== 'voice_agent') {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
    }

    if (run.intent === 'voice_agent') {
      if (run.ioMode !== 'streaming') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
      const config = run.voiceAgentConfig ?? null;
      if (!config) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing voice agent config' };
      const resumeHandle =
        run.resumeHandle && run.resumeHandle.backendId === run.backendId
          ? run.resumeHandle
          : null;
      if (!resumeHandle) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Missing resume handle' };

      const needsBudget = Boolean(this.budgetRegistry && run.status !== 'running');
      if (needsBudget && this.budgetRegistry && !this.budgetRegistry.tryAcquireExecutionRun(runId, run.intent)) {
        return { ok: false, errorCode: 'execution_run_budget_exceeded', error: 'Execution run budget exceeded' };
      }

      try {
        let resolveTerminal!: () => void;
        const terminalPromise = new Promise<void>((resolve) => {
          resolveTerminal = resolve;
        });

        const startedVoice = await this.voiceAgentManager.start({
          agentId: run.backendId as any,
          chatModelId: config.chatModelId,
          commitModelId: config.commitModelId,
          permissionPolicy: config.permissionPolicy,
          idleTtlSeconds: config.idleTtlSeconds,
          initialContext: config.initialContext,
          verbosity: config.verbosity,
          resumeHandle,
        });

        const voiceCtrl: ExecutionRunVoiceAgentController = {
          kind: 'voice_agent',
          voiceAgentId: startedVoice.voiceAgentId,
          cancelled: false,
          lastMarkerWriteAtMs: 0,
          terminalPromise,
          resolveTerminal,
          transcript: config.transcript,
          externalStreamIdByInternal: new Map(),
          internalStreamIdByExternal: new Map(),
          persistedDoneByExternalStreamId: new Set(),
        };
        this.controllers.set(runId, voiceCtrl);

        const nextResumeHandle = this.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId) ?? resumeHandle;
        this.runs.set(runId, {
          ...run,
          status: 'running',
          finishedAtMs: undefined,
          error: undefined,
          resumeHandle: nextResumeHandle,
          voiceAgentConfig: config,
        });

        await this.writeActivityMarker(runId, this.getNowMs(), { force: true });
        return { ok: true };
      } catch (e: any) {
        if (needsBudget) this.budgetRegistry?.releaseExecutionRun(runId);
        const message = e instanceof Error ? e.message : 'Resume failed';
        return { ok: false, errorCode: 'execution_run_not_allowed', error: message };
      }
    }

    const resumed = await resumeBackendControllerForResumableRun({
      runId,
      run,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createBackend: ({ backendId, permissionMode }) => this.createBackend({ backendId, permissionMode }),
      onModelOutput: () => {
        void this.writeActivityMarker(runId, this.getNowMs());
      },
    });
    if (!resumed.ok) return resumed;
    await this.writeActivityMarker(runId, this.getNowMs(), { force: true });
    return { ok: true };
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
    params: Readonly<{ message: string; resume?: boolean }>,
  ): Promise<{ ok: true; streamId: string } | { ok: false; errorCode: string; error: string }> {
    if (params.resume === true) {
      const ensured = await this.ensure(runId, { resume: true });
      if (!ensured.ok) return { ok: false, errorCode: ensured.errorCode ?? 'execution_run_failed', error: ensured.error ?? 'Ensure failed' };
    }
    return startVoiceAgentTurnStream({
      runId,
      params: { message: params.message },
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      transcriptWriter: this.transcriptWriter ? { appendUserText: this.transcriptWriter.appendUserText } : null,
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
      transcriptWriter: this.transcriptWriter ? { appendAssistantText: this.transcriptWriter.appendAssistantText } : null,
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
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
    });
  }
}
