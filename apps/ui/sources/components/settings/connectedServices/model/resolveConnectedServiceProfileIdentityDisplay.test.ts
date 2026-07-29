import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceProfileIdentityDisplay } from './resolveConnectedServiceProfileIdentityDisplay';

describe('resolveConnectedServiceProfileIdentityDisplay', () => {
  it('keeps the stable profile id visible when provider email is the primary identity', () => {
    const display = resolveConnectedServiceProfileIdentityDisplay({
      serviceId: 'claude-subscription',
      profileId: 'work',
      labelsByKey: {},
      profile: {
        profileId: 'work',
        providerEmail: 'work@example.com',
      },
    });

    expect(display.primaryLabel).toBe('work@example.com');
    expect(display.secondaryLabel).toBe('work');
    expect(display.diagnosticLabel).toContain('work@example.com');
    expect(display.diagnosticLabel).toContain('work');
  });

  it('keeps the stable profile id visible when a display label masks it', () => {
    const display = resolveConnectedServiceProfileIdentityDisplay({
      serviceId: 'claude-subscription',
      profileId: 'leeroy',
      labelsByKey: { 'claude-subscription/leeroy': 'batiplus' },
      profile: {
        profileId: 'leeroy',
        providerEmail: 'leeroy.brun@gmail.com',
      },
    });

    expect(display.primaryLabel).toBe('batiplus');
    expect(display.secondaryLabel).toContain('leeroy.brun@gmail.com');
    expect(display.secondaryLabel).toContain('leeroy');
    expect(display.diagnosticLabel).toContain('batiplus');
    expect(display.diagnosticLabel).toContain('leeroy');
    expect(display.warning).toBe('label_masks_stable_identity');
  });
});
