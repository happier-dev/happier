import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntime,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { ConcreteAntigravityRuntimeMode } from '../lifecycle/runtimeMode.js';
import { createAntigravityNativeTerminalSurface } from '../terminal/nativeSurface.js';

type NativeExecutionRunEventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

type AntigravityNativeRuntimeFactory<TContext extends AgentRuntimeContext> = (input: Readonly<{
  mode: ConcreteAntigravityRuntimeMode;
  request: AgentSessionOpenRequest;
  context: TContext;
  connectedAccountEnv?: Readonly<Record<string, string>>;
  materializeAuthEnv?: () => Promise<Readonly<Record<string, string>> | null>;
}>) => AgentSessionRuntime | Promise<AgentSessionRuntime>;

export type AntigravityNativeSessionFactory =
  AntigravityNativeRuntimeFactory<AgentSessionRuntimeContext>;

export type AntigravityNativeExecutionRunFactory =
  AntigravityNativeRuntimeFactory<AgentRuntimeContext>;

export type CreateAntigravityNativeRuntimeOptions = Readonly<{
  openSession: AntigravityNativeSessionFactory;
  openExecutionRun: AntigravityNativeExecutionRunFactory;
  resolveMode?: (input: Readonly<{
    request: AgentSessionOpenRequest;
    context: AgentRuntimeContext;
  }>) => ConcreteAntigravityRuntimeMode | Promise<ConcreteAntigravityRuntimeMode>;
}>;

const ANTIGRAVITY_MODEL_UPSTREAM_PURPOSE = 'model_upstream';
const ANTIGRAVITY_GEMINI_SERVICE = Object.freeze({
  pluginId: 'happier.agent.gemini',
  localId: 'gemini-account',
});
const ANTIGRAVITY_GEMINI_ENVIRONMENT_KEYS = Object.freeze([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
] as const);

function isAntigravityGeminiBinding(
  binding: Awaited<ReturnType<AgentRuntimeContext['services']['connectedAccounts']['getBinding']>>,
): boolean {
  return binding?.service.pluginId === ANTIGRAVITY_GEMINI_SERVICE.pluginId
    && binding.service.localId === ANTIGRAVITY_GEMINI_SERVICE.localId;
}

async function materializeAntigravityGeminiEnvironment(
  context: AgentRuntimeContext,
): Promise<Readonly<Record<string, string>>> {
  const materialized = await context.services.connectedAccounts.materialize(
    ANTIGRAVITY_MODEL_UPSTREAM_PURPOSE,
    { kind: 'environment', keys: ANTIGRAVITY_GEMINI_ENVIRONMENT_KEYS },
    { signal: context.signal },
  );
  if (materialized.kind !== 'environment') {
    throw new Error('Antigravity Gemini account returned an invalid environment materialization.');
  }
  const env: Record<string, string> = {};
  for (const key of ANTIGRAVITY_GEMINI_ENVIRONMENT_KEYS) {
    const value = materialized.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return Object.freeze(env);
}

async function openAntigravityRuntimeWithConnectedAccount<
  TContext extends AgentRuntimeContext,
>(input: Readonly<{
  mode: ConcreteAntigravityRuntimeMode;
  request: AgentSessionOpenRequest;
  context: TContext;
  openRuntime: AntigravityNativeRuntimeFactory<TContext>;
}>): Promise<AgentSessionRuntime> {
  let initialResyncPending = true;
  let invalidated = false;
  let disposePreparedSession: ((reason: 'runtime_recovery') => Promise<void>) | null = null;
  const subscription = input.context.services.connectedAccounts.watch(
    ANTIGRAVITY_MODEL_UPSTREAM_PURPOSE,
    () => {
      if (initialResyncPending) {
        initialResyncPending = false;
        return;
      }
      invalidated = true;
      void disposePreparedSession?.('runtime_recovery');
    },
  );

  try {
    const binding = await input.context.services.connectedAccounts.getBinding(
      ANTIGRAVITY_MODEL_UPSTREAM_PURPOSE,
      { signal: input.context.signal },
    );
    const materializeAuthEnv = isAntigravityGeminiBinding(binding)
      ? async () => await materializeAntigravityGeminiEnvironment(input.context)
      : undefined;
    const connectedAccountEnv = materializeAuthEnv && input.mode === 'cliPrint'
      ? await materializeAuthEnv()
      : undefined;
    const session = await input.openRuntime({
      mode: input.mode,
      request: input.request,
      context: input.context,
      ...(connectedAccountEnv ? { connectedAccountEnv } : {}),
      ...(materializeAuthEnv && input.mode === 'sdk' ? { materializeAuthEnv } : {}),
    });
    let disposed = false;
    const dispose = async (reason?: Parameters<AgentSessionRuntime['dispose']>[0]): Promise<void> => {
      if (disposed) return;
      disposed = true;
      subscription.dispose();
      await session.dispose(reason);
    };
    disposePreparedSession = async (reason) => await dispose(reason);
    const prepared = { ...session, dispose } satisfies AgentSessionRuntime;
    if (invalidated) void dispose('runtime_recovery');
    return prepared;
  } catch (error) {
    subscription.dispose();
    throw error;
  }
}

function createExecutionRunRuntime(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
  session: AgentSessionRuntime,
): AgentExecutionRunRuntime {
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;

  const emit = (event: NativeExecutionRunEventInput, emittedAtMs = Date.now()): void => {
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      runId: request.runId,
      emittedAtMs,
    }) as AgentExecutionRunEvent;
    history.push(published);
    for (const listener of listeners) listener(published);
  };

  const subscription = session.watch((event) => {
    if (event.kind === 'message-delta') {
      emit({ kind: 'output-delta', channel: event.channel, text: event.text }, event.emittedAtMs);
    } else if (event.kind === 'turn-progress') {
      emit({ kind: 'run-progress' }, event.emittedAtMs);
    } else if (event.kind === 'turn-complete') {
      activeTurnId = null;
      emit({ kind: 'run-complete' }, event.emittedAtMs);
    } else if (event.kind === 'turn-failed') {
      activeTurnId = null;
      emit({ kind: 'run-failed', diagnostic: event.diagnostic }, event.emittedAtMs);
    } else if (event.kind === 'turn-cancelled') {
      activeTurnId = null;
      emit({ kind: 'run-cancelled', ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}) }, event.emittedAtMs);
    }
  });

  const send: AgentExecutionRunRuntime['send'] = async (input, options) => {
    activeTurnId = `${request.runId}-turn-${++turnOrdinal}`;
    const result = await session.send({
      inputIds: [`${request.runId}-input-${turnOrdinal}`],
      input,
      delivery: { kind: 'newTurn', turnId: activeTurnId },
    }, options);
    return result.status === 'admitted'
      ? { status: 'admitted' }
      : { status: result.status, diagnostic: result.diagnostic };
  };

  emit({ kind: 'run-start' });
  return {
    send,
    async stop(options) {
      if (!activeTurnId) return { status: 'notRunning' };
      const result = await session.cancel?.({ turnId: activeTurnId, reason: 'user' }, options);
      return { status: result?.status ?? 'unsupported' };
    },
    watch(listener) {
      listeners.add(listener);
      for (const event of history) listener(event);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      subscription.dispose();
      listeners.clear();
      await session.dispose();
    },
  };
}

function readRequestedMode(request: AgentSessionOpenRequest): ConcreteAntigravityRuntimeMode {
  const mode = request.configuration?.mode.value
    ?? request.configuration?.options.antigravityRuntimeMode?.value
    ?? request.launchEnvironment?.values.HAPPIER_ANTIGRAVITY_RUNTIME_MODE;
  if (mode === 'sdk' || mode === 'cliPrint') return mode;
  return 'cliPrint';
}

export function createAntigravityNativeRuntime(
  options: CreateAntigravityNativeRuntimeOptions,
): AgentRuntime {
  const openSession = async (
    request: AgentSessionOpenRequest,
    context: AgentSessionRuntimeContext,
  ): Promise<AgentSessionRuntime> => {
    const mode = request.kind === 'resume'
      ? 'cliPrint'
      : await (options.resolveMode?.({ request, context }) ?? readRequestedMode(request));
    return await openAntigravityRuntimeWithConnectedAccount({
      mode,
      request,
      context,
      openRuntime: options.openSession,
    });
  };
  const openExecutionRunRuntime = async (
    request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
    context: AgentRuntimeContext,
  ): Promise<AgentSessionRuntime> => {
    const sessionRequest: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: request.runId,
      cwd: request.cwd,
      ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
    };
    const mode = await (
      options.resolveMode?.({ request: sessionRequest, context })
      ?? readRequestedMode(sessionRequest)
    );
    return await openAntigravityRuntimeWithConnectedAccount({
      mode,
      request: sessionRequest,
      context,
      openRuntime: options.openExecutionRun,
    });
  };

  return {
    sessions: { open: openSession },
    executionRuns: {
      async open(request, context) {
        if (request.kind !== 'create') {
          throw new Error(`Antigravity execution runs do not support ${request.kind}.`);
        }
        const session = await openExecutionRunRuntime(request, context);
        const runtime = createExecutionRunRuntime(request, session);
        const result = await runtime.send(request.input);
        if (result.status !== 'admitted') await runtime.dispose();
        return runtime;
      },
    },
    surfaces: {
      terminal: createAntigravityNativeTerminalSurface(),
    },
  };
}
