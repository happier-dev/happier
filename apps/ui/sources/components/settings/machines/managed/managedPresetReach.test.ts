import { describe, expect, it } from 'vitest';

import { resolvePresetSharedSections } from './managedPresetReach';

const localSandbox = {
  enrollmentRole: 'sandbox' as const,
  billing: {
    location: 'local' as const,
    stoppedBilling: 'not-billed' as const,
  },
};
const cloudSandbox = {
  enrollmentRole: 'sandbox' as const,
  billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
};

describe('preset sections made for others', () => {
  it('leaves them out of a personal local sandbox preset and keeps them for cloud and Team presets', () => {
    expect(
      resolvePresetSharedSections({
        ownerKind: 'account',
        descriptor: localSandbox,
        kindLoading: false,
      }),
    ).toBe('hide');
    expect(
      resolvePresetSharedSections({
        ownerKind: 'account',
        descriptor: cloudSandbox,
        kindLoading: false,
      }),
    ).toBe('show');
    expect(
      resolvePresetSharedSections({
        ownerKind: 'team',
        descriptor: localSandbox,
        kindLoading: false,
      }),
    ).toBe('show');
  });

  it('says nothing while the kind is read, and shows them when it cannot be read', () => {
    expect(
      resolvePresetSharedSections({
        ownerKind: 'account',
        descriptor: undefined,
        kindLoading: true,
      }),
    ).toBe('unknown');
    expect(
      resolvePresetSharedSections({
        ownerKind: 'account',
        descriptor: undefined,
        kindLoading: false,
      }),
    ).toBe('show');
  });
});
