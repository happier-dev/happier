import { describe, expect, it } from 'vitest';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import { buildAccountEncryptionAuthoringMemoryDirective } from './buildAccountEncryptionAuthoringMemoryDirective';

const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey: new Uint8Array(32).fill(42) };
const randomBytes = (length: number) => new Uint8Array(length);

describe('buildAccountEncryptionAuthoringMemoryDirective', () => {
  it.each(['plain', 'e2ee'] as const)('preserves opened authoring memory and its revision through a mode switch (%s)', (mode) => {
    const candidates = [{ key: 'lastUsedProfile' as const, revision: 7, value: 'profile-a' }];
    const directive = buildAccountEncryptionAuthoringMemoryDirective({
      candidates, target: mode === 'plain' ? { mode } : { mode, material, randomBytes },
    });
    expect(directive).toMatchObject({ items: [{ key: 'lastUsedProfile', expectedRevision: 7 }] });
    const cipher = createAuthoringMemoryCipher({ mode, material: mode === 'plain' ? null : material, randomBytes });
    expect(cipher.open('lastUsedProfile', directive!.items[0]!.content)).toBe('profile-a');
  });

  it('does not create a directive for an empty inventory', () => {
    expect(buildAccountEncryptionAuthoringMemoryDirective({ candidates: [], target: { mode: 'plain' } })).toBeUndefined();
  });
});
