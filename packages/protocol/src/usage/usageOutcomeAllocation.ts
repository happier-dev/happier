import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ScmPullRequestWorkEvidenceSchema, ScmPullRequestSummarySchema, type ScmPullRequestSummary, type ScmPullRequestWorkEvidence } from '../scm/pullRequests.js';
import { UsageAnalyticsContributionSchema, type UsageAnalyticsContribution } from './usageAnalyticsContracts.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { ScmBranchWorkEvidenceSchema, ScmBranchWorkIdentitySchema, type ScmBranchWorkEvidence } from '../scm/branches.js';
import { resolveUsageBucketBounds } from './usageCalendar.js';

/** Resolved A inputs; this projection never ingests or reconciles accounting. */
export type UsageWorkContribution = UsageAnalyticsContribution;
/** Only the authorized SCM/hosting reader may supply these witnessed relationships. */
export type UsageWorkEvidence = ScmPullRequestWorkEvidence;
export type UsageWorkOutcome = Readonly<{
  key: string; repositoryKey: string; pullRequest: ScmPullRequestSummary; contributionIds: string[];
}>;
export type UsageWorkAllocation = Readonly<{
  contribution: UsageWorkContribution; outcome: UsageWorkOutcome | null;
  reason: 'allocated' | 'missing_turn' | 'missing_evidence' | 'ambiguous_outcome' | 'uncertain_writers';
  evidence: UsageWorkEvidence[];
}>;
export type UsageWorkProjection = Readonly<{
  allocations: UsageWorkAllocation[]; outcomes: UsageWorkOutcome[];
  branchAllocations: UsageWorkBranchAllocation[]; branches: UsageWorkBranch[];
}>;
export type UsageWorkBranch = Readonly<{
  key: string; repositoryKey: string; branch: ScmBranchWorkEvidence['branch']; contributionIds: string[];
}>;
export type UsageWorkBranchAllocation = Readonly<{
  contribution: UsageWorkContribution; branch: UsageWorkBranch | null; reason: UsageWorkAllocation['reason'];
  evidence: ScmBranchWorkEvidence[];
}>;

const UsageWorkOutcomeSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)), repositoryKey: z.string().check(z.minLength(1)), pullRequest: ScmPullRequestSummarySchema,
  contributionIds: z.array(z.string().check(z.minLength(1))),
}));
const UsageWorkBranchSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)), repositoryKey: z.string().check(z.minLength(1)), branch: ScmBranchWorkIdentitySchema,
  contributionIds: z.array(z.string().check(z.minLength(1))),
}));
export const UsageWorkProjectionSchema = lazyZodSchema(() => z.strictObject({
  allocations: z.array(z.strictObject({
    contribution: UsageAnalyticsContributionSchema, outcome: z.nullable(UsageWorkOutcomeSchema),
    reason: z.enum(['allocated', 'missing_turn', 'missing_evidence', 'ambiguous_outcome', 'uncertain_writers']),
    evidence: z.array(ScmPullRequestWorkEvidenceSchema),
  })),
  outcomes: z.array(UsageWorkOutcomeSchema),
  branchAllocations: z.array(z.strictObject({
    contribution: UsageAnalyticsContributionSchema, branch: z.nullable(UsageWorkBranchSchema),
    reason: z.enum(['allocated', 'missing_turn', 'missing_evidence', 'ambiguous_outcome', 'uncertain_writers']),
    evidence: z.array(ScmBranchWorkEvidenceSchema),
  })),
  branches: z.array(UsageWorkBranchSchema),
}));

/** Private witnessed attribution; contribution count is not authorship or elapsed work. */
export const UsageMergedOutcomeSummarySchema = lazyZodSchema(() => z.strictObject({
  period: z.strictObject({
    startMs: z.number().check(z.int(), z.nonnegative()), endMs: z.number().check(z.int(), z.nonnegative()),
  }),
  timeZoneOffsetMinutes: z.number().check(z.int()),
  attributionBasis: z.literal('contribution_count'),
  /** Merged outcomes linked to admitted work, regardless of when the merge occurred. */
  linkedMergedCount: z.number().check(z.int(), z.nonnegative()),
  /** Subset of linked outcomes with a witnessed merge inside the half-open period. */
  mergedInPeriodCount: z.number().check(z.int(), z.nonnegative()),
  outsidePeriodMergedCount: z.number().check(z.int(), z.nonnegative()),
  undatedMergedCount: z.number().check(z.int(), z.nonnegative()),
  mergeWeeks: z.array(z.strictObject({
    bucketStartMs: z.number().check(z.int(), z.nonnegative()),
    bucketEndMs: z.number().check(z.int(), z.nonnegative()), count: z.number().check(z.int(), z.positive()),
  })),
  outcomes: z.array(z.strictObject({
    key: z.string().check(z.minLength(1)), mergedAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    attribution: z.enum(['single', 'mixed', 'unknown']),
    agentContributions: z.array(z.strictObject({
      agentId: z.nullable(z.string().check(z.minLength(1))), contributionCount: z.number().check(z.int(), z.positive()),
    })),
    leadingAgentIds: z.array(z.nullable(z.string().check(z.minLength(1)))),
  })),
}));
export type UsageMergedOutcomeSummary = z.infer<typeof UsageMergedOutcomeSummarySchema>;
export const UsageWorkSummarySchema = lazyZodSchema(() => z.strictObject({
  mergedPrCount: z.number().check(z.int(), z.nonnegative()),
}));
export type UsageWorkSummary = z.infer<typeof UsageWorkSummarySchema>;

/** The same admitted-outcome count serves rich Work and bounded summary consumers. */
export function projectUsageWorkSummary(outcomes: readonly Pick<UsageWorkOutcome, 'pullRequest'>[]): UsageWorkSummary {
  return { mergedPrCount: outcomes.filter(outcome => outcome.pullRequest.state === 'merged').length };
}

/** Consumes the canonical allocation; usage timestamps never stand in for merge dates. */
export function summarizeUsageMergedOutcomes(input: Readonly<{
  work: UsageWorkProjection; period: Readonly<{ startMs: number; endMs: number }>; timeZoneOffsetMinutes: number;
}>): UsageMergedOutcomeSummary {
  const countsByOutcome = new Map<string, Map<string | null, number>>();
  for (const allocation of input.work.allocations) {
    if (!allocation.outcome || allocation.outcome.pullRequest.state !== 'merged') continue;
    const counts = countsByOutcome.get(allocation.outcome.key) ?? new Map<string | null, number>();
    counts.set(allocation.contribution.agentId, (counts.get(allocation.contribution.agentId) ?? 0) + 1);
    countsByOutcome.set(allocation.outcome.key, counts);
  }
  const summary: UsageMergedOutcomeSummary = {
    period: { ...input.period }, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes, attributionBasis: 'contribution_count',
    linkedMergedCount: projectUsageWorkSummary(input.work.outcomes).mergedPrCount,
    mergedInPeriodCount: 0, outsidePeriodMergedCount: 0, undatedMergedCount: 0,
    mergeWeeks: [], outcomes: [],
  };
  const weeks = new Map<number, UsageMergedOutcomeSummary['mergeWeeks'][number]>();
  for (const outcome of input.work.outcomes) {
    if (outcome.pullRequest.state !== 'merged') continue;
    const mergedAtMs = outcome.pullRequest.mergedAtMs ?? null;
    if (mergedAtMs === null) summary.undatedMergedCount += 1;
    else if (mergedAtMs >= input.period.startMs && mergedAtMs < input.period.endMs) {
      summary.mergedInPeriodCount += 1;
      const bounds = resolveUsageBucketBounds('week', mergedAtMs, input.timeZoneOffsetMinutes);
      const bucketStartMs = Math.max(bounds.bucketStartMs, input.period.startMs);
      const week = weeks.get(bucketStartMs) ?? { bucketStartMs,
        bucketEndMs: Math.min(bounds.bucketEndMs, input.period.endMs), count: 0 };
      week.count += 1;
      weeks.set(bucketStartMs, week);
    } else summary.outsidePeriodMergedCount += 1;
    const agentContributions = [...(countsByOutcome.get(outcome.key) ?? [])]
      .map(([agentId, contributionCount]) => ({ agentId, contributionCount }))
      .sort((left, right) => left.agentId === right.agentId ? 0 : left.agentId === null ? 1 : right.agentId === null ? -1
        : left.agentId < right.agentId ? -1 : 1);
    const leadingCount = agentContributions.reduce((maximum, row) => Math.max(maximum, row.contributionCount), 0);
    summary.outcomes.push({ key: outcome.key, mergedAtMs,
      attribution: agentContributions.length > 1 ? 'mixed' : agentContributions[0]?.agentId == null ? 'unknown' : 'single',
      agentContributions, leadingAgentIds: agentContributions.filter(row => row.contributionCount === leadingCount).map(row => row.agentId) });
  }
  summary.mergeWeeks = [...weeks.values()].sort((left, right) => left.bucketStartMs - right.bucketStartMs);
  return summary;
}

export type UsageWorkTurnIdentity = Readonly<{ sessionId: string; turnId: string }>;
type QualifiedUsageWorkOutcome = Pick<UsageWorkOutcome, 'key' | 'repositoryKey' | 'pullRequest'>;

/** Rich Work and compact public facts share the exact witnessed outcome decision. */
export function resolveUsageWorkOutcomeAdmissions(input: Readonly<{
  turns: readonly UsageWorkTurnIdentity[]; evidence: readonly UsageWorkEvidence[];
}>): Readonly<{
  turns: readonly Readonly<{ turn: UsageWorkTurnIdentity; outcome: QualifiedUsageWorkOutcome | null;
    reason: UsageWorkAllocation['reason']; evidence: UsageWorkEvidence[] }>[];
  outcomes: readonly QualifiedUsageWorkOutcome[];
}> {
  const byTurn = new Map<string, UsageWorkEvidence[]>();
  const turnKey = (sessionId: string, turnId: string) => JSON.stringify([sessionId, turnId]);
  const admittedTurns = new Map(input.turns.map(turn => [turnKey(turn.sessionId, turn.turnId), turn]));
  const outcomeKey = (witness: UsageWorkEvidence) => JSON.stringify([witness.repositoryKey,
    witness.pullRequest.number ?? witness.pullRequest.providerNativeId ?? witness.pullRequest.url]);
  const jsonKey = (value: unknown) => createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(value));
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const ordered = [...new Map(input.evidence.filter(witness => admittedTurns.has(turnKey(witness.sessionId, witness.turnId)))
    .map(witness => [jsonKey(witness), witness])).entries()]
    .sort(([left], [right]) => compare(left, right)).map(([, witness]) => witness);
  const summaries = new Map<string, string>();
  const conflictingSummaries = new Set<string>();
  for (const witness of ordered) {
    const outcome = outcomeKey(witness);
    const summary = jsonKey(witness.pullRequest);
    const previous = summaries.get(outcome);
    if (previous !== undefined && previous !== summary) conflictingSummaries.add(outcome);
    summaries.set(outcome, summary);
    const key = turnKey(witness.sessionId, witness.turnId);
    const witnesses = byTurn.get(key) ?? [];
    witnesses.push(witness);
    byTurn.set(key, witnesses);
  }
  const outcomes = new Map<string, QualifiedUsageWorkOutcome>();
  const turns = [...admittedTurns.values()].map(turn => {
    const evidence = byTurn.get(turnKey(turn.sessionId, turn.turnId)) ?? [];
    const keys = new Set(evidence.map(outcomeKey));
    const reason: UsageWorkAllocation['reason'] = evidence.length === 0 ? 'missing_evidence'
        : keys.size !== 1 || [...keys].some(key => conflictingSummaries.has(key)) ? 'ambiguous_outcome'
          : evidence.some(witness => witness.attributionScope !== 'no_happier_checkpoint_overlap_observed') ? 'uncertain_writers'
            : 'allocated';
    if (reason !== 'allocated') return { turn, outcome: null, reason, evidence };
    const witness = evidence[0]!;
    const key = outcomeKey(witness);
    const outcome = outcomes.get(key) ?? { key, repositoryKey: witness.repositoryKey, pullRequest: witness.pullRequest };
    outcomes.set(key, outcome);
    return { turn, outcome, reason, evidence };
  });
  return { turns, outcomes: [...outcomes.values()].sort((a, b) => compare(a.key, b.key)) };
}

export function allocateUsageOutcomes(input: Readonly<{
  contributions: readonly UsageWorkContribution[]; evidence: readonly UsageWorkEvidence[];
  branchEvidence?: readonly ScmBranchWorkEvidence[];
}>): UsageWorkProjection {
  const ids = new Set<string>();
  const turnKey = (sessionId: string, turnId: string) => JSON.stringify([sessionId, turnId]);
  const turns = input.contributions.flatMap(contribution => contribution.sessionId && contribution.turnId
    ? [{ sessionId: contribution.sessionId, turnId: contribution.turnId }] : []);
  const admittedTurns = new Set(turns.map(turn => turnKey(turn.sessionId, turn.turnId)));
  const admitted = resolveUsageWorkOutcomeAdmissions({ turns, evidence: input.evidence });
  const byTurn = new Map(admitted.turns.map(row => [turnKey(row.turn.sessionId, row.turn.turnId), row]));
  const outcomes = new Map<string, UsageWorkOutcome>();
  const allocations: UsageWorkAllocation[] = input.contributions.map(contribution => {
    if (ids.has(contribution.id)) throw new Error('Resolved contribution identities must be unique');
    ids.add(contribution.id);
    const admission = contribution.sessionId && contribution.turnId
      ? byTurn.get(turnKey(contribution.sessionId, contribution.turnId)) : undefined;
    if (!admission?.outcome) return { contribution, outcome: null,
      reason: admission?.reason ?? 'missing_turn', evidence: admission?.evidence ?? [] };
    const outcome = outcomes.get(admission.outcome.key) ?? { ...admission.outcome, contributionIds: [] };
    outcome.contributionIds.push(contribution.id);
    outcomes.set(outcome.key, outcome);
    return { contribution, outcome, reason: admission.reason, evidence: admission.evidence };
  });
  const jsonKey = (value: unknown) => createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(value));
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const branchKey = (witness: ScmBranchWorkEvidence) => JSON.stringify([witness.repositoryKey, witness.branch.ref, witness.branch.headSha]);
  const branchByTurn = new Map<string, ScmBranchWorkEvidence[]>();
  for (const witness of [...new Map((input.branchEvidence ?? [])
    .filter(row => admittedTurns.has(turnKey(row.sessionId, row.turnId)))
    .map(row => [jsonKey(row), row])).entries()].sort(([a], [b]) => compare(a, b)).map(([, row]) => row)) {
    const key = turnKey(witness.sessionId, witness.turnId);
    const rows = branchByTurn.get(key) ?? [];
    rows.push(witness);
    branchByTurn.set(key, rows);
  }
  const branches = new Map<string, UsageWorkBranch & { contributionIds: string[] }>();
  const branchAllocations: UsageWorkBranchAllocation[] = input.contributions.map(contribution => {
    const evidence = contribution.sessionId && contribution.turnId
      ? branchByTurn.get(turnKey(contribution.sessionId, contribution.turnId)) ?? [] : [];
    const keys = new Set(evidence.map(branchKey));
    const reason: UsageWorkAllocation['reason'] = !contribution.sessionId || !contribution.turnId ? 'missing_turn'
      : evidence.length === 0 ? 'missing_evidence' : keys.size !== 1 ? 'ambiguous_outcome'
        : evidence.some(row => row.attributionScope !== 'no_happier_checkpoint_overlap_observed') ? 'uncertain_writers' : 'allocated';
    if (reason !== 'allocated') return { contribution, branch: null, reason, evidence };
    const witness = evidence[0]!;
    const key = branchKey(witness);
    const branch = branches.get(key) ?? { key, repositoryKey: witness.repositoryKey, branch: witness.branch, contributionIds: [] };
    branch.contributionIds.push(contribution.id);
    branches.set(key, branch);
    return { contribution, branch, reason, evidence };
  });
  return { allocations, outcomes: [...outcomes.values()].sort((a, b) => compare(a.key, b.key)),
    branchAllocations, branches: [...branches.values()].sort((a, b) => compare(a.key, b.key)) };
}
