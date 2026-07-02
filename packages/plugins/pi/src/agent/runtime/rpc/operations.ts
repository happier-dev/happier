import { randomUUID } from 'node:crypto';

import type {
  ExecJsonStreamClientSpecV1,
  ExecClientHandleV1,
  JsonStreamClientV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type { InternalRuntimeTurnOperationsV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import { PI_THINKING_LEVEL_ENV, resolvePiThinkingLevelFromEnv } from '../../../protocol/thinking.js';
import { buildPiRpcArgs } from './args.js';
import { createPiJsonStreamRpcClient, type PiJsonStreamRpcClient } from './client.js';
import { projectPiRuntimeEvents, readPiProviderTurnId, readPiRuntimeRecordType } from './events.js';
import type { PiPermissionMode, PiRpcStateData } from './types.js';

type PiRuntimeOperationsParams = Readonly<{
  ctx: PluginContextV1;
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: PiPermissionMode;
  initialSessionId?: string | null;
  resumeSessionId?: string | null;
  happierSessionId?: string | null;
}>;

type RuntimeEventHandler = (event: RuntimeEventV1) => void;

type ActiveTurnState = Readonly<{
  turnId: string;
  providerTurnId: string | null;
}>;

type PendingCompletion = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}>;

type RuntimeOperationsWithRecordHandler = InternalRuntimeTurnOperationsV1 & Readonly<{
  handleRuntimeRecord(record: Readonly<Record<string, unknown>>): void;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function readSessionIdFromState(value: unknown): string | null {
  return isRecord(value) ? readString(value.sessionId) : null;
}

function readTimeoutMs(opts: Readonly<Record<string, unknown>> | undefined): number | null {
  const value = opts?.timeoutMs ?? opts?.timeout;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function createCompletion(): PendingCompletion {
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  promise.catch(() => undefined);
  return {
    promise,
    resolve() {
      resolveCompletion?.();
    },
    reject(error: Error) {
      rejectCompletion?.(error);
    },
  };
}

async function withTimeout(promise: Promise<void>, opts: Readonly<Record<string, unknown>> | undefined): Promise<void> {
  const timeoutMs = readTimeoutMs(opts);
  if (timeoutMs === null) {
    await promise;
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Pi turn completion timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createPiExecSpec(params: PiRuntimeOperationsParams): ExecJsonStreamClientSpecV1 {
  const thinkingLevel = resolvePiThinkingLevelFromEnv(params.env);
  return {
    launch: {
      kind: 'agent-cli',
      agentId: 'pi',
      args: buildPiRpcArgs({
        permissionMode: params.permissionMode,
        thinkingLevel,
        resumeSessionId: params.resumeSessionId,
      }),
      cwd: params.cwd,
      env: {
        ...params.env,
        ...(thinkingLevel ? { [PI_THINKING_LEVEL_ENV]: thinkingLevel } : {}),
        NODE_ENV: 'production',
        DEBUG: '',
        CI: '1',
      },
    },
    transport: {
      kind: 'stdio',
      framing: { kind: 'strict-lf-json' },
    },
    protocol: { kind: 'json-stream' },
    lifecycle: {
      requestTimeoutMs: 30_000,
      maxStderrBytes: 4096,
    },
  };
}

function createRuntimeOperations(params: Readonly<{
  rpc: PiJsonStreamRpcClient;
  happierSessionId: string | null;
  initialSessionId: string | null;
  subscribeRuntimeEvents: (handler: RuntimeEventHandler) => () => void;
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
}>): RuntimeOperationsWithRecordHandler {
  let sessionId = params.initialSessionId;
  let activeTurn: ActiveTurnState | null = null;
  let pendingCompletion: PendingCompletion | null = null;

  function beginTurn(providerTurnId: string | null = null): ActiveTurnState {
    const turn = Object.freeze({
      turnId: randomUUID(),
      providerTurnId,
    });
    activeTurn = turn;
    pendingCompletion = createCompletion();
    if (params.happierSessionId) {
      params.publishRuntimeEvent({
        kind: 'turn-start',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        turnId: turn.turnId,
        ...(providerTurnId ? { providerTurnId } : {}),
        startedBy: 'provider',
      });
    }
    return turn;
  }

  function readOrBeginTurn(providerTurnId: string | null = null): ActiveTurnState {
    if (!activeTurn) return beginTurn(providerTurnId);
    if (providerTurnId && activeTurn.providerTurnId !== providerTurnId) {
      activeTurn = Object.freeze({
        turnId: activeTurn.turnId,
        providerTurnId,
      });
      if (params.happierSessionId) {
        params.publishRuntimeEvent({
          kind: 'turn-provider-id-observed',
          sessionId: params.happierSessionId,
          emittedAtMs: Date.now(),
          turnId: activeTurn.turnId,
          providerTurnId,
        });
      }
    }
    return activeTurn;
  }

  function settleTurnComplete(providerTurnId: string | null = null): void {
    const turn = activeTurn;
    if (!turn) return;
    const terminalProviderTurnId = providerTurnId ?? turn.providerTurnId;
    if (params.happierSessionId) {
      params.publishRuntimeEvent({
        kind: 'turn-complete',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        turnId: turn.turnId,
        ...(terminalProviderTurnId ? { providerTurnId: terminalProviderTurnId } : {}),
      });
    }
    const completion = pendingCompletion;
    activeTurn = null;
    pendingCompletion = null;
    completion?.resolve();
  }

  function handleRuntimeRecord(record: Readonly<Record<string, unknown>>): void {
    const type = readPiRuntimeRecordType(record);
    const providerTurnId = readPiProviderTurnId(record);
    if (type === 'turn_start') {
      readOrBeginTurn(providerTurnId);
      return;
    }
    const turn = activeTurn;
    for (const event of projectPiRuntimeEvents(record, {
      sessionId: params.happierSessionId,
      turnId: turn?.turnId ?? null,
      providerSessionId: sessionId,
      nowMs: () => Date.now(),
    })) {
      params.publishRuntimeEvent(event);
    }
    if (type === 'turn_end') {
      if (providerTurnId) readOrBeginTurn(providerTurnId);
      settleTurnComplete(providerTurnId);
      return;
    }
    if (type === 'agent_end' && record.willRetry !== true) {
      settleTurnComplete(providerTurnId);
    }
  }

  return {
    beginTurnLifecycle() {
      beginTurn();
    },
    async startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null> {
      const requestedResumeId = readString(opts?.resumeId) ?? readString(opts?.providerSessionId);
      if (sessionId) {
        if (requestedResumeId && requestedResumeId !== sessionId) {
          throw new Error(`Pi session mismatch (expected ${requestedResumeId}, got ${sessionId})`);
        }
        return sessionId;
      }
      const stateBefore = await params.rpc.send({ type: 'get_state' }, 30_000);
      sessionId = readSessionIdFromState(stateBefore.data);
      if (!sessionId && !requestedResumeId) {
        await params.rpc.send({ type: 'new_session' }, 60_000);
        const stateAfter = await params.rpc.send({ type: 'get_state' }, 30_000);
        sessionId = readSessionIdFromState(stateAfter.data);
      }
      if (!sessionId && requestedResumeId) {
        sessionId = requestedResumeId;
      }
      if (!sessionId) {
        throw new Error('Pi did not return a session id');
      }
      return sessionId;
    },
    async sendTurnPrompt(prompt: string): Promise<void> {
      readOrBeginTurn();
      await params.rpc.send({ type: 'prompt', message: prompt }, 30_000);
    },
    async steerInFlightTurn(message: string): Promise<void> {
      await params.rpc.send({ type: 'prompt', message, streamingBehavior: 'steer' }, 30_000);
    },
    async waitForTurnCompletion(opts?: Readonly<Record<string, unknown>>): Promise<void> {
      const completion = pendingCompletion;
      if (!completion) return;
      await withTimeout(completion.promise, opts);
    },
    subscribeRuntimeEvents(handler: RuntimeEventHandler): () => void {
      return params.subscribeRuntimeEvents(handler);
    },
    async respondToPermission(): Promise<void> {
      return undefined;
    },
    async cancelTurn(): Promise<void> {
      await params.rpc.send({ type: 'abort' }, 30_000);
    },
    readSessionIdentity() {
      return { sessionId };
    },
    async updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void> {
      const modelId = readString(update.modelId) ?? readString(update.model);
      if (modelId) {
        const [provider, ...modelParts] = modelId.split('/');
        await params.rpc.send({
          type: 'set_model',
          provider: modelParts.length > 0 ? provider : 'default',
          modelId: modelParts.length > 0 ? modelParts.join('/') : modelId,
        }, 30_000);
      }
      const configOption = isRecord(update.configOption) ? update.configOption : null;
      if (configOption?.id === 'piThinkingLevel') {
        const level = readString(configOption.value);
        if (level) await params.rpc.send({ type: 'set_thinking_level', level }, 30_000);
      }
    },
    async resetOrDisposeRuntime(): Promise<void> {
      pendingCompletion?.reject(new Error('Pi runtime disposed'));
      pendingCompletion = null;
      activeTurn = null;
      await params.rpc.dispose();
    },
    handleRuntimeRecord,
  };
}

export async function createPiRuntimeOperations(params: PiRuntimeOperationsParams): Promise<Readonly<{
  operations: InternalRuntimeTurnOperationsV1;
  nativeRuntime: InternalRuntimeTurnOperationsV1;
}>> {
  const normalizedEnv = normalizeEnv(params.env);
  const happierSessionId = readString(params.happierSessionId);
  const handle = await params.ctx.exec.spawnClient(createPiExecSpec({
    ...params,
    env: normalizedEnv,
  }));
  const subscribers = new Set<RuntimeEventHandler>();
  const publishRuntimeEvent = (event: RuntimeEventV1): void => {
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  };
  let operations: RuntimeOperationsWithRecordHandler | null = null;
  const rpc = createPiJsonStreamRpcClient({
    handle,
    onEvent(record) {
      if (record.type === 'runtime_event') {
        if (!isRecord(record.event)) return;
        publishRuntimeEvent(record.event as RuntimeEventV1);
        return;
      }
      operations?.handleRuntimeRecord(record);
    },
  });
  operations = createRuntimeOperations({
    rpc,
    happierSessionId,
    initialSessionId: params.initialSessionId ?? null,
    subscribeRuntimeEvents(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    publishRuntimeEvent,
  });
  return {
    operations,
    nativeRuntime: operations,
  };
}

export const PI_RUNTIME_CAPABILITIES = Object.freeze({
  mcp: { policy: 'unsupported' },
  workState: { supported: false },
  nativeSkills: { supported: false },
  strictLfJsonStream: { supported: true },
});
