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
import { fireAndForget } from '@/utils/system/fireAndForget';

/** An import's result as a surface says it: the import owner's outcome, or `unreachable` when no outcome came back. */
export type PetImportResult =
  | PetImportOutcomeV1
  | Readonly<{ kind: 'unreachable' }>;

/** The import owner's Undo for a newly added pet (`pet.delete` of that pet); a reused pet has none. */
export type PetImportUndo = NonNullable<
  Extract<PetImportOutcomeV1, { kind: 'added' }>['undo']
>;

type PetImportOperation = Parameters<
  ReturnType<typeof useMountedActionExecution>['execute']
>[2];

/**
 * Adds a pet to the Account library through `pet.import` (the Store listing, a shared Bot's "Add <pet>", Settings ›
 * Pets' copy from a Machine): one Action, one reader, one set of outcomes, including a new pet's Undo. An added pet
 * joins the library at once, so every face that matches it by origin draws it. `home` names the Home the Action runs
 * on when it isn't the Account settings scope (Settings › Pets runs on its administration target).
 */
export function usePetImport(home?: string | null): (
  input: PetImportInputV1,
  operation?: PetImportOperation,
) => Promise<PetImportResult> {
  const accountScope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(home === undefined ? accountScope : home);
  return React.useCallback(
    async (input: PetImportInputV1, operation?: PetImportOperation) => {
      try {
        const result = await execute(PET_IMPORT_ACTION_ID_V1, input, operation);
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

/**
 * Runs an import's own Undo (`pet.delete` of the pet that Add created) on the Home the Add ran on, and drops that pet
 * from the library at once, as Add put it there. `progress` belongs to this Undo carrier: a new Add starts clean.
 * A refusal leaves the pet in the library and says so (`failed`).
 */
export function usePetAddUndo(
  undo: PetImportUndo | null,
  home?: string | null,
): Readonly<{ progress: 'running' | 'failed' | 'removed' | null; onUndo: (() => void) | undefined }> {
  const accountScope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(home === undefined ? accountScope : home);
  const petId = undo?.input.accountPetId ?? null;
  const [run, setRun] = React.useState<Readonly<{ petId: string; progress: 'running' | 'failed' | 'removed' }> | null>(null);
  const progress = run && run.petId === petId ? run.progress : null;
  const onUndo = React.useCallback(() => {
    if (!undo) return;
    const id = undo.input.accountPetId;
    setRun({ petId: id, progress: 'running' });
    fireAndForget(
      (async () => {
        let removed = false;
        try {
          removed = (await execute(undo.actionId, undo.input)).ok;
        } catch {
          removed = false;
        }
        if (removed) storage.getState().removeAccountPet(id);
        setRun({ petId: id, progress: removed ? 'removed' : 'failed' });
      })(),
      { tag: 'petImport.undo' },
    );
  }, [execute, undo]);
  return { progress, onUndo: undo && progress !== 'removed' ? onUndo : undefined };
}
