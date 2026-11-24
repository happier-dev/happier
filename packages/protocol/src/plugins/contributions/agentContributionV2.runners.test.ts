import { describe, expect, it } from 'vitest';

import { PluginAgentContributionV2Schema } from './agentContributionV2.js';

const engine = {
  id: 'review', title: 'Review', primary: 'executionRuns', runtime: { kind: 'custom' },
  capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
};

describe('Agent runner declarations', () => {
  it('retains executable runner identities and contributed Provider protocols', () => {
    const declaration = { ...engine, runnerSelection: 'perMember', runnerAgents: [{
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.runner', localId: 'reviewer' } },
      providerProtocols: ['acme-protocol'],
    }] };
    expect(PluginAgentContributionV2Schema.parse(declaration)).toEqual(declaration);
  });

  it('rejects unresolved runner ids and malformed configured targets at manifest admission', () => {
    for (const agentTarget of ['codex', { kind: 'agent', identity: { pluginId: 'acme.runner', localId: 'reviewer' }, definitionId: 'unexpected' }]) {
      expect(PluginAgentContributionV2Schema.safeParse({ ...engine,
        runnerAgents: [{ agentTarget, providerProtocols: [] }],
      }).success).toBe(false);
    }
  });
});
