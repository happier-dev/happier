// Load the OS boundary before the production owners or named filesystem imports.
import { createDockerNetworkAuthoredProvider, createGenericDefaultFactoryJourney, executeReviewedReachabilityConfigure,
  installationId, journey, machineId, parseCompletedReachabilityConfigure, parseReachabilityInspectResult, selection,
} from './genericMachineReachability.testkit';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessProviderSelectionV1 } from '@happier-dev/plugin-sdk/access-providers';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

describe.runIf(process.platform === 'linux' && userInfo().uid !== 0)('public generic Machine reachability journey', () => {
describe('independent Generic join', () => {
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    // Same deciding invariant through a physical generic author:
    // NetBird production declarations remain deferred and unactivated.
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it.each(['disabled', 'applying', 'unavailable', 'unseparated'] as const)(
    'reports the isolation prerequisite before Saved Secret acquisition when isolation is %s', async state => {
    try {
      if (state === 'disabled') {
        await api.client.updateMachineMetadata(metadata => {
          if (!metadata) throw new Error('Expected the published Machine metadata');
          return { ...metadata, agentIsolation: { enabled: false } };
        });
        expect(api.client.getAgentIsolationSnapshot()).toMatchObject({ enabled: false });
      } else if (state === 'unseparated') {
        fixture.identity.setAgentGroupIds([fixture.identity.agentUid, fixture.identity.daemon.gid]);
      } else {
        const status = state === 'applying' ? { kind: 'applying', phase: 'account' } as const
          : { kind: 'unavailable', code: 'provisioning_unavailable' } as const;
        await api.client.updateDaemonState(current => ({ ...current, agentIsolation: status }));
        expect(api.client.getAgentIsolationSnapshot()).toMatchObject({ enabled: true, status });
      }
      const materialReads = fixture.home.secretMaterialReads.length;
      const result = await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      expect(result).not.toHaveProperty('result.plan');
      expect(fixture.home.secretMaterialReads).toHaveLength(materialReads);
      expect(fixture.hostNative.networkMutations()).toBe(0);
      expect(fixture.elevation.launches).toHaveLength(0);
    } finally { await api.dispose(); }
  });

  it('keeps a public Generic join independent of an incumbent Docker engine with zero Docker reads', async () => {
    let release!: () => void;
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = machineNativeEffectAdmission.run({ operation: { operationId: 'held-unrelated-engine', kind: 'fixture' },
      keys: [{ kind: 'composeProject', dockerEndpoint: fixture.hostNative.engineId, projectName: 'incumbent' }] }, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await running;
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      expect(parseCompletedReachabilityConfigure((await executeReviewedReachabilityConfigure(fixture, api, review)).result))
        .toMatchObject({ status: 'applied' });
      expect(fixture.hostNative.engineReads()).toBe(0);
      expect(fixture.hostNative.calls.filter(command => command.args.includes('--system'))).toEqual([]);
      expect(fixture.hostNative.networkMutations()).toBe(1);
      await expect(readFile(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      expect(api.processBoundary.failures).toEqual([]);
    } finally { release(); await held; await api.dispose(); }
  });

});
});
