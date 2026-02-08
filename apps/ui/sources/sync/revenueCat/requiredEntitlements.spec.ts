import { describe, expect, it } from 'vitest';

import { hasRequiredEntitlement } from './requiredEntitlements';

describe('hasRequiredEntitlement', () => {
  const baseInfo: any = {
    activeSubscriptions: {},
    entitlements: { all: {} },
    originalAppUserId: 'u',
    requestDate: new Date(),
  };

  it('treats pro-only as entitled for voice', () => {
    const info = {
      ...baseInfo,
      entitlements: { all: { pro: { isActive: true, identifier: 'pro' } } },
    };
    expect(hasRequiredEntitlement(info, 'voice')).toBe(true);
  });

  it('treats voice-only as entitled for pro', () => {
    const info = {
      ...baseInfo,
      entitlements: { all: { voice: { isActive: true, identifier: 'voice' } } },
    };
    expect(hasRequiredEntitlement(info, 'pro')).toBe(true);
  });

  it('returns false when neither pro nor voice is active', () => {
    expect(hasRequiredEntitlement(baseInfo, 'voice')).toBe(false);
    expect(hasRequiredEntitlement(baseInfo, 'pro')).toBe(false);
  });
});

