import {
  createExecutionRunHostBackendFromSessionRuntime,
  type AgentExecutionRunOpenRequest,
  type AgentRuntime,
  type AgentRuntimeContext,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { ConcreteAntigravityRuntimeMode } from '../lifecycle/runtimeMode.js';
import { createAntigravityNativeTerminalSurface } from '../terminal/nativeSurface.js';

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
        return await createExecutionRunHostBackendFromSessionRuntime({
          request,
          openSession: async () => await openExecutionRunRuntime(request, context),
        });
      },
    },
    surfaces: {
      terminal: createAntigravityNativeTerminalSurface(),
    },
  };
}
