import { describe, expect, it } from 'vitest';

import { decrypt, encrypt } from '@/api/encryption';

describe('encryption BigInt handling', () => {
  it('round-trips BigInt values through both encryption variants', () => {
    const legacyKey = new Uint8Array(32).fill(1);
    const dataKey = new Uint8Array(32).fill(2);
    const input = { value: BigInt(1) };

    expect(decrypt(legacyKey, 'legacy', encrypt(legacyKey, 'legacy', input))).toEqual({ value: '1n' });

    expect(decrypt(dataKey, 'dataKey', encrypt(dataKey, 'dataKey', input))).toEqual({ value: '1n' });
  });
});

