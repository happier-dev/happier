import { BUG_REPORT_DEFAULT_ISSUE_OWNER, BUG_REPORT_DEFAULT_ISSUE_REPO } from './types.js';

const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;

export function normalizeBugReportIssueSlug(input: string | null | undefined): string | null {
  const value = String(input ?? '').trim();
  if (!value) return null;
  if (!GITHUB_SLUG_PATTERN.test(value)) return null;
  return value;
}

export function normalizeBugReportIssueTarget(input: {
  owner: string | null | undefined;
  repo: string | null | undefined;
}): { owner: string; repo: string } | null {
  const owner = normalizeBugReportIssueSlug(input.owner);
  const repo = normalizeBugReportIssueSlug(input.repo);
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function resolveBugReportIssueTargetWithDefaults(input: {
  owner: string | null | undefined;
  repo: string | null | undefined;
  defaultOwner?: string;
  defaultRepo?: string;
}): { owner: string; repo: string } {
  const fallbackOwner = normalizeBugReportIssueSlug(input.defaultOwner ?? BUG_REPORT_DEFAULT_ISSUE_OWNER) ?? BUG_REPORT_DEFAULT_ISSUE_OWNER;
  const fallbackRepo = normalizeBugReportIssueSlug(input.defaultRepo ?? BUG_REPORT_DEFAULT_ISSUE_REPO) ?? BUG_REPORT_DEFAULT_ISSUE_REPO;
  const owner = normalizeBugReportIssueSlug(input.owner) ?? fallbackOwner;
  const repo = normalizeBugReportIssueSlug(input.repo) ?? fallbackRepo;
  return { owner, repo };
}

