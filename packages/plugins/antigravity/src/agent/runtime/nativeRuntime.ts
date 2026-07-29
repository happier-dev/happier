import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntime,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agent-runtime';

import type { ConcreteAntigravityRuntimeMode } from '../lifecycle/runtimeMode.js';
import { createAntigravityNativeTerminalSurface } from '../terminal/nativeSurface.js';

type NativeExecutionRunEventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

export type AntigravityNativeSessionFactory = (input: Readonly<{
  mode: ConcreteAntigravityRuntimeMode;
  request: AgentSessionOpenRequest;
  context: AgentRuntimeContext;
}>) => AgentSessionRuntime | Promise<AgentSessionRuntime>;

export type CreateAntigravityNativeRuntimeOptions = Readonly<{
  openSession: AntigravityNativeSessionFactory;
  resolveMode?: (input: Readonly<{
    request: AgentSessionOpenRequest;
    context: AgentRuntimeContext;
  }>) => ConcreteAntigravityRuntimeMode | Promise<ConcreteAntigravityRuntimeMode>;
}>;

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
    context: AgentRuntimeContext,
  ): Promise<AgentSessionRuntime> => {
    const mode = request.kind === 'resume'
      ? 'cliPrint'
      : await (options.resolveMode?.({ request, context }) ?? readRequestedMode(request));
    return await options.openSession({ mode, request, context });
  };

  return {
    sessions: { open: openSession },
    executionRuns: {
      async open(request, context) {
        if (request.kind !== 'create') {
          throw new Error(`Antigravity execution runs do not support ${request.kind}.`);
        }
        const session = await openSession({
          kind: 'create',
          sessionId: request.runId,
          cwd: request.cwd,
          ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
        }, context);
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
