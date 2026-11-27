import type { PluginDiagnosticData } from '../diagnostics.js';
import { isPluginError } from '../errors.js';
import type { PluginContributionRef } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { PluginJsonSchemaV2 } from '../actions/actionTypeMap.generated.js';
import type { AgentExecutionTargetV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import type { AgentExecutionRunEventV1 } from '@happier-dev/protocol/runtime';
import type { AgentExecutionRunHostServicesV1, AgentRuntimeContext } from './context.js';
import type {
  AgentLaunchEnvironment,
  AgentPermissionIntent,
  AgentSessionConfigurationSnapshot,
  AgentSessionInput,
  AgentSessionOpenRequest,
  AgentSessionProviderBinding,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
} from './session.js';

/**
 * Exact result requested for one Agent execution turn. This SDK-owned
 * structural projection keeps external author declarations independent from
 * Protocol's private declaration graph while Protocol remains the runtime
 * schema owner.
 */
export type AgentExecutionRunResultContractV1 =
  | { kind: 'text' }
  | { kind: 'json'; schema: PluginJsonSchemaV2 }
  | { kind: 'decision'; decisions: string[] };

export type AgentExecutionRunOpenRequest =
  Readonly<{
    runId: string;
    cwd: string;
    profile: PluginContributionRef;
    /** Admitted Agent whose existing credential binding this engine drives. */
    runnerAgentTarget?: AgentExecutionTargetV1;
    /** Host-produced model-source purposes, independent of inherited environment contents. */
    runnerConnectedAccountPurposes?: readonly string[];
    /** Runner Agent-owned translation of those selected credentials for the engine. */
    runnerConnectedAccountMaterialization?: AgentSessionProviderBinding['materialization'];
    launchEnvironment?: AgentLaunchEnvironment;
    modelSelection?: ProviderBoundModelRef;
    configuration?: AgentSessionConfigurationSnapshot;
    providerBinding?: AgentSessionProviderBinding;
    /** Exact immutable authority admitted for the host input that opened this Run. */
    causalPermissionAuthority?: AgentSessionSendRequest['causalPermissionAuthority'];
    /** Same host-resolved policy an Agent session open carries. */
    stateSharing?: AgentSessionOpenRequest['stateSharing'];
    /** Exact host-resolved MCP process bindings for this Run open. */
    mcpServers?: AgentSessionOpenRequest['mcpServers'];
    mcpServersStrictMode?: AgentSessionOpenRequest['mcpServersStrictMode'];
    mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
    /** Exact host-resolved session-private skills for this Run. */
    skills?: AgentSessionOpenRequest['skills'];
  }> & (
    | Readonly<{
        kind: 'create';
        input: AgentSessionInput;
        /** Stable host-authored identity for this initial input. */
        localInputId?: string;
        /** Exact result requested for this initial turn only. */
        resultContract?: AgentExecutionRunResultContractV1;
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

export type AgentExecutionRunEvent = AgentExecutionRunEventV1;

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
    options?: Readonly<{
      signal?: AbortSignal;
      /** Stable host-authored identity for this input. */
      localInputId?: string;
      /** Exact result requested for this turn only. */
      resultContract?: AgentExecutionRunResultContractV1;
      /** Exact immutable authority admitted for the host input that sends this turn. */
      causalPermissionAuthority?: AgentSessionSendRequest['causalPermissionAuthority'];
    }>,
  ): Promise<AgentExecutionRunSendResult>;
  stop(options?: Readonly<{ signal?: AbortSignal }>): Promise<AgentExecutionRunStopResult>;
  /**
   * Subscribes to ordered Run events. The first watcher synchronously receives
   * events published before `open()` settled, closing the open/watch race; that
   * replay is then retired. Later watchers receive live fanout, or only the
   * terminal event after settlement.
   */
  watch(listener: (event: AgentExecutionRunEvent) => void): Disposable;
}

export interface AgentExecutionRunRuntimeFactory {
  open(
    request: AgentExecutionRunOpenRequest,
    context: AgentExecutionRunRuntimeContextV1,
  ): AgentExecutionRunRuntime | Promise<AgentExecutionRunRuntime>;
}

/** Truthful host context for a detached Execution Run. */
export type AgentExecutionRunRuntimeContextV1 = Omit<AgentRuntimeContext, 'session'> & Readonly<{
  scope: Readonly<{ kind: 'execution_run'; executionRunId: string }>;
  session?: never;
  executionRun: Readonly<{
    id: string;
    services: AgentExecutionRunHostServicesV1;
  }>;
}>;

/**
 * Additive detached-run facet for Session-primary Agents. Its lifecycle is an
 * Execution Run; it must not call the Session V1 factory with a Run id.
 */
export interface AgentSessionExecutionRunRuntimeFactoryV1 {
  open(
    request: AgentExecutionRunOpenRequest,
    context: AgentExecutionRunRuntimeContextV1,
  ): AgentExecutionRunRuntime | Promise<AgentExecutionRunRuntime>;
  /**
   * Optional retained conversation. Opening does not submit the initial input;
   * the host watches first, then owns every turn and the conversation lifetime.
   * Absence means retained detached interaction is unsupported, never a finite fallback.
   */
  openConversation?(
    request: AgentExecutionRunOpenRequest,
    context: AgentExecutionRunRuntimeContextV1,
  ): AgentExecutionRunConversationRuntimeV1 | Promise<AgentExecutionRunConversationRuntimeV1>;
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
  /**
   * Preserves the provider-owned Session usage observation for a host that has
   * an existing usage publisher. Usage deliberately remains outside the finite
   * Run event union so this adapter cannot become a second terminal producer.
   */
  observeSessionUsage?: (
    event: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' | 'skill-usage' }>,
  ) => void;
}>;

export type AgentExecutionRunConversationEventV1 = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'> & Readonly<{ emittedAtMs?: number }>
    : never
  : never;

/**
 * Scope-neutral provider conversation used by shared protocol composers. It
 * deliberately carries no Happier Session identity or Session-only services.
 */
export interface AgentExecutionRunConversationRuntimeV1<
  Event extends AgentExecutionRunConversationEventV1 = AgentExecutionRunConversationEventV1,
> extends Disposable {
  send(
    request: AgentSessionSendRequest,
    options?: AgentExecutionRunConversationSendOptionsV1,
  ): Promise<AgentExecutionRunSendResult>;
  cancel?(
    request: Readonly<{
      turnId: string;
      reason: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery';
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{
    status: 'requested' | 'notRunning' | 'unavailable' | 'unsupported';
    turnId?: string;
    diagnostic?: PluginDiagnosticData;
  }>>;
  watch(listener: (event: Event) => void): Disposable;
}

export type AgentExecutionRunConversationSendOptionsV1 = Readonly<{
  signal?: AbortSignal;
  /** Resolved native policy for this input; apply before effects or refuse the input. */
  permissionIntent?: AgentPermissionIntent;
  /** Exact host-authored identity also carried in `request.inputIds`. */
  localInputId?: string;
  /** Per-turn result contract; never retained as conversation-wide configuration. */
  resultContract?: AgentExecutionRunResultContractV1;
  /** Exact current admission authority also carried on the native send request. */
  causalPermissionAuthority?: AgentSessionSendRequest['causalPermissionAuthority'];
}>;

export type AgentExecutionRunConversationAdapterOptionsV1<
  Event extends AgentExecutionRunConversationEventV1 = AgentExecutionRunConversationEventV1,
> = Readonly<{
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' | 'resume' }>;
  openConversation():
    | AgentExecutionRunConversationRuntimeV1<Event>
    | Promise<AgentExecutionRunConversationRuntimeV1<Event>>;
  readCheckpointId?: (event: Event) => string | null;
  /** Observes only the active turn's usage, preserving the provider's exact event. */
  observeUsage?: (event: Extract<Event, { kind: 'usage-observed' | 'skill-usage' }>) => void;
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
  /** Supplies a diagnostic for an untyped execution failure. */
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
    options?: Parameters<AgentExecutionRunRuntime['send']>[1],
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
  let preWatchReplay: AgentExecutionRunEvent[] | null = [];
  let terminalEvent: AgentExecutionRunEvent | null = null;
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
    preWatchReplay?.push(published);
    if (isTerminalExecutionRunEvent(event)) terminalEvent = published;
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
      if (preWatchReplay !== null) {
        const replay = preWatchReplay;
        preWatchReplay = null;
        for (const event of replay) listener(event);
      } else if (terminalEvent !== null) {
        listener(terminalEvent);
      }
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

function readPluginErrorDiagnostic(error: unknown): PluginDiagnosticData | undefined {
  if (!isPluginError(error)) return undefined;
  const { details, failureCause, remediation } = error.data;
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    details: failureCause === undefined ? details : {
      ...(isJsonObject(details) ? details : details === undefined ? {} : { producerDetails: details }),
      failureCause,
    },
    ...(remediation === undefined ? {} : { remediation }),
  };
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
        : { status: 'failed', diagnostic: readPluginErrorDiagnostic(error) ?? options.mapFailure(error) };
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

function createExecutionRunRuntimeFromConversation<Event extends AgentExecutionRunConversationEventV1>(
  options: Omit<AgentExecutionRunConversationAdapterOptionsV1<Event>, 'openConversation'>,
  session: AgentExecutionRunConversationRuntimeV1<Event>,
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
      const inputIds = [
        sendOptions?.localInputId
          ?? (options.request.kind === 'create' && turnOrdinal === 1
            ? options.request.localInputId
            : undefined)
          ?? `${options.request.runId}-input-${turnOrdinal}`,
      ] as const;
      activeTurnId = turnId;
      activeInputIds = inputIds;
      let result: AgentExecutionRunSendResult;
      try {
        const causalPermissionAuthority = sendOptions?.causalPermissionAuthority
          ?? options.request.causalPermissionAuthority;
        result = await session.send({
          inputIds: [...inputIds],
          input,
          delivery: { kind: 'newTurn', turnId },
          ...(causalPermissionAuthority
            ? { causalPermissionAuthority }
            : {}),
        }, sendOptions);
      } catch (error) {
        const diagnostic = readPluginErrorDiagnostic(error);
        emit({ kind: 'run-failed', ...(diagnostic === undefined ? {} : { diagnostic }) });
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
    if (event.kind === 'usage-observed' || event.kind === 'skill-usage') {
      if (!activeTurnId || (event.turnId !== undefined && event.turnId !== activeTurnId)) {
        return;
      }
      try {
        if (event.kind === 'usage-observed' && !options.observeUsage) {
          // Session-backed callers already own publication through their
          // explicit observer. Detached finite Runs carry the same payload.
          const { sessionId: _sessionId, sequence: _sequence, emittedAtMs, ...usage } = event as
            Extract<Event, { kind: 'usage-observed' }> & { sessionId?: string; sequence?: number };
          lifecycle.emit(usage, emittedAtMs);
        }
        // The kind check narrows the generic event to its usage members.
        options.observeUsage?.(event as Extract<Event, { kind: 'usage-observed' | 'skill-usage' }>);
      } catch {
        // Usage publication is observational and cannot change Run lifecycle.
      }
      return;
    }
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
      && event.kind !== 'transcript-message-committed'
      && event.kind !== 'turn-progress'
      && event.kind !== 'turn-complete'
      && event.kind !== 'turn-failed'
      && event.kind !== 'turn-cancelled') {
      return;
    }
    if (event.turnId !== activeTurnId) return;
    if ((event.kind === 'message-delta' || event.kind === 'transcript-message-committed')
      && event.sidechainId !== undefined) return;
    switch (event.kind) {
      case 'message-delta':
        lifecycle.emit({ kind: 'output-delta', channel: event.channel, text: event.text,
          ...(event.messageId ? { messageId: event.messageId } : {}),
          ...(event.phase ? { phase: event.phase } : {}) }, event.emittedAtMs);
        return;
      case 'transcript-message-committed':
        if (event.role !== 'assistant') return;
        lifecycle.emit({ kind: 'output-message-committed', channel: 'assistant',
          messageId: event.messageId, text: event.text }, event.emittedAtMs);
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
    ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
    ...(request.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: request.mcpServersStrictMode } : {}),
    ...(request.mcpToolPolicy ? { mcpToolPolicy: request.mcpToolPolicy } : {}),
    ...(request.skills ? { skills: request.skills } : {}),
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
  return await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
    request: options.request,
    openConversation: async () => await options.openSession(createSessionOpenRequestFromExecutionRun(
      options.request,
      options.sessionId,
    )),
    ...(options.readCheckpointId ? { readCheckpointId: options.readCheckpointId } : {}),
    ...(options.observeSessionUsage ? { observeUsage: options.observeSessionUsage } : {}),
  });
}

/**
 * Adapts a provider conversation that has no Happier Session identity into the
 * canonical Execution Run lifecycle. This is the truthful path used by
 * versioned protocol composers such as ACP execution-run V1.
 */
export async function createExecutionRunHostBackendFromConversationRuntime<
  Event extends AgentExecutionRunConversationEventV1 = AgentExecutionRunConversationEventV1,
>(
  options: AgentExecutionRunConversationAdapterOptionsV1<Event>,
): Promise<AgentExecutionRunRuntime> {
  let conversation: AgentExecutionRunConversationRuntimeV1<Event> | null = null;
  let runtime: AgentExecutionRunRuntime | null = null;
  try {
    conversation = await options.openConversation();
    runtime = createExecutionRunRuntimeFromConversation(options, conversation);
    if (options.request.kind === 'create') {
      const result = await runtime.send(options.request.input, {
        ...(options.request.localInputId ? { localInputId: options.request.localInputId } : {}),
        ...(options.request.resultContract ? { resultContract: options.request.resultContract } : {}),
        ...(options.request.causalPermissionAuthority
          ? { causalPermissionAuthority: options.request.causalPermissionAuthority }
          : {}),
      });
      if (result.status !== 'admitted') await runtime.dispose();
    }
    return runtime;
  } catch (error) {
    try {
      await (runtime?.dispose() ?? conversation?.dispose());
    } catch {
      // Preserve the opening or initial admission failure after cleanup.
    }
    throw error;
  }
}
