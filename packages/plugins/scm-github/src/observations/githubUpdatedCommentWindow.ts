import { compareGithubIssueCommentCursorPositions, type GithubIssueCommentCursorPositionV1 } from './githubIssueCommentCursor.js';

/** Shared mutable `sort=updated` window for GitHub conversation and inline comments. */
export async function readGithubUpdatedCommentWindow<T>(input: Readonly<{
  startPosition: GithubIssueCommentCursorPositionV1;
  etag: string | null;
  position(row: T): GithubIssueCommentCursorPositionV1;
  readPage(position: GithubIssueCommentCursorPositionV1, etag: string | null, nextPageUrl: string | null): Promise<Readonly<{
    kind: 'notModified' | 'page'; comments: readonly T[]; etag: string | null; morePages: boolean; nextPageUrl: string | null; headers: Readonly<Record<string, string>>;
  }>>;
}>): Promise<Readonly<{ kind: 'notModified' | 'window'; comments: readonly T[]; etag: string | null;
  morePages: boolean; requestCount: number }>> {
  let position = input.startPosition;
  let etag: string | null = null;
  let morePages = false;
  let requestCount = 0;
  let nextPageUrl: string | null = null;
  const byId = new Map<string, T>();
  // Finish an equal-time group before advancing the checkpoint: a
  // timestamp/ID checkpoint cannot represent an unseen part of that group.
  for (;;) {
    const page = await input.readPage(position, requestCount === 0 ? input.etag : null, nextPageUrl);
    requestCount += 1;
    if (page.kind === 'notModified') return { kind: 'notModified', comments: [], etag: page.etag, morePages: false, requestCount };
    if (requestCount === 1) etag = page.etag;
    const ordered = [...page.comments].sort((a, b) => compareGithubIssueCommentCursorPositions(input.position(a), input.position(b)));
    for (const row of ordered) {
      const at = input.position(row);
      const prior = byId.get(at.commentIdAtUpdatedAt);
      if (prior === undefined) byId.set(at.commentIdAtUpdatedAt, row);
      else {
        const priorAt = input.position(prior);
        // Provider timestamps have second precision: two authenticated edits
        // or enrichment changes can share it. Keep the latest snapshot; the
        // core's native occurrence owner decides replay/conflict scope.
        if (at.updatedAtIso >= priorAt.updatedAtIso) byId.set(at.commentIdAtUpdatedAt, row);
      }
    }
    morePages = page.morePages;
    if (!morePages) break;
    const trailing = ordered.at(-1);
    let completed: T | undefined;
    for (let index = ordered.length - 1; index >= 0 && trailing !== undefined; index -= 1) {
      const row = ordered[index]!;
      if (input.position(row).updatedAtIso !== input.position(trailing).updatedAtIso) { completed = row; break; }
    }
    if (completed === undefined || compareGithubIssueCommentCursorPositions(input.position(completed), position) <= 0) {
      nextPageUrl = page.nextPageUrl;
      continue;
    }
    // Offset pages move when an earlier comment is edited/deleted. Requery
    // using the last complete provider-time group so unread rows cannot shift
    // behind the next request. Only a tied group needs native offset paging.
    position = input.position(completed);
    nextPageUrl = null;
  }
  return { kind: 'window', comments: [...byId.values()].sort((a, b) => compareGithubIssueCommentCursorPositions(input.position(a), input.position(b))), etag,
    morePages, requestCount };
}
