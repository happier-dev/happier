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
  /** The finite create or resumed Run whose lifecycle this adapter owns. */
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' | 'resume' }>;
  /** Host Session identity whose services and work state custody this Run. */
  sessionId: string;
  /** Opens the provider-native Session that executes the finite Run. */
  openSession: (
    request: Extract<AgentSessionOpenRequest, { kind: 'create' | 'resume' }>,
  ) => AgentSessionRuntime | Promise<AgentSessionRuntime>;
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

export type AgentFiniteExecutionRunProgressEvent =
  | Readonly<{ kind: 'run-progress' }>
  | Readonly<{
      kind: 'output-delta';
      channel: 'assistant' | 'reasoning';
      text: string;
    }>
  | Readonly<{ kind: 'checkpoint'; checkpointId: string }>;

export type AgentFiniteExecutionRunResult =
  | Readonly<{ status: 'complete' }>
  | Readonly<{ status: 'failed'; diagnostic?: PluginDiagnosticData }>
  | Readonly<{ status: 'cancelled'; diagnostic?: PluginDiagnosticData }>;

export type AgentFiniteExecutionRunHostOptions = Readonly<{
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>;
  signal?: AbortSignal;
  execute(context: Readonly<{
    signal: AbortSignal;
    emit(event: AgentFiniteExecutionRunProgressEvent): void;
  }>): Promise<AgentFiniteExecutionRunResult>;
  mapFailure(error: unknown): PluginDiagnosticData;
  unsupportedSendDiagnostic: PluginDiagnosticData;
}>;

function isTerminalExecutionRunEvent(event: AgentExecutionRunEventInput): boolean {
  return event.kind === 'run-complete'
    || event.kind === 'run-failed'
    || event.kind === 'run-cancelled';
}

type AgentExecutionRunLifecycle = Readonly<{
  runtime: AgentExecutionRunRuntime;
  emit(event: AgentExecutionRunEventInput, emittedAtMs?: number): void;
  isTerminal(): boolean;
}>;

type AgentExecutionRunLifecycleOptions = Readonly<{
  runId: string;
  send(
    lifecycle: AgentExecutionRunLifecycle,
    input: AgentSessionInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentExecutionRunSendResult>;
  stop(
    lifecycle: AgentExecutionRunLifecycle,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentExecutionRunStopResult>;
  dispose(): Promise<void>;
}>;

/**
 * The single owner of Execution Run publication, replay, terminalization, and
 * disposal. Session-backed and direct finite projections supply only their
 * distinct admission, cancellation, and native-cleanup operations.
 */
function createExecutionRunLifecycle(
  options: AgentExecutionRunLifecycleOptions,
): AgentExecutionRunLifecycle {
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let terminal = false;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const emit = (event: AgentExecutionRunEventInput, emittedAtMs = Date.now()): void => {
    if (terminal) return;
    if (isTerminalExecutionRunEvent(event)) terminal = true;
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      runId: options.runId,
      emittedAtMs,
    }) as AgentExecutionRunEvent;
    history.push(published);
    for (const listener of Array.from(listeners)) {
      try {
        listener(published);
      } catch {
        // One projection cannot interrupt ordered publication or terminal cleanup.
      }
    }
  };

  let lifecycle!: AgentExecutionRunLifecycle;
  const runtime: AgentExecutionRunRuntime = {
    async send(input, sendOptions) {
      if (terminal || disposed) return { status: 'unavailable' };
      return await options.send(lifecycle, input, sendOptions);
    },
    async stop(stopOptions) {
      if (terminal || disposed) return { status: 'notRunning' };
      return await options.stop(lifecycle, stopOptions);
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
      // Establish the exactly-once fence before terminal publication: a Run
      // subscriber may synchronously re-enter dispose while receiving the
      // cancellation event.
      disposePromise = Promise.resolve();
      disposed = true;
      emit({ kind: 'run-cancelled' });
      listeners.clear();
      // Terminal truth and controller retirement are host-owned settlement.
      // Provider cleanup is exactly-once, detached, and best effort: a plugin
      // promise that never settles must not retain a completed Run forever.
      void Promise.resolve()
        .then(async () => await options.dispose())
        .catch(() => undefined);
      return await disposePromise;
    },
  };
  lifecycle = Object.freeze({
    runtime: Object.freeze(runtime),
    emit,
    isTerminal: () => terminal,
  });
  emit({ kind: 'run-start' });
  return lifecycle;
}

/**
 * Runs one native finite operation behind the canonical Execution Run event,
 * cancellation, replay, terminalization, and disposal lifecycle.
 */
export function createFiniteExecutionRunHostRuntime(
  options: AgentFiniteExecutionRunHostOptions,
): AgentExecutionRunRuntime {
  const abortController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;
  let execution: Promise<void>;
  const lifecycle = createExecutionRunLifecycle({
    runId: options.request.runId,
    async send() {
      return {
        status: 'unsupported',
        diagnostic: options.unsupportedSendDiagnostic,
      };
    },
    async stop() {
      abortController.abort(new Error('Finite Agent execution run stopped'));
      return { status: 'requested' };
    },
    async dispose() {
      abortController.abort(new Error('Finite Agent execution run disposed'));
      void execution.catch(() => undefined);
    },
  });
  execution = (async () => {
    let result: AgentFiniteExecutionRunResult;
    try {
      result = await options.execute({ signal, emit: lifecycle.emit });
    } catch (error) {
      result = signal.aborted
        ? { status: 'cancelled' }
        : { status: 'failed', diagnostic: options.mapFailure(error) };
    }
    if (result.status === 'complete') {
      lifecycle.emit({ kind: 'run-complete' });
    } else if (result.status === 'failed') {
      lifecycle.emit({
        kind: 'run-failed',
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      });
    } else {
      lifecycle.emit({
        kind: 'run-cancelled',
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      });
    }
  })();
  return lifecycle.runtime;
}

function createExecutionRunRuntimeFromSession(
  options: AgentExecutionRunSessionAdapterOptions,
  session: AgentSessionRuntime,
): AgentExecutionRunRuntime {
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;
  let activeInputIds: readonly string[] = [];
  let subscription: Disposable | null = null;
  const disposeAfterTerminal = (): void => {
    void Promise.resolve().then(async () => await lifecycle.runtime.dispose()).catch(() => {
      // The terminal Run fact remains authoritative when provider cleanup fails.
    });
  };
  const lifecycle = createExecutionRunLifecycle({
    runId: options.request.runId,
    async send({ emit }, input, sendOptions) {
      if (activeTurnId) return { status: 'unavailable' };
      const turnId = `${options.request.runId}-turn-${++turnOrdinal}`;
      const inputIds = [`${options.request.runId}-input-${turnOrdinal}`] as const;
      activeTurnId = turnId;
      activeInputIds = inputIds;
      let result: Awaited<ReturnType<AgentSessionRuntime['send']>>;
      try {
        result = await session.send({
          inputIds: [...inputIds],
          input,
          delivery: { kind: 'newTurn', turnId },
        }, sendOptions);
      } catch (error) {
        emit({ kind: 'run-failed' });
        try {
          await lifecycle.runtime.dispose();
        } catch {
          // Preserve the send failure after cleanup has been attempted.
        }
        throw error;
      }
      if (result.status === 'admitted') return { status: 'admitted' };
      emit({
        kind: 'run-failed',
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      });
      try {
        await lifecycle.runtime.dispose();
      } catch {
        // Preserve the provider rejection after cleanup has been attempted.
      }
      return { status: result.status, diagnostic: result.diagnostic };
    },
    async stop(_lifecycle, stopOptions) {
      if (!activeTurnId) return { status: 'notRunning' };
      const result = await session.cancel?.({ turnId: activeTurnId, reason: 'user' }, stopOptions);
      if (result?.status === 'notRunning') {
        await lifecycle.runtime.dispose();
      }
      return { status: result?.status ?? 'unsupported' };
    },
    async dispose() {
      try {
        subscription?.dispose();
      } finally {
        await session.dispose();
      }
    },
  });
  subscription = session.watch((event) => {
    if (lifecycle.isTerminal()) return;
    const checkpointId = options.readCheckpointId?.(event);
    if (checkpointId !== undefined && checkpointId !== null) {
      lifecycle.emit({ kind: 'checkpoint', checkpointId }, event.emittedAtMs);
      return;
    }
    if (event.kind === 'runtime-ended') {
      activeTurnId = null;
      activeInputIds = [];
      lifecycle.emit({
        kind: 'run-failed',
        ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
      }, event.emittedAtMs);
      disposeAfterTerminal();
      return;
    }
    if (
      event.kind === 'input-rejected'
      || event.kind === 'input-custody-unknown'
      || event.kind === 'input-delivery-failed'
    ) {
      const hasExactInputs = event.inputIds.length === activeInputIds.length
        && event.inputIds.every((inputId) => activeInputIds.includes(inputId));
      if (!hasExactInputs) return;
      if (event.kind === 'input-delivery-failed' && event.delivery.turnId !== activeTurnId) return;
      activeTurnId = null;
      activeInputIds = [];
      lifecycle.emit({
        kind: 'run-failed',
        diagnostic: event.kind === 'input-rejected' ? event.diagnostic : event.issue,
      }, event.emittedAtMs);
      disposeAfterTerminal();
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
        lifecycle.emit({ kind: 'output-delta', channel: event.channel, text: event.text }, event.emittedAtMs);
        return;
      case 'turn-progress':
        lifecycle.emit({ kind: 'run-progress' }, event.emittedAtMs);
        return;
      case 'turn-complete':
        activeTurnId = null;
        activeInputIds = [];
        lifecycle.emit({ kind: 'run-complete' }, event.emittedAtMs);
        disposeAfterTerminal();
        return;
      case 'turn-failed':
        activeTurnId = null;
        activeInputIds = [];
        lifecycle.emit({ kind: 'run-failed', diagnostic: event.diagnostic }, event.emittedAtMs);
        disposeAfterTerminal();
        return;
      case 'turn-cancelled':
        activeTurnId = null;
        activeInputIds = [];
        lifecycle.emit({
          kind: 'run-cancelled',
          ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
        }, event.emittedAtMs);
        disposeAfterTerminal();
        return;
    }
  });
  return lifecycle.runtime;
}

function createSessionOpenRequestFromExecutionRun(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' | 'resume' }>,
  sessionId: string,
): Extract<AgentSessionOpenRequest, { kind: 'create' | 'resume' }> {
  const common = {
    sessionId,
    cwd: request.cwd,
    ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
    ...(request.configuration ? { configuration: request.configuration } : {}),
    ...(request.providerBinding ? { providerBinding: request.providerBinding } : {}),
    ...(request.stateSharing ? { stateSharing: request.stateSharing } : {}),
  };
  return request.kind === 'resume'
    ? { ...common, kind: 'resume', providerSessionId: request.checkpointId }
    : { ...common, kind: 'create' };
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
    session = await options.openSession(createSessionOpenRequestFromExecutionRun(
      options.request,
      options.sessionId,
    ));
    runtime = createExecutionRunRuntimeFromSession(options, session);
    if (options.request.kind === 'create') {
      const result = await runtime.send(options.request.input);
      if (result.status !== 'admitted') await runtime.dispose();
    }
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
