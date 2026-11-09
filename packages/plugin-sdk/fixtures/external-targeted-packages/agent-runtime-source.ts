import {
  AgentSessionProviderBindingV1Schema,
  AgentSessionRuntimeEventSchema,
  type AgentSessionCompactRequest,
  type AgentSessionOpenRequest,
  type AgentSessionHappierToolsService,
  type AgentSessionProviderBinding,
  type AgentSessionProviderCheckpoint,
  type AgentSessionRuntimeContext,
  type AgentSessionRuntimeEvent,
  type AgentSessionSendRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginCustomAgentDeclaration } from '@happier-dev/plugin-sdk/agents';

export const externalRuntimeEvent: AgentSessionRuntimeEvent = {
  kind: 'input-accepted',
  sequence: 1,
  sessionId: 'session-external',
  emittedAtMs: 1,
  inputIds: ['input-external'],
  delivery: { kind: 'newTurn', turnId: 'turn-external' },
};

export const externalProviderBinding: AgentSessionProviderBinding = {
  connectionId: 'connection-external',
  upstream: {
    protocol: 'openai-responses',
    normalizedUrl: 'https://api.example.test/v1',
    credential: 'apiKey',
  },
  model: {
    id: 'model-external',
    name: 'External model',
  },
  materialization: { v: 1, kind: 'spawnEnv' },
};

export const externalProviderCheckpoint: AgentSessionProviderCheckpoint = {
  providerRevision: 1,
};

export const externalOpenRequest = {
  kind: 'create',
  sessionId: 'session-external',
  cwd: '/external',
  startupInstructions: {
    v: 1,
    id: 'startup-external',
    revision: 1,
    instructions: 'Use the external author contract.',
  },
} satisfies AgentSessionOpenRequest;

export const externalSendRequest: AgentSessionSendRequest = {
  inputIds: ['input-external'],
  input: { text: 'Hello from an external author.' },
  delivery: { kind: 'newTurn', turnId: 'turn-external' },
};

export const externalCompactRequest: AgentSessionCompactRequest = {
  compactionId: 'compact-external',
  trigger: 'manual',
};

/** Provider-native child evidence uses the focused Agent Session seam, not generic Session mutation. */
export async function publishExternalNativeSubagent(
  context: AgentSessionRuntimeContext,
) {
  return await context.session.services.subagents.observe({
    observationId: 'external-native-child-1',
    status: 'running',
    detail: { source: 'external-agent-native-event' },
  });
}

/** Public schema values remain useable without importing Protocol directly. */
export const externalRuntimeSchemaValues = [
  AgentSessionProviderBindingV1Schema,
  AgentSessionRuntimeEventSchema,
] as const;

/** An external Agent declares delivery; the host still owns its Session authentication. */
export const externalShellBridgeAgentDeclaration = {
  title: 'External shell bridge Agent',
  runtime: { kind: 'custom' },
  primary: 'sessions',
  capabilities: {
    sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
    tools: { delivery: 'shell_bridge' },
  },
} satisfies PluginCustomAgentDeclaration;

/** Forward the resulting launch unchanged to the bridge child, including its opaque env. */
export async function resolveExternalHappierToolsBridge(
  request: AgentSessionOpenRequest,
  context: Pick<AgentSessionRuntimeContext, 'session' | 'signal'>,
): ReturnType<AgentSessionHappierToolsService['resolveNativeBridge']> {
  const service = context.session.services.happierTools;
  if (!service) throw new Error('Happier tools are unavailable for this Session');
  return await service.resolveNativeBridge({
    systemPrompt: request.kind === 'fork' ? undefined : request.startupInstructions?.instructions,
  }, { signal: context.signal });
}
