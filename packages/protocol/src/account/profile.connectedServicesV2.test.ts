import { describe, expect, it } from 'vitest';

import { AccountProfileSchema } from './profile';

describe('AccountProfileSchema connectedServicesV2', () => {
  it('defaults connectedServicesV2 to an empty array', () => {
    const parsed = AccountProfileSchema.parse({ id: 'acct' });
    expect(parsed.connectedServicesV2).toEqual([]);
  });

  it('accepts connectedServicesV2 service + profile projections', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [
            { profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'a@b.com', expiresAt: 1 },
          ],
        },
      ],
    });
    expect(parsed.connectedServicesV2[0]?.serviceId).toBe('openai-codex');
    expect(parsed.connectedServicesV2[0]?.profiles[0]?.profileId).toBe('work');
  });
});

