import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1,
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  normalizeTriageSingleLineV1,
  projectTriageDisplayTextV1,
  type TriageEntryLocatorV1,
  type TriageRowFactStatusToneV1,
  type TriageRowFactV1,
  type TriageSourceEntrySnapshotV1,
  type TriageSourceScanObservationV1,
  type TriageViewerInvolvementV1,
} from '@happier-dev/triage-protocol/v1';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';

import type {
  AzureInvolvement,
  AzurePullRequestEntry,
  AzurePullRequestMergeStatus,
  AzureRowFact,
} from './types.js';

type PresentObservation = Extract<TriageSourceScanObservationV1, Readonly<{ kind: 'present' }>>;

const MERGE_STATUS_TONE: Readonly<Record<AzurePullRequestMergeStatus, TriageRowFactStatusToneV1>> = {
  notSet: 'neutral',
  queued: 'info',
  conflicts: 'danger',
  succeeded: 'success',
  rejectedByPolicy: 'danger',
  failure: 'danger',
};

/**
 * Project one mapped Azure pull request into the closed public present observation.
 *
 * `involvement` is supplied by the caller rather than read from the entry because the two read
 * paths prove different things: a scan lane is a provider query whose membership already
 * establishes the canonical token, while an authoritative `get` for an uninvolved viewer must
 * be able to say "no involvement" instead of inheriting a lane it never ran (`CONTRACT.md` §4).
 */
export function projectAzurePresentObservation(input: Readonly<{
  entry: AzurePullRequestEntry;
  involvement: readonly AzureInvolvement[];
}>): TriageSourceScanObservationV1 {
  const { entry } = input;
  const facts = projectRowFacts(entry.facts);
  // Display text is normalized into one bounded line at the shared owner: every V1 string
  // is single-line, and the target rejects a control-bearing result ATOMICALLY, so one
  // Azure title carrying a newline would discard every other row on the same scan page.
  const projectedTitle = projectTriageDisplayTextV1(entry.title, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  const title = projectedTitle.value.length === 0
    ? projectTriageDisplayTextV1(`Pull request !${entry.entryId}`, MAX_TRIAGE_TEXT_UTF8_BYTES_V1)
    : projectedTitle;
  const projectedScope = projectTriageDisplayTextV1(
    entry.locator.repositoryKey,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  const scopeLabel = projectedScope.value.length === 0
    ? projectTriageDisplayTextV1(entry.locator.repositoryId, MAX_TRIAGE_TEXT_UTF8_BYTES_V1)
    : projectedScope;
  const displayPath = projectTriageDisplayTextV1(
    `${scopeLabel.value} !${entry.entryId}`,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  const createdAtMs = readEpochMs(entry.createdAt);
  const webUrl = fittingLocation(buildPullRequestWebUrl(entry));
  // §2.10: the routing token is `repositoryKey`, verbatim — this source is its only parser, so a
  // shortened one would be a wrong route rather than a shortened label. It is omitted instead.
  const routingToken = fittingWithin(
    normalizeTriageSingleLineV1(entry.locator.repositoryKey),
    MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  );
  const nativeRevision = fittingWithin(
    normalizeTriageSingleLineV1(entry.headCommitId ?? ''),
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  );
  const reviewRevision = readReviewRevision(entry, nativeRevision);

  const snapshot: TriageSourceEntrySnapshotV1 = {
    v: 1,
    title: title.value,
    scopeLabel: scopeLabel.value,
    ...(createdAtMs === null ? {} : { createdAtMs }),
    state: {
      presentation: readPresentationState(entry),
      ...(entry.nativeLabel.trim().length === 0
        ? {}
        : {
          nativeLabel: projectTriageDisplayTextV1(
            entry.nativeLabel,
            MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
          ).value,
        }),
    },
    facts: facts.facts,
    ...(reviewRevision === null ? {} : { reviewRevision }),
    ...(title.truncated
      || scopeLabel.truncated
      || facts.truncated
      || routingToken === null
      || (webUrl === null && entry.locator.webUrl !== null)
      ? { projectionTruncated: true as const }
      : {}),
  };

  const locator: TriageEntryLocatorV1 = {
    v: 1,
    ...(webUrl === null ? {} : { webUrl }),
    displayPath: displayPath.value,
    ...(routingToken === null ? {} : { routingToken }),
  };

  // The forge repository, in the vocabulary a project's resolved
  // `ScmHostingProviderRef` already uses, so launch placement joins the two by
  // equality and nothing parses a git remote. Emitted whole or not at all: a
  // shortened deployment or repository key is a DIFFERENT repository, and an
  // entry that proves none resolves to no checkout rather than to every
  // checkout on the deployment.
  const repositoryDeployment = fittingWithin(
    normalizeTriageSingleLineV1(entry.locator.deploymentBaseUrl),
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  );
  const repositoryNameWithOwner = fittingWithin(
    normalizeTriageSingleLineV1(entry.locator.repositoryKey),
    MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1,
  );
  const repository = repositoryDeployment === null || repositoryNameWithOwner === null
    ? null
    : normalizeScmHostingRepositoryIdentity({
      kind: 'azure-devops',
      deployment: repositoryDeployment,
      repository: repositoryNameWithOwner,
    });

  const observation: PresentObservation = {
    kind: 'present',
    localRef: {
      kindId: entry.kindId,
      collisionScope: entry.collisionScope,
      entryId: entry.entryId,
    },
    locator,
    snapshot,
    viewer: { involvement: dedupeInvolvement(input.involvement) },
    ...(nativeRevision === null ? {} : { nativeRevision }),
    ...(repository === null ? {} : { repository }),
  };
  return observation;
}

/** Azure's source commit is both the generic head and its native revision fact. */
function readReviewRevision(
  entry: AzurePullRequestEntry,
  nativeRevision: string | null,
): Readonly<{ baseSha: string; headSha: string; nativeRevision: string }> | null {
  const baseSha = fittingWithin(
    normalizeTriageSingleLineV1(entry.baseCommitId ?? ''),
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  );
  const headSha = fittingWithin(
    normalizeTriageSingleLineV1(entry.headCommitId ?? ''),
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  );
  if (baseSha === null || headSha === null || nativeRevision === null) return null;
  return { baseSha, headSha, nativeRevision };
}

/** A machine-meaningful string is emitted whole or not at all; a shortened one is wrong. */
function fittingWithin(value: string, maximumBytes: number): string | null {
  if (value.length === 0) return null;
  return new TextEncoder().encode(value).length > maximumBytes ? null : value;
}

function fittingLocation(value: string | null): string | null {
  return value === null ? null : fittingWithin(value, MAX_TRIAGE_LOCATION_UTF8_BYTES_V1);
}

/**
 * Azure's `notSet` and `all` are not evidence that a pull request is open.
 *
 * `TRIAGE_ENTRY_PRESENTATION_STATES_V1` publishes `unknown` for exactly this case: the entry
 * stays `present` with the provider's own word, rather than being displayed as an active pull
 * request on the strength of a status the provider did not commit to.
 */
function readPresentationState(
  entry: AzurePullRequestEntry,
): TriageSourceEntrySnapshotV1['state']['presentation'] {
  if (entry.state === 'notSet' || entry.state === 'all') return 'unknown';
  return entry.state === 'completed' || entry.state === 'abandoned' ? 'closed' : 'active';
}

/**
 * The provider returns the repository web URL, not the pull request's.
 *
 * Azure's pull-request page lives at `<repositoryWebUrl>/pullrequest/<id>`, so the row's link is
 * composed from provider evidence plus that documented path. Without a repository URL there is
 * nothing to compose from and the field is omitted — a relative or invented link is worse than
 * no link.
 */
function buildPullRequestWebUrl(entry: AzurePullRequestEntry): string | null {
  const repositoryWebUrl = entry.locator.webUrl;
  if (repositoryWebUrl === null) return null;
  return `${repositoryWebUrl.replace(/\/+$/u, '')}/pullrequest/${entry.entryId}`;
}

function dedupeInvolvement(
  involvement: readonly AzureInvolvement[],
): readonly TriageViewerInvolvementV1[] {
  return [...new Set(involvement)];
}

function projectRowFacts(facts: readonly AzureRowFact[]): Readonly<{
  facts: readonly TriageRowFactV1[];
  truncated: boolean;
}> {
  const projected: TriageRowFactV1[] = [];
  const seen = new Set<string>();
  let truncated = false;

  facts.forEach((fact, index) => {
    const candidate = projectRowFact(fact, index);
    if (candidate === null) return;
    if (seen.has(candidate.id)) return;
    if (projected.length >= MAX_TRIAGE_ROW_FACTS_V1) {
      truncated = true;
      return;
    }
    seen.add(candidate.id);
    projected.push(candidate);
  });

  return { facts: projected, truncated };
}

function projectRowFact(fact: AzureRowFact, index: number): TriageRowFactV1 | null {
  switch (fact.kind) {
    case 'reviewerVote':
      return {
        id: 'azure-devops/reviewer-vote',
        label: 'Your vote',
        importance: 'primary',
        value: {
          kind: 'status',
          value: boundedFactText(fact.nativeLabel),
          tone: fact.vote > 0 ? 'success' : fact.vote < 0 ? 'danger' : 'neutral',
        },
      };
    case 'mergeStatus':
      return {
        id: 'azure-devops/merge-status',
        label: 'Merge',
        importance: 'primary',
        value: {
          kind: 'status',
          value: boundedFactText(fact.nativeLabel),
          tone: MERGE_STATUS_TONE[fact.value],
        },
      };
    case 'draft':
      return {
        id: 'azure-devops/draft',
        importance: 'secondary',
        value: { kind: 'text', value: 'Draft' },
      };
    case 'autoCompleteEnabled':
      // §6.3.1 rule 3: auto-complete can complete this pull request later, on policy
      // satisfaction, entirely outside any request we make. Disclosing it at read time is the
      // whole point; it is never silently normalized away.
      return {
        id: 'azure-devops/auto-complete',
        label: 'Auto-complete',
        importance: 'secondary',
        value: { kind: 'status', value: 'Set', tone: 'warning' },
      };
    case 'label': {
      const value = boundedFactText(fact.value);
      if (value.length === 0) return null;
      return {
        id: `azure-devops/tag/${index}`,
        importance: 'supplementary',
        value: { kind: 'text', value },
      };
    }
  }
}

function boundedFactText(value: string): string {
  return projectTriageDisplayTextV1(value, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1).value;
}

function readEpochMs(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}
