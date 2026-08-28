/**
 * Provider row → plugin-local entry mapping.
 *
 * Merge requests and issues are two native verticals with separate counters,
 * separate routes and separate state vocabularies. They share this file, not a
 * mapper: a shared mapper is how an issue ends up carrying a draft flag or a
 * mergeability status it can never have.
 *
 * Decoding is tolerant one row at a time. A malformed row is skipped with its reason
 * and the surrounding valid rows survive; a valid row is never dropped for being
 * large.
 */

import { MAX_TRIAGE_ROW_FACTS_V1 } from '@happier-dev/triage-protocol/v1';

import { buildGitlabEntryIdentity } from '../identity.js';
import type { GitlabConfiguredOrigin } from '../origin.js';
import type {
  GitlabActor,
  GitlabInvolvementFact,
  GitlabKindId,
  GitlabRowDecodeResult,
  GitlabRowFact,
  GitlabStateProjection,
} from '../types.js';
import {
  boundGitlabRowFactText,
  boundGitlabText,
  summarizeGitlabLabels,
} from './bounded.js';
import { readGitlabSubscribedFact } from './gitlabInvolvement.js';
import {
  readGitlabMergeRequestHeadSha,
  readGitlabMergeRequestReviewRevision,
} from './mergeRequestHead.js';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readTimestampMs(value: unknown): number | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readActor(value: unknown): GitlabActor | null {
  const record = readRecord(value);
  const username = record ? readString(record.username) : null;
  if (!username) return null;
  return {
    username,
    displayName: readString(record?.name) ?? username,
    avatarUrl: readString(record?.avatar_url),
  };
}

function readActors(value: unknown): readonly GitlabActor[] {
  if (!Array.isArray(value)) return [];
  const actors: GitlabActor[] = [];
  for (const candidate of value) {
    const actor = readActor(candidate);
    if (actor) actors.push(actor);
  }
  return actors;
}

function readLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const candidate of value) {
    // GitLab returns plain names by default and label objects under
    // `with_labels_details=true`. Both are read; neither is required.
    const name = readString(candidate) ?? readString(readRecord(candidate)?.name);
    if (name) labels.push(name);
  }
  return labels;
}

/**
 * Draft is both a title prefix and a flag. The flag is authoritative: parsing the
 * title is a second owner of the same fact and misreads a title that legitimately
 * begins with the word.
 */
export function projectGitlabMergeRequestState(
  row: Readonly<Record<string, unknown>>,
): GitlabStateProjection {
  const state = readString(row.state);
  const draft = row.draft === true;
  if (state === 'opened') {
    return { presentation: 'active', nativeLabel: draft ? 'Draft' : 'Open' };
  }
  if (state === 'locked') return { presentation: 'active', nativeLabel: 'Locked' };
  if (state === 'merged') return { presentation: 'closed', nativeLabel: 'Merged' };
  if (state === 'closed') return { presentation: 'closed', nativeLabel: 'Closed' };
  return {
    presentation: 'unknown',
    nativeLabel: state
      ? boundGitlabText(state).text
      : 'Unknown',
  };
}

export function projectGitlabIssueState(
  row: Readonly<Record<string, unknown>>,
): GitlabStateProjection {
  const state = readString(row.state);
  if (state === 'opened') return { presentation: 'active', nativeLabel: 'Open' };
  if (state === 'closed') return { presentation: 'closed', nativeLabel: 'Closed' };
  return {
    presentation: 'unknown',
    nativeLabel: state
      ? boundGitlabText(state).text
      : 'Unknown',
  };
}

/**
 * `detailed_merge_status` carries more members than a boolean can hold. `checking`
 * and its siblings are *ask again shortly*, which is not *cannot merge*: rendering
 * them as a hard block gives a permanently disabled Merge button, and rendering them
 * as mergeable arms a button that answers `405`.
 */
export function projectGitlabMergeStatusFact(
  detailedMergeStatus: string | null,
): GitlabRowFact | null {
  switch (detailedMergeStatus) {
    case 'mergeable':
      return { id: 'gitlab/merge-status', importance: 'secondary', value: { kind: 'status', label: 'Mergeable', tone: 'success' } };
    case 'conflict':
    case 'broken_status':
      return { id: 'gitlab/merge-status', importance: 'secondary', value: { kind: 'status', label: 'Conflicts', tone: 'danger' } };
    case 'draft_status':
      return { id: 'gitlab/merge-status', importance: 'secondary', value: { kind: 'status', label: 'Draft', tone: 'warning' } };
    case 'checking':
    case 'unchecked':
    case 'preparing':
    case 'approvals_syncing':
    case 'ci_still_running':
      return { id: 'gitlab/merge-status', importance: 'secondary', value: { kind: 'status', label: 'Computing', tone: 'info' } };
    default:
      // An unrecognized value is omitted rather than guessed. Omitted means *this
      // provider did not report it here*, which is not the same as a blocked merge.
      return null;
  }
}

/**
 * The contract's own display weight decides which facts survive its count bound.
 *
 * A row carries at most `MAX_TRIAGE_ROW_FACTS_V1` projected facts, so the selection is
 * a real decision rather than an accident of push order: importance first, then the
 * order this mapper declared them. Slicing raw declaration order instead drops the
 * provider-native state a triage reader acts on — a merge request's conflict status —
 * in favour of whatever happened to be appended earlier.
 */
const ROW_FACT_IMPORTANCE_RANK: Readonly<Record<GitlabRowFact['importance'], number>> =
  Object.freeze({ primary: 0, secondary: 1, supplementary: 2 });

function selectBoundedRowFacts(facts: readonly GitlabRowFact[]): readonly GitlabRowFact[] {
  return facts
    .map((fact, index) => ({ fact, index }))
    .sort((left, right) =>
      ROW_FACT_IMPORTANCE_RANK[left.fact.importance] - ROW_FACT_IMPORTANCE_RANK[right.fact.importance]
      || left.index - right.index)
    .slice(0, MAX_TRIAGE_ROW_FACTS_V1)
    .map((entry) => entry.fact);
}

export type GitlabRowDecodeInput = Readonly<{
  kindId: GitlabKindId;
  origin: GitlabConfiguredOrigin;
  row: unknown;
  /**
   * The canonical fact the private lane that returned this row proves. An
   * authoritative single-item read has no lane and therefore omits it: the
   * involvement it can prove comes from the item itself, not from how it was
   * reached.
   */
  laneInvolvement?: GitlabInvolvementFact;
  /** A bounded native row fact the lane proves, beyond the involvement. */
  laneRowFact?: GitlabRowFact;
}>;

export function decodeGitlabRow(input: GitlabRowDecodeInput): GitlabRowDecodeResult {
  const row = readRecord(input.row);
  if (!row) return { kind: 'undecodable', reason: 'not-an-object' };

  const identityResult = buildGitlabEntryIdentity({
    kindId: input.kindId,
    origin: input.origin,
    row,
  });
  if (identityResult.kind !== 'built') {
    return { kind: 'undecodable', reason: identityResult.reason };
  }
  const { identity, locator } = identityResult;

  const isMergeRequest = input.kindId === 'merge-request';
  const rawTitle = readString(row.title) ?? '';
  const title = boundGitlabText(rawTitle);
  const labels = readLabels(row.labels);
  const author = readActor(row.author);
  const state = isMergeRequest
    ? projectGitlabMergeRequestState(row)
    : projectGitlabIssueState(row);
  const detailedMergeStatus = isMergeRequest ? readString(row.detailed_merge_status) : null;
  const sourceUpdatedAtMs = readTimestampMs(row.updated_at);
  // The revision the read observed, per kind. A merge request publishes its head
  // commit, because that is the value `sources/SCM.md` §2.6 requires a merge and
  // a mark-ready to carry and the one GitLab's merge endpoint consumes as its own
  // `sha` precondition. An issue has no head, so it publishes GitLab's
  // `updated_at` byte — unparsed, because the pin is compared for equality and a
  // parsed clock would make two spellings of one instant compare equal.
  const reviewRevision = isMergeRequest
    ? readGitlabMergeRequestReviewRevision(row)
    : null;
  const nativeRevision = isMergeRequest
    ? reviewRevision?.nativeRevision ?? readGitlabMergeRequestHeadSha(row)
    : readString(row.updated_at);
  const commentCount = typeof row.user_notes_count === 'number' ? row.user_notes_count : null;

  const involvement: GitlabInvolvementFact[] = input.laneInvolvement
    ? [input.laneInvolvement]
    : [];
  const subscribed = readGitlabSubscribedFact(row);
  if (subscribed && !involvement.includes(subscribed)) involvement.push(subscribed);

  const labelSummary = summarizeGitlabLabels(labels);
  // The projected fact list carries only what the observation's own dedicated fields
  // do NOT already carry. The project path is `snapshot.scopeLabel` and the update time
  // is `sourceUpdatedAtMs`; repeating either as a row fact is a second owner of one
  // displayed fact, and at four projected facts that duplicate costs a slot the
  // provider-native state needs.
  const facts: GitlabRowFact[] = [
    {
      id: 'gitlab/iid',
      importance: 'primary',
      value: { kind: 'text', text: `${isMergeRequest ? '!' : '#'}${identity.entryId}` },
    },
  ];
  if (isMergeRequest) {
    const mergeStatusFact = projectGitlabMergeStatusFact(detailedMergeStatus);
    if (mergeStatusFact) facts.push(mergeStatusFact);
  }
  if (input.laneRowFact) facts.push(input.laneRowFact);
  if (author) {
    facts.push({
      id: 'gitlab/author',
      importance: 'secondary',
      value: { kind: 'actor', actor: boundGitlabRowFactText(author.username).text },
    });
  }
  if (commentCount !== null) {
    facts.push({
      id: 'gitlab/comments',
      importance: 'supplementary',
      value: { kind: 'number', value: commentCount, display: 'compact' },
    });
  }
  if (labels.length > 0) {
    facts.push({ id: 'gitlab/labels', importance: 'supplementary', value: { kind: 'text', text: labelSummary.text } });
  }

  const boundedFacts = selectBoundedRowFacts(facts);

  return {
    kind: 'mapped',
    entry: {
      identity,
      locator,
      snapshot: {
        title: title.text,
        state,
        sourceUpdatedAtMs,
        nativeRevision,
        reviewRevision,
        sourceCreatedAtMs: readTimestampMs(row.created_at),
        author,
        assignees: readActors(row.assignees),
        reviewers: isMergeRequest ? readActors(row.reviewers) : [],
        // Every decoded label and reviewer survives here: they are identity-valid
        // provider data, and only presentation is summarized. The item-count
        // ceiling for these collections is a source-contract constant this mapper
        // adopts when that package publishes; nothing local invents one.
        labels,
        detailedMergeStatus,
        branches: isMergeRequest
          ? { source: readString(row.source_branch), target: readString(row.target_branch) }
          : null,
        draft: isMergeRequest ? row.draft === true : null,
        commentCount,
      },
      viewer: { involvement },
      rowFacts: boundedFacts,
      projectionTruncated:
        title.truncated || labelSummary.truncated || facts.length > boundedFacts.length,
    },
  };
}

export type GitlabPageDecodeResult = Readonly<{
  entries: readonly Extract<GitlabRowDecodeResult, { kind: 'mapped' }>['entry'][];
  /** Rows GitLab returned that could not be identified. */
  undecodableCount: number;
  /** Raw response cardinality, counted before decoding. */
  rawItemCount: number;
}>;

export function decodeGitlabPage(input: Readonly<{
  kindId: GitlabKindId;
  origin: GitlabConfiguredOrigin;
  body: unknown;
  laneInvolvement: GitlabInvolvementFact;
  laneRowFact?: GitlabRowFact;
}>): GitlabPageDecodeResult | null {
  if (!Array.isArray(input.body)) return null;
  const entries: Extract<GitlabRowDecodeResult, { kind: 'mapped' }>['entry'][] = [];
  let undecodableCount = 0;
  for (const row of input.body) {
    const decoded = decodeGitlabRow({
      kindId: input.kindId,
      origin: input.origin,
      row,
      laneInvolvement: input.laneInvolvement,
      ...(input.laneRowFact ? { laneRowFact: input.laneRowFact } : {}),
    });
    if (decoded.kind === 'mapped') entries.push(decoded.entry);
    else undecodableCount += 1;
  }
  return { entries, undecodableCount, rawItemCount: input.body.length };
}
