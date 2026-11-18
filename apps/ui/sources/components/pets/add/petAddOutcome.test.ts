import { describe, expect, it } from 'vitest';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';

import { petAddOutcomeOfImport, petAddOutcomeWithUndo } from './petAddOutcome';

const pet = {
  accountPetId: 'pet-1',
  packageFormat: 'codex-compatible-atlas-v1',
  origin: { kind: 'registry', sourceId: 'builtin:petdex', itemId: 'boba' },
  digest: 'sha256:x',
  sizeBytes: 1,
  createdAt: 0,
  updatedAt: 0,
  manifest: { id: 'boba', displayName: 'Boba', description: 'Boba', spritesheetPath: 'spritesheet.webp' },
  spritesheetAssetRef: { assetId: 'a', mediaType: 'image/webp', digest: 'sha256:x', sizeBytes: 1 },
} as AccountPetLibraryEntryV1;
const undo = { actionId: 'pet.delete' as const, input: { accountPetId: 'pet-1' } };

describe('an Add\'s outcome, as the Store and a Session say it', () => {
  it('keeps the import owner\'s Undo for a new pet, and none for a reused one, so an existing pet survives', () => {
    expect(petAddOutcomeOfImport({ kind: 'added', pet, undo })).toEqual({ state: { kind: 'addedNow', undo: 'ready' }, undo });
    expect(petAddOutcomeOfImport({ kind: 'added', pet, reused: true })).toEqual({ state: { kind: 'added' }, undo: null });
    expect(petAddOutcomeOfImport({ kind: 'library_full', errorCode: 'quota_exceeded' }).undo).toBeNull();
  });

  it('blames the sheet only when the outcome names a failed sheet check', () => {
    expect(petAddOutcomeOfImport({ kind: 'could_not_add', errorCode: 'validation_failed' }).state)
      .toEqual({ kind: 'couldntAdd', reason: 'sheetCheck' });
    for (const errorCode of ['account_encryption_mode_mismatch', 'custom_pet_sync_requires_plaintext', 'internal_error']) {
      expect(petAddOutcomeOfImport({ kind: 'could_not_add', errorCode }).state).toEqual({ kind: 'couldntAdd', reason: 'other' });
    }
  });

  it('lays Undo\'s progress over a new pet only, and says Undone once it ran', () => {
    const fresh = { kind: 'addedNow', undo: 'ready' } as const;
    expect(petAddOutcomeWithUndo(fresh, 'running')).toEqual({ kind: 'addedNow', undo: 'running' });
    expect(petAddOutcomeWithUndo(fresh, 'failed')).toEqual({ kind: 'addedNow', undo: 'failed' });
    expect(petAddOutcomeWithUndo(fresh, 'removed')).toEqual({ kind: 'removed' });
    expect(petAddOutcomeWithUndo({ kind: 'added' }, 'running')).toEqual({ kind: 'added' });
  });
});
