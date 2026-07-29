import { getJson } from './http.js';
import { normalizeBugReportProviderUrl } from './sanitize.js';
import { normalizeBugReportIssueTarget } from './issueTarget.js';

export type BugReportSimilarIssue = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed';
  updatedAt: string;
};

export async function searchBugReportSimilarIssues(input: {
  providerUrl: string;
  owner: string;
  repo: string;
  query: string;
  limit?: number;
  state?: 'open' | 'closed' | 'all';
  timeoutMs?: number;
}): Promise<{ issues: BugReportSimilarIssue[] }> {
  const baseUrl = normalizeBugReportProviderUrl(input.providerUrl);
  if (!baseUrl) {
    throw new Error('Invalid bug report provider URL');
  }
  const issueTarget = normalizeBugReportIssueTarget({
    owner: input.owner,
    repo: input.repo,
  });
  if (!issueTarget) {
    throw new Error('Invalid bug report issue target');
  }

  const query = String(input.query ?? '').trim().slice(0, 1200);
  if (query.length < 3) return { issues: [] };

  const limitRaw = Number(input.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 25)) : 10;
  const state = input.state === 'open' || input.state === 'closed' || input.state === 'all' ? input.state : 'all';
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1_000, Math.floor(input.timeoutMs!)) : 20_000;

  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    state,
  });

  return await getJson<{ issues: BugReportSimilarIssue[] }>({
    url: `${baseUrl}/v1/issues/similar?${params.toString()}`,
    timeoutMs,
  });
}
