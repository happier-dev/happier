import { expect, it } from 'vitest';
import { evaluateAgentSessionCapabilitySupport, getAgentSessionCapability } from '@happier-dev/agents';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';

it('makes counted native usage available through the public catalog and admitted Session capability reader', async () => {
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'muse-usage-capability', cwd: process.cwd() });
    const support = evaluateAgentSessionCapabilitySupport({ agentId: 'muse', capability: 'usageReporting',
      metadata: { agentRuntimeCapabilitiesV1: session.runtimeCapabilities } });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toEqual([]);
    expect(support).toBe('supported');
    expect(getAgentSessionCapability('muse', 'usageReporting')).toBe('supported');
  } finally {
    await fixture.dispose();
  }
});
