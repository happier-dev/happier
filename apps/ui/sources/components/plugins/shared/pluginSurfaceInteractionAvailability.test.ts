import { describe, expect, it } from 'vitest';

import type { PluginMachineExecutionOriginStateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { isPluginSurfaceMachineConnectionPending, isPluginSurfaceSelectionOffline } from './pluginSurfaceInteractionAvailability';

type Unavailable = Extract<PluginMachineExecutionOriginStateV1, { kind: 'unavailable' }>;
const unavailable = (reasons: Unavailable['reasons']): Unavailable => ({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons });

describe('plugin surface Machine offline fact', () => {
  // READY149/150 cold load (D1): while the selection still resolves 105 candidates, its interim refusals include
  // `offline`; the page chip says "Loading…" and the list is live, so the surface must not also say "offline".
  it('is not offline while the selection is still loading, whatever interim refusals it lists', () => {
    expect(
      isPluginSurfaceSelectionOffline({
        loading: true,
        state: unavailable(['offline', 'source_not_ready', 'home_unreachable']),
      }),
    ).toBe(false);
  });

  it('is offline once the settled selection names offline', () => {
    expect(
      isPluginSurfaceSelectionOffline({
        loading: false,
        state: unavailable(['offline']),
      }),
    ).toBe(true);
    expect(
      isPluginSurfaceSelectionOffline({
        loading: false,
        state: unavailable(['unknown']),
      }),
    ).toBe(false);
  });
});

describe('plugin surface Machine connection pending fact', () => {
  const settled = { needsMachineExecution: true, executionLoading: false, targetReadRequired: true, targetReadReady: false,
    targetReadLoading: true };

  // DESIGN-ACCEPT-1116-X (C71 X2): a fresh Account with no Machine. Its widget's Account target read was still
  // fetching plugin declarations, and the surface said "Connecting to this machine" for 20+ minutes.
  it('is not pending on a Machine while only the Account target read loads and no Machine is involved', () => {
    expect(isPluginSurfaceMachineConnectionPending({ ...settled, machineId: null })).toBe(false);
  });

  it('is pending while the selection loads or the selected Machine still answers its target read', () => {
    expect(isPluginSurfaceMachineConnectionPending({ ...settled, machineId: 'machine_1' })).toBe(true);
    expect(isPluginSurfaceMachineConnectionPending({ ...settled, machineId: null, executionLoading: true })).toBe(true);
    expect(isPluginSurfaceMachineConnectionPending({ ...settled, machineId: 'machine_1', targetReadLoading: false })).toBe(false);
    expect(isPluginSurfaceMachineConnectionPending({ ...settled, machineId: 'machine_1', targetReadReady: true })).toBe(false);
  });
});
