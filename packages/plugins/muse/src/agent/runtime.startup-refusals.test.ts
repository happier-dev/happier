import { expect, it } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createMuseAgentRuntime } from './runtime.js';

it('refuses an unrepresentable tool restriction before native launch', async () => {
  // This pre-launch boundary fixture supplies only the host scope read before
  // admission. Reaching native execution instead of refusing is a test failure.
  const context = { signal: new AbortController().signal, session: { services: {} }, services: {} } as unknown as AgentSessionRuntimeContext;
  const request: AgentSessionOpenRequest = { kind: 'create', sessionId: 'muse-startup-refusal', cwd: process.cwd(),
        configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {}, allowedTools: ['Read'] } };
  await expect(createMuseAgentRuntime().sessions.open(request, context)).rejects.toMatchObject({
    code: 'unsupported',
  });
});
