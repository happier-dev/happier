import type {
  ConnectedAccountBindingSummary,
  ConnectedAccountListRequest,
  ConnectedAccountListedAccount,
  ConnectedAccountListedMaterializationRequest,
  ConnectedAccountMaterialization,
  ConnectedAccountMetadataList,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MAX_TRIAGE_INSTANCE_DRAFTS_V1,
  type TriageGetInputV1,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriageScanInputV1,
  type TriageScanResultV1,
  type TriageSourceAccountBindingV1,
  type TriageSourceFailureV1,
  type TriageSourceInstanceDraftV1,
  type TriageSourceScanEvidenceV1,
  type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';

import { readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';

import { materializeAzureDevOpsListedAuthorization } from './auth.js';
import { createAzureDevOpsApiClient } from './client.js';
import {
  encodeAzureSourceConfiguration,
  resolveAzureConfiguredOrigin,
} from './configuration.js';
import { decodeAzureScanContinuation, encodeAzureScanContinuation } from './continuation.js';
import { decodeAzureConnectionData, decodeAzurePullRequestRow, readRecord, readString } from './decode.js';
import { AZURE_DEVOPS_TRIAGE_PURPOSE } from './descriptor.js';
import { createAzureSourceFailure, projectAzureSourceFailure } from './failureProjection.js';
import { isAzureGuid } from './identity.js';
import { parseAzureEntryLocalRef } from './localRef.js';
import { mapAzurePullRequestEntry } from './mapping.js';
import { projectAzurePresentObservation } from './observation.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import {
  advanceAzureLane,
  advanceAzureLaneRotation,
  azurePageFitsBudget,
  createAzureLaneFrontiers,
  createAzureScanFrontier,
  readAzurePullRequestLanePage,
  readAzureProjectPage,
  readAzureRepositoriesAfter,
  recordAzureWalkHealth,
  selectAzureLane,
} from './paging.js';
import {
  AZURE_SCAN_STICKY_REASONS,
  type AzureDevOpsApiClient,
  type AzureDevOpsHttpTransport,
  type AzureDevOpsOrigin,
  type AzureInvolvement,
  type AzurePullRequestRow,
  type AzureRepositoryRow,
  type AzureScanFrontier,
} from './types.js';

/**
 * One native provider page for a `(repository, lane)` walk.
 *
 * It is deliberately smaller than the contract's 64-entry page ceiling so a lane that has more
 * than one page can actually take a second one inside the caller's projection budget — the
 * condition that makes Azure's offset walk report `moving` instead of silently claiming a
 * finished walk.
 */
export const AZURE_NATIVE_PAGE_SIZE = 30;

/** The bounded account slice of the host Connected Accounts service this source consumes. */
export type AzureTriageAccountService = Readonly<{
  listAccounts(
    request: ConnectedAccountListRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ConnectedAccountMetadataList>;
  getBinding(
    purpose: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ConnectedAccountBindingSummary | null>;
  materializeListedAccount(
    request: ConnectedAccountListedMaterializationRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ConnectedAccountMaterialization>;
}>;

export type AzureTriageReadServices = Readonly<{
  connectedAccounts: Pick<AzureTriageAccountService, 'materializeListedAccount'>;
  transport: AzureDevOpsHttpTransport;
  /** Injected clock. A provider retry deadline is the only absolute time this source produces. */
  now: () => number;
}>;

/* -------------------------------------------------------------------------- */
/* listInstances                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Discovery of candidate configured instances for this source's declared purpose.
 *
 * `CONTRACT.md` §3.1: the source asks the generic Connected Accounts owner for its own purpose,
 * accepts only `status:'complete'` as complete enumeration, and returns one candidate per exact
 * account ref × provider-native scope. It creates nothing: an unmatched candidate is a Settings
 * choice until the user invokes the target-owned administration Action.
 *
 * Routing is by the account's published `connectedAccountBases` — the configured service base,
 * which for Azure DevOps carries the organization (Services) or collection (Server) path segment
 * every REST path is built beneath. `connectedAccountOrigins` is the separate network fact
 * HostAccess governs by; it is never a route, and the host guarantees each base begins with one of
 * them. An account that publishes no base becomes an explicit exact-binding failure instead of a
 * silently missing row.
 */
export async function runAzureTriageListInstances(input: Readonly<{
  connectedAccounts: Pick<AzureTriageAccountService, 'listAccounts' | 'getBinding'>;
  signal: AbortSignal;
}>): Promise<TriageListInstancesResultV1> {
  const outcome = await readTriageSourceAccountListingV1({
    connectedAccounts: input.connectedAccounts,
    purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
    signal: input.signal,
  });
  if (outcome.kind === 'failed') {
    return {
      kind: 'failed',
      failure: createAzureSourceFailure({
        class: 'transient',
        code: 'azure-devops/account-listing-failed',
        detail: 'The Connected Accounts listing for Azure DevOps could not be read.',
      }),
    };
  }
  // No selected account is an empty set the reader can act on by connecting one,
  // never an Azure DevOps that refused a request this source never sent.
  const listing: ConnectedAccountMetadataList = outcome.kind === 'unbound'
    ? { status: 'complete', accounts: [] }
    : outcome.listing;

  const candidates: TriageSourceInstanceDraftV1[] = [];
  const failures: Array<Readonly<{
    binding: TriageSourceAccountBindingV1;
    localInstanceKey?: string;
    failure: TriageSourceFailureV1;
  }>> = [];
  let bounded = false;

  for (const account of listing.accounts) {
    const binding: TriageSourceAccountBindingV1 = {
      purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
      account: account.account,
    };
    if (account.connectedAccountBases.length === 0) {
      failures.push({
        binding,
        failure: createAzureSourceFailure({
          class: 'unsupportedContract',
          code: 'azure-devops/configured-base-unavailable',
          detail: 'This Azure DevOps account publishes no configured organization or collection base.',
        }),
      });
      continue;
    }
    for (const configuredBase of account.connectedAccountBases) {
      const candidate = buildCandidate(binding, configuredBase);
      if (candidate.kind !== 'candidate') {
        failures.push({
          binding,
          localInstanceKey: configuredBase,
          failure: createAzureSourceFailure({
            class: 'unsupportedContract',
            ...(candidate.kind === 'unroutable'
              ? {
                code: 'azure-devops/organization-scope-unavailable',
                detail: 'This Azure DevOps base names no organization or collection to read.',
              }
              : {
                code: 'azure-devops/configured-base-unsupported',
                detail: 'This Azure DevOps configured base is not a usable https deployment base.',
              }),
          }),
        });
        continue;
      }
      if (candidates.length >= MAX_TRIAGE_INSTANCE_DRAFTS_V1) {
        bounded = true;
        break;
      }
      candidates.push(candidate.draft);
    }
    if (bounded) break;
  }

  if (bounded) {
    return {
      kind: 'incomplete',
      candidates,
      failures,
      failure: createAzureSourceFailure({
        class: 'unknown',
        code: 'azure-devops/discovery-bounded',
        detail: 'More Azure DevOps candidates exist than one discovery result can carry.',
      }),
    };
  }
  if (listing.status === 'truncated') {
    // The incumbent owner has no resumable cursor, so a truncated listing can only be reported
    // as incomplete; silently omitting the accounts it elided would be the worse answer.
    return {
      kind: 'incomplete',
      candidates,
      failures,
      failure: createAzureSourceFailure({
        class: 'unknown',
        code: 'azure-devops/account-listing-truncated',
        detail: 'The Connected Accounts listing was truncated, so some accounts may be unrepresented.',
      }),
    };
  }
  return { kind: 'complete', candidates, failures };
}

/**
 * One published account base, classified.
 *
 * `unroutable` is a distinct arm from `unsupported` on purpose: a base this source cannot parse at
 * all and a base it parsed perfectly but which names no organization or collection are different
 * facts, and only the second tells the user which piece of configuration is missing.
 */
type CandidateOutcome =
  | Readonly<{ kind: 'candidate'; draft: TriageSourceInstanceDraftV1 }>
  | Readonly<{ kind: 'unroutable' }>
  | Readonly<{ kind: 'unsupported' }>;

function buildCandidate(
  binding: TriageSourceAccountBindingV1,
  configuredBase: ConnectedAccountListedAccount['connectedAccountBases'][number],
): CandidateOutcome {
  const normalized = normalizeAzureDevOpsBaseUrl(configuredBase);
  if (!normalized.ok) return { kind: 'unsupported' };
  const origin = normalized.origin;
  // Every Azure DevOps REST path lives beneath an organization (Services) or collection (Server)
  // path segment. A base without one cannot address `_apis/projects`, so it is not a candidate:
  // it is a missing configuration fact, reported as such.
  if (origin.organizationOrCollection === null) return { kind: 'unroutable' };
  return {
    kind: 'candidate',
    draft: {
      v: 1,
      binding,
      // §3.1: source-native scope only. The account already travels as its own tuple member.
      localInstanceKey: origin.baseUrl,
      // Azure exposes no immutable deployment id, so the key is derived from the explicitly
      // configured normalized base and a base change is explicit reconfiguration.
      keyStability: 'locatorDerived',
      configuration: encodeAzureSourceConfiguration(origin),
      locator: {
        v: 1,
        displayLabel: origin.organizationOrCollection,
        displayPath: origin.baseUrl,
        webUrl: origin.baseUrl,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* scan                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The per-call half of scan health.
 *
 * `sources/SCM.md` §2.8b splits health in two: caveats that outlive the page live in the
 * frontier's sticky set, and these describe only the call that emits them. `projection-budget` is
 * resolved by the continuation this very call returns; the other two end the walk where they
 * appear. Keeping them out of the frontier is what stops a resumed walk from repeating a page
 * shape it already solved.
 */
const AZURE_PER_CALL_REASONS = [
  'scan-cancelled',
  'continuation-unavailable',
  'projection-budget',
] as const;
type AzurePerCallReason = (typeof AZURE_PER_CALL_REASONS)[number];

type ScanWalkState = {
  readonly observations: TriageSourceScanObservationV1[];
  readonly perCallReasons: AzurePerCallReason[];
  /** Entry rows this page omitted. Scope rows never count here — see `recordScopeOmission`. */
  omitted: number;
};

export async function runAzureTriageScan(input: Readonly<{
  services: AzureTriageReadServices;
  request: TriageScanInputV1;
  signal: AbortSignal;
}>): Promise<TriageScanResultV1> {
  const { services, request, signal } = input;

  const origin = resolveAzureConfiguredOrigin(request.instance.configuration);
  if (origin === null) return { kind: 'failed', failure: undecodableConfiguration() };

  const frontier = request.page.kind === 'initial'
    ? createAzureScanFrontier({
      scanLimit: request.page.limit,
      nativePageSize: Math.min(request.page.limit, AZURE_NATIVE_PAGE_SIZE),
    })
    : decodeAzureScanContinuation(request.page.continuation);
  if (frontier === null) {
    return {
      kind: 'failed',
      failure: createAzureSourceFailure({
        class: 'unsupportedContract',
        code: 'azure-devops/continuation-undecodable',
        detail: 'This Azure DevOps scan continuation was not produced by this source.',
      }),
    };
  }

  const client = await openClient({ services, instance: request.instance, origin, signal });
  if (!client.ok) return { kind: 'failed', failure: client.failure };

  return walkAzureScan({ client: client.client, origin, viewerId: client.viewerId, frontier, signal });
}

async function walkAzureScan(input: Readonly<{
  client: AzureDevOpsApiClient;
  origin: AzureDevOpsOrigin;
  viewerId: string;
  frontier: AzureScanFrontier;
  signal: AbortSignal;
}>): Promise<TriageScanResultV1> {
  const { client, origin, viewerId, frontier, signal } = input;
  const state: ScanWalkState = { observations: [], perCallReasons: [], omitted: 0 };
  let repository: AzureRepositoryRow | null = null;

  while (true) {
    if (signal.aborted) {
      return settle(state, frontier, 'cancelled', createAzureSourceFailure({
        class: 'transient',
        code: 'azure-devops/cancelled',
        detail: 'The Azure DevOps scan was cancelled.',
      }));
    }

    if (repository === null) {
      if (frontier.projectId === null) {
        const projects = await readAzureProjectPage({
          client,
          continuationToken: frontier.projectNextToken,
          signal,
        });
        if (!projects.ok) return settle(state, frontier, 'failed', projectAzureSourceFailure(projects.failure));
        recordScopeOmission(frontier, projects.undecodable);
        frontier.projectNextToken = projects.continuationToken;
        const next = projects.projects[0];
        if (next === undefined) {
          if (frontier.projectNextToken === null) return settle(state, frontier, 'finished', null);
          continue;
        }
        frontier.projectId = next.id;
        frontier.lastCompletedRepositoryId = null;
      }

      const repositories = await readAzureRepositoriesAfter({
        client,
        projectId: frontier.projectId,
        lastCompletedRepositoryId: frontier.lastCompletedRepositoryId,
        signal,
      });
      if (!repositories.ok) {
        return settle(state, frontier, 'failed', projectAzureSourceFailure(repositories.failure));
      }
      recordScopeOmission(frontier, repositories.undecodable);

      const next = repositories.repositories[0];
      if (next === undefined) {
        frontier.projectId = null;
        frontier.currentRepositoryId = null;
        frontier.lastCompletedRepositoryId = null;
        if (frontier.projectNextToken === null) return settle(state, frontier, 'finished', null);
        continue;
      }
      if (next.isDisabled) {
        // A disabled repository is skipped with an attributed outcome, never presented as a
        // repository whose lanes were empty.
        recordAzureWalkHealth(frontier, 'lane-unavailable');
        frontier.lastCompletedRepositoryId = next.id;
        continue;
      }
      if (frontier.currentRepositoryId !== null && frontier.currentRepositoryId !== next.id) {
        // The pinned GUID is no longer the frontier head: repositories moved underneath the
        // walk. The new head is adopted with fresh lane offsets rather than continuing offsets
        // that belong to a different repository.
        recordAzureWalkHealth(frontier, 'lane-unresolved');
        frontier.currentRepositoryId = null;
      }
      if (frontier.currentRepositoryId !== next.id) {
        enterAzureRepository(frontier, next.id);
      }
      repository = next;
    }

    const laneIndex = selectAzureLane(frontier);
    if (laneIndex < 0) {
      frontier.lastCompletedRepositoryId = repository.id;
      enterAzureRepository(frontier, null);
      repository = null;
      continue;
    }
    const lane = frontier.lanes[laneIndex];
    if (lane === undefined) return settle(state, frontier, 'finished', null);

    if (!azurePageFitsBudget(frontier)) {
      recordPerCall(state, 'projection-budget');
      return settle(state, frontier, 'page', null);
    }

    const lanePage = await readAzurePullRequestLanePage({
      client,
      projectId: repository.projectId,
      repositoryId: repository.id,
      lane: lane.laneId,
      viewerId,
      top: frontier.nativePageSize,
      skip: lane.skip,
      signal,
    });
    if (!lanePage.ok) return settle(state, frontier, 'failed', projectAzureSourceFailure(lanePage.failure));
    // `$top`/`$skip` over a mutating list skips and duplicates by construction, so any lane that
    // needed a second page can only claim `moving` — and it stays true for the rest of the walk,
    // including the call that settles it from an entirely different repository.
    if (lane.skip > 0) recordAzureWalkHealth(frontier, 'offset-paging');
    // §6.5: raw `value.length` is what `$skip` and the projection budget both advance by, so an
    // undecodable row costs budget instead of leaving it unspent for a later page to overfill.
    frontier.observed += lanePage.rawCardinality;
    recordEntryOmission(state, frontier, lanePage.undecodable);

    for (const row of lanePage.rows) {
      const entry = mapAzurePullRequestEntry({
        origin,
        project: { id: repository.projectId, name: repository.projectName, state: null },
        repository,
        row,
        lane: lane.laneId,
        viewerId,
      });
      if (entry === null) {
        recordEntryOmission(state, frontier, 1);
        continue;
      }
      state.observations.push(projectAzurePresentObservation({
        entry,
        involvement: [entry.involvement],
      }));
    }

    advanceAzureLane(frontier, lane.laneId, lanePage.rawCardinality, lanePage.ended);
    advanceAzureLaneRotation(frontier, laneIndex);
  }
}

/** Enter a repository — or leave the last one — with a fresh rotation and fresh lane offsets. */
function enterAzureRepository(frontier: AzureScanFrontier, repositoryId: string | null): void {
  frontier.currentRepositoryId = repositoryId;
  frontier.nextLaneIndex = 0;
  frontier.lanes = createAzureLaneFrontiers();
}

function settle(
  state: ScanWalkState,
  frontier: AzureScanFrontier,
  outcome: 'finished' | 'page' | 'failed' | 'cancelled',
  failure: TriageSourceFailureV1 | null,
): TriageScanResultV1 {
  if (failure !== null && state.observations.length === 0) {
    return { kind: 'failed', failure };
  }
  if (failure !== null) {
    // Observations already learned are not discarded by a later frontier failure: the walk ends
    // and settles as partial, which is health evidence rather than set-complement evidence.
    if (outcome === 'cancelled') recordPerCall(state, 'scan-cancelled');
    else recordAzureWalkHealth(frontier, 'lane-unresolved');
    return { kind: 'complete', observations: state.observations, evidence: readEvidence(state, frontier) };
  }
  if (outcome === 'page') {
    const continuation = encodeAzureScanContinuation(frontier);
    if (continuation === null) {
      // The walk cannot be resumed, so it ends here. Saying so is the point: a `complete` arm
      // that quietly dropped the rest of the walk would read as a finished one.
      recordPerCall(state, 'continuation-unavailable');
      return {
        kind: 'complete',
        observations: state.observations,
        evidence: readEvidence(state, frontier),
      };
    }
    return {
      kind: 'page',
      observations: state.observations,
      evidence: readEvidence(state, frontier),
      continuation,
    };
  }
  return {
    kind: 'complete',
    observations: state.observations,
    evidence: readEvidence(state, frontier),
  };
}

/**
 * One reason out of two sets, in one fixed precedence (`sources/SCM.md` §2.8b).
 *
 * The evidence arm carries exactly one reason, so the order is declaration order over the sticky
 * set first, then this call's own reasons. A `partial` reason outranks `moving { offset-paging }`
 * because work never inspected is a stronger caveat than work whose order shifted, and only
 * `partial` can carry `omittedItemCount`. `walkFinished` therefore requires an empty sticky set —
 * it is never emitted from a call that merely did not witness the truncation itself.
 */
function readEvidence(
  state: ScanWalkState,
  frontier: AzureScanFrontier,
): TriageSourceScanEvidenceV1 {
  const sticky = AZURE_SCAN_STICKY_REASONS.filter((reason) => (
    reason !== 'offset-paging' && frontier.walkHealth.includes(reason)
  ));
  const reason = sticky[0] ?? AZURE_PER_CALL_REASONS.find(
    (candidate) => state.perCallReasons.includes(candidate),
  );
  if (reason !== undefined) {
    return {
      kind: 'partial',
      reason,
      ...(state.omitted > 0 ? { omittedItemCount: state.omitted } : {}),
    };
  }
  if (frontier.walkHealth.includes('offset-paging')) {
    return { kind: 'moving', reason: 'offset-paging' };
  }
  return { kind: 'walkFinished' };
}

function recordPerCall(state: ScanWalkState, reason: AzurePerCallReason): void {
  if (!state.perCallReasons.includes(reason)) state.perCallReasons.push(reason);
}

/**
 * An entry row the source could not decode or map.
 *
 * It already consumed provider position, so it costs the page budget and is counted, keeping
 * `observations.length + omittedItemCount <= limit` true (`CONTRACT.md` §5.1).
 */
function recordEntryOmission(
  state: ScanWalkState,
  frontier: AzureScanFrontier,
  omitted: number,
): void {
  if (omitted <= 0) return;
  state.omitted += omitted;
  recordAzureWalkHealth(frontier, 'undecodable-items');
}

/**
 * A project or repository row the enumeration could not read.
 *
 * It is a scope the walk could not enter, not an entry it omitted: the number of pull requests
 * lost is unknown, and charging it to `omittedItemCount` would break the bound the target
 * enforces against the submitted `limit`.
 */
function recordScopeOmission(frontier: AzureScanFrontier, undecodable: number): void {
  if (undecodable <= 0) return;
  recordAzureWalkHealth(frontier, 'repository-enumeration-incomplete');
}

/* -------------------------------------------------------------------------- */
/* get                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The authoritative read of one local ref.
 *
 * `sources/SCM.md` §6.5 makes `absent` deliberately unreachable for Azure in V1: a `200` whose
 * repository GUID and number match is `present`, and redirects, mismatched or malformed bodies,
 * `401`, `403`, `404`, `429`, `5xx`, cancellation and transport failure are all `unresolved`.
 * Azure documents `404` as nonexistent **or** not permitted to view, and no second read
 * separates them, so a cached row stays stale rather than being deleted on masked permission.
 */
export async function runAzureTriageGet(input: Readonly<{
  services: AzureTriageReadServices;
  request: TriageGetInputV1;
  signal: AbortSignal;
}>): Promise<TriageGetResultV1> {
  const { services, request, signal } = input;
  const localRef = request.localRef;

  const origin = resolveAzureConfiguredOrigin(request.instance.configuration);
  if (origin === null) return { kind: 'unresolved', localRef, failure: undecodableConfiguration() };

  const address = parseAzureEntryLocalRef(localRef, origin);
  if (address === null) {
    return {
      kind: 'unresolved',
      localRef,
      failure: createAzureSourceFailure({
        class: 'unsupportedContract',
        code: 'azure-devops/entry-outside-configured-instance',
        detail: 'This entry reference was not derived from this configured Azure DevOps base.',
      }),
    };
  }

  const client = await openClient({ services, instance: request.instance, origin, signal });
  if (!client.ok) return { kind: 'unresolved', localRef, failure: client.failure };

  const response = await client.client.request({
    // The Git area addresses a repository by GUID with no project segment, which is the only
    // route this input can build: it carries no project name and must not guess one.
    route: {
      resource: 'pullRequest',
      repositoryId: address.repositoryId,
      pullRequestId: address.pullRequestId,
    },
    signal,
  });
  if (!response.ok) {
    return { kind: 'unresolved', localRef, failure: projectAzureSourceFailure(response.failure) };
  }

  const row = decodeAzurePullRequestRow(response.body);
  const scope = readPullRequestScope(response.body);
  if (row === null || scope === null) {
    return { kind: 'unresolved', localRef, failure: malformedPullRequest() };
  }
  if (row.repositoryId !== address.repositoryId || row.pullRequestId !== address.pullRequestId) {
    // A body that names another repository or number is a routing error, never a redirect.
    return { kind: 'unresolved', localRef, failure: malformedPullRequest() };
  }

  const involvement = readViewerInvolvement(row, client.viewerId);
  const entry = mapAzurePullRequestEntry({
    origin,
    project: { id: scope.projectId, name: scope.projectName, state: null },
    repository: scope.repository,
    row,
    lane: involvement.includes('author') ? 'authored' : 'reviewer',
    viewerId: client.viewerId,
  });
  if (entry === null) return { kind: 'unresolved', localRef, failure: malformedPullRequest() };

  const observation = projectAzurePresentObservation({ entry, involvement });
  if (observation.kind !== 'present') {
    return { kind: 'unresolved', localRef, failure: malformedPullRequest() };
  }
  // The result's ref must equal the exact input ref; a different one is invalid, not a redirect.
  return { ...observation, localRef };
}

/**
 * The viewer's involvement in one authoritative read.
 *
 * Unlike a scan, `get` runs no lane, so it must be able to say the viewer is not involved at
 * all rather than inheriting the meaning of a query it never issued. A non-zero returned
 * reviewer vote is the only evidence of participation, and the native vote survives as a row
 * fact rather than becoming ABI vocabulary.
 */
function readViewerInvolvement(
  row: AzurePullRequestRow,
  viewerId: string,
): readonly AzureInvolvement[] {
  const wanted = viewerId.trim().toLowerCase();
  const involvement: AzureInvolvement[] = [];
  if ((row.createdBy?.id ?? '').trim().toLowerCase() === wanted) involvement.push('author');
  const reviewer = row.reviewers.find((entry) => entry.id.trim().toLowerCase() === wanted);
  if (reviewer !== undefined) {
    involvement.push(reviewer.vote === 0 ? 'reviewRequested' : 'participating');
  }
  return involvement;
}

/**
 * The repository and project a pull-request body names.
 *
 * The shared row decoder deliberately keeps only the repository GUID, because a scan already
 * holds the repository row it walked. An authoritative `get` has no such row, so it reads the
 * body's own nested scope here rather than widening the shared decoder for one caller.
 */
/**
 * The project and repository one pull-request body names.
 *
 * Exported because the detail planes need it too: a policy evaluation is a
 * PROJECT-scoped resource, so reading it requires the project this pull request
 * lives in, and that fact exists only in the pull-request body. One reader keeps
 * the two paths from disagreeing about what a malformed body is.
 */
export function readPullRequestScope(raw: unknown): Readonly<{
  repository: AzureRepositoryRow;
  projectId: string;
  projectName: string;
}> | null {
  const record = readRecord(raw);
  const repository = record === null ? null : readRecord(record.repository);
  if (repository === null) return null;
  const project = readRecord(repository.project);
  const repositoryId = readString(repository.id);
  const repositoryName = readString(repository.name);
  const projectId = project === null ? null : readString(project.id);
  const projectName = project === null ? null : readString(project.name);
  if (repositoryId === null || !isAzureGuid(repositoryId) || repositoryName === null) return null;
  if (projectId === null || !isAzureGuid(projectId) || projectName === null) return null;
  return {
    repository: {
      id: repositoryId.toLowerCase(),
      name: repositoryName,
      projectId: projectId.toLowerCase(),
      projectName,
      defaultBranch: readString(repository.defaultBranch),
      isDisabled: repository.isDisabled === true,
      webUrl: readAbsoluteRepositoryUrl(repository.webUrl),
    },
    projectId: projectId.toLowerCase(),
    projectName,
  };
}

function readAbsoluteRepositoryUrl(raw: unknown): string | null {
  const value = readString(raw);
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared invocation setup                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One authorized invocation's client plus the viewer it resolved.
 *
 * Exported so the detail planes reauthorize through the SAME rule `scan` and
 * `get` use rather than growing a second admission path.
 */
export type OpenedClient =
  | Readonly<{ ok: true; client: AzureDevOpsApiClient; viewerId: string }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/**
 * Reauthorize the exact configured account and resolve the viewer for one invocation.
 *
 * The viewer GUID is re-read from the provider on every invocation rather than carried in a
 * continuation: it is provider account identity, and `CONTRACT.md` §3.1 keeps account identity
 * out of paging tokens entirely.
 */
export type AuthorizedClient =
  | Readonly<{ ok: true; client: AzureDevOpsApiClient }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/**
 * Reauthorize the exact configured account and build one invocation's client.
 *
 * This is the one authorization owner. `openClient` adds the viewer read on top
 * of it for the paths that need provider account identity; a detail plane does
 * not, and paying for `connectionData` on every mounted panel read would spend a
 * provider request to learn a fact nothing on that path consumes.
 */
export async function authorizeClient(input: Readonly<{
  services: AzureTriageReadServices;
  instance: Readonly<{ binding: TriageSourceAccountBindingV1 }>;
  origin: AzureDevOpsOrigin;
  signal: AbortSignal;
}>): Promise<AuthorizedClient> {
  const authorization = await materializeAzureDevOpsListedAuthorization({
    connectedAccounts: input.services.connectedAccounts,
    purpose: input.instance.binding.purpose,
    account: input.instance.binding.account,
    origin: input.origin,
    signal: input.signal,
  });
  if (!authorization.ok) {
    return { ok: false, failure: projectAzureSourceFailure(authorization.failure) };
  }

  return {
    ok: true,
    client: createAzureDevOpsApiClient({
      origin: input.origin,
      authorization: authorization.authorization,
      transport: input.services.transport,
      now: input.services.now,
    }),
  };
}

export async function openClient(input: Readonly<{
  services: AzureTriageReadServices;
  instance: Readonly<{ binding: TriageSourceAccountBindingV1 }>;
  origin: AzureDevOpsOrigin;
  signal: AbortSignal;
}>): Promise<OpenedClient> {
  const authorized = await authorizeClient(input);
  if (!authorized.ok) return authorized;
  const { client } = authorized;

  const connection = await client.request({ route: { resource: 'connectionData' }, signal: input.signal });
  if (!connection.ok) return { ok: false, failure: projectAzureSourceFailure(connection.failure) };
  const connectionData = decodeAzureConnectionData(connection.body);
  if (connectionData === null) {
    return {
      ok: false,
      failure: createAzureSourceFailure({
        class: 'unsupportedContract',
        code: 'azure-devops/connection-data-unusable',
        detail: 'Azure DevOps did not return a usable authenticated identity.',
      }),
    };
  }
  return { ok: true, client, viewerId: connectionData.authenticatedUserId };
}

function undecodableConfiguration(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/configuration-undecodable',
    detail: 'This Azure DevOps configured-instance token was not produced by this source.',
  });
}

function malformedPullRequest(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/malformed-pull-request',
    detail: 'Azure DevOps returned a pull request this source could not route or map.',
  });
}
