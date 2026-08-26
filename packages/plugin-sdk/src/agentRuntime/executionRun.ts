import type { PluginDiagnosticData } from '../diagnostics.js';
import type { PluginContributionRef } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { AgentRuntimeContext } from './context.js';
import type {
  AgentLaunchEnvironment,
  AgentSessionConfigurationSnapshot,
  AgentSessionInput,
  AgentSessionOpenRequest,
  AgentSessionProviderBinding,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from './session.js';

export type AgentExecutionRunOpenRequest =
  Readonly<{
    runId: string;
    cwd: string;
    profile: PluginContributionRef;
    launchEnvironment?: AgentLaunchEnvironment;
    modelSelection?: ProviderBoundModelRef;
    configuration?: AgentSessionConfigurationSnapshot;
    providerBinding?: AgentSessionProviderBinding;
    /** Same host-resolved policy an Agent session open carries. */
    stateSharing?: AgentSessionOpenRequest['stateSharing'];
  }> & (
    | Readonly<{
        kind: 'create';
        input: AgentSessionInput;
      }>
    | Readonly<{
        kind: 'resume';
        checkpointId: string;
      }>
    | Readonly<{
        kind: 'fork';
        sourceRunId: string;
        checkpointId?: string;
      }>
  );

export type AgentExecutionRunEvent =
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-start' | 'run-progress';
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'output-delta';
      channel: 'assistant' | 'reasoning';
      text: string;
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'checkpoint';
      checkpointId: string;
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-complete';
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-failed' | 'run-cancelled';
      diagnostic?: PluginDiagnosticData;
    }>;

export type AgentExecutionRunSendResult = Readonly<{
  status: 'admitted' | 'rejected' | 'unavailable' | 'unsupported';
  diagnostic?: PluginDiagnosticData;
}>;

export type AgentExecutionRunStopResult = Readonly<{
  status: 'requested' | 'notRunning' | 'unavailable' | 'unsupported';
}>;

export interface AgentExecutionRunRuntime extends Disposable {
  send(
    input: AgentSessionInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentExecutionRunSendResult>;
  stop(options?: Readonly<{ signal?: AbortSignal }>): Promise<AgentExecutionRunStopResult>;
  watch(listener: (event: AgentExecutionRunEvent) => void): Disposable;
}

export interface AgentExecutionRunRuntimeFactory {
  open(
    request: AgentExecutionRunOpenRequest,
    context: AgentRuntimeContext,
  ): AgentExecutionRunRuntime | Promise<AgentExecutionRunRuntime>;
}

export type AgentExecutionRunSessionAdapterOptions = Readonly<{
  /** The finite create-run request whose lifecycle this adapter owns. */
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>;
  /** Opens the provider-native Session that executes the finite Run. */
  openSession: () => AgentSessionRuntime | Promise<AgentSessionRuntime>;
  /**
   * Projects a provider-owned Session event to a checkpoint when that Agent
   * has one. All common Run lifecycle decisions remain in this adapter.
   */
  readCheckpointId?: (event: AgentSessionRuntimeEvent) => string | null;
}>;

type AgentExecutionRunEventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

function isTerminalExecutionRunEvent(event: AgentExecutionRunEventInput): boolean {
  return event.kind === 'run-complete'
    || event.kind === 'run-failed'
    || event.kind === 'run-cancelled';
}

function createExecutionRunRuntimeFromSession(
  options: AgentExecutionRunSessionAdapterOptions,
  session: AgentSessionRuntime,
): AgentExecutionRunRuntime {
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;
  let terminal = false;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const emit = (event: AgentExecutionRunEventInput, emittedAtMs = Date.now()): void => {
    if (terminal) return;
    const terminalEvent = isTerminalExecutionRunEvent(event);
    if (terminalEvent) {
      terminal = true;
      activeTurnId = null;
    }
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      runId: options.request.runId,
      emittedAtMs,
    }) as AgentExecutionRunEvent;
    history.push(published);
    for (const listener of Array.from(listeners)) listener(published);
  };

  emit({ kind: 'run-start' });

  const subscription = session.watch((event) => {
    if (terminal || disposed) return;
    const checkpointId = options.readCheckpointId?.(event);
    if (checkpointId !== undefined && checkpointId !== null) {
      emit({ kind: 'checkpoint', checkpointId }, event.emittedAtMs);
      return;
    }
    if (event.kind !== 'message-delta'
      && event.kind !== 'turn-progress'
      && event.kind !== 'turn-complete'
      && event.kind !== 'turn-failed'
      && event.kind !== 'turn-cancelled') {
      return;
    }
    if (event.turnId !== activeTurnId) return;
    switch (event.kind) {
      case 'message-delta':
        emit({ kind: 'output-delta', channel: event.channel, text: event.text }, event.emittedAtMs);
        return;
      case 'turn-progress':
        emit({ kind: 'run-progress' }, event.emittedAtMs);
        return;
      case 'turn-complete':
        emit({ kind: 'run-complete' }, event.emittedAtMs);
        return;
      case 'turn-failed':
        emit({ kind: 'run-failed', diagnostic: event.diagnostic }, event.emittedAtMs);
        return;
      case 'turn-cancelled':
        emit({
          kind: 'run-cancelled',
          ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
        }, event.emittedAtMs);
        return;
    }
  });

  const runtime: AgentExecutionRunRuntime = {
    async send(input, sendOptions) {
      if (terminal || disposed) return { status: 'unavailable' };
      const turnId = `${options.request.runId}-turn-${++turnOrdinal}`;
      activeTurnId = turnId;
      let result: Awaited<ReturnType<AgentSessionRuntime['send']>>;
      try {
        result = await session.send({
          inputIds: [`${options.request.runId}-input-${turnOrdinal}`],
          input,
          delivery: { kind: 'newTurn', turnId },
        }, sendOptions);
      } catch (error) {
        if (activeTurnId === turnId) activeTurnId = null;
        throw error;
      }
      if (result.status === 'admitted') return { status: 'admitted' };
      if (activeTurnId === turnId) activeTurnId = null;
      emit({
        kind: 'run-failed',
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      });
      return { status: result.status, diagnostic: result.diagnostic };
    },
    async stop(stopOptions) {
      if (!activeTurnId || terminal || disposed) return { status: 'notRunning' };
      const result = await session.cancel?.({ turnId: activeTurnId, reason: 'user' }, stopOptions);
      if (result?.status === 'requested') await runtime.dispose();
      return { status: result?.status ?? 'unsupported' };
    },
    watch(listener) {
      for (const event of history) listener(event);
      if (!terminal && !disposed) listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    async dispose() {
      if (disposePromise) return await disposePromise;
      if (!terminal && activeTurnId) emit({ kind: 'run-cancelled' });
      disposed = true;
      listeners.clear();
      disposePromise = (async () => {
        try {
          subscription.dispose();
        } finally {
          await session.dispose();
        }
      })();
      return await disposePromise;
    },
  };

  return runtime;
}

/**
 * Adapts one provider-native interactive Session into one finite execution
 * Run. The adapter is the sole owner of Run event ordering, terminalization,
 * cancellation, replay, and cleanup; Agent leaves own only session opening and
 * optional provider checkpoint projection.
 */
export async function createExecutionRunHostBackendFromSessionRuntime(
  options: AgentExecutionRunSessionAdapterOptions,
): Promise<AgentExecutionRunRuntime> {
  let session: AgentSessionRuntime | null = null;
  let runtime: AgentExecutionRunRuntime | null = null;
  try {
    session = await options.openSession();
    runtime = createExecutionRunRuntimeFromSession(options, session);
    const result = await runtime.send(options.request.input);
    if (result.status !== 'admitted') await runtime.dispose();
    return runtime;
  } catch (error) {
    try {
      await (runtime?.dispose() ?? session?.dispose());
    } catch {
      // Preserve the opening or send failure; cleanup has already been attempted.
    }
    throw error;
  }
}
