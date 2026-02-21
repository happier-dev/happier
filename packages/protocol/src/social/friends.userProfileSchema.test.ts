import { describe, expect, it } from 'vitest';

import { UserProfileSchema } from './friends.js';

describe('UserProfileSchema', () => {
  it('accepts keyless accounts (publicKey=null)', () => {
    const parsed = UserProfileSchema.parse({
      id: 'u_1',
      firstName: 'A',
      lastName: null,
      avatar: null,
      username: 'alice',
      bio: null,
      badges: [],
      status: 'none',
      publicKey: null,
      contentPublicKey: null,
      contentPublicKeySig: null,
    });

    expect(parsed.publicKey).toBeNull();
  });
});

