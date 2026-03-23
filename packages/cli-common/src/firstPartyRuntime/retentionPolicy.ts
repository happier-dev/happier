export interface FirstPartyRetentionResolution {
  keep: string[];
  prune: string[];
}

function appendUnique(target: string[], value: string | null | undefined): void {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return;
  if (target.includes(normalized)) return;
  target.push(normalized);
}

export function resolveRetainedVersionIds(params: Readonly<{
  orderedVersionIdsNewestFirst: readonly string[];
  currentVersionId: string | null;
  previousVersionId?: string | null;
  retainCount?: number;
}>): FirstPartyRetentionResolution {
  const retainCount = Math.max(1, params.retainCount ?? 2);
  const keep: string[] = [];

  appendUnique(keep, params.currentVersionId);
  appendUnique(keep, params.previousVersionId);

  for (const versionId of params.orderedVersionIdsNewestFirst) {
    appendUnique(keep, versionId);
    if (keep.length >= retainCount) {
      break;
    }
  }

  const prune = params.orderedVersionIdsNewestFirst.filter((versionId) => !keep.includes(versionId));
  return { keep, prune };
}
