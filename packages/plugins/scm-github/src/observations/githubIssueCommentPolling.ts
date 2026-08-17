import {
  createGithubIssueCommentSince,
  type GithubIssueCommentCursorV1,
} from './githubIssueCommentCursor.js';

function encodeRepositorySegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError(`GitHub ${label} is required`);
  return encodeURIComponent(trimmed);
}

/**
 * Repository comments deliberately use GitHub's documented updated ascending
 * order. This remains separate from the bounded Repository Events timeline
 * because their cursor algebra and transport guarantees differ.
 */
export function createGithubRepositoryIssueCommentsUrl(input: Readonly<{
  apiBaseUrl: string;
  owner: string;
  repository: string;
  cursor: GithubIssueCommentCursorV1;
}>): string {
  const url = new URL(
    `/repos/${encodeRepositorySegment(input.owner, 'repository owner')}/${encodeRepositorySegment(input.repository, 'repository name')}/issues/comments`,
    input.apiBaseUrl,
  );
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('since', createGithubIssueCommentSince(input.cursor));
  url.searchParams.set('per_page', '100');
  return url.toString();
}
