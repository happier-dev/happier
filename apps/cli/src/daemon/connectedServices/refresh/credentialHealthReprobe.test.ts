import { describe, expect, it } from 'vitest';

import {
  canReprobeCredentialHealth,
  shouldReadCredentialHealthForRefresh,
} from './credentialHealthReprobe';

describe('credentialHealthReprobe', () => {
  it('routes provider-auth bridge failures through canonical health and bounded reprobe policy', () => {
    expect(shouldReadCredentialHealthForRefresh('provider_auth_bridge')).toBe(true);
    expect(canReprobeCredentialHealth('provider_auth_bridge', { force: true })).toBe(true);
    expect(canReprobeCredentialHealth('provider_auth_bridge', { force: false })).toBe(false);
  });
});
