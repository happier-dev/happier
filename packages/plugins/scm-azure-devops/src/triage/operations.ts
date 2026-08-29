import type {
  ConnectedAccountBindingSummary,
  ConnectedAccountListRequest,
  ConnectedAccountListedAccount,
  ConnectedAccountListedMaterializationRequest,
  ConnectedAccountMaterialization,
  ConnectedAccountMetadataList,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ActionsService,
  PluginActionInputById,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  type TriageGetInputV1,
  type TriageGetResultV1,
  type TriageListInstancesResultV1,
  type TriagePrepareReviewWorkspaceInputV1,
  type TriagePrepareReviewWorkspaceResultV1,
  type TriageScanInputV1,
  type TriageScanResultV1,
  type TriageSourceAccountBindingV1,
  type TriageSourceEntryLocalRefV1,
  type TriageSourceFailureV1,
  type TriageSourceInstanceDraftV1,
  type TriageSourceScanEvidenceV1,
  type TriageSourceScanObservationV1,
  type TriageVerifyReviewWorkspaceInputV1,
  type TriageVerifyReviewWorkspaceResultV1,
} from '@happier-dev/triage-protocol/v1';

import {
  readTriageSourceAccountListingV1,
  type TriageSourceAccountListingOutcomeV1,
} from '@happier-dev/triage-sources/runtime';

import { azureDevopsHostingProviderAdapter } from '../detection/adapter.js';
import { stripAzureBranchRef } from '../parsing/azureDevopsCoordinates.js';
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
import { classifyAzureDevOpsTransportFailure } from './failures.js';
import { isAzureGuid } from './identity.js';
import { matchesAzureEntryLocalRef, parseAzureEntryLocalRef } from './localRef.js';
import { mapAzurePullRequestEntry } from './mapping.js';
import { projectAzurePresentObservation } from './observation.js';
import {
  buildAzureRepositoryKey,
  normalizeAzureDevOpsBaseUrl,
  parseAzureRepositoryKey,
} from './origin.js';
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

function projectAzureAccountListingFailure(
  outcome: Extract<TriageSourceAccountListingOutcomeV1, Readonly<{ kind: 'failed' }>>,
  signal: AbortSignal,
): TriageSourceFailureV1 {
  if (outcome.reason === 'failed') {
    return createAzureSourceFailure({
      class: 'transient',
      code: 'azure-devops/account-listing-failed',
      detail: 'The Connected Accounts listing for Azure DevOps could not be read.',
    });
  }
  return projectAzureSourceFailure(classifyAzureDevOpsTransportFailure({
    error: outcome.error,
    signal: signal.aborted ? signal : AbortSignal.abort(outcome.error),
  }));
}

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
  /**
   * The listing half is not optional bookkeeping: `authorizeClient` re-confirms the exact
   * configured base against the account's own published bases before any request is authorized.
   * See `confirmAzureConfiguredBaseIsCurrent`.
   */
  connectedAccounts: AzureTriageAccountService;
  transport: AzureDevOpsHttpTransport;
  /** Injected clock. A provider retry deadline is the only absolute time this source produces. */
  now: () => number;
}>;

/** The one host-owned local-materialization capability this source consumes after its reread. */
export type AzureTriageReviewWorkspaceServices = AzureTriageReadServices & Readonly<{
  actions: Pick<ActionsService, 'execute'>;
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
      failure: projectAzureAccountListingFailure(outcome, input.signal),
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
      candidates.push(candidate.draft);
    }
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
  const requestedProjectTokens = new Set<string | null>();

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
        const requestedProjectToken = frontier.projectNextToken;
        if (requestedProjectTokens.has(requestedProjectToken)) {
          recordAzureWalkHealth(frontier, 'lane-unresolved');
          frontier.projectNextToken = null;
          return settle(state, frontier, 'finished', null);
        }
        requestedProjectTokens.add(requestedProjectToken);
        const projects = await readAzureProjectPage({
          client,
          continuationToken: requestedProjectToken,
          signal,
        });
        if (!projects.ok) return settle(state, frontier, 'failed', projectAzureSourceFailure(projects.failure));
        recordScopeOmission(frontier, projects.undecodable);
        if (
          requestedProjectToken !== null
          && projects.continuationToken === requestedProjectToken
        ) {
          // The provider repeated the exact position just consumed. Process this
          // response once, then settle partial instead of re-entering it forever.
          recordAzureWalkHealth(frontier, 'lane-unresolved');
          frontier.projectNextToken = null;
        } else {
          frontier.projectNextToken = projects.continuationToken;
        }
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

      // A continuation's lane offsets belong to `currentRepositoryId`, not to whatever happens
      // to sort first in a freshly enumerated repository array. A repository inserted before the
      // active one must wait for the next walk; adopting it here would reset the active offsets
      // and replay that repository from lane zero.
      const activeRepositoryId = frontier.currentRepositoryId;
      const next = activeRepositoryId === null
        ? repositories.repositories[0]
        : repositories.repositories.find((candidate) => candidate.id === activeRepositoryId);
      if (activeRepositoryId !== null && next === undefined) {
        // The offsets in this continuation address only the missing GUID. Advancing from that
        // immutable boundary keeps repositories inserted before it for the next fresh walk and
        // avoids replaying one of them from lane zero under somebody else's continuation.
        recordAzureWalkHealth(frontier, 'lane-unresolved');
        frontier.lastCompletedRepositoryId = activeRepositoryId;
        enterAzureRepository(frontier, null);
        continue;
      }
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
      top: frontier.scanLimit - frontier.observed,
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

  const entryIdentity = parseAzureEntryLocalRef(localRef, origin);
  if (entryIdentity === null) {
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
  const route = readAzurePullRequestLocatorRoute({
    origin,
    locator: request.lastKnownLocator,
    pullRequestId: entryIdentity.pullRequestId,
  });
  if (route === null) return { kind: 'unresolved', localRef, failure: unroutablePullRequest() };

  const client = await openClient({ services, instance: request.instance, origin, signal });
  if (!client.ok) return { kind: 'unresolved', localRef, failure: client.failure };

  return (await observeAzureEntry({
    client: client.client,
    viewerId: client.viewerId,
    origin,
    route,
    localRef,
    signal,
  })).observation;
}

/**
 * One authoritative observation of a single Azure pull request, given an authorized client.
 *
 * `get` publishes it as a Triage role; a mutation reaches it twice — once as the fresh pre-write
 * currentness proof and once as the confirming read that says what actually happened. All three
 * must agree about what "this pull request, as this viewer sees it" means, so there is one reader
 * rather than one per caller.
 *
 * The decoded row travels back beside the published observation because Azure's confirming read is
 * a **field-level comparison of the values we sent**, not a status check: a `PATCH` may silently
 * ignore a property it does not accept, and the observation deliberately does not expose `status`,
 * `mergeStatus`, `lastMergeCommit` or the completion options as separate fields. Reading the row a
 * second time to get them would be a second race.
 */
export type AzureEntryObservation = Readonly<{
  observation: TriageGetResultV1;
  /** `null` exactly when the observation is `unresolved`. */
  row: AzurePullRequestRow | null;
}>;

/** One exact provider reread, shared by observation and review-workspace preparation. */
export type AzurePullRequestReread =
  | Readonly<{
    kind: 'resolved';
    row: AzurePullRequestRow;
    scope: AzurePullRequestScope;
  }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'malformed' }>;

/** The source-private locator route used to address one Azure pull request. */
export type AzurePullRequestLocatorRoute = Readonly<{
  kind: 'locator';
  project: string;
  repositoryId: string;
  pullRequestId: number;
  routingToken: string;
}>;

/** The one reader accepts the route each operation's published contract authorizes. */
type AzurePullRequestRoute = AzurePullRequestLocatorRoute | Readonly<{
  kind: 'identity';
  repositoryId: string;
  pullRequestId: number;
}>;

/**
 * Decodes the newest source-minted locator into the provider route.
 *
 * A collision scope stays identity-only: its repository GUID is never substituted into this
 * route. It is checked after the provider returns its own immutable repository id below.
 */
export function readAzurePullRequestLocatorRoute(input: Readonly<{
  origin: AzureDevOpsOrigin;
  locator: TriageGetInputV1['lastKnownLocator'];
  pullRequestId: number;
}>): AzurePullRequestLocatorRoute | null {
  const routingToken = input.locator?.routingToken;
  if (routingToken === undefined) return null;
  const repository = parseAzureRepositoryKey({ origin: input.origin, repositoryKey: routingToken });
  if (repository === null) return null;
  return {
    kind: 'locator',
    project: repository.projectName,
    repositoryId: repository.repositoryName,
    pullRequestId: input.pullRequestId,
    routingToken,
  };
}

export async function rereadAzurePullRequest(input: Readonly<{
  client: AzureDevOpsApiClient;
  origin: AzureDevOpsOrigin;
  localRef: TriageSourceEntryLocalRefV1;
  route: AzurePullRequestRoute;
  signal: AbortSignal;
}>): Promise<AzurePullRequestReread> {
  const response = await input.client.request({
    // This source's opaque locator is the only route input. Its current project/repository names
    // reach Azure here; the existing mutation path carries an already validated immutable address.
    // In both cases the public collision scope is checked only against the returned GUID.
    route: {
      resource: 'pullRequest',
      ...(input.route.kind === 'locator' ? { project: input.route.project } : {}),
      repositoryId: input.route.repositoryId,
      pullRequestId: input.route.pullRequestId,
    },
    signal: input.signal,
  });
  if (!response.ok) return { kind: 'unavailable', failure: projectAzureSourceFailure(response.failure) };

  const row = decodeAzurePullRequestRow(response.body);
  const scope = readPullRequestScope(response.body);
  if (row === null || scope === null) return { kind: 'malformed' };
  const returnedRoutingToken = input.route.kind !== 'locator' ? null : buildAzureRepositoryKey({
    organizationOrCollection: input.origin.organizationOrCollection,
    forgeHostId: input.origin.forgeHostId,
    projectName: scope.projectName,
    repositoryName: scope.repository.name,
  });
  if (
    row.repositoryId !== scope.repository.id
    || row.pullRequestId !== input.route.pullRequestId
    || (input.route.kind === 'identity' && row.repositoryId !== input.route.repositoryId)
    || (input.route.kind === 'locator' && returnedRoutingToken !== input.route.routingToken)
    || !matchesAzureEntryLocalRef({
      localRef: input.localRef,
      origin: input.origin,
      repositoryId: row.repositoryId,
      pullRequestId: row.pullRequestId,
    })
  ) {
    // A stale locator or body that names another repository/number is never a redirect.
    return { kind: 'malformed' };
  }
  return { kind: 'resolved', row, scope };
}

export async function observeAzureEntry(input: Readonly<{
  client: AzureDevOpsApiClient;
  viewerId: string;
  origin: AzureDevOpsOrigin;
  route: AzurePullRequestRoute;
  localRef: TriageGetInputV1['localRef'];
  signal: AbortSignal;
}>): Promise<AzureEntryObservation> {
  const { localRef, origin, viewerId } = input;
  const unresolved = (failure: TriageSourceFailureV1): AzureEntryObservation => ({
    observation: { kind: 'unresolved', localRef, failure },
    row: null,
  });

  const reread = await rereadAzurePullRequest({
    client: input.client,
    origin,
    localRef,
    route: input.route,
    signal: input.signal,
  });
  if (reread.kind === 'unavailable') return unresolved(reread.failure);
  if (reread.kind === 'malformed') return unresolved(malformedPullRequest());
  const { row, scope } = reread;

  const involvement = readViewerInvolvement(row, viewerId);
  const entry = mapAzurePullRequestEntry({
    origin,
    project: { id: scope.projectId, name: scope.projectName, state: null },
    repository: scope.repository,
    row,
    lane: involvement.includes('author') ? 'authored' : 'reviewer',
    viewerId,
  });
  if (entry === null) return unresolved(malformedPullRequest());

  const observation = projectAzurePresentObservation({ entry, involvement });
  if (observation.kind !== 'present') return unresolved(malformedPullRequest());
  // The result's ref must equal the exact input ref; a different one is invalid, not a redirect.
  return { observation: { ...observation, localRef }, row };
}

/* -------------------------------------------------------------------------- */
/* prepareReviewWorkspace                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Prepare the one user-selected root for the exact provider-authoritative Azure source tip.
 *
 * The source owns every precondition up to the generic SCM Action: decoding its configured
 * instance, validating the source-local ref, reauthorizing that exact account, rereading that
 * exact pull request, and comparing the observed base/head/native revision. The generic Action
 * owns only selected-root SCM resolution, remote matching, Git mutation, and local currentness.
 */
export async function runAzureTriagePrepareReviewWorkspace(input: Readonly<{
  services: AzureTriageReviewWorkspaceServices;
  request: TriagePrepareReviewWorkspaceInputV1;
  signal: AbortSignal;
}>): Promise<TriagePrepareReviewWorkspaceResultV1> {
  const { request } = input;
  // There is no inferred/default root. This return happens before either provider authorization or
  // the generic materializer, so a missing selection cannot become a filesystem probe.
  if (request.workspace === undefined) return { kind: 'workspaceRequired' };

  const proof = await readCurrentAzureReviewWorkspaceProviderProof({
    services: input.services,
    request,
    signal: input.signal,
  });
  if (proof.kind !== 'current') return proof;

  const materialized = await executeAzureReviewWorkspaceScmAction({
    actions: input.services.actions,
    request: {
      cwd: request.workspace.rootPath,
      displayName: proof.sourceTip.branch,
      sourceTip: proof.sourceTip,
    },
    signal: input.signal,
  });
  if (materialized === null) return { kind: 'unavailable', reason: 'scmResolver' };
  if (!materialized.success) {
    // These codes mean the selected root was not a usable repository or lacks the matched remote.
    // Other generic SCM failures have no source-specific interpretation and remain an SCM resolver
    // unavailability rather than a provider-level retry or a local fallback.
    if (
      materialized.errorCode === 'NOT_REPOSITORY'
      || materialized.errorCode === 'INVALID_PATH'
      || materialized.errorCode === 'REMOTE_NOT_FOUND'
    ) {
      return { kind: 'workspaceMismatch' };
    }
    return { kind: 'unavailable', reason: 'scmResolver' };
  }
  if ('verification' in materialized) {
    return { kind: 'unavailable', reason: 'scmResolver' };
  }
  return {
    kind: 'prepared',
    repositoryPath: materialized.targetPath,
    branch: materialized.branchName,
    created: materialized.created,
    currentness: materialized.currentness,
    // Transport only the canonical SCM reference from the authoritative reread;
    // Triage remains opaque to its grammar.
    pullRequest: { number: proof.row.pullRequestId },
  };
}

type AzureReviewWorkspaceProviderProof =
  | Readonly<{
    kind: 'current';
    row: AzurePullRequestRow;
    sourceTip: AzurePreparedSourceTip;
  }>
  | Extract<
    TriagePrepareReviewWorkspaceResultV1,
    Readonly<{ kind: 'unavailable' | 'refused' }>
  >;

/**
 * The sole provider-currentness proof shared by preparation and final review start.
 *
 * Both callers reauthorize the same configured account, decode the same source-local identity and
 * locator, and require the same base/head/native revision. Keeping that sequence here prevents the
 * final verifier from becoming a weaker, similar-but-different reread of the provider.
 */
async function readCurrentAzureReviewWorkspaceProviderProof(input: Readonly<{
  services: AzureTriageReadServices;
  request: Pick<
    TriagePrepareReviewWorkspaceInputV1,
    'instance' | 'entryRef' | 'lastKnownLocator' | 'observed'
  >;
  signal: AbortSignal;
}>): Promise<AzureReviewWorkspaceProviderProof> {
  const { request } = input;

  const origin = resolveAzureConfiguredOrigin(request.instance.configuration);
  if (origin === null) return { kind: 'refused', reason: 'instanceMoved' };

  const localRef: TriageSourceEntryLocalRefV1 = {
    kindId: request.entryRef.kindId,
    collisionScope: request.entryRef.collisionScope,
    entryId: request.entryRef.entryId,
  };
  const entryIdentity = parseAzureEntryLocalRef(localRef, origin);
  if (entryIdentity === null) return { kind: 'refused', reason: 'pullRequestMoved' };
  const route = readAzurePullRequestLocatorRoute({
    origin,
    locator: request.lastKnownLocator,
    pullRequestId: entryIdentity.pullRequestId,
  });
  if (route === null) return { kind: 'refused', reason: 'pullRequestMoved' };

  const authorized = await authorizeClient({
    services: input.services,
    instance: request.instance,
    origin,
    signal: input.signal,
  });
  if (!authorized.ok) return { kind: 'unavailable', reason: 'account' };

  const reread = await rereadAzurePullRequest({
    client: authorized.client,
    origin,
    localRef,
    route,
    signal: input.signal,
  });
  if (reread.kind === 'unavailable') return { kind: 'unavailable', reason: 'account' };
  if (reread.kind === 'malformed') return { kind: 'refused', reason: 'pullRequestMoved' };

  const { row } = reread;
  if (!sameAzureRevision(row.lastMergeTargetCommitId, request.observed.baseSha)) {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }
  if (
    !sameAzureRevision(row.lastMergeSourceCommitId, request.observed.headSha)
    || !sameAzureRevision(row.lastMergeSourceCommitId, request.observed.nativeRevision)
  ) {
    return { kind: 'refused', reason: 'observedHeadMoved' };
  }

  const sourceTip = readAzurePreparedSourceTip(row);
  if (sourceTip === null) return { kind: 'refused', reason: 'pullRequestMoved' };

  return { kind: 'current', row, sourceTip };
}

/**
 * Final provider and local-workspace verification immediately before `review.start`.
 *
 * The provider reread is authoritative for the PR and its base/head/native revision. The existing
 * generic SCM materialization Action owns repository matching and local HEAD inspection; its
 * verification arm is read-only and must return the exact target and source head it resolved.
 */
export async function runAzureTriageVerifyReviewWorkspace(input: Readonly<{
  services: AzureTriageReviewWorkspaceServices;
  request: TriageVerifyReviewWorkspaceInputV1;
  signal: AbortSignal;
}>): Promise<TriageVerifyReviewWorkspaceResultV1> {
  const { request } = input;
  const proof = await readCurrentAzureReviewWorkspaceProviderProof({
    services: input.services,
    request,
    signal: input.signal,
  });
  if (proof.kind !== 'current') return proof;
  const pullRequest = { number: proof.row.pullRequestId };
  if (!pluginJsonValuesEqual(request.prepared.pullRequest, pullRequest)) {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }

  const verified = await executeAzureReviewWorkspaceScmAction({
    actions: input.services.actions,
    request: {
      cwd: request.workspace.rootPath,
      displayName: proof.sourceTip.branch,
      sourceTip: proof.sourceTip,
      verification: { targetPath: request.prepared.repositoryPath },
    },
    signal: input.signal,
  });
  if (verified === null) return { kind: 'unavailable', reason: 'scmResolver' };
  if (!verified.success) {
    if (
      verified.errorCode === 'NOT_REPOSITORY'
      || verified.errorCode === 'INVALID_PATH'
      || verified.errorCode === 'REMOTE_NOT_FOUND'
    ) {
      return { kind: 'workspaceMismatch' };
    }
    return { kind: 'unavailable', reason: 'scmResolver' };
  }
  if (!('verification' in verified)) {
    return { kind: 'unavailable', reason: 'scmResolver' };
  }
  if (verified.verification.targetPath !== request.prepared.repositoryPath) {
    return { kind: 'workspaceMismatch' };
  }
  if (!sameAzureRevision(verified.verification.sourceHeadSha, proof.sourceTip.sourceHeadSha)) {
    return { kind: 'refused', reason: 'observedHeadMoved' };
  }
  return { kind: 'verified', pullRequest };
}

/** Azure commit identifiers are case-insensitive hexadecimal values. */
function sameAzureRevision(current: string | null, observed: string): boolean {
  return current !== null && current.toLowerCase() === observed.trim().toLowerCase();
}

/**
 * Build the generic SCM checkout authority from Azure's editable source facts only.
 *
 * `repository` on a pull request is the target repository. Azure exposes a fork separately, and
 * the source decoder intentionally gives it precedence over `sourceRepository`; this function
 * never looks at the target-side row or at a generated pull-request merge ref.
 */
type AzurePreparedSourceTip = PluginActionInputById[
  'scm.reviewWorkspace.materializePrepared'
]['sourceTip'];

/**
 * The one failure/cancellation boundary for the generic SCM Action used by both preparation and
 * final verification. A transport rejection is typed source unavailability; cancellation keeps
 * the caller's abort reason and is never converted into a retryable provider result.
 */
async function executeAzureReviewWorkspaceScmAction(input: Readonly<{
  actions: Pick<ActionsService, 'execute'>;
  request: PluginActionInputById['scm.reviewWorkspace.materializePrepared'];
  signal: AbortSignal;
}>): Promise<PluginActionResultById['scm.reviewWorkspace.materializePrepared'] | null> {
  try {
    const result = await input.actions.execute(
      'scm.reviewWorkspace.materializePrepared',
      input.request,
      { signal: input.signal },
    );
    input.signal.throwIfAborted();
    return result;
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return null;
  }
}

function readAzurePreparedSourceTip(row: AzurePullRequestRow): AzurePreparedSourceTip | null {
  const cloneUrl = row.sourceRepositoryCloneUrl;
  const fetchRef = row.sourceRefName;
  if (cloneUrl === null || fetchRef === null || !fetchRef.startsWith('refs/heads/')) return null;

  const branch = stripAzureBranchRef(fetchRef);
  if (branch === null || branch.length === 0) return null;
  const sourceHeadSha = row.lastMergeSourceCommitId;
  if (sourceHeadSha === null || !/^[0-9a-fA-F]{7,64}$/u.test(sourceHeadSha)) return null;

  // This is the Azure plugin's own canonical remote parser, not an SCM provider registry or a
  // default clone lookup. It keeps Services, legacy and Server clone URLs aligned with detection.
  const repository = azureDevopsHostingProviderAdapter.detectRemote({ remoteName: null, remoteUrl: cloneUrl });
  if (repository === null || repository.kind !== 'azure-devops' || repository.nameWithOwner === undefined) {
    return null;
  }

  return {
    repository: {
      kind: 'azure-devops',
      deployment: repository.baseUrl,
      repository: repository.nameWithOwner,
    },
    cloneUrl,
    branch,
    sourceHeadSha: sourceHeadSha.toLowerCase(),
    fetchRef,
  };
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
export type AzurePullRequestScope = Readonly<{
  repository: AzureRepositoryRow;
  projectId: string;
  projectName: string;
}>;

export function readPullRequestScope(raw: unknown): AzurePullRequestScope | null {
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
 * The exact configured base, re-confirmed against the account that publishes it.
 *
 * A credential is minted for an **origin**, because that is the only thing HostAccess admits and
 * the only shape the materialization request carries. Every Azure DevOps Services organization
 * shares the single origin `https://dev.azure.com`, so origin admission alone cannot tell an
 * account configured for `…/orgA` from that same account reconnected to `…/orgB`. Without this
 * gate a configured instance minted before such a move keeps routing org-A paths and authorizing
 * them with org-B's credential — the account was never asked whether org A is still its
 * deployment, because nothing after discovery ever looked at the path again.
 *
 * So the configured base — the whole base, path included, exactly as `listInstances` recorded it —
 * is compared against the account's own currently published `connectedAccountBases` before any
 * request is authorized. The comparison is byte-for-byte because both sides come from the same
 * host normalizer, and a collection path is case-significant.
 *
 * The three outcomes are deliberately distinct: a listing that could not be read is `transient`
 * and says nothing about the configuration; an account that is gone is `authentication` and asks
 * the user to reconnect; a base the account no longer publishes is `unsupportedContract` and asks
 * them to reconfigure the instance. Reporting any of these as another would send somebody to the
 * wrong screen.
 */
async function confirmAzureConfiguredBaseIsCurrent(input: Readonly<{
  connectedAccounts: Pick<AzureTriageAccountService, 'listAccounts' | 'getBinding'>;
  binding: TriageSourceAccountBindingV1;
  origin: AzureDevOpsOrigin;
  signal: AbortSignal;
}>): Promise<TriageSourceFailureV1 | null> {
  const outcome = await readTriageSourceAccountListingV1({
    connectedAccounts: input.connectedAccounts,
    purpose: input.binding.purpose,
    signal: input.signal,
  });
  if (outcome.kind === 'failed') {
    // An abort is not a listing that refused. This gate runs FIRST on every read, so
    // classifying its own deadline or its own caller cancellation as a generic listing
    // failure would erase the one distinction `isAzureDevOpsDeadlineAbort` exists to
    // preserve — a mount that went away versus a provider still owing an answer — for
    // every detail and scan read in the vertical. It is deferred to the same abort owner
    // every other request already uses rather than decided a second time here.
    return projectAzureAccountListingFailure(outcome, input.signal);
  }
  const accounts = outcome.kind === 'unbound' ? [] : outcome.listing.accounts;
  const listed = accounts.find((candidate) => (
    candidate.account.accountId === input.binding.account.accountId
    && candidate.account.service.pluginId === input.binding.account.service.pluginId
    && candidate.account.service.localId === input.binding.account.service.localId
  ));
  if (listed === undefined) {
    if (outcome.kind === 'listed' && outcome.listing.status === 'truncated') {
      return createAzureSourceFailure({
        class: 'transient',
        code: 'azure-devops/configured-account-listing-truncated',
        detail: 'The Connected Accounts listing ended before this configured Azure DevOps account could be confirmed.',
      });
    }
    return createAzureSourceFailure({
      class: 'authentication',
      code: 'azure-devops/configured-account-unavailable',
      detail: 'The Azure DevOps account this configured instance is bound to is no longer connected.',
    });
  }
  if (!listed.connectedAccountBases.includes(input.origin.baseUrl)) {
    return createAzureSourceFailure({
      class: 'unsupportedContract',
      code: 'azure-devops/configured-base-stale',
      detail: 'This Azure DevOps account no longer publishes the organization or collection this configured instance reads.',
    });
  }
  return null;
}

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
  const stale = await confirmAzureConfiguredBaseIsCurrent({
    connectedAccounts: input.services.connectedAccounts,
    binding: input.instance.binding,
    origin: input.origin,
    signal: input.signal,
  });
  if (stale !== null) return { ok: false, failure: stale };

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

  // Credential materialization is an awaited authority boundary. Azure
  // Services accounts share one bare origin while their configured base owns
  // the organization path, so the host's origin reauthorization cannot detect
  // an account retarget from org A to org B during that await. Reconfirm the
  // exact base before the newly minted credential can reach any provider path.
  const retargeted = await confirmAzureConfiguredBaseIsCurrent({
    connectedAccounts: input.services.connectedAccounts,
    binding: input.instance.binding,
    origin: input.origin,
    signal: input.signal,
  });
  if (retargeted !== null) return { ok: false, failure: retargeted };

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

function unroutablePullRequest(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/pull-request-route-unavailable',
    detail: 'This Azure DevOps pull request has no usable retained source route.',
  });
}
