import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { runAgentSkillDeliveryContract } from '@happier-dev/plugin-sdk/testing';
import { createSkillDeliveryPluginFixture } from '../../../../../apps/cli/src/agent/acp/testkit/skillDeliveryPluginFixture';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createCopilotAgentRuntime } from './runtime/factory.js';

const agent = PLUGIN_MANIFEST.contributes.agents[0]!;
let fixture: Awaited<ReturnType<typeof createSkillDeliveryPluginFixture>>;
beforeAll(async () => { fixture = await createSkillDeliveryPluginFixture(agent); });
afterAll(async () => { await fixture?.dispose(); });
it('graduates the probed Copilot skill carrier', () => {
  expect(agent.capabilities.skills?.delivery).toBe('session_dir');
});
const runtime = createCopilotAgentRuntime({
  plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
  agent: { id: 'copilot' }, signal: new AbortController().signal,
});
const openSession = async (request: Parameters<typeof fixture.open>[0]) => {
  const factory = await runtime;
  if (!factory.sessions) throw new Error('Expected Copilot Sessions.');
  // The host ACP service is the plugin's external boundary; its real file
  // shaping runs in the fixture and the composed CLI suite covers the process.
  const context = { protocols: { acp: { open: fixture.open } } } as unknown as AgentSessionRuntimeContext;
  return await factory.sessions.open({ ...request, configuration: {
    mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
    permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {},
  } }, context);
};
runAgentSkillDeliveryContract({ agent, openSession, observeLaunch: () => fixture.observeLaunch(), variants: [
  { id: 'resume', open: request => openSession({ ...request, kind: 'resume', providerSessionId: 'copilot-checkpoint' }), expect: 'delivers' },
] });
