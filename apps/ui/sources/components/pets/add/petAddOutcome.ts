import { PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol/pets/constants';

import type { PetImportResult, PetImportUndo } from '@/components/pets/source/usePetImport';

/** Undo's own progress after a new pet was added. */
export type PetAddUndoStatus = 'ready' | 'running' | 'failed';

/**
 * Where an Add stands once the import owner answered, said the same way in the Store and in a Session (R12 §16): one
 * Action, one set of outcomes. `added` is a pet already in your pets (or reused on Add), so it has no Undo.
 */
export type PetAddOutcomeState =
  | Readonly<{ kind: 'added' }>
  | Readonly<{ kind: 'addedNow'; undo: PetAddUndoStatus }>
  | Readonly<{ kind: 'removed' }>
  /** `sheetCheck` only when the outcome names a failed sheet check; a locked library or a Home refusal is `other`. */
  | Readonly<{ kind: 'couldntAdd'; reason: 'sheetCheck' | 'other' }>
  | Readonly<{ kind: 'libraryFull'; limit: number }>
  | Readonly<{ kind: 'syncOff' }>
  | Readonly<{ kind: 'unreachable' }>;

/** Only the daemon's strict validation names a failed sheet check; every other refusal is said generically. */
const SHEET_CHECK_ERROR_CODE = 'validation_failed';

/**
 * An import's outcome as a surface says it. A new pet keeps the import owner's Undo; a reused one has none, so Undo can
 * never remove a pet the person already had.
 */
export function petAddOutcomeOfImport(outcome: PetImportResult): Readonly<{
  state: PetAddOutcomeState;
  undo: PetImportUndo | null;
}> {
  switch (outcome.kind) {
    case 'added':
      return outcome.undo
        ? { state: { kind: 'addedNow', undo: 'ready' }, undo: outcome.undo }
        : { state: { kind: 'added' }, undo: null };
    case 'library_full':
      return { state: { kind: 'libraryFull', limit: PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount }, undo: null };
    case 'pet_sync_off':
      return { state: { kind: 'syncOff' }, undo: null };
    case 'could_not_add':
      return { state: { kind: 'couldntAdd', reason: outcome.errorCode === SHEET_CHECK_ERROR_CODE ? 'sheetCheck' : 'other' }, undo: null };
    case 'unreachable':
      return { state: { kind: 'unreachable' }, undo: null };
  }
}

/** The outcome with Undo's progress laid over it: Undone once it ran, or the running or failed Undo. */
export function petAddOutcomeWithUndo(
  state: PetAddOutcomeState,
  progress: 'running' | 'failed' | 'removed' | null,
): PetAddOutcomeState {
  if (progress === 'removed') return REMOVED;
  if (progress && state.kind === 'addedNow') return { kind: 'addedNow', undo: progress };
  return state;
}

const REMOVED: PetAddOutcomeState = { kind: 'removed' };
