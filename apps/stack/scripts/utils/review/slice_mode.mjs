const UNCOMMITTED_PATH_SLICE_REVIEWERS = new Set(['coderabbit', 'codex', 'claude']);

export function reviewerSupportsUncommittedPathSlices(reviewer) {
  return UNCOMMITTED_PATH_SLICE_REVIEWERS.has(String(reviewer ?? '').trim().toLowerCase());
}

export function shouldUseUncommittedPathSlices({
  reviewer,
  changeType,
  fileCount,
  maxFiles,
  chunksPreference = null,
} = {}) {
  if (String(changeType ?? '').trim().toLowerCase() !== 'uncommitted') return false;
  if (!reviewerSupportsUncommittedPathSlices(reviewer)) return false;
  if (chunksPreference !== null && chunksPreference !== undefined) return Boolean(chunksPreference);
  const parsedMaxFiles = Number(maxFiles);
  if (!Number.isFinite(parsedMaxFiles) || parsedMaxFiles <= 0) return false;
  return Number(fileCount ?? 0) > parsedMaxFiles;
}
