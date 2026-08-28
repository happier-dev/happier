/**
 * One raw GitLab issue body → the re-observed row every issue mutation answers
 * with, plus the subject descriptor that routes an issue mutation.
 *
 * It is deliberately narrow, exactly like its merge-request sibling: it does not
 * build a Triage entry, does not decide an outcome, and does not repair
 * anything. It projects what a person needs to see after a write — what state
 * GitLab now reports, and when GitLab last saw the issue change.
 *
 * `revision` is the load-bearing one. An issue has no head commit, so
 * `sources/SCM.md` §4.7 makes GitLab's `updated_at` the currentness gate, and
 * this reader is the one that produces the value the caller's pin is compared
 * against. It is read as the RAW string the scan/get mapper publishes as
 * `nativeRevision`, never as a parsed instant: the comparison is an equality,
 * and two spellings of one timestamp must not compare equal.
 */

import { normalizeTriageSingleLineV1 } from '@happier-dev/triage-protocol/v1';
import type { GitlabIssueStateRowV1 } from './contracts.js';
import type { GitlabMutationSubjectV1 } from './preflight.js';

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

function readLabel(value: unknown): string | null {
  const text = readNonEmptyString(value);
  if (text === null) return null;
  const normalized = normalizeTriageSingleLineV1(text);
  return normalized === '' ? null : normalized;
}

function readTimestampMs(value: unknown): number | null {
  const text = readNonEmptyString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function readStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const member of value) {
    const item = readLabel(member);
    if (item === null) return undefined;
    if (!values.includes(item)) values.push(item);
  }
  return Object.freeze(values);
}

function readUsernameList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const member of value) {
    const item = readLabel(readRecord(member)?.username);
    if (item === null) return undefined;
    if (!values.includes(item)) values.push(item);
  }
  return Object.freeze(values);
}

export type GitlabIssueRowDecoding =
  | Readonly<{ ok: true; row: GitlabIssueStateRowV1 }>
  | Readonly<{ ok: false }>;

export function decodeGitlabIssueStateRow(body: unknown): GitlabIssueRowDecoding {
  const record = readRecord(body);
  if (record === null) return Object.freeze({ ok: false as const });

  const iid = record.iid;
  const projectId = record.project_id;
  const state = readLabel(record.state);
  if (typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid < 1
    || typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId < 1
    || state === null) {
    return Object.freeze({ ok: false as const });
  }

  // The SAME byte the scan/get mapper publishes as an issue's `nativeRevision`,
  // unparsed. One rule owns both sides of the comparison.
  const revision = readNonEmptyString(record.updated_at);
  const closedAtMs = readTimestampMs(record.closed_at);
  const webUrl = readNonEmptyString(record.web_url);
  const assigneeUsernames = readUsernameList(record.assignees);
  const labelNames = readStringList(record.labels);

  return Object.freeze({
    ok: true as const,
    row: Object.freeze({
      projectId,
      iid: String(iid),
      state,
      ...(revision === null ? {} : { revision }),
      ...(closedAtMs === null ? {} : { closedAtMs }),
      ...(webUrl === null ? {} : { webUrl }),
      ...(assigneeUsernames === undefined ? {} : { assigneeUsernames }),
      ...(labelNames === undefined ? {} : { labelNames }),
    }),
  });
}

/**
 * How an issue mutation is routed and made current.
 *
 * `observedPin` names `revision` because an issue has no head: this is the exact
 * §4.7 gate, and naming it here rather than inside the preflight is what lets one
 * preflight serve both kinds without a kind branch.
 */
export const GITLAB_ISSUE_MUTATION_SUBJECT_V1: GitlabMutationSubjectV1<GitlabIssueStateRowV1> =
  Object.freeze({
    kindId: 'issue',
    decode: decodeGitlabIssueStateRow,
    observedPin: (row) => row.revision,
  });

/** The project path (`group/project`) carried by GitLab's own issue reference. */
export function readGitlabIssueProjectPath(body: unknown): string | null {
  const reference = readNonEmptyString(readRecord(readRecord(body)?.references)?.full);
  if (reference === null) return null;
  const path = reference.split('#')[0] ?? '';
  return path === '' ? null : path;
}
