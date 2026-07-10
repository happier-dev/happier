import test from 'node:test';
import assert from 'node:assert/strict';

test('package export entrypoints load in Node ESM', async () => {
  const links = await import('../dist/links.js');
  assert.equal(typeof links.buildTerminalConnectLinks, 'function');
  assert.equal(typeof links.buildConfigureServerLinks, 'function');

  const tailscale = await import('../dist/tailscale/index.js');
  assert.equal(typeof tailscale.resolveTailscaleBin, 'function');
  assert.equal(typeof tailscale.tailscaleServeStatusMatchesInternalServerUrl, 'function');

  const service = await import('../dist/service/index.js');
  assert.equal(typeof service.resolveServiceBackend, 'function');

  const agents = await import('../dist/agents/index.js');
  assert.equal(typeof agents.planAgentCliInstall, 'function');

  const root = await import('../dist/index.js');
  assert.equal(typeof root.links.buildTerminalConnectLinks, 'function');
  assert.equal(typeof root.tailscale.resolveTailscaleBin, 'function');
  assert.equal(typeof root.service.resolveServiceBackend, 'function');
  assert.equal(typeof root.service.listKnownServiceDefinitionFiles, 'function');
  assert.equal(typeof root.agents.planAgentCliInstall, 'function');

  const firstPartyRuntime = await import('../dist/firstPartyRuntime/index.js');
  assert.equal(typeof firstPartyRuntime.getFirstPartyComponentCatalogEntry, 'function');
  assert.equal(typeof root.firstPartyRuntime.getFirstPartyComponentCatalogEntry, 'function');

  const serviceDiscovery = await import('../dist/service/discovery/index.js');
  assert.equal(typeof serviceDiscovery.parseLaunchdPlist, 'function');
  assert.equal(typeof root.service.parseLaunchdPlist, 'function');
});
