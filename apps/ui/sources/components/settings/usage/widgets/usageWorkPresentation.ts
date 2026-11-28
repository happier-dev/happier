import { addUsageCostForMode, addUsageMeasuredTokens, aggregateUsageContributionCosts, compareUsageMeasurementsDescending, createEmptyUsageCost, createEmptyUsageTokens } from '@happier-dev/protocol/usage/usageAggregation';
import type { UsageAnalyticsTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import type { RepositoryCheckpointCommitEvidence } from '@happier-dev/protocol/sessions/changes/types';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice, UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';
import { usageSourceTitle } from '@/sync/domains/usage/usageLabels';
import { getPreferredLanguage, t } from '@/text';
import {
  UsageWorkProjectionSchema,
  type UsageWorkAllocation as UsageWorkAllocationRef,
  type UsageWorkContribution,
  type UsageWorkProjection as UsageWorkAllocationGraph,
} from '@happier-dev/protocol/usage/usageOutcomeAllocation';

type UsageWorkAllocation = UsageWorkAllocationRef & { contribution: UsageWorkContribution };
type UsageWorkBranchAllocation = UsageWorkAllocationGraph['branchAllocations'][number] & { contribution: UsageWorkContribution };
type UsageWorkProjection = Omit<UsageWorkAllocationGraph, 'allocations' | 'branchAllocations'> & {
  allocations: UsageWorkAllocation[];
  branchAllocations: UsageWorkBranchAllocation[];
};

function readUsageWorkAllocations(work: UsageWorkAllocationGraph, contributions: readonly UsageWorkContribution[]): UsageWorkProjection {
  // The admitted Work arrays conserve accounting order. Join bodies only for
  // the display computation, without putting their copies on the wire.
  return {
    ...work,
    allocations: work.allocations.map((row, index) => ({ ...row, contribution: contributions[index]! })),
    branchAllocations: work.branchAllocations.map((row, index) => ({ ...row, contribution: contributions[index]! })),
  };
}

type UsageWorkOutcome = NonNullable<UsageWorkAllocation['outcome']>;
type UsageWorkBranch = NonNullable<UsageWorkProjection['branchAllocations'][number]['branch']>;

/**
 * Display grouping of U7's canonical allocation. It never reallocates: every row sums the exact
 * per-contribution amounts the projection already assigned (or left unallocated), so the
 * allocated and unallocated parts always add back to the admitted total, per metric and basis.
 */
export type UsageWorkAmount = Readonly<{
  metric: UsageQuery['metric'];
  costBasis: UsageQuery['costBasis'];
}>;
export type UsageWorkUnallocatedReason = Exclude<
  UsageWorkAllocation['reason'],
  'allocated'
>;

export const USAGE_WORK_UNALLOCATED_REASONS = UsageWorkProjectionSchema.shape.allocations._zod.def.element
  .shape.reason.options.filter(reason => reason !== 'allocated');

export function usageWorkAllocationReasonLabel(reason: UsageWorkUnallocatedReason | 'missing_pr'): string {
  return t(`usage.board.work.reason_${reason}`);
}

export function usageWorkPageReadLabel(state: 'partial' | 'unavailable'): string {
  return t(state === 'partial' ? 'usage.board.charts.coveragePartialShort' : 'usage.board.page.notReadTitle');
}

export function usageWorkContributionAmount(
  allocation: Pick<UsageWorkAllocation, 'contribution'>,
  basis: UsageWorkAmount,
): number | null {
  const contribution = allocation.contribution;
  return basis.metric === 'cost'
    ? resolveUsageCostBasis(contribution.cost, basis.costBasis)?.amountUsd ?? null
    : resolveUsageMeasuredTokens(contribution.tokens).total;
}

export type UsageWorkProvider = Readonly<{ providerId: string; machineId: string | null }>;
export type UsageWorkMoneyBasis = Pick<NonNullable<ReturnType<typeof resolveUsageCostBasis>>, 'kind' | 'currency'>;
type MoneyDisplay = Readonly<{ moneyBasis: UsageWorkMoneyBasis | null; tokensFromParts?: boolean }>;
/** One Session's exact part of a row: the sum of only the contributions that row counts. */
export type UsageWorkSessionPart = MoneyDisplay & Readonly<{ sessionId: string; amount: number | null }>;
/** Who a row's contributions were witnessed with. An Agent never implies a Provider. */
export type UsageWorkIdentities = Readonly<{
  agentIds: readonly string[];
  providers: readonly UsageWorkProvider[];
  /** At least one contribution carries no admitted Provider binding. */
}>;

export type UsageWorkOutcomeRow = UsageWorkIdentities & MoneyDisplay & Readonly<{
  key: string;
  outcome: UsageWorkOutcome;
  amount: number | null;
  sessionIds: readonly string[];
  sessions: readonly UsageWorkSessionPart[];
  projectKeys: readonly (string | null)[];
}>;

export type UsageWorkBranchRow = UsageWorkIdentities & MoneyDisplay & Readonly<{
  branch: UsageWorkBranch;
  amount: number | null;
  sessionIds: readonly string[];
  sessions: readonly UsageWorkSessionPart[];
  projectKeys: readonly (string | null)[];
  /** Distinct witnessed commits, in first-witnessed order. */
  commits: readonly string[];
  /** The plain mean of this row's exact amount over its Sessions; unknown stays unknown. */
  perSession: number | null;
  retainedChanges: readonly UsageWorkRetainedChange[];
  linkedPullRequests: readonly ScmPullRequestSummary[];
}>;

export type UsageWorkProjectRow = MoneyDisplay & Readonly<{
  projectKey: string | null;
  /** Distinct unnamed folders represented by the single null-key display row. */
  unnamedProjectCount: number;
  amount: number | null;
  allocated: number | null;
  unallocated: number | null;
  allocatedBasis: UsageWorkMoneyBasis | null;
  unallocatedBasis: UsageWorkMoneyBasis | null;
  sessionIds: readonly string[];
  /** Machines that contributed to this project, in id order; what tells same-named folders on two machines apart. */
  machineIds: readonly string[];
  agentIds: readonly string[];
  providers: readonly UsageWorkProvider[];
  outcomes: readonly UsageWorkOutcomeRow[];
  /** Each Session's part of this project, largest first. */
  sessions: readonly UsageWorkSessionPart[];
  /** Branches witnessed for this project's contributions, counting only those contributions. */
  branches: readonly UsageWorkBranchRow[];
}>;

export type UsageWorkSessionRow = MoneyDisplay & Readonly<{
  sessionId: string;
  /** Machines the Session's usage came from, in id order, and when it was last observed: what tells untitled Sessions apart. */
  machineIds: readonly string[];
  lastObservedAtMs: number;
  amount: number | null;
  agentIds: readonly string[];
  providers: readonly UsageWorkProvider[];
  /** Distinct exactly-allocated outcomes; ambiguous or missing links are not counted as outcomes. */
  outcomes: readonly UsageWorkOutcome[];
  /** Any witnessed PR evidence, even when the amount stayed unallocated. */
  witnessed: boolean;
  unallocatedReasons: readonly UsageWorkUnallocatedReason[];
}>;

export type UsageWorkSessionIdentity = Pick<UsageWorkSessionRow, 'sessionId' | 'machineIds' | 'lastObservedAtMs'>;
type SessionIdentityAccumulator = { machines: Set<string>; lastObservedAtMs: number };

function recordSessionIdentity(target: SessionIdentityAccumulator, contribution: UsageWorkAllocation['contribution']): void {
  if (contribution.machineId) target.machines.add(contribution.machineId);
  target.lastObservedAtMs = Math.max(target.lastObservedAtMs, contribution.observedAtMs);
}

function sessionIdentity(sessionId: string, row: SessionIdentityAccumulator): UsageWorkSessionIdentity {
  return { sessionId, machineIds: sorted(row.machines), lastObservedAtMs: row.lastObservedAtMs };
}

type UsageWorkOutcomesPresentation = Readonly<{ kind: 'ready' }> | Readonly<{
  kind: 'reading' | 'partial' | 'unavailable' | 'empty' | 'noPrs';
  sessions: readonly UsageWorkSessionIdentity[];
  machineIds: readonly string[];
}>;

type UsageWorkEvidence = 'observed' | 'reading' | 'partial' | 'unavailable';
type UsageWorkProjectionKey = 'work' | 'mergedOutcomes';

function readUsageWorkEvidence(
  slice: UsageQueryResultSlice, projection: UsageWorkProjectionKey, source: UsageQuerySourceState | undefined,
): UsageWorkEvidence {
  // The query projection decides whether an empty result was observed.
  if (slice[projection] !== undefined && slice.workSummary?.pullRequestsRead === true) return 'observed';
  if (source?.status === 'pending' || source?.status === 'not_loaded') return 'reading';
  // Partial Work can settle a subset while an unread Session still has a retryable failure.
  return source?.status === 'partial' ? 'partial' : 'unavailable';
}

export function readUsageWorkOutcomesEvidence(slice: UsageQueryResultSlice, projection: UsageWorkProjectionKey): UsageWorkEvidence {
  return readUsageWorkEvidence(slice, projection, slice.sources.find(row => row.source === 'work'));
}

type UsageWorkUnreadCause = Readonly<{ kind: 'unreachable' | 'unread'; count: number | null }>;
type UsageWorkCause = UsageWorkUnreadCause | Readonly<{ kind: 'allocation'; reason: UsageWorkUnallocatedReason }>;

function readUsageWorkUnreadCauses(source: UsageQuerySourceState | undefined): UsageWorkUnreadCause[] {
  const unread = source?.unreadSessions ?? {};
  const other = (unread.not_entitled ?? 0) + (unread.timed_out ?? 0) + (unread.failed ?? 0);
  const causes: UsageWorkUnreadCause[] = [];
  if (unread.machine_unavailable || source?.errorCode === 'machine_offline') {
    causes.push({ kind: 'unreachable', count: unread.machine_unavailable ?? null });
  }
  if (other > 0) causes.push({ kind: 'unread', count: other });
  return causes;
}

export function usageWorkCauseLabel(cause: UsageWorkCause): string {
  if (cause.kind === 'allocation') return usageWorkAllocationReasonLabel(cause.reason);
  if (cause.count === null) {
    return t(cause.kind === 'unreachable' ? 'usage.board.work.workUnreadUnreachableSome' : 'usage.board.work.workUnreadOtherSome');
  }
  return t(cause.kind === 'unreachable' ? 'usage.board.work.workUnreadUnreachable' : 'usage.board.work.workUnreadOther', {
    count: cause.count,
    formattedCount: cause.count.toLocaleString(getPreferredLanguage()),
  });
}

// The Resource retains unchanged allocation identities through sibling publications.
const reasonsByAllocation = new WeakMap<UsageWorkAllocationGraph['allocations'], readonly UsageWorkUnallocatedReason[]>();

function readUsageWorkAllocationReasons(
  slice: UsageQueryResultSlice, source: UsageQuerySourceState | undefined, state: UsageWorkEvidence,
): readonly UsageWorkUnallocatedReason[] {
  if (!slice.work || slice.work.outcomes.length > 0) return [];
  const { allocations } = slice.work;
  let reasons = reasonsByAllocation.get(allocations);
  if (!reasons) {
    const present = new Set<UsageWorkAllocationRef['reason']>();
    for (const row of allocations) present.add(row.reason);
    reasons = USAGE_WORK_UNALLOCATED_REASONS.filter(reason => present.has(reason));
    reasonsByAllocation.set(allocations, reasons);
  }
  // An empty witness set also comes from reads that could not run.
  return state === 'observed' || source?.status === 'available' ? reasons : reasons.filter(reason => reason !== 'missing_evidence');
}

/** Name known Work gaps while reading, and allocation reasons once the read settles. */
export function usageWorkLinksNotice(slice: UsageQueryResultSlice): Readonly<{
  state: UsageWorkEvidence;
  title: string;
  cause: string | null;
  progress?: true;
}> {
  const source = slice.sources.find(row => row.source === 'work');
  const state = readUsageWorkEvidence(slice, 'work', source);
  const unreadCauses = readUsageWorkUnreadCauses(source).map(usageWorkCauseLabel);
  if (state === 'reading') {
    if (source?.status === 'pending' && (unreadCauses.length || slice.work?.outcomes.length || slice.work?.branches.length)) {
      return { state, title: t('usage.board.page.coveragePending', { sources: usageSourceTitle('work') }),
        cause: unreadCauses.join(' · ') || null, progress: true };
    }
    return { state, title: t('usage.board.work.workUnavailableTitle'), cause: null };
  }
  const failed = source?.status === 'error' || source?.status === 'stale' || source?.status === 'unsupported'
    || source?.errorCode !== undefined || source?.unreadSessions !== undefined;
  const title = state === 'partial' ? t('usage.board.work.workPartialTitle')
    : failed ? t('usage.board.page.workNotRead') : t('usage.board.work.notLinked');
  const causes = unreadCauses.concat(readUsageWorkAllocationReasons(slice, source, state).map(usageWorkAllocationReasonLabel));
  return { state, title, cause: causes.join(' · ') || null };
}

/** The page Details says the settled Work gaps that cards abbreviate. */
export function readUsagePageWorkCauses(slices: readonly UsageQueryResultSlice[]): UsageWorkCause[] {
  const unreadCauses = new Map<UsageWorkUnreadCause['kind'], UsageWorkUnreadCause>();
  const reasons = new Set<UsageWorkUnallocatedReason>();
  let scopes = 0;
  for (const slice of slices) {
    if (!slice.requestedQuery.includeWorkEvidence) continue;
    const source = slice.sources.find(row => row.source === 'work');
    if (!source) continue;
    scopes++;
    const state = readUsageWorkEvidence(slice, 'work', source);
    if (state === 'reading' || (state === 'observed' && source.status === 'available')) continue;
    for (const cause of readUsageWorkUnreadCauses(source)) unreadCauses.set(cause.kind, cause);
    for (const reason of readUsageWorkAllocationReasons(slice, source, state)) reasons.add(reason);
  }
  // The batch carries counts scoped to each query, with no Session identities for a page-wide total.
  return [
    ...Array.from(unreadCauses.values(), cause => scopes === 1 ? cause : { ...cause, count: null }),
    ...USAGE_WORK_UNALLOCATED_REASONS.filter(reason => reasons.has(reason))
      .map(reason => ({ kind: 'allocation' as const, reason })),
  ];
}

/** Empty Outcomes consumes identities and evidence, never monetary or Project detail. */
export function readUsageWorkOutcomesPresentation(slice: UsageQueryResultSlice): UsageWorkOutcomesPresentation {
  const { work } = slice;
  const contributions = slice.accounting?.contributions;
  const evidence = readUsageWorkOutcomesEvidence(slice, 'work');
  if (!work || !contributions) return { kind: evidence === 'observed' ? 'unavailable' : evidence, sessions: [], machineIds: [] };
  const sessions = new Map<string, SessionIdentityAccumulator>();
  const machineIds = new Set<string>();
  let allocatedOutcome = false;
  let witnessed = false;
  for (const [index, row] of work.allocations.entries()) {
    const contribution = contributions[index]!;
    if (contribution.machineId) machineIds.add(contribution.machineId);
    if (contribution.sessionId) {
      const identity = sessions.get(contribution.sessionId) ?? { machines: new Set<string>(), lastObservedAtMs: 0 };
      recordSessionIdentity(identity, contribution);
      sessions.set(contribution.sessionId, identity);
      witnessed ||= row.evidence.length > 0;
    }
    allocatedOutcome ||= row.reason === 'allocated' && !!row.outcome;
    if (sessions.size > 0 && (allocatedOutcome || (evidence === 'observed' && witnessed))) return { kind: 'ready' };
  }
  return { kind: evidence !== 'observed' ? evidence : sessions.size === 0 ? 'empty' : 'noPrs',
    // Empty presentations have no monetary ordering; retain first-observed Session identity order.
    sessions: [...sessions].map(([id, identity]) => sessionIdentity(id, identity)), machineIds: [...machineIds] };
}

export type UsageWorkSummary = MoneyDisplay & Readonly<{
  total: number | null;
  allocated: number | null;
  missingMoneyCount: number;
  unallocated: number | null;
  allocatedBasis: UsageWorkMoneyBasis | null;
  unallocatedBasis: UsageWorkMoneyBasis | null;
  unallocatedReasonBases: Readonly<Record<UsageWorkUnallocatedReason, UsageWorkMoneyBasis | null>>;
  unallocatedByReason: Readonly<Record<UsageWorkUnallocatedReason, number | null>>;
  outcomes: readonly UsageWorkOutcomeRow[];
  branches: readonly UsageWorkBranchRow[];
  projects: readonly UsageWorkProjectRow[];
  sessions: readonly UsageWorkSessionRow[];
  /** Agents by their exact amount, largest first (the scatter's identity slots). */
  agents: readonly (MoneyDisplay & Readonly<{ agentId: string; amount: number | null }>)[];
  funnel: Readonly<{
    sessions: number;
    witnessed: number;
    allocated: number;
  }>;
}>;

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const byAmount = <T extends { amount: number | null }>(left: T, right: T) =>
  compareUsageMeasurementsDescending(left.amount, right.amount);
type AmountAccumulator = { amount: number | null;
  contributions?: UsageWorkAllocation['contribution'][]; moneyBasis: UsageWorkMoneyBasis | null; tokensFromParts: boolean };
const newAmount = (): AmountAccumulator => ({ amount: 0, moneyBasis: null, tokensFromParts: false });
function accumulate(target: AmountAccumulator, allocation: Pick<UsageWorkAllocation, 'contribution'>, basis: UsageWorkAmount): void {
  (target.contributions ??= []).push(allocation.contribution);
}

function measureTokens(contributions: Iterable<UsageWorkAllocation['contribution']>) {
  let tokens: UsageAnalyticsTokens = createEmptyUsageTokens();
  for (const contribution of contributions) tokens = addUsageMeasuredTokens(tokens, contribution.tokens);
  return resolveUsageMeasuredTokens(tokens);
}

/** Display groups consume complete populations, unlike the Session's witnessed-prefix timeline. */
function finishAmounts(amounts: Iterable<AmountAccumulator>, basis: UsageWorkAmount): void {
  for (const target of amounts) {
    if (!target.contributions?.length) continue;
    if (basis.metric !== 'cost') {
      const measured = measureTokens(target.contributions);
      target.amount = measured.total;
      target.tokensFromParts = measured.fromParts;
      continue;
    }
    const cost = aggregateUsageContributionCosts(target.contributions, basis.costBasis);
    const selected = resolveUsageCostBasis(cost, basis.costBasis);
    target.amount = selected?.amountUsd ?? null;
    target.moneyBasis = selected ? { kind: selected.kind, currency: selected.currency } : null;
  }
}

type Marks = { agents: Set<string>; providers: Map<string, UsageWorkProvider> };
const newMarks = (): Marks => ({ agents: new Set(), providers: new Map() });
function witness(marks: Marks, contribution: UsageWorkAllocation['contribution']): void {
  if (contribution.agentId) marks.agents.add(contribution.agentId);
  if (contribution.providerId) {
    const provider = { providerId: contribution.providerId, machineId: contribution.machineId };
    marks.providers.set(JSON.stringify(provider), provider);
  }
}
const identities = (marks: Marks): UsageWorkIdentities => ({
  agentIds: sorted(marks.agents),
  providers: [...marks.providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
});
function addPart(parts: Map<string, AmountAccumulator>, sessionId: string | null,
  allocation: Pick<UsageWorkAllocation, 'contribution'>, basis: UsageWorkAmount): void {
  if (!sessionId) return;
  const part = parts.get(sessionId) ?? newAmount();
  accumulate(part, allocation, basis);
  parts.set(sessionId, part);
}
const sessionParts = (parts: Map<string, AmountAccumulator>): UsageWorkSessionPart[] =>
  [...parts.entries()].map(([sessionId, amount]) => ({ sessionId, amount: amount.amount,
    moneyBasis: amount.moneyBasis, tokensFromParts: amount.tokensFromParts })).sort(byAmount);

/** Only like monetary kinds/currencies share a comparative chart; tokens remain one domain. */
export function partitionUsageWorkMoneyRows<Row extends MoneyDisplay>(rows: readonly Row[], metric: UsageWorkAmount['metric']) {
  const groups = new Map<string, { key: string; moneyBasis: UsageWorkMoneyBasis | null; rows: Row[] }>();
  for (const row of rows) {
    const moneyBasis = metric === 'cost' ? row.moneyBasis : null;
    const key = JSON.stringify(moneyBasis);
    const group = groups.get(key) ?? { key, moneyBasis, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Scatter fallback rows belong to the ledger; a plot needs a witnessed outcome axis. */
export function projectUsageSessionValuePlots(rows: readonly UsageWorkSessionRow[], metric: UsageWorkAmount['metric']) {
  return partitionUsageWorkMoneyRows(rows.filter((row): row is UsageWorkSessionRow & { amount: number } =>
    row.amount !== null && row.outcomes.length > 0), metric).map(plot => {
      const amounts = plot.rows.map(row => row.amount).sort((left, right) => left - right);
      const middle = Math.floor(amounts.length / 2);
      const medianAmount = amounts.length <= 1 ? null : amounts.length % 2 ? amounts[middle]!
        : amounts[middle - 1]! + (amounts[middle]! - amounts[middle - 1]!) / 2;
      return { ...plot, medianAmount };
    });
}

type BranchGroup = Marks & { branch: UsageWorkBranch; amount: AmountAccumulator; parts: Map<string, AmountAccumulator>;
  projects: Set<string | null>; commits: Set<string>; evidence: RepositoryCheckpointCommitEvidence[];
  linkedPullRequests: Map<string, ScmPullRequestSummary> };
function groupBranches(allocations: UsageWorkProjection['branchAllocations'], basis: UsageWorkAmount,
  outcomeByContribution: ReadonlyMap<string, UsageWorkProjection['allocations'][number]>,
  anchor: (key: string | null) => string | null = key => key): UsageWorkBranchRow[] {
  const rows = new Map<string, BranchGroup>();
  for (const allocation of allocations) {
    if (!allocation.branch) continue;
    const row: BranchGroup = rows.get(allocation.branch.key) ?? { ...newMarks(), branch: allocation.branch, amount: newAmount(), parts: new Map(),
      projects: new Set(), commits: new Set(), evidence: [], linkedPullRequests: new Map() };
    accumulate(row.amount, allocation, basis);
    addPart(row.parts, allocation.contribution.sessionId, allocation, basis);
    witness(row, allocation.contribution);
    row.projects.add(anchor(allocation.contribution.projectKey));
    for (const evidence of allocation.evidence) row.commits.add(evidence.commitSha);
    row.evidence.push(...allocation.evidence);
    for (const witness of outcomeByContribution.get(allocation.contribution.id)?.evidence ?? []) {
      // The SCM producer supplied this graph edge. Display it without assigning any PR cost here.
      if (witness.branches?.some(branch => branch.ref === row.branch.branch.ref && branch.headSha === row.branch.branch.headSha)
        && allocation.evidence.some(branchWitness => branchWitness.commitSha === witness.commitSha
          && branchWitness.checkpointCommitSha === witness.checkpointCommitSha
          && branchWitness.repositoryKey === witness.branchRepositoryKey)) {
        row.linkedPullRequests.set(JSON.stringify(witness.pullRequest), witness.pullRequest);
      }
    }
    rows.set(allocation.branch.key, row);
  }
  for (const row of rows.values()) finishAmounts([row.amount, ...row.parts.values()], basis);
  return [...rows.values()].map((row): UsageWorkBranchRow => ({ branch: row.branch, amount: row.amount.amount,
    moneyBasis: row.amount.moneyBasis, tokensFromParts: row.amount.tokensFromParts, ...identities(row),
    sessionIds: sorted(row.parts.keys()), sessions: sessionParts(row.parts), commits: [...row.commits],
    perSession: row.amount.amount === null || row.parts.size === 0 ? null : row.amount.amount / row.parts.size,
    retainedChanges: retainedChanges(row.evidence), linkedPullRequests: [...row.linkedPullRequests.values()],
    projectKeys: [...row.projects].sort((a, b) => (a ?? '').localeCompare(b ?? '')) })).sort(byAmount);
}

/** One displayed group for unnamed Projects, including accounting's absent-Project operand. */
export function usageProjectDisplayKey(key: string | null, namedProjectKeys?: Pick<ReadonlySet<string>, 'has'>,
  anchorOf?: (key: string) => string): string | null {
  const project = key === null || key === 'unknown' ? null : anchorOf ? anchorOf(key) : key;
  return project === null || namedProjectKeys && !namedProjectKeys.has(project) ? null : project;
}

export function summarizeUsageWork(
  graph: UsageWorkAllocationGraph,
  contributions: readonly UsageWorkContribution[],
  basis: UsageWorkAmount,
  namedProjectKeys?: ReadonlySet<string>,
  /**
   * The Project a stamped key belongs to now (`createProjectAnchorOfKeyV1`, owner 11-08): usage a checkout was stamped
   * with before it joined a Project counts under that Project.
   */
  anchorOf?: (key: string) => string,
): UsageWorkSummary {
  const work = readUsageWorkAllocations(graph, contributions);
  const anchor = (key: string | null) => key === null || !anchorOf ? key : anchorOf(key);
  const displayProjectKey = (key: string | null) => usageProjectDisplayKey(key, namedProjectKeys, anchorOf);
  const unallocatedAmounts: Record<UsageWorkUnallocatedReason, AmountAccumulator> = {
    missing_turn: newAmount(),
    missing_evidence: newAmount(),
    ambiguous_outcome: newAmount(),
    uncertain_writers: newAmount(),
  };
  const total = newAmount();
  const allocated = newAmount();
  const unallocated = newAmount();
  let missingMoneyCount = 0;
  const outcomeRows = new Map<
    string,
    {
      outcome: UsageWorkOutcome;
      amount: AmountAccumulator;
      parts: Map<string, AmountAccumulator>;
      marks: Marks;
      projects: Set<string | null>;
    }
  >();
  const projectRows = new Map<
    string | null,
    {
      amount: AmountAccumulator;
      allocated: AmountAccumulator;
      unallocated: AmountAccumulator;
      sessions: Set<string>;
      machines: Set<string>;
      agents: Set<string>;
      providers: Map<string, UsageWorkProvider>;
      outcomes: Set<string>;
      parts: Map<string, AmountAccumulator>;
      projectKeys: Set<string | null>;
    }
  >();
  const sessionRows = new Map<
    string,
    {
      amount: AmountAccumulator;
      machines: Set<string>;
      lastObservedAtMs: number;
      agents: Set<string>;
      providers: Map<string, UsageWorkProvider>;
      outcomes: Map<string, UsageWorkOutcome>;
      witnessed: boolean;
      reasons: Set<UsageWorkUnallocatedReason>;
    }
  >();
  const agentAmounts = new Map<string, AmountAccumulator>();
  const outcomeByContribution = new Map<string, UsageWorkProjection['allocations'][number]>();
  for (const row of work.allocations) {
    const amount = usageWorkContributionAmount(row, basis);
    const { contribution } = row;
    outcomeByContribution.set(contribution.id, row);
    accumulate(total, row, basis);
    addPart(agentAmounts, contribution.agentId, row, basis);
    if (amount === null) missingMoneyCount += 1;
    const projectKey = displayProjectKey(contribution.projectKey);
    const project = projectRows.get(projectKey) ?? {
      amount: newAmount(),
      allocated: newAmount(),
      unallocated: newAmount(),
      sessions: new Set(),
      machines: new Set(),
      agents: new Set(),
      providers: new Map(),
      outcomes: new Set(),
      parts: new Map(),
      projectKeys: new Set<string | null>(),
    };
    project.projectKeys.add(contribution.projectKey);
    accumulate(project.amount, row, basis);
    addPart(project.parts, contribution.sessionId, row, basis);
    if (contribution.sessionId) project.sessions.add(contribution.sessionId);
    if (contribution.machineId) project.machines.add(contribution.machineId);
    if (contribution.agentId) project.agents.add(contribution.agentId);
    const provider = contribution.providerId ? { providerId: contribution.providerId, machineId: contribution.machineId } : null;
    if (provider) project.providers.set(JSON.stringify(provider), provider);
    projectRows.set(projectKey, project);
    if (contribution.sessionId) {
      const session = sessionRows.get(contribution.sessionId) ?? {
        amount: newAmount(),
        machines: new Set(),
        lastObservedAtMs: 0,
        agents: new Set(),
        providers: new Map(),
        outcomes: new Map(),
        witnessed: false,
        reasons: new Set(),
      };
      accumulate(session.amount, row, basis);
      recordSessionIdentity(session, contribution);
      if (contribution.agentId) session.agents.add(contribution.agentId);
      if (provider) session.providers.set(JSON.stringify(provider), provider);
      session.witnessed ||= row.evidence.length > 0;
      if (row.outcome) session.outcomes.set(row.outcome.key, row.outcome);
      if (row.reason !== 'allocated') session.reasons.add(row.reason);
      sessionRows.set(contribution.sessionId, session);
    }
    if (row.reason !== 'allocated' || !row.outcome) {
      if (row.reason !== 'allocated') accumulate(unallocatedAmounts[row.reason], row, basis);
      accumulate(unallocated, row, basis);
      accumulate(project.unallocated, row, basis);
      continue;
    }
    accumulate(allocated, row, basis);
    accumulate(project.allocated, row, basis);
    project.outcomes.add(row.outcome.key);
    const outcome = outcomeRows.get(row.outcome.key) ?? {
      outcome: row.outcome,
      amount: newAmount(),
      parts: new Map(),
      marks: newMarks(),
      projects: new Set(),
    };
    accumulate(outcome.amount, row, basis);
    addPart(outcome.parts, contribution.sessionId, row, basis);
    witness(outcome.marks, contribution);
    outcome.projects.add(anchor(contribution.projectKey));
    outcomeRows.set(row.outcome.key, outcome);
  }
  finishAmounts([total, allocated, unallocated, ...Object.values(unallocatedAmounts), ...agentAmounts.values()], basis);
  for (const row of outcomeRows.values()) finishAmounts([row.amount, ...row.parts.values()], basis);
  for (const row of projectRows.values()) finishAmounts([row.amount, row.allocated, row.unallocated, ...row.parts.values()], basis);
  for (const row of sessionRows.values()) finishAmounts([row.amount], basis);
  const outcomes = [...outcomeRows.entries()]
    .map(([key, row]): UsageWorkOutcomeRow => ({
      key,
      outcome: row.outcome,
      amount: row.amount.amount,
      moneyBasis: row.amount.moneyBasis,
      tokensFromParts: row.amount.tokensFromParts,
      sessionIds: sorted(row.parts.keys()),
      sessions: sessionParts(row.parts),
      ...identities(row.marks),
      projectKeys: [...row.projects],
    }))
    .sort(byAmount);
  const outcomeByKey = new Map(outcomes.map((row) => [row.key, row]));
  // Partition once: each Project consumes its own branches, never the whole contribution inventory.
  const branchesByProject = new Map<string | null, UsageWorkProjection['branchAllocations'][number][]>();
  for (const allocation of work.branchAllocations) {
    if (!allocation.branch) continue;
    const key = displayProjectKey(allocation.contribution.projectKey);
    const branches = branchesByProject.get(key) ?? [];
    branches.push(allocation);
    branchesByProject.set(key, branches);
  }
  const projects = [...projectRows.entries()]
    .map(([projectKey, row]): UsageWorkProjectRow => ({
      projectKey,
      unnamedProjectCount: projectKey === null ? row.projectKeys.size : 0,
      amount: row.amount.amount,
      moneyBasis: row.amount.moneyBasis,
      tokensFromParts: row.amount.tokensFromParts,
      allocated: row.allocated.amount,
      unallocated: row.unallocated.amount,
      allocatedBasis: row.allocated.moneyBasis,
      unallocatedBasis: row.unallocated.moneyBasis,
      sessionIds: sorted(row.sessions),
      machineIds: sorted(row.machines),
      agentIds: sorted(row.agents),
      providers: [...row.providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
      outcomes: [...row.outcomes]
        .flatMap((key) => outcomeByKey.get(key) ?? [])
        .sort(byAmount),
      sessions: sessionParts(row.parts),
      branches: groupBranches(branchesByProject.get(projectKey) ?? [], basis, outcomeByContribution, anchor),
    }))
    .sort(byAmount);
  const sessions = [...sessionRows.entries()]
    .map(([sessionId, row]): UsageWorkSessionRow => ({
      ...sessionIdentity(sessionId, row),
      amount: row.amount.amount,
      moneyBasis: row.amount.moneyBasis,
      tokensFromParts: row.amount.tokensFromParts,
      agentIds: sorted(row.agents),
      providers: [...row.providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
      outcomes: [...row.outcomes.values()],
      witnessed: row.witnessed,
      unallocatedReasons: [...row.reasons].sort(),
    }))
    .sort(byAmount);
  return {
    total: total.amount,
    moneyBasis: total.moneyBasis,
    tokensFromParts: total.tokensFromParts,
    allocated: allocated.amount,
    allocatedBasis: allocated.moneyBasis,
    missingMoneyCount,
    unallocated: unallocated.amount,
    unallocatedBasis: unallocated.moneyBasis,
    unallocatedReasonBases: { missing_turn: unallocatedAmounts.missing_turn.moneyBasis, missing_evidence: unallocatedAmounts.missing_evidence.moneyBasis,
      ambiguous_outcome: unallocatedAmounts.ambiguous_outcome.moneyBasis, uncertain_writers: unallocatedAmounts.uncertain_writers.moneyBasis },
    unallocatedByReason: { missing_turn: unallocatedAmounts.missing_turn.amount, missing_evidence: unallocatedAmounts.missing_evidence.amount,
      ambiguous_outcome: unallocatedAmounts.ambiguous_outcome.amount, uncertain_writers: unallocatedAmounts.uncertain_writers.amount },
    outcomes,
    branches: groupBranches(work.branchAllocations, basis, outcomeByContribution, anchor),
    projects,
    sessions,
    agents: sessionParts(agentAmounts).map((row) => ({ agentId: row.sessionId, amount: row.amount,
      moneyBasis: row.moneyBasis, tokensFromParts: row.tokensFromParts })),
    funnel: {
      sessions: sessions.length,
      witnessed: sessions.filter((row) => row.witnessed).length,
      allocated: sessions.filter((row) => row.outcomes.length > 0).length,
    },
  };
}

export type UsageWorkTurnRow = MoneyDisplay & Readonly<{
  contributionId: string;
  /** Every model call this turn adds up (a turn usually spans several). */
  contributionIds: readonly string[];
  /** Null when the contribution carries no turn: it is still counted, and never guessed. */
  turnId: string | null;
  observedAtMs: number;
  modelId: string | null;
  machineId: string | null;
  amount: number | null;
  outcome: UsageWorkOutcome | null;
  reason: UsageWorkAllocation['reason'];
  checkpoints: readonly string[];
  commits: readonly string[];
  /** Branch refs witnessed for this turn's commits. */
  branches: readonly string[];
  moments: readonly Readonly<{ kind: 'checkpoint' | 'commit'; sha: string; atMs: number }>[];
  retainedChanges: readonly UsageWorkRetainedChange[];
}>;
export type UsageWorkRetainedChange = NonNullable<RepositoryCheckpointCommitEvidence['retainedChange']> & Readonly<{ commitSha: string }>;

function retainedChanges(evidence: readonly RepositoryCheckpointCommitEvidence[]): UsageWorkRetainedChange[] {
  return [...new Map(evidence.flatMap(row => row.retainedChange ? [[JSON.stringify([row.commitSha, row.retainedChange]),
    { commitSha: row.commitSha, ...row.retainedChange }] as const] : [])).values()];
}
export type UsageWorkSessionAutopsy = UsageWorkIdentities & Readonly<{
  turns: readonly UsageWorkTurnRow[];
  outcomes: readonly UsageWorkOutcome[];
  /** Cumulative selected cost kind at the accounting observation times; an unpriced part stays unknown. */
  costTimeline: readonly Readonly<{ id: string; observedAtMs: number; amount: number | null }>[];
  /** The known prefix's one monetary basis; unavailable later values are gaps, never another kind. */
  costTimelineBasis: UsageWorkMoneyBasis | null;
}>;

/** One Session's contributions in witnessed order, each with its own exact amount and evidence. */
/** A turn spans several model calls; one row per turn, its parts added up. A no-turn row with no usage says nothing. */
function groupUsageWorkTurns(
  rows: readonly UsageWorkTurnRow[],
  contributionOf: (id: string) => UsageWorkAllocation['contribution'],
  basis: UsageWorkAmount,
): UsageWorkTurnRow[] {
  const groups = new Map<string | null, UsageWorkTurnRow[]>();
  for (const row of rows) groups.set(row.turnId, [...(groups.get(row.turnId) ?? []), row]);
  return [...groups.values()].flatMap((parts): UsageWorkTurnRow[] => {
    const first = parts[0]!;
    const selected = basis.metric === 'cost'
      ? resolveUsageCostBasis(aggregateUsageContributionCosts(parts.map(part => contributionOf(part.contributionId)), basis.costBasis), basis.costBasis)
      : null;
    const measured = basis.metric === 'cost' ? null : measureTokens(parts.map(part => contributionOf(part.contributionId)));
    const amount = measured ? measured.total : selected?.amountUsd ?? null;
    if (first.turnId === null && amount === 0) return [];
    const unique = <T,>(values: readonly T[]) => [...new Set(values)];
    const withOutcome = parts.find(part => part.outcome !== null);
    return [{
      ...first,
      contributionIds: parts.map(part => part.contributionId),
      amount,
      moneyBasis: selected ? { kind: selected.kind, currency: selected.currency } : null,
      tokensFromParts: measured?.fromParts ?? false,
      outcome: withOutcome?.outcome ?? null,
      reason: withOutcome?.reason ?? first.reason,
      checkpoints: unique(parts.flatMap(part => part.checkpoints)),
      commits: unique(parts.flatMap(part => part.commits)),
      branches: unique(parts.flatMap(part => part.branches)),
      moments: [...new Map(parts.flatMap(part => part.moments).map(moment => [JSON.stringify(moment), moment])).values()],
      retainedChanges: [...new Map(parts.flatMap(part => part.retainedChanges).map(change => [JSON.stringify(change), change])).values()],
    }];
  });
}

export function summarizeUsageWorkSession(
  graph: UsageWorkAllocationGraph,
  contributions: readonly UsageWorkContribution[],
  basis: UsageWorkAmount,
  sessionId: string,
): UsageWorkSessionAutopsy {
  const work = readUsageWorkAllocations(graph, contributions);
  const branchByContribution = new Map(work.branchAllocations.map((row) => [row.contribution.id, row]));
  const marks = newMarks();
  const outcomes = new Map<string, UsageWorkOutcome>();
  const contributionRows = work.allocations
    .filter((row) => row.contribution.sessionId === sessionId)
    .map((row): UsageWorkTurnRow => {
      const branch = branchByContribution.get(row.contribution.id);
      const evidence = [...row.evidence, ...(branch?.evidence ?? [])];
      const turnAmount = usageWorkContributionAmount(row, basis);
      const turnBasis = basis.metric === 'cost' ? resolveUsageCostBasis(row.contribution.cost, basis.costBasis) : null;
      witness(marks, row.contribution);
      if (row.outcome) outcomes.set(row.outcome.key, row.outcome);
      return {
        contributionId: row.contribution.id,
        contributionIds: [row.contribution.id],
        turnId: row.contribution.turnId,
        observedAtMs: row.contribution.observedAtMs,
        modelId: row.contribution.modelId,
        machineId: row.contribution.machineId,
        amount: turnAmount,
        moneyBasis: turnBasis ? { kind: turnBasis.kind, currency: turnBasis.currency } : null,
        tokensFromParts: basis.metric !== 'cost' && resolveUsageMeasuredTokens(row.contribution.tokens).fromParts,
        outcome: row.outcome,
        reason: row.reason,
        checkpoints: [...new Set(evidence.map((item) => item.checkpointRef))],
        commits: [...new Set(evidence.map((item) => item.commitSha))],
        branches: [...new Set((branch?.evidence ?? []).map((item) => item.branch.ref))],
        moments: [...new Map(evidence.flatMap(item => [
          ...(item.checkpointCommittedAtMs === undefined ? [] : [{ kind: 'checkpoint' as const,
            sha: item.checkpointCommitSha, atMs: item.checkpointCommittedAtMs }]),
          ...(item.committedAtMs === undefined ? [] : [{ kind: 'commit' as const, sha: item.commitSha, atMs: item.committedAtMs }]),
        ]).map(moment => [JSON.stringify(moment), moment])).values()],
        retainedChanges: retainedChanges(evidence),
      };
    })
    .sort((left, right) => left.observedAtMs - right.observedAtMs || left.contributionId.localeCompare(right.contributionId));
  const allocations = new Map(work.allocations.map(row => [row.contribution.id, row]));
  let cumulativeCost = createEmptyUsageCost();
  const cumulativeRows: UsageWorkAllocation['contribution'][] = [];
  let costTimelineBasis: UsageWorkSessionAutopsy['costTimelineBasis'] = null;
  const costTimeline = contributionRows.map(turn => {
    const contribution = allocations.get(turn.contributionId)!.contribution;
    cumulativeRows.push(contribution);
    cumulativeCost = contribution.cost.reportedTotalContributionIds
      ? aggregateUsageContributionCosts(cumulativeRows, basis.costBasis)
      : addUsageCostForMode(cumulativeCost, contribution.cost, basis.costBasis);
    const selected = resolveUsageCostBasis(cumulativeCost, basis.costBasis);
    if (selected) costTimelineBasis = { kind: selected.kind, currency: selected.currency };
    return { id: turn.contributionId, observedAtMs: turn.observedAtMs,
      amount: selected?.amountUsd ?? null };
  });
  const turns = groupUsageWorkTurns(contributionRows, id => allocations.get(id)!.contribution, basis);
  return { turns, costTimeline, costTimelineBasis, outcomes: [...outcomes.values()], ...identities(marks) };
}
