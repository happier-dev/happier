import { describe, expect, it } from 'vitest';

import { resolveProjectServiceStartChoice } from './projectServicePlacement';

describe('Project service next-start choice', () => {
  it('uses the service entry independently of the finite worker preference', () => {
    expect(resolveProjectServiceStartChoice({
      execution: 'portable',
      placement: { status: 'ready', placement: {
        runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-b' } },
        unavailable: 'fail',
      }, revision: 4, provenance: 'saved' },
    })).toEqual({ status: 'resolved', choice: {
      kind: 'workers', destination: { kind: 'machine', machineId: 'worker-b' },
    }, unavailable: 'fail', provenance: 'saved' });
  });

  it('defaults only a successfully read absent entry to primary/fail', () => {
    expect(resolveProjectServiceStartChoice({ execution: 'portable', placement: {
      status: 'ready', placement: { runsOn: { kind: 'primary' }, unavailable: 'fail' },
      revision: 'absent', provenance: 'default',
    } })).toEqual({ status: 'resolved', choice: { kind: 'primary' }, unavailable: 'fail', provenance: 'default' });
    for (const status of ['locked', 'invalid', 'unavailable'] as const) {
      expect(resolveProjectServiceStartChoice({ execution: 'portable', placement: { status } }))
        .toEqual({ status: 'refused', reason: 'settings_unavailable' });
    }
  });

  it('refuses primary-only worker requests before target selection or effects', () => {
    expect(resolveProjectServiceStartChoice({ execution: 'primary', placement: {
      status: 'ready', placement: { runsOn: { kind: 'primary' }, unavailable: 'fail' },
      revision: 'absent', provenance: 'default',
    }, invocation: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-b' } } }))
      .toEqual({ status: 'refused', reason: 'primary_only' });
  });

  it('preserves an exact request and leaves Auto unresolved until start-time admission', () => {
    const placement = { status: 'ready', placement: {
      runsOn: { kind: 'workers', destination: {
        kind: 'pool', poolId: '00000000-0000-4000-8000-000000000001', selection: 'automatic',
      } }, unavailable: 'primary',
    }, revision: 1, provenance: 'saved' } as const;
    expect(resolveProjectServiceStartChoice({ execution: 'portable', placement }))
      .toEqual({ status: 'resolved', choice: placement.placement.runsOn, unavailable: 'primary', provenance: 'saved' });
    expect(resolveProjectServiceStartChoice({ execution: 'portable', placement, invocation: {
      kind: 'workers', destination: { kind: 'machine', machineId: 'worker-exact' },
    } })).toEqual({ status: 'resolved', choice: {
      kind: 'workers', destination: { kind: 'machine', machineId: 'worker-exact' },
    }, unavailable: 'primary', provenance: 'invocation' });
  });
});
