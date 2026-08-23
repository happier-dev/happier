/**
 * One raw GitLab merge-request body → the re-observed row every mutation
 * answers with.
 *
 * This is the mutation vertical's only reader of a raw provider body, and it is
 * deliberately narrow: it does not build a Triage entry, does not decide an
 * outcome, and does not repair anything. It projects the facts a person needs to
 * see after a write — what state the item is in, whose commit it is at, whether
 * GitLab still calls it a draft, and whether GitLab intends to merge it later.
 *
 * The Action decides its arm from this row. Keeping the decision out of the
 * decoder is what lets `merged`, `scheduled` and `unconfirmed` be three answers
 * from one confirming read.
 */

import { boundGitlabText } from '../mapping/bounded.js';
import { readGitlabMergeRequestHeadSha } from '../mapping/mergeRequestHead.js';
import { GITLAB_DETAIL_BOUNDS_V1 } from '../detail/projection.js';
import type { GitlabMergeRequestStateRowV1 } from './contracts.js';
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
  return text === null ? null : boundGitlabText(text, GITLAB_DETAIL_BOUNDS_V1.labelUtf8Bytes).text;
}

function readTimestampMs(value: unknown): number | null {
  const text = readNonEmptyString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * GitLab has spelled scheduled auto-merge more than one way across its own
 * versions. Either flag being true means the same thing to a person — GitLab
 * merges this later, not now — and neither being present means it does not.
 */
function readAutoMergeScheduled(row: Readonly<Record<string, unknown>>): boolean {
  return row.auto_merge_enabled === true || row.merge_when_pipeline_succeeds === true;
}

export type GitlabMergeRequestRowDecoding =
  | Readonly<{ ok: true; row: GitlabMergeRequestStateRowV1 }>
  | Readonly<{ ok: false }>;

export function decodeGitlabMergeRequestStateRow(body: unknown): GitlabMergeRequestRowDecoding {
  const record = readRecord(body);
  if (record === null) return Object.freeze({ ok: false as const });

  const iid = record.iid;
  const state = readLabel(record.state);
  if (typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid < 1 || state === null) {
    return Object.freeze({ ok: false as const });
  }

  // The SAME reader the scan/get mapper publishes `nativeRevision` with. The two
  // values are compared against each other, so one rule owns both.
  const headSha = readGitlabMergeRequestHeadSha(record);
  const revision = readNonEmptyString(record.updated_at);
  const mergedAtMs = readTimestampMs(record.merged_at);
  const webUrl = readNonEmptyString(record.web_url);
  const detailedMergeStatus = readLabel(record.detailed_merge_status);

  return Object.freeze({
    ok: true as const,
    row: Object.freeze({
      iid: String(iid),
      state,
      draft: record.draft === true,
      ...(headSha === null ? {} : { headSha }),
      ...(revision === null ? {} : { revision }),
      ...(mergedAtMs === null ? {} : { mergedAtMs }),
      ...(webUrl === null ? {} : { webUrl }),
      ...(detailedMergeStatus === null ? {} : { detailedMergeStatus }),
      autoMergeScheduled: readAutoMergeScheduled(record),
    }),
  });
}

/**
 * The project path GitLab's GraphQL mutations address a merge request by.
 *
 * It is read from the item's own `references.full` (`group/project!7`) rather
 * than from a second request or from the web URL: the currentness read already
 * carries it, and a path guessed from a URL would send a mutation at whatever
 * that guess produced.
 */
export function readGitlabProjectPath(body: unknown): string | null {
  const reference = readNonEmptyString(readRecord(readRecord(body)?.references)?.full);
  if (reference === null) return null;
  const path = reference.split('!')[0] ?? '';
  return path === '' ? null : path;
}

/**
 * How a merge-request mutation is routed and made current.
 *
 * `observedPin` names `headSha` because §2.6 pins a merge request to a COMMIT
 * and only to a commit: a retitled or relabelled merge request moved its
 * `updated_at` and moved no code, and refusing there would deny a merge nothing
 * invalidated.
 */
export const GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1:
  GitlabMutationSubjectV1<GitlabMergeRequestStateRowV1> = Object.freeze({
    kindId: 'merge-request',
    decode: decodeGitlabMergeRequestStateRow,
    observedPin: (row) => row.headSha,
  });
