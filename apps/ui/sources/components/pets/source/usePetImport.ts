import * as React from 'react';
import { PET_IMPORT_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsPetsV1';
import {
  readPetImportOutcomeV1,
  type PetImportInputV1,
  type PetImportOutcomeV1,
} from '@happier-dev/protocol/pets/importActionV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { storage } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

/** An import's result as a surface says it: the import owner's outcome, or `unreachable` when no outcome came back. */
export type PetImportResult =
  | PetImportOutcomeV1
  | Readonly<{ kind: 'unreachable' }>;

/**
 * Adds a pet to the Account library through `pet.import` (the Store listing, a shared Bot's "Add <pet>"): one Action,
 * one set of outcomes. An added pet joins the library at once, so every face that matches it by origin draws it.
 */
export function usePetImport(): (
  input: PetImportInputV1,
) => Promise<PetImportResult> {
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope);
  return React.useCallback(
    async (input: PetImportInputV1) => {
      try {
        const result = await execute(PET_IMPORT_ACTION_ID_V1, input);
        const outcome = readPetImportOutcomeV1(
          result.ok
            ? { ok: true, result: result.result }
            : {
                ok: false,
                errorCode: result.errorCode,
                ...(result.details === undefined
                  ? {}
                  : { details: result.details }),
              },
        );
        if (outcome?.kind === 'added')
          storage.getState().upsertAccountPet(outcome.pet);
        return outcome ?? { kind: 'unreachable' };
      } catch {
        return { kind: 'unreachable' };
      }
    },
    [execute],
  );
}
