import { expect, it } from 'vitest';
import { projectMachineAgentsDetectResponse } from '@happier-dev/protocol';
import { resolveMachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { createProbeTempDir } from '@/capabilities/probes/agentModelsProbe.testkit';
import { observeCurrentAgentSessionFactory, requiresAgentSessionCli } from '@/agent/catalog/runtimeEntry';

import { detectCliSnapshotOnDaemonPath } from './cliSnapshot';

it('reports admitted execution-only reviewers without requiring a Session CLI', async () => {
  const home = await createProbeTempDir('happier-reviewer-inventory-');
  const fixture = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.review.slices', 'happier.review.panels'] },
  });
  const agents = fixture.registry.contributes.agents;
  const names = agents.map(agent => agent.id);
  const environment = { HOME: home.dir, USERPROFILE: home.dir, HAPPIER_HOME_DIR: home.dir, PATH: '' };
  const request = { requestedCliNames: names, requestedTools: [], includeVersion: false } as const;
  try {
    expect(agents).toHaveLength(2);
    expect(Object.values(fixture.registry.pluginDiagnosticsByPluginId).flat()).toEqual([]);
    expect(agents.every(agent => agent.runtimeSpec == null)).toBe(true);
    expect(names.map(name => requiresAgentSessionCli(name, fixture.registry))).toEqual([true, true]);
    const snapshot = await detectCliSnapshotOnDaemonPath(request, undefined, environment, home.dir);
    const results = Object.fromEntries(names.map(name => [`cli.${name}`, {
      ok: true, data: buildCliCapabilityData({ request: { id: `cli.${name}` }, entry: snapshot.clis[name] }),
    }]));
    const inventory = projectMachineAgentsDetectResponse({
      agents: agents.map(agent => ({ agentId: agent.id, title: agent.id })),
      response: { protocolVersion: 1, results },
    });
    expect(inventory.items.map(item => ({ agentId: item.agentId, state: resolveMachineAgentExecutionStateV1(item) })))
      .toEqual(names.map(agentId => ({ agentId, state: 'ready' })));
    const observations = await Promise.all(names.map(name => observeCurrentAgentSessionFactory(name, { registry: fixture.registry })));
    const requester = await detectCliSnapshotOnDaemonPath(request, {
      observations: Object.fromEntries(observations.map((observation, index) => [names[index]!, observation ? {
        nativeAuthenticationRequired: observation.nativeAuthenticationRequired,
      } : null])),
      isCurrent: () => observations.every(observation => observation?.isCurrent()),
    }, environment, home.dir);
    expect(requester.clis).toEqual(snapshot.clis);
    fixture.registry.retireConsumers();
    const retired = await detectCliSnapshotOnDaemonPath(request, undefined, environment, home.dir);
    expect(names.map(name => retired.clis[name]?.installed)).not.toContain(true);
    const missing = await detectCliSnapshotOnDaemonPath({ ...request, requestedCliNames: ['acme.missing/reviewer'] }, undefined, environment, home.dir);
    expect(missing.clis['acme.missing/reviewer']?.installed).not.toBe(true);
  } finally {
    await fixture.lease.release();
    await fixture.dispose();
    await home.cleanup();
  }
});
