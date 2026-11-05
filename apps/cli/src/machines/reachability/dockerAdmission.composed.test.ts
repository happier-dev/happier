// The canonical journey substitutes native OS boundaries and runs the real Home/Action path.
import { createDockerNetworkAuthoredProvider, createGenericDefaultFactoryJourney, executeReviewedReachabilityConfigure,
  journey, machineId, parseReachabilityInspectResult, selection,
} from './genericMachineReachability.testkit';
import { userInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe.runIf(process.platform === 'linux' && userInfo().uid !== 0)('public Docker admission diagnostic', () => {
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;
  let selected: typeof selection;

  beforeEach(async () => {
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true, false, { installDockerService: true });
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [selected], { providerSelection: selected, dockerUnitsAvailable: true,
      authoredProvider, dockerProcessAvailable: false, dockerInventoryAvailable: false });
    api = await createGenericDefaultFactoryJourney(fixture);
  // Reuse the canonical Generic Home fixture's acquisition budget.
  }, 120_000);
  afterEach(async () => { await api?.dispose(); });

  it('preserves the engine owner’s recovery message before credentials or native effects', async () => {
    const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
      serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
    }));
    const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
    expect(result).toMatchObject({ ok: false, errorCode: 'native_engine_impact_ambiguous',
      error: expect.stringMatching(/review.*apply/i), effectAttempted: false });
    expect(fixture.hostNative.engineReads()).toBe(1);
    expect(fixture.hostNative.dockerUnitMutations).toEqual([]);
    expect(fixture.hostNative.networkMutations()).toBe(0);
    expect(await fixture.home.readConnectorGrantCount()).toBe(0);
    expect(fixture.elevation.launches).toHaveLength(0);
    expect(api.metadataPublications).toHaveLength(0);
  });
});
