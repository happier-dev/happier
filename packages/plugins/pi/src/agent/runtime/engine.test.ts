import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

const mocks = vi.hoisted(() => ({
  createPiRuntimeOperations: vi.fn(),
  preparePiQualifiedConnectedAccounts: vi.fn(),
}));

vi.mock('./rpc/operations.js', () => ({
  createPiRuntimeOperations: mocks.createPiRuntimeOperations,
}));

vi.mock('./qualifiedConnectedAccounts.js', () => ({
  preparePiQualifiedConnectedAccounts: mocks.preparePiQualifiedConnectedAccounts,
}));

import { buildPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import { createPiAgentRuntime } from './engine.js';

function createRuntime(): AgentSessionRuntime {
  return {
    send: vi.fn(async () => ({ status: 'admitted' as const })),
    watch: () => ({ dispose: () => undefined }),
    dispose: vi.fn(async () => undefined),
  };
}

describe('Pi Agent runtime', () => {
  beforeEach(() => {
    mocks.createPiRuntimeOperations.mockReset();
    mocks.preparePiQualifiedConnectedAccounts.mockReset();
  });

  it('interprets its bounded descriptor session file for an external resume', async () => {
    const sessionFile = '/home/lee/.pi/agent/sessions/workspace-a/pi-shared.jsonl';
    const runtime = createRuntime();
    mocks.createPiRuntimeOperations.mockResolvedValue(runtime);
    mocks.preparePiQualifiedConnectedAccounts.mockResolvedValue({
      launchEnvironment: { values: {}, unset: [] },
      isInvalidated: () => false,
      bind: (value: AgentSessionRuntime) => value,
      dispose: async () => undefined,
    });

    await createPiAgentRuntime().sessions.open({
      kind: 'resume',
      sessionId: 'happier-session-1',
      cwd: '/workspace',
      providerSessionId: 'pi-shared',
      runtimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
        resumeStrategy: 'sessionFileAbsolutePreferred',
        providerSessionId: 'pi-shared',
        sessionFile,
      }),
    } as unknown as AgentSessionOpenRequest, {
      signal: new AbortController().signal,
      services: { logger: {} },
      session: { id: 'happier-session-1', services: {} },
      workState: { publish: vi.fn() },
    } as unknown as AgentSessionRuntimeContext);

    expect(mocks.createPiRuntimeOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSessionId: sessionFile,
      }),
    );
  });
});
