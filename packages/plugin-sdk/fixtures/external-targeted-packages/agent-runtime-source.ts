import {
  AgentSessionProviderBindingV1Schema,
  AgentSessionRuntimeEventSchema,
  type AgentSessionCompactRequest,
  type AgentSessionOpenRequest,
  type AgentSessionProviderBinding,
  type AgentSessionProviderCheckpoint,
  type AgentSessionRuntimeEvent,
  type AgentSessionSendRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

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

export const externalOpenRequest: AgentSessionOpenRequest = {
  kind: 'create',
  sessionId: 'session-external',
  cwd: '/external',
  startupInstructions: {
    v: 1,
    id: 'startup-external',
    revision: 1,
    instructions: 'Use the external author contract.',
  },
};

export const externalSendRequest: AgentSessionSendRequest = {
  inputIds: ['input-external'],
  input: { text: 'Hello from an external author.' },
  delivery: { kind: 'newTurn', turnId: 'turn-external' },
};

export const externalCompactRequest: AgentSessionCompactRequest = {
  compactionId: 'compact-external',
  trigger: 'manual',
};

/** Public schema values remain useable without importing Protocol directly. */
export const externalRuntimeSchemaValues = [
  AgentSessionProviderBindingV1Schema,
  AgentSessionRuntimeEventSchema,
] as const;
