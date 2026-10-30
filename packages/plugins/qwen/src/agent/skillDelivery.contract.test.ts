import { afterAll, beforeAll, expect, it } from 'vitest';
import { runAgentSkillDeliveryContract } from '@happier-dev/plugin-sdk/testing';
import { createSkillDeliveryPluginFixture } from '../../../../../apps/cli/src/agent/acp/testkit/skillDeliveryPluginFixture';
import { normalizePluginDeclarativeAcpRuntime } from '../../../../../apps/cli/src/agent/acp/runtime/definition/plugin';
import { PLUGIN_MANIFEST } from '../manifest.js';

const agent = PLUGIN_MANIFEST.contributes.agents[0]!;
let fixture: Awaited<ReturnType<typeof createSkillDeliveryPluginFixture>>;
beforeAll(async () => { fixture = await createSkillDeliveryPluginFixture(agent); });
afterAll(async () => { await fixture?.dispose(); });
it('graduates the probed Qwen defaults-file carrier', () => {
  expect(agent.capabilities.skills?.delivery).toBe('session_dir');
});
const openSession = (request: Parameters<typeof fixture.open>[0]) => fixture.open(request,
  normalizePluginDeclarativeAcpRuntime(agent.runtime));
runAgentSkillDeliveryContract({ agent, openSession, observeLaunch: () => fixture.observeLaunch(), variants: [
  { id: 'resume', open: request => openSession({ ...request, kind: 'resume', providerSessionId: 'qwen-checkpoint' }), expect: 'delivers' },
] });
