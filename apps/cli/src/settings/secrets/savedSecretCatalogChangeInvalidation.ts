import {
  isAccountCurrentnessChangeV1,
  readConnectedServicesAccountChangeV1,
  TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
} from '@happier-dev/protocol/changes';

type SavedSecretRelevantChange = Readonly<{
  kind: string;
  entityId: string;
  hint?: unknown;
}>;

/**
 * One daemon-side decision for changes that can retire Saved Secret material.
 * Team and Group lifecycle shares the existing stable Teams AccountChange.
 */
export function changesRequireSavedSecretCatalogRefresh(
  changes: readonly SavedSecretRelevantChange[],
): boolean {
  return changes.some((change) => {
    if (change.kind === 'savedSecretResource') return true;
    if (change.kind !== 'account') return false;
    if (readConnectedServicesAccountChangeV1(change)) return true;
    if (change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) return true;
    return isAccountCurrentnessChangeV1(change);
  });
}
