import { expect, it } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createMuseAgentRuntime } from './runtime.js';

it.each(['permission profile', 'fork MCP'] as const)('preserves the %s refusal as a typed client-start cause', async cause => {
  // This pre-launch boundary fixture supplies only the host scope read before
  // admission. Reaching native execution instead of refusing is a test failure.
  const context = { signal: new AbortController().signal, session: { services: {} }, services: {} } as unknown as AgentSessionRuntimeContext;
  const request: AgentSessionOpenRequest = cause === 'permission profile'
    ? { kind: 'create', sessionId: 'muse-startup-refusal', cwd: process.cwd(),
        configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'yolo', updatedAtMs: 0 }, options: {} } }
    : { kind: 'fork', sessionId: 'muse-startup-refusal', cwd: process.cwd(),
        source: { sessionId: 'source-host', providerSessionId: '00000000-0000-7000-8000-000000000002', cwd: process.cwd() },
        mcpServers: { happier: { command: 'selected-happier-bridge' } } };
  await expect(createMuseAgentRuntime().sessions.open(request, context)).rejects.toMatchObject({
    code: 'agent_startup_invalid_state', retryable: false,
    details: { failureCause: { code: 'agent_startup_invalid_state', phase: 'client_start',
      failureReason: 'unclassified_provider_error', providerErrorMessage: expect.any(String) } },
  });
});
