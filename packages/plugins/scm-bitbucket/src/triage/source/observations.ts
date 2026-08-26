import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  type TriageEntryLocatorV1,
  type TriageRowFactV1,
  type TriageSourceEntryLocalRefV1,
  type TriageSourceEntrySnapshotV1,
  type TriageSourceScanObservationV1,
  type TriageSourceViewerFactsV1,
} from '@happier-dev/triage-protocol/v1';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';

import type {
  BitbucketAccountRef,
  BitbucketParticipantFact,
  BitbucketPullRequestEntry,
  BitbucketPullRequestState,
} from '../entries.js';
import {
  BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1,
} from '../identity.js';
import type { BitbucketInvolvement } from '../pullRequests.js';
import { toBoundedDisplayLine } from '../text.js';

import { BITBUCKET_PULL_REQUEST_KIND_ID } from './descriptor.js';

/**
 * @internal One projected display value, plus whether producing it cost content.
 *
 * Every published string is single-line and byte-bounded, so a projection either fits or reports
 * that it did not. Threading the flag rather than mutating a shared counter keeps `projectionTruncated`
 * a derived fact of what was actually published.
 */
type ProjectedText = Readonly<{ value: string; truncated: boolean }>;

function projectLine(value: string | null, maxBytes: number): ProjectedText | null {
  return value === null ? null : toBoundedDisplayLine(value, maxBytes);
}

/**
 * The lossy projection of Bitbucket's four-member pull-request state enum.
 *
 * `MERGED`, `DECLINED` and `SUPERSEDED` are all terminal on this forge and all project to `closed`;
 * the provider's own word survives in `nativeLabel` so the three stay distinguishable in
 * presentation. Bitbucket has no `resolved` or `suppressed` analogue for a pull request, and an
 * unrecognised native state stays `unknown` — present, nonterminal, and never a closed substitute.
 */
function toPresentationState(
  state: BitbucketPullRequestState,
): TriageSourceEntrySnapshotV1['state'] {
  switch (state.presentation) {
    case 'open':
      return { presentation: 'active', nativeLabel: state.nativeLabel };
    case 'merged':
    case 'declined':
    case 'superseded':
      return { presentation: 'closed', nativeLabel: state.nativeLabel };
    default:
      return { presentation: 'unknown', nativeLabel: state.nativeLabel };
  }
}

function readActorLabel(account: BitbucketAccountRef | null): string | null {
  if (account === null) return null;
  return account.displayName ?? account.nickname ?? null;
}

function readScopeLabelSource(entry: BitbucketPullRequestEntry): string {
  return entry.repository.fullName ?? entry.repository.name ?? entry.repository.uuid;
}

/** @internal One candidate row fact together with whether projecting it cost content. */
type FactDraft = Readonly<{ fact: TriageRowFactV1; truncated: boolean }>;

function textFact(
  id: string,
  importance: TriageRowFactV1['importance'],
  kind: 'text' | 'actor',
  raw: string | null,
): FactDraft | null {
  const projected = projectLine(raw, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
  if (projected === null) return null;
  return {
    fact: { id, importance, value: { kind, value: projected.value } },
    truncated: projected.truncated,
  };
}

/**
 * The viewer's own review VERDICT on this pull request, or `null`.
 *
 * This is the one owner of "did I review this?", and both the canonical `participating`
 * involvement and the native `bitbucket/your-review` row fact are derived from it. Two readers
 * would be two answers to one question, and the drifting one would be the one deciding which
 * lane a row lands in.
 *
 * Membership of `participants` is deliberately NOT the test. Bitbucket's participant list is
 * every account that has interacted with the pull request — Atlassian's own contract includes
 * users who "are not explicit reviewers, but have approved" it, and the same list carries
 * `role: PARTICIPANT`, `approved: false`, `state: null` records for people who merely commented.
 * `CONTRACT.md` §4 maps only "reviewed, approved, or a non-zero native review vote" to
 * `participating`, and `sources/SCM.md` §5.5 says "participants with `approved`". Reading bare
 * presence as a review tells a reader they have already reviewed something they only commented
 * on, and files it under work they have finished.
 *
 * A verdict is read from the record's own `state` first, because that is where Bitbucket puts
 * `changes_requested` — a non-zero native vote that is emphatically not an approval, and which
 * `approved: false` alone cannot be distinguished from silence.
 *
 * An ABSENT participant list means unknown, never "no verdict": a collection page fetched
 * without the participants projection reports `review-evidence-unprojected` at the walk instead
 * of publishing that silence here.
 */
function readViewerReviewVerdict(
  entry: BitbucketPullRequestEntry,
  viewerAccountUuid: string,
): BitbucketParticipantFact['state'] {
  const participant = entry.participants
    ?.find((candidate) => candidate.user.uuid === viewerAccountUuid);
  if (participant === undefined) return null;
  return participant.state ?? (participant.approved ? 'approved' : null);
}

/**
 * The native review verdict, preserved as its own word.
 *
 * `CONTRACT.md` §4 maps an approval or a non-zero native review vote to the canonical
 * `participating` token **plus** a bounded row fact retaining the native label — because
 * "approved" and "changes requested" are different answers to the only question a reviewer asks
 * about their own row.
 */
function reviewVerdictFact(verdict: BitbucketParticipantFact['state']): FactDraft | null {
  if (verdict === null) return null;
  const value = verdict === 'approved' ? 'Approved' : 'Changes requested';
  const tone = verdict === 'approved' ? 'success' as const : 'warning' as const;
  return {
    fact: { id: 'bitbucket/your-review', importance: 'primary', value: { kind: 'status', value, tone } },
    truncated: false,
  };
}

/** The authoritative roster from `self`, or the existing deferred answer on a collection row. */
function reviewersFact(entry: BitbucketPullRequestEntry): FactDraft {
  if (entry.reviewers === null) {
    return {
      fact: { id: 'bitbucket/reviewers', importance: 'secondary', value: { kind: 'detailOnly' } },
      truncated: false,
    };
  }
  const labels = entry.reviewers
    .map(readActorLabel)
    .filter((label): label is string => label !== null);
  return textFact(
    'bitbucket/reviewers',
    'secondary',
    'text',
    labels.length === 0 ? 'No reviewers' : labels.join(', '),
  ) ?? {
    fact: { id: 'bitbucket/reviewers', importance: 'secondary', value: { kind: 'detailOnly' } },
    truncated: false,
  };
}

/**
 * The Bitbucket row facts, in the order a triage reader needs them and bounded to the published
 * fact count.
 *
 * Absent features are absent rows: Bitbucket pull requests have no labels and no assignees, and
 * neither is emitted as an empty value. Build statuses and mergeability are separate provider reads
 * this projection does not perform, so they are omitted rather than reported as `0` — the source
 * did not ask.
 *
   * `bitbucket/reviewers` is `detailOnly` when a collection row omitted it, and a bounded roster when
   * the authoritative self read returned it. The latter is detail launch data, not a second read.
 *
 * There is deliberately no repository fact. `scopeLabel` is a required snapshot field carrying
 * exactly that string, and with five slots a fact that repeats a field already on the row spends a
 * slot to say nothing new.
 *
 * The list below is written in importance order, so the bound drops the least decision-relevant
 * facts first and reports the drop as projection truncation rather than losing them silently.
 */
function buildRowFacts(
  entry: BitbucketPullRequestEntry,
  verdict: BitbucketParticipantFact['state'],
): Readonly<{ facts: readonly TriageRowFactV1[]; truncated: boolean }> {
  const drafts: (FactDraft | null)[] = [
    reviewVerdictFact(verdict),
    { fact: { id: 'bitbucket/number', importance: 'primary', value: { kind: 'text', value: `#${entry.entryId}` } }, truncated: false },
    textFact('bitbucket/author', 'secondary', 'actor', readActorLabel(entry.author)),
    reviewersFact(entry),
    entry.updatedAtMs === null ? null : {
      fact: {
        id: 'bitbucket/updated',
        importance: 'secondary',
        value: { kind: 'timestamp', atMs: entry.updatedAtMs, format: 'relative' },
      },
      truncated: false,
    },
    !entry.draft ? null : {
      fact: {
        id: 'bitbucket/draft',
        importance: 'secondary',
        value: { kind: 'status', value: 'Draft', tone: 'warning' },
      },
      truncated: false,
    },
    textFact('bitbucket/target-branch', 'supplementary', 'text', entry.destination?.branchName ?? null),
    entry.commentCount === null ? null : {
      fact: {
        id: 'bitbucket/comments',
        importance: 'supplementary',
        value: { kind: 'number', value: entry.commentCount, format: 'compact' },
      },
      truncated: false,
    },
    entry.taskCount === null ? null : {
      fact: {
        id: 'bitbucket/tasks',
        importance: 'supplementary',
        value: { kind: 'number', value: entry.taskCount, format: 'compact' },
      },
      truncated: false,
    },
  ];

  const present = drafts.filter((draft): draft is FactDraft => draft !== null);
  const kept = present.slice(0, MAX_TRIAGE_ROW_FACTS_V1);
  return {
    facts: kept.map((draft) => draft.fact),
    truncated: present.length > kept.length || kept.some((draft) => draft.truncated),
  };
}

/**
 * The mutable locator.
 *
 * `routingToken` is the repository locator verbatim and nothing else. An entry key is
 * `<scope>:<number>` and no Bitbucket route is addressable by that pair alone, so the token
 * supplies the path — one field, with nothing to read out of it and therefore no accidental second
 * identity. It carries no credential, no local path, and no origin: the origin comes from the
 * Connected Account binding at read time, so a token can never keep routing to a dead host.
 *
 * A machine-meaningful string is omitted rather than shortened. A truncated URL or repository path
 * is not a shorter destination, it is a wrong one.
 */
function buildLocator(entry: BitbucketPullRequestEntry): TriageEntryLocatorV1 {
  const webUrl = projectLine(entry.webUrl, MAX_TRIAGE_LOCATION_UTF8_BYTES_V1);
  const displayPath = projectLine(entry.repository.repositoryKey, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  const routingToken = projectLine(
    entry.repository.repositoryKey,
    MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  );
  return {
    v: 1,
    ...(webUrl === null || webUrl.truncated ? {} : { webUrl: webUrl.value }),
    ...(displayPath === null || displayPath.truncated ? {} : { displayPath: displayPath.value }),
    ...(routingToken === null || routingToken.truncated
      ? {}
      : { routingToken: routingToken.value }),
  };
}

/**
 * Compares the one source-owned opaque route semantic that survives a
 * provider reread. Presentation fields may change independently, while the
 * immutable entry route remains admitted through `collisionScope`; neither
 * path is reconstructed from the other.
 */
export function matchesBitbucketEntryLocator(
  entry: BitbucketPullRequestEntry,
  locator: TriageEntryLocatorV1,
): boolean {
  const current = buildLocator(entry);
  return current.routingToken !== undefined && current.routingToken === locator.routingToken;
}

/**
 * Involvement is proven against the exact credential in hand, not inferred from the lane that
 * happened to return the row. The lane contributes its own canonical token, and the entry's own
 * author/reviewer/participant evidence contributes the rest, so a pull request returned by one lane
 * still reports every involvement the provider actually shows for this viewer.
 */
function buildViewerFacts(
  entry: BitbucketPullRequestEntry,
  input: Readonly<{
    laneInvolvement?: BitbucketInvolvement;
    viewerAccountUuid: string;
    verdict: BitbucketParticipantFact['state'];
  }>,
): TriageSourceViewerFactsV1 {
  const involvement = new Set<TriageSourceViewerFactsV1['involvement'][number]>();
  if (input.laneInvolvement !== undefined) involvement.add(input.laneInvolvement);
  if (entry.author?.uuid === input.viewerAccountUuid) involvement.add('author');
  if (entry.reviewers?.some((reviewer) => reviewer.uuid === input.viewerAccountUuid) === true) {
    involvement.add('reviewRequested');
  }
  // Only a real verdict. See `readViewerReviewVerdict`: bare membership of Bitbucket's
  // participant list is interaction, not review, and there is no canonical token for
  // "commented without deciding" — so such a viewer contributes no involvement from it rather
  // than borrowing the one that means they are done.
  if (input.verdict !== null) involvement.add('participating');
  // `sourceAttention` is deliberately not emitted. Bitbucket publishes no attention signal beyond
  // the involvement this projection already carries, and declaring a source-owned attention level
  // from involvement alone would invent a provider fact rather than report one.
  return { involvement: [...involvement] };
}

/**
 * Publishes the three revision facts only when the one provider response
 * proves every member. A partial revision would let a later selected-workspace
 * request compare one mutable source fact without its destination base.
 */
function readReviewRevision(
  entry: BitbucketPullRequestEntry,
): TriageSourceEntrySnapshotV1['reviewRevision'] | null {
  const baseSha = projectLine(
    entry.destination?.commitHash ?? null,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  );
  const sourceHeadSha = projectLine(
    entry.source?.commitHash ?? null,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  );
  if (
    baseSha === null || baseSha.truncated
    || sourceHeadSha === null || sourceHeadSha.truncated
  ) {
    return null;
  }
  return {
    baseSha: baseSha.value,
    headSha: sourceHeadSha.value,
    nativeRevision: sourceHeadSha.value,
  };
}

/** The local ref, built from proven native identity rather than from any row presentation field. */
export function buildBitbucketLocalRef(
  entry: BitbucketPullRequestEntry,
): TriageSourceEntryLocalRefV1 {
  return {
    kindId: BITBUCKET_PULL_REQUEST_KIND_ID,
    collisionScope: entry.collisionScope,
    entryId: entry.entryId,
  };
}

/**
 * Projects one decoded Bitbucket pull request into the public present observation.
 *
 * This is a **list row**, not a document. The pull-request description, its comments, its activity
 * and its diff are detail-surface content that a live source materialization returns; none of them
 * rides a scan or get result, so no body excerpt is projected here as a subtitle.
 *
 * Every identity-valid provider entity still reaches `present`. A pull request whose title is empty
 * or is nothing but control characters still projects, under its own number, because the public
 * title is required display text and dropping a real entry over missing presentation would be an
 * invented absence.
 */
export function toBitbucketPresentObservation(
  entry: BitbucketPullRequestEntry,
  input: Readonly<{ laneInvolvement?: BitbucketInvolvement; viewerAccountUuid: string }>,
): Extract<TriageSourceScanObservationV1, Readonly<{ kind: 'present' }>> {
  const verdict = readViewerReviewVerdict(entry, input.viewerAccountUuid);
  const rowFacts = buildRowFacts(entry, verdict);
  const title = projectLine(entry.title, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  const summary = projectLine(entry.summary, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  const scopeLabel = projectLine(readScopeLabelSource(entry), MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  const nativeLabel = projectLine(entry.state.nativeLabel, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  const nativeRevision = projectLine(
    entry.source?.commitHash ?? null,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  );
  const reviewRevision = readReviewRevision(entry);

  const state = toPresentationState(entry.state);
  const projectionTruncated = entry.projectionTruncated
    || rowFacts.truncated
    || (title?.truncated ?? false)
    || (summary?.truncated ?? false)
    || (scopeLabel?.truncated ?? false);

  const snapshot: TriageSourceEntrySnapshotV1 = {
    v: 1,
    title: title?.value ?? `Pull request #${entry.entryId}`,
    ...(summary === null ? {} : { summary: summary.value }),
    // The repository UUID is the last resort and is always a valid single line, so a required
    // field is never published blank.
    scopeLabel: scopeLabel?.value ?? entry.repository.uuid,
    ...(entry.createdAtMs === null ? {} : { createdAtMs: entry.createdAtMs }),
    state: {
      presentation: state.presentation,
      ...(nativeLabel === null ? {} : { nativeLabel: nativeLabel.value }),
    },
    facts: rowFacts.facts,
    ...(reviewRevision === null ? {} : { reviewRevision }),
    ...(projectionTruncated ? { projectionTruncated: true as const } : {}),
  };

  const repository = entry.repository.repositoryKey === null
    ? null
    // The forge repository, in the vocabulary a project's resolved
    // `ScmHostingProviderRef` already uses, so launch placement joins the two by
    // equality and nothing parses a git remote. A row whose `full_name` never
    // resolved a two-segment key proves no repository and resolves to no
    // checkout rather than to every checkout on Bitbucket Cloud.
    : normalizeScmHostingRepositoryIdentity({
      kind: 'bitbucket',
      deployment: BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1,
      repository: entry.repository.repositoryKey,
    });

  return {
    kind: 'present',
    localRef: buildBitbucketLocalRef(entry),
    locator: buildLocator(entry),
    ...(repository === null ? {} : { repository }),
    snapshot,
    viewer: buildViewerFacts(entry, { ...input, verdict }),
    ...(entry.updatedAtMs === null ? {} : { sourceUpdatedAtMs: entry.updatedAtMs }),
    ...(nativeRevision === null || nativeRevision.truncated
      ? {}
      : { nativeRevision: nativeRevision.value }),
  };
}
