import { describe, expect, it } from 'vitest';

import type { PluginMachineExecutionOriginStateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { isPluginSurfaceSelectionOffline } from './pluginSurfaceInteractionAvailability';

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
