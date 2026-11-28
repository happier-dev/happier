/**
 * The commit a GitLab merge request is currently at, read from one raw row.
 *
 * One reader, because there are two callers who must agree byte for byte or the
 * gate they share stops working: the scan/get mapper publishes this value as the
 * observation's `nativeRevision`, and the mutation preflight reads it back off
 * its own fresh read to compare. A second, similar-but-different rule — one
 * preferring `diff_refs`, one trimming differently — would let a merge request
 * refuse every write while looking correct in both files.
 *
 * `sha` is the merge request's own diff head, and it is what GitLab's merge
 * endpoint compares its `sha` precondition against. `diff_refs.head_sha` is read
 * only as a fallback, and only in that order, because GitLab documents
 * `diff_refs` as *initially empty* on a freshly created merge request
 * (`sources/SCM.md` §4.7.2): treating an unpopulated field as authoritative would
 * publish "no head" for a merge request that has one.
 *
 * `null` means GitLab reported no head *yet*. It never means the merge request
 * has no commits, and it is never repaired from a branch name, a pipeline's sha,
 * or a per-file diff — none of which is the source-branch head.
 */

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function readGitlabMergeRequestHeadSha(row: unknown): string | null {
  const record = readRecord(row);
  if (record === null) return null;
  const direct = readNonEmptyString(record.sha);
  if (direct !== null) return direct;
  return readNonEmptyString(readRecord(record.diff_refs)?.head_sha);
}

/**
 * The complete provider revision tuple a selected-review workspace must pin.
 *
 * GitLab's `sha` remains the native write precondition and `diff_refs.head_sha`
 * is the source branch tip the local materializer must fetch. They often match,
 * but are separate provider facts and may not be collapsed by a caller. A fresh
 * merge request can omit `diff_refs.head_sha`, in which case its direct `sha` is
 * the only available source-head fact; an omitted base has no safe substitute.
 */
export type GitlabMergeRequestReviewRevision = Readonly<{
  baseSha: string;
  headSha: string;
  nativeRevision: string;
}>;

export function readGitlabMergeRequestReviewRevision(
  row: unknown,
): GitlabMergeRequestReviewRevision | null {
  const record = readRecord(row);
  if (record === null) return null;

  const nativeRevision = readGitlabMergeRequestHeadSha(record);
  const diffRefs = readRecord(record.diff_refs);
  const baseSha = readNonEmptyString(diffRefs?.base_sha);
  const headSha = readNonEmptyString(diffRefs?.head_sha) ?? nativeRevision;
  if (baseSha === null || headSha === null || nativeRevision === null) return null;

  return Object.freeze({ baseSha, headSha, nativeRevision });
}

export type GitlabComparisonEndpoints = Readonly<{
  url?: string;
  title?: string;
  beforeOid: string;
  baseOid: string;
  headOid: string;
  totalFileCount: number | null;
}>;

/** Latest provider diff version: merge base, target witness and source head. */
export function readGitlabComparisonEndpoints(row: unknown): GitlabComparisonEndpoints | null {
  const record = readRecord(row);
  const revision = readGitlabMergeRequestReviewRevision(row);
  const baseOid = readNonEmptyString(readRecord(record?.diff_refs)?.start_sha);
  if (!record || !revision || !baseOid || revision.nativeRevision !== revision.headSha
    || ![revision.baseSha, baseOid, revision.headSha].every(oid => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid))) return null;
  // GitLab reports capped counts with a '+' and populates new MRs
  // asynchronously. Neither shape is an exact total, including on an empty page.
  const count = typeof record.changes_count === 'string' && /^(0|[1-9][0-9]*)$/.test(record.changes_count)
    ? Number(record.changes_count) : null;
  const title = readNonEmptyString(record.title);
  return { beforeOid: revision.baseSha, baseOid, headOid: revision.headSha,
    ...(title ? { title } : {}),
    ...(typeof record.web_url === 'string' && /^https?:\/\//i.test(record.web_url) ? { url: record.web_url } : {}),
    totalFileCount: count !== null && Number.isSafeInteger(count) ? count : null };
}
