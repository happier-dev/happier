import { describe, expect, it } from 'vitest';

import { ServerRetentionPolicyV2Schema } from './serverRetentionPolicyV2';

describe('ServerRetentionPolicyV2Schema', () => {
  it('keeps newly introduced domain ids forward-extensible', () => {
    const policy = ServerRetentionPolicyV2Schema.parse({
      version: 2,
      enabled: true,
      complete: true,
      domains: [{
        id: 'futureDomain',
        policy: { mode: 'delete_older_than', days: 9 },
      }],
    });

    expect(policy.domains[0]?.id).toBe('futureDomain');
  });
});
