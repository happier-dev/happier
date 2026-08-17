import { describe, expect, it } from 'vitest';

import { OH_MY_PI_UI_DESCRIPTOR } from './descriptor.js';

describe('OH_MY_PI_UI_DESCRIPTOR', () => {
  it('does not advertise background follow for reconciliation-only observation', () => {
    expect(OH_MY_PI_UI_DESCRIPTOR.behavior.externalSessions.supportsBackgroundFollow).toBe(false);
  });
});
