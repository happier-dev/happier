import { describe, expect, it } from 'vitest';

import { clearServerScopedAuthStateInSettings } from './clearServerScopedAuthState';
import type { Settings } from '@/persistence';

describe('clearServerScopedAuthStateInSettings', () => {
  it('clears machine id, account-bound machine ids, token sub, confirmation, and cursors for target server only', () => {
    const input: Settings = {
      schemaVersion: 6,
      onboardingCompleted: true,
      machineIdByServerId: { cloud: 'm1', other: 'm2' },
      machineIdByServerIdByAccountId: { cloud: { a: 'm1' }, other: { b: 'm2' } },
      lastTokenSubByServerId: { cloud: 'a', other: 'b' },
      machineIdConfirmedByServerByServerId: { cloud: true, other: true },
      lastChangesCursorByServerIdByAccountId: { cloud: { a: 1 }, other: { b: 2 } },
    };

    const out = clearServerScopedAuthStateInSettings(input, 'cloud');

    expect(out.machineIdByServerId).toEqual({ other: 'm2' });
    expect(out.machineIdByServerIdByAccountId).toEqual({ other: { b: 'm2' } });
    expect(out.lastTokenSubByServerId).toEqual({ other: 'b' });
    expect(out.machineIdConfirmedByServerByServerId).toEqual({ other: true });
    expect(out.lastChangesCursorByServerIdByAccountId).toEqual({ other: { b: 2 } });
  });
});
