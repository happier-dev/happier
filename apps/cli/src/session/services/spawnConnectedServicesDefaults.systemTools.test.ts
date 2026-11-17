import { describe, expect, it } from 'vitest';
import { readAgentPurposeDefaults, resolveSpawnConnectedServicesDefaultDisposition } from './spawnConnectedServicesDefaults';

const service = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const consumer = { pluginId: service.pluginId, localId: 'gh' };
const purpose = { consumer, purpose: 'github.cli' };
const contributions = {
  agentDefinitionsById: new Map([['custom-agent', { identity: { pluginId: 'acme.agent', localId: 'runtime' },
    richDefinition: { definition: { connectedAccounts: [] } }, catalogEntry: {} }]]),
  systemTools: [{ pluginId: service.pluginId, definition: { id: 'gh', title: 'GitHub CLI', executableNames: ['gh'],
    connectedAccountLaunch: { purpose: purpose.purpose, service: service.localId, environmentKey: 'GH_TOKEN' } } }],
};

describe('machine CLI launch account defaults', () => {
  it('retains a tool-qualified default when its Agent declares no Connected Account', () => {
    const purposeCatalog = { status: 'ready' as const, revision: 1,
      record: { key: 'purposes' as const, value: { v: 1 as const, bindings: [
        { purpose, target: { kind: 'account' as const, account: { service, accountId: 'selected-github' } } },
      ] } } };
    const params = { accountSettings: {}, agentId: 'custom-agent', contributions, purposeCatalog };
    expect(readAgentPurposeDefaults(params)).toEqual([expect.objectContaining({
      purpose, service, target: { kind: 'account', account: { service, accountId: 'selected-github' } },
    })]);
    expect(resolveSpawnConnectedServicesDefaultDisposition(params)).toMatchObject({ kind: 'connected',
      bindings: { bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
        source: 'connected', selection: 'profile', profileId: 'selected-github',
      } } } });
  });
});
