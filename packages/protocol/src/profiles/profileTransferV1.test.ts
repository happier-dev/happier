import { describe, expect, it } from 'vitest';
import {
  ProfileTransferControlV1Schema, ProfileTransferMutationV1Schema,
  StoredProfileTransferControlV1Schema, openProfileTransferContentV1, sealProfileTransferContentV1,
} from './profileTransferV1.js';

const control = { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 7, migratedLogicalRevision: 0,
  inventory: [{ kind: 'account_row' as const, id: 'profile-a', revision: 2 },
    { kind: 'artifact' as const, id: 'artifact-a', revision: { headerVersion: 3, bodyVersion: 5 } }] };

describe('Profile transfer control', () => {
  it('authenticates the complete authority proof with the Account domain and fails closed on wrong mode or unavailable keys', () => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) };
    const sealed = sealProfileTransferContentV1({ mode: 'e2ee', material, record: control, randomBytes: length => new Uint8Array(length).fill(1) });
    expect(Object.keys(sealed)).toEqual(['t', 'c']);
    expect(openProfileTransferContentV1({ mode: 'e2ee', material, content: sealed })).toEqual({ status: 'opened', record: control });
    expect(openProfileTransferContentV1({ mode: 'e2ee', material: null, content: sealed })).toEqual({ status: 'unavailable', reason: 'encryption-material-unavailable' });
    expect(openProfileTransferContentV1({ mode: 'plain', material: null, content: sealed })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
    expect(openProfileTransferContentV1({ mode: 'e2ee', material: { ...material, secret: new Uint8Array(32).fill(9) }, content: sealed })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    const plain = sealProfileTransferContentV1({ mode: 'plain', material: null, record: control });
    expect(openProfileTransferContentV1({ mode: 'plain', material: null, content: plain })).toEqual({ status: 'opened', record: control });
  });

  it('preserves composite revisions and rejects duplicate inventory identities and mismatched Plain mutation proofs', () => {
    expect(ProfileTransferControlV1Schema.safeParse({ ...control, inventory: [...control.inventory, control.inventory[0]] }).success).toBe(false);
    expect(StoredProfileTransferControlV1Schema.parse({ ...control, future: true, inventory: control.inventory.map(entry => ({ ...entry, future: true })) })).toEqual(control);
    expect(ProfileTransferControlV1Schema.safeParse({ ...control, future: true }).success).toBe(false);
    expect(ProfileTransferMutationV1Schema.safeParse({ operation: 'activate', sourceSettingsVersion: 7,
      expectedRevision: 1, inventory: [], content: { t: 'plain', v: control } }).success).toBe(false);
    expect(ProfileTransferMutationV1Schema.safeParse({ operation: 'activate', sourceSettingsVersion: 7,
      expectedRevision: 1, inventory: control.inventory, content: { t: 'plain', v: control } }).success).toBe(true);
  });

  it('rejects SavedSecret inventory identities that the canonical shared-reference codec cannot address', () => {
    for (const id of [' secret', 'secret\n', 'a'.repeat(256)]) {
      expect(ProfileTransferControlV1Schema.safeParse({ ...control,
        inventory: [{ kind: 'saved_secret', id, revision: 1 }] }).success).toBe(false);
    }
  });
});
