import { addUsageCostForMode, aggregateUsageContributionCosts, createEmptyUsageCost } from '@happier-dev/protocol/usage/usageAggregation';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import type { RepositoryCheckpointCommitEvidence } from '@happier-dev/protocol/sessions/changes/types';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm';
import type {
  UsageWorkAllocation,
  UsageWorkOutcome,
  UsageWorkProjection,
  UsageWorkBranch,
} from '@happier-dev/protocol/usage/usageOutcomeAllocation';

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

export function usageWorkContributionAmount(
  allocation: Pick<UsageWorkAllocation, 'contribution'>,
  basis: UsageWorkAmount,
): number | null {
  const contribution = allocation.contribution;
  return basis.metric === 'cost'
    ? resolveUsageCostBasis(contribution.cost, basis.costBasis)?.amountUsd ?? null
    : contribution.tokens.total;
}

export type UsageWorkProvider = Readonly<{ providerId: string; machineId: string | null }>;
export type UsageWorkMoneyBasis = Pick<NonNullable<ReturnType<typeof resolveUsageCostBasis>>, 'kind' | 'currency'>;
type MoneyDisplay = Readonly<{ moneyBasis: UsageWorkMoneyBasis | null }>;
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
    merged: number;
  }>;
}>;

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const byAmount = <T extends { amount: number | null }>(left: T, right: T) =>
  (right.amount ?? -1) - (left.amount ?? -1);
const addAmount = (left: number | null, right: number | null) =>
  left === null || right === null ? null : left + right;
type AmountAccumulator = { amount: number | null;
  contributions?: UsageWorkAllocation['contribution'][]; moneyBasis: UsageWorkMoneyBasis | null };
const newAmount = (): AmountAccumulator => ({ amount: 0, moneyBasis: null });
function accumulate(target: AmountAccumulator, allocation: Pick<UsageWorkAllocation, 'contribution'>, basis: UsageWorkAmount): void {
  if (basis.metric !== 'cost') { target.amount = addAmount(target.amount, allocation.contribution.tokens.total); return; }
  (target.contributions ??= []).push(allocation.contribution);
}

/** Display groups consume complete populations, unlike the Session's witnessed-prefix timeline. */
function finishAmounts(amounts: Iterable<AmountAccumulator>, basis: UsageWorkAmount): void {
  if (basis.metric !== 'cost') return;
  for (const target of amounts) {
    if (!target.contributions?.length) continue;
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
  [...parts.entries()].map(([sessionId, amount]) => ({ sessionId, amount: amount.amount, moneyBasis: amount.moneyBasis })).sort(byAmount);

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
    row.amount !== null && row.outcomes.length > 0), metric);
}

type BranchGroup = Marks & { branch: UsageWorkBranch; amount: AmountAccumulator; parts: Map<string, AmountAccumulator>;
  projects: Set<string | null>; commits: Set<string>; evidence: RepositoryCheckpointCommitEvidence[];
  linkedPullRequests: Map<string, ScmPullRequestSummary> };
function groupBranches(allocations: UsageWorkProjection['branchAllocations'], basis: UsageWorkAmount,
  outcomeAllocations: UsageWorkProjection['allocations']): UsageWorkBranchRow[] {
  const rows = new Map<string, BranchGroup>();
  const outcomeByContribution = new Map(outcomeAllocations.map(row => [row.contribution.id, row]));
  for (const allocation of allocations) {
    if (!allocation.branch) continue;
    const row: BranchGroup = rows.get(allocation.branch.key) ?? { ...newMarks(), branch: allocation.branch, amount: newAmount(), parts: new Map(),
      projects: new Set(), commits: new Set(), evidence: [], linkedPullRequests: new Map() };
    accumulate(row.amount, allocation, basis);
    addPart(row.parts, allocation.contribution.sessionId, allocation, basis);
    witness(row, allocation.contribution);
    row.projects.add(allocation.contribution.projectKey);
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
  return [...rows.values()].map((row): UsageWorkBranchRow => ({ branch: row.branch, amount: row.amount.amount, moneyBasis: row.amount.moneyBasis, ...identities(row),
    sessionIds: sorted(row.parts.keys()), sessions: sessionParts(row.parts), commits: [...row.commits],
    perSession: row.amount.amount === null || row.parts.size === 0 ? null : row.amount.amount / row.parts.size,
    retainedChanges: retainedChanges(row.evidence), linkedPullRequests: [...row.linkedPullRequests.values()],
    projectKeys: [...row.projects].sort((a, b) => (a ?? '').localeCompare(b ?? '')) })).sort(byAmount);
}

export function summarizeUsageWork(
  work: UsageWorkProjection,
  basis: UsageWorkAmount,
  namedProjectKeys?: ReadonlySet<string>,
): UsageWorkSummary {
  const displayProjectKey = (key: string | null) => key === null || namedProjectKeys && !namedProjectKeys.has(key) ? null : key;
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
  for (const row of work.allocations) {
    const amount = usageWorkContributionAmount(row, basis);
    const { contribution } = row;
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
      if (contribution.machineId) session.machines.add(contribution.machineId);
      session.lastObservedAtMs = Math.max(session.lastObservedAtMs, contribution.observedAtMs);
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
    outcome.projects.add(contribution.projectKey);
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
      sessionIds: sorted(row.parts.keys()),
      sessions: sessionParts(row.parts),
      ...identities(row.marks),
      projectKeys: [...row.projects],
    }))
    .sort(byAmount);
  const outcomeByKey = new Map(outcomes.map((row) => [row.key, row]));
  const projects = [...projectRows.entries()]
    .map(([projectKey, row]): UsageWorkProjectRow => ({
      projectKey,
      unnamedProjectCount: projectKey === null ? row.projectKeys.size : 0,
      amount: row.amount.amount,
      moneyBasis: row.amount.moneyBasis,
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
      branches: groupBranches(work.branchAllocations.filter((allocation) => displayProjectKey(allocation.contribution.projectKey) === projectKey), basis, work.allocations),
    }))
    .sort(byAmount);
  const sessions = [...sessionRows.entries()]
    .map(([sessionId, row]): UsageWorkSessionRow => ({
      sessionId,
      machineIds: sorted(row.machines),
      lastObservedAtMs: row.lastObservedAtMs,
      amount: row.amount.amount,
      moneyBasis: row.amount.moneyBasis,
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
    branches: groupBranches(work.branchAllocations, basis, work.allocations),
    projects,
    sessions,
    agents: sessionParts(agentAmounts).map((row) => ({ agentId: row.sessionId, amount: row.amount, moneyBasis: row.moneyBasis })),
    funnel: {
      sessions: sessions.length,
      witnessed: sessions.filter((row) => row.witnessed).length,
      allocated: sessions.filter((row) => row.outcomes.length > 0).length,
      merged: sessions.filter((row) =>
        row.outcomes.some((outcome) => outcome.pullRequest.state === 'merged'),
      ).length,
    },
  };
}

export type UsageWorkTurnRow = MoneyDisplay & Readonly<{
  contributionId: string;
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
export type UsageWorkSessionAutopsy = UsageWorkIdentities & MoneyDisplay & Readonly<{
  amount: number | null;
  turns: readonly UsageWorkTurnRow[];
  outcomes: readonly UsageWorkOutcome[];
  /** Cumulative selected cost kind at the accounting observation times; an unpriced part stays unknown. */
  costTimeline: readonly Readonly<{ id: string; observedAtMs: number; amount: number | null }>[];
  /** The known prefix's one monetary basis; unavailable later values are gaps, never another kind. */
  costTimelineBasis: UsageWorkMoneyBasis | null;
}>;

/** One Session's contributions in witnessed order, each with its own exact amount and evidence. */
export function summarizeUsageWorkSession(
  work: UsageWorkProjection,
  basis: UsageWorkAmount,
  sessionId: string,
): UsageWorkSessionAutopsy {
  const branchByContribution = new Map(work.branchAllocations.map((row) => [row.contribution.id, row]));
  const marks = newMarks();
  const outcomes = new Map<string, UsageWorkOutcome>();
  let amount: number | null = 0;
  const turns = work.allocations
    .filter((row) => row.contribution.sessionId === sessionId)
    .map((row): UsageWorkTurnRow => {
      const branch = branchByContribution.get(row.contribution.id);
      const evidence = [...row.evidence, ...(branch?.evidence ?? [])];
      const turnAmount = usageWorkContributionAmount(row, basis);
      const turnBasis = basis.metric === 'cost' ? resolveUsageCostBasis(row.contribution.cost, basis.costBasis) : null;
      amount = addAmount(amount, turnAmount);
      witness(marks, row.contribution);
      if (row.outcome) outcomes.set(row.outcome.key, row.outcome);
      return {
        contributionId: row.contribution.id,
        turnId: row.contribution.turnId,
        observedAtMs: row.contribution.observedAtMs,
        modelId: row.contribution.modelId,
        machineId: row.contribution.machineId,
        amount: turnAmount,
        moneyBasis: turnBasis ? { kind: turnBasis.kind, currency: turnBasis.currency } : null,
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
  const costTimeline = turns.map(turn => {
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
  if (basis.metric === 'cost' && turns.length > 0) amount = resolveUsageCostBasis(cumulativeCost, basis.costBasis)?.amountUsd ?? null;
  const selected = basis.metric === 'cost' ? resolveUsageCostBasis(cumulativeCost, basis.costBasis) : null;
  return { amount, moneyBasis: selected ? { kind: selected.kind, currency: selected.currency } : null,
    turns, costTimeline, costTimelineBasis, outcomes: [...outcomes.values()], ...identities(marks) };
}
