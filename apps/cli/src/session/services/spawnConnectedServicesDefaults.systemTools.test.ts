import { describe, expect, it } from 'vitest';
import { resolveCliConnectedDefaultSelection } from './agentConnectedDefaultRoutes';
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
  it('projects selected account metadata independently from unavailable material and unrelated process tools', () => {
    const purposeCatalog = { status: 'ready' as const, revision: 1,
      record: { key: 'purposes' as const, value: { v: 1 as const, bindings: [
        { purpose, target: { kind: 'account' as const, account: { service, accountId: 'unavailable-account' } } },
      ] } } };
    const params = { accountSettings: {}, contributions, purposeCatalog };
    // The account need not be present in a material catalog: this is a selection,
    // never a promise of a token or permission to fall back to the Machine login.
    expect(resolveCliConnectedDefaultSelection({ ...params, agentId: `${consumer.pluginId}/${consumer.localId}` })).toBe('connectedAccount');
    expect(resolveCliConnectedDefaultSelection({ ...params, agentId: 'custom-agent' })).toBe('native');
    expect(resolveCliConnectedDefaultSelection({ ...params, agentId: `${consumer.pluginId}/${consumer.localId}`,
      purposeCatalog: { status: 'unavailable', reason: 'scope-retired' } })).toBeNull();
    const agentService = { pluginId: 'acme.agent', localId: 'model-account' };
    const agentConsumer = { pluginId: 'acme.agent', localId: 'runtime' };
    const connectedAgentContributions = { ...contributions, agentDefinitionsById: new Map([['custom-agent', {
      identity: agentConsumer, richDefinition: { definition: { connectedAccounts: [{ purpose: 'model', service: agentService,
        materializationKinds: ['environment'] }] } }, catalogEntry: {},
    }]]) };
    const agentCatalog = { ...purposeCatalog, record: { ...purposeCatalog.record, value: { v: 1 as const, bindings: [
      { purpose: { consumer: agentConsumer, purpose: 'model' }, target: { kind: 'account' as const,
        account: { service: agentService, accountId: 'selected-model' } } },
    ] } } };
    expect(resolveCliConnectedDefaultSelection({ ...params, contributions: connectedAgentContributions,
      purposeCatalog: agentCatalog, agentId: 'custom-agent' })).toBe('connectedAccount');
    expect(resolveCliConnectedDefaultSelection({ ...params, purposeCatalog: agentCatalog,
      agentId: `${consumer.pluginId}/${consumer.localId}` })).toBe('native');
  });

  it('uses the same qualified tool default when reading a standalone Machine CLI', () => {
    const purposeCatalog = { status: 'ready' as const, revision: 1,
      record: { key: 'purposes' as const, value: { v: 1 as const, bindings: [
        { purpose, target: { kind: 'account' as const, account: { service, accountId: 'selected-github' } } },
      ] } } };
    const params = { accountSettings: {}, agentId: `${consumer.pluginId}/${consumer.localId}`, contributions, purposeCatalog };
    expect(readAgentPurposeDefaults(params)).toEqual([expect.objectContaining({ purpose, service,
      target: { kind: 'account', account: { service, accountId: 'selected-github' } } })]);
    expect(resolveSpawnConnectedServicesDefaultDisposition(params)).toMatchObject({ kind: 'connected' });
    expect(resolveSpawnConnectedServicesDefaultDisposition({ ...params,
      purposeCatalog: { ...purposeCatalog, record: { ...purposeCatalog.record, value: { v: 1, bindings: [] } } },
    })).toEqual({ kind: 'native' });
  });

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
