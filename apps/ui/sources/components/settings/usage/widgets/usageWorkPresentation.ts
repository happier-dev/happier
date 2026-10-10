import { resolveUsageCostBasis } from '@happier-dev/protocol';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
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
/** One Session's exact part of a row: the sum of only the contributions that row counts. */
export type UsageWorkSessionPart = Readonly<{ sessionId: string; amount: number | null }>;
/** Who a row's contributions were witnessed with. An Agent never implies a Provider. */
export type UsageWorkIdentities = Readonly<{
  agentIds: readonly string[];
  providers: readonly UsageWorkProvider[];
  /** At least one contribution carries no admitted Provider binding. */
  providerUnknown: boolean;
}>;

export type UsageWorkOutcomeRow = UsageWorkIdentities & Readonly<{
  key: string;
  outcome: UsageWorkOutcome;
  amount: number | null;
  sessionIds: readonly string[];
  sessions: readonly UsageWorkSessionPart[];
  projectKeys: readonly (string | null)[];
}>;

export type UsageWorkBranchRow = UsageWorkIdentities & Readonly<{
  branch: UsageWorkBranch;
  amount: number | null;
  sessionIds: readonly string[];
  sessions: readonly UsageWorkSessionPart[];
  projectKeys: readonly (string | null)[];
  /** Distinct witnessed commits, in first-witnessed order. */
  commits: readonly string[];
  /** The plain mean of this row's exact amount over its Sessions; unknown stays unknown. */
  perSession: number | null;
}>;

export type UsageWorkProjectRow = Readonly<{
  projectKey: string | null;
  amount: number | null;
  allocated: number | null;
  unallocated: number | null;
  sessionIds: readonly string[];
  agentIds: readonly string[];
  providers: readonly UsageWorkProvider[];
  providerUnknown: boolean;
  outcomes: readonly UsageWorkOutcomeRow[];
  /** Each Session's part of this project, largest first. */
  sessions: readonly UsageWorkSessionPart[];
  /** Branches witnessed for this project's contributions, counting only those contributions. */
  branches: readonly UsageWorkBranchRow[];
}>;

export type UsageWorkSessionRow = Readonly<{
  sessionId: string;
  amount: number | null;
  agentIds: readonly string[];
  providers: readonly UsageWorkProvider[];
  providerUnknown: boolean;
  /** Distinct exactly-allocated outcomes; ambiguous or missing links are not counted as outcomes. */
  outcomes: readonly UsageWorkOutcome[];
  /** Any witnessed PR evidence, even when the amount stayed unallocated. */
  witnessed: boolean;
  unallocatedReasons: readonly UsageWorkUnallocatedReason[];
}>;

export type UsageWorkSummary = Readonly<{
  total: number | null;
  allocated: number | null;
  missingMoneyCount: number;
  unallocated: number | null;
  unallocatedByReason: Readonly<Record<UsageWorkUnallocatedReason, number | null>>;
  outcomes: readonly UsageWorkOutcomeRow[];
  branches: readonly UsageWorkBranchRow[];
  projects: readonly UsageWorkProjectRow[];
  sessions: readonly UsageWorkSessionRow[];
  /** Agents by their exact amount, largest first (the scatter's identity slots). */
  agents: readonly Readonly<{ agentId: string; amount: number | null }>[];
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

type Marks = { agents: Set<string>; providers: Map<string, UsageWorkProvider>; providerUnknown: boolean };
const newMarks = (): Marks => ({ agents: new Set(), providers: new Map(), providerUnknown: false });
function witness(marks: Marks, contribution: UsageWorkAllocation['contribution']): void {
  if (contribution.agentId) marks.agents.add(contribution.agentId);
  if (contribution.providerId) {
    const provider = { providerId: contribution.providerId, machineId: contribution.machineId };
    marks.providers.set(JSON.stringify(provider), provider);
  } else marks.providerUnknown = true;
}
const identities = (marks: Marks): UsageWorkIdentities => ({
  agentIds: sorted(marks.agents),
  providers: [...marks.providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
  providerUnknown: marks.providerUnknown,
});
function addPart(parts: Map<string, number | null>, sessionId: string | null, amount: number | null): void {
  if (sessionId) parts.set(sessionId, addAmount(parts.get(sessionId) ?? 0, amount));
}
const sessionParts = (parts: Map<string, number | null>): UsageWorkSessionPart[] =>
  [...parts.entries()].map(([sessionId, amount]) => ({ sessionId, amount })).sort(byAmount);

type BranchGroup = Marks & { branch: UsageWorkBranch; amount: number | null; parts: Map<string, number | null>;
  projects: Set<string | null>; commits: Set<string> };
function groupBranches(allocations: UsageWorkProjection['branchAllocations'], basis: UsageWorkAmount): UsageWorkBranchRow[] {
  const rows = new Map<string, BranchGroup>();
  for (const allocation of allocations) {
    if (!allocation.branch) continue;
    const row: BranchGroup = rows.get(allocation.branch.key) ?? { ...newMarks(), branch: allocation.branch, amount: 0, parts: new Map(),
      projects: new Set(), commits: new Set() };
    const amount = usageWorkContributionAmount(allocation, basis);
    row.amount = addAmount(row.amount, amount);
    addPart(row.parts, allocation.contribution.sessionId, amount);
    witness(row, allocation.contribution);
    row.projects.add(allocation.contribution.projectKey);
    for (const evidence of allocation.evidence) row.commits.add(evidence.commitSha);
    rows.set(allocation.branch.key, row);
  }
  return [...rows.values()].map((row): UsageWorkBranchRow => ({ branch: row.branch, amount: row.amount, ...identities(row),
    sessionIds: sorted(row.parts.keys()), sessions: sessionParts(row.parts), commits: [...row.commits],
    perSession: row.amount === null || row.parts.size === 0 ? null : row.amount / row.parts.size,
    projectKeys: [...row.projects].sort((a, b) => (a ?? '').localeCompare(b ?? '')) })).sort(byAmount);
}

export function summarizeUsageWork(
  work: UsageWorkProjection,
  basis: UsageWorkAmount,
): UsageWorkSummary {
  const unallocatedByReason: Record<UsageWorkUnallocatedReason, number | null> = {
    missing_turn: 0,
    missing_evidence: 0,
    ambiguous_outcome: 0,
    uncertain_writers: 0,
  };
  let total: number | null = 0;
  let allocated: number | null = 0;
  let missingMoneyCount = 0;
  const outcomeRows = new Map<
    string,
    {
      outcome: UsageWorkOutcome;
      amount: number | null;
      parts: Map<string, number | null>;
      marks: Marks;
      projects: Set<string | null>;
    }
  >();
  const projectRows = new Map<
    string | null,
    {
      amount: number | null;
      allocated: number | null;
      unallocated: number | null;
      sessions: Set<string>;
      agents: Set<string>;
      providers: Map<string, UsageWorkProvider>;
      providerUnknown: boolean;
      outcomes: Set<string>;
      parts: Map<string, number | null>;
    }
  >();
  const sessionRows = new Map<
    string,
    {
      amount: number | null;
      agents: Set<string>;
      providers: Map<string, UsageWorkProvider>;
      providerUnknown: boolean;
      outcomes: Map<string, UsageWorkOutcome>;
      witnessed: boolean;
      reasons: Set<UsageWorkUnallocatedReason>;
    }
  >();
  const agentAmounts = new Map<string, number | null>();
  for (const row of work.allocations) {
    const amount = usageWorkContributionAmount(row, basis);
    const { contribution } = row;
    total = addAmount(total, amount);
    addPart(agentAmounts, contribution.agentId, amount);
    if (amount === null) missingMoneyCount += 1;
    const project = projectRows.get(contribution.projectKey) ?? {
      amount: 0,
      allocated: 0,
      unallocated: 0,
      sessions: new Set(),
      agents: new Set(),
      providers: new Map(),
      providerUnknown: false,
      outcomes: new Set(),
      parts: new Map(),
    };
    project.amount = addAmount(project.amount, amount);
    addPart(project.parts, contribution.sessionId, amount);
    if (contribution.sessionId) project.sessions.add(contribution.sessionId);
    if (contribution.agentId) project.agents.add(contribution.agentId);
    const provider = contribution.providerId ? { providerId: contribution.providerId, machineId: contribution.machineId } : null;
    if (provider) project.providers.set(JSON.stringify(provider), provider);
    else project.providerUnknown = true;
    projectRows.set(contribution.projectKey, project);
    if (contribution.sessionId) {
      const session = sessionRows.get(contribution.sessionId) ?? {
        amount: 0,
        agents: new Set(),
        providers: new Map(),
        providerUnknown: false,
        outcomes: new Map(),
        witnessed: false,
        reasons: new Set(),
      };
      session.amount = addAmount(session.amount, amount);
      if (contribution.agentId) session.agents.add(contribution.agentId);
      if (provider) session.providers.set(JSON.stringify(provider), provider);
      else session.providerUnknown = true;
      session.witnessed ||= row.evidence.length > 0;
      if (row.outcome) session.outcomes.set(row.outcome.key, row.outcome);
      if (row.reason !== 'allocated') session.reasons.add(row.reason);
      sessionRows.set(contribution.sessionId, session);
    }
    if (row.reason !== 'allocated' || !row.outcome) {
      if (row.reason !== 'allocated') unallocatedByReason[row.reason] = addAmount(unallocatedByReason[row.reason], amount);
      project.unallocated = addAmount(project.unallocated, amount);
      continue;
    }
    allocated = addAmount(allocated, amount);
    project.allocated = addAmount(project.allocated, amount);
    project.outcomes.add(row.outcome.key);
    const outcome = outcomeRows.get(row.outcome.key) ?? {
      outcome: row.outcome,
      amount: 0,
      parts: new Map(),
      marks: newMarks(),
      projects: new Set(),
    };
    outcome.amount = addAmount(outcome.amount, amount);
    addPart(outcome.parts, contribution.sessionId, amount);
    witness(outcome.marks, contribution);
    outcome.projects.add(contribution.projectKey);
    outcomeRows.set(row.outcome.key, outcome);
  }
  const outcomes = [...outcomeRows.entries()]
    .map(([key, row]): UsageWorkOutcomeRow => ({
      key,
      outcome: row.outcome,
      amount: row.amount,
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
      amount: row.amount,
      allocated: row.allocated,
      unallocated: row.unallocated,
      sessionIds: sorted(row.sessions),
      agentIds: sorted(row.agents),
      providers: [...row.providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
      providerUnknown: row.providerUnknown,
      outcomes: [...row.outcomes]
        .flatMap((key) => outcomeByKey.get(key) ?? [])
        .sort(byAmount),
      sessions: sessionParts(row.parts),
      branches: groupBranches(work.branchAllocations.filter((allocation) => allocation.contribution.projectKey === projectKey), basis),
    }))
    .sort(byAmount);
  const sessions = [...sessionRows.entries()]
    .map(([sessionId, row]): UsageWorkSessionRow => ({
      sessionId,
      amount: row.amount,
      agentIds: sorted(row.agents),
      providers: [...row.providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
      providerUnknown: row.providerUnknown,
      outcomes: [...row.outcomes.values()],
      witnessed: row.witnessed,
      unallocatedReasons: [...row.reasons].sort(),
    }))
    .sort(byAmount);
  return {
    total,
    allocated,
    missingMoneyCount,
    unallocated: Object.values(unallocatedByReason).reduce<number | null>(addAmount, 0),
    unallocatedByReason,
    outcomes,
    branches: groupBranches(work.branchAllocations, basis),
    projects,
    sessions,
    agents: sessionParts(agentAmounts).map((row) => ({ agentId: row.sessionId, amount: row.amount })),
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

export type UsageWorkTurnRow = Readonly<{
  contributionId: string;
  /** Null when the contribution carries no turn: it is still counted, and never guessed. */
  turnId: string | null;
  observedAtMs: number;
  amount: number | null;
  outcome: UsageWorkOutcome | null;
  reason: UsageWorkAllocation['reason'];
  checkpoints: readonly string[];
  commits: readonly string[];
  /** Branch refs witnessed for this turn's commits. */
  branches: readonly string[];
}>;
export type UsageWorkSessionAutopsy = UsageWorkIdentities & Readonly<{
  amount: number | null;
  turns: readonly UsageWorkTurnRow[];
  outcomes: readonly UsageWorkOutcome[];
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
      amount = addAmount(amount, turnAmount);
      witness(marks, row.contribution);
      if (row.outcome) outcomes.set(row.outcome.key, row.outcome);
      return {
        contributionId: row.contribution.id,
        turnId: row.contribution.turnId,
        observedAtMs: row.contribution.observedAtMs,
        amount: turnAmount,
        outcome: row.outcome,
        reason: row.reason,
        checkpoints: [...new Set(evidence.map((item) => item.checkpointRef))],
        commits: [...new Set(evidence.map((item) => item.commitSha))],
        branches: [...new Set((branch?.evidence ?? []).map((item) => item.branch.ref))],
      };
    })
    .sort((left, right) => left.observedAtMs - right.observedAtMs);
  return { amount, turns, outcomes: [...outcomes.values()], ...identities(marks) };
}
