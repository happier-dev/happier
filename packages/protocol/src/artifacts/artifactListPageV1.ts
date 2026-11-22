/** Existing structural /v1/artifacts transport page bound, shared by dependent page reads. */
export const ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 = 500;

export const ARTIFACT_LIST_SORTS_V1 = ['updated_desc', 'created_desc', 'title_asc', 'size_desc'] as const;
export type ArtifactListSortV1 = typeof ARTIFACT_LIST_SORTS_V1[number];

/** Unknown retained sizes sort after known sizes, including zero. */
export function compareArtifactStoredSizeV1(
  leftBytes: number | undefined,
  rightBytes: number | undefined,
  leftTitle: string | null | undefined,
  rightTitle: string | null | undefined,
): number {
  return (rightBytes ?? -1) - (leftBytes ?? -1)
    || (leftTitle ?? '').localeCompare(rightTitle ?? '', undefined, { sensitivity: 'base' });
}
