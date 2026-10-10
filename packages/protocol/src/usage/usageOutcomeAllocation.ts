import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ScmPullRequestWorkEvidenceSchema, ScmPullRequestSummarySchema, type ScmPullRequestSummary, type ScmPullRequestWorkEvidence } from '../scm/pullRequests.js';
import { UsageAnalyticsContributionSchema, type UsageAnalyticsContribution } from './usageAnalyticsContracts.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ScmBranchWorkEvidenceSchema, ScmBranchWorkIdentitySchema, type ScmBranchWorkEvidence } from '../scm/branches.js';

/** Resolved A inputs; this projection never ingests or reconciles accounting. */
export type UsageWorkContribution = UsageAnalyticsContribution;
/** Only the authorized SCM/hosting reader may supply these witnessed relationships. */
export type UsageWorkEvidence = ScmPullRequestWorkEvidence;
export type UsageWorkOutcome = Readonly<{
  key: string; repositoryKey: string; pullRequest: ScmPullRequestSummary; contributionIds: readonly string[];
}>;
export type UsageWorkAllocation = Readonly<{
  contribution: UsageWorkContribution; outcome: UsageWorkOutcome | null;
  reason: 'allocated' | 'missing_turn' | 'missing_evidence' | 'ambiguous_outcome' | 'uncertain_writers';
  evidence: readonly UsageWorkEvidence[];
}>;
export type UsageWorkProjection = Readonly<{
  allocations: readonly UsageWorkAllocation[]; outcomes: readonly UsageWorkOutcome[];
  branchAllocations: readonly UsageWorkBranchAllocation[]; branches: readonly UsageWorkBranch[];
}>;
export type UsageWorkBranch = Readonly<{
  key: string; repositoryKey: string; branch: ScmBranchWorkEvidence['branch']; contributionIds: readonly string[];
}>;
export type UsageWorkBranchAllocation = Readonly<{
  contribution: UsageWorkContribution; branch: UsageWorkBranch | null; reason: UsageWorkAllocation['reason'];
  evidence: readonly ScmBranchWorkEvidence[];
}>;

const UsageWorkOutcomeSchema = lazyZodSchema(() => z.object({
  key: z.string().min(1), repositoryKey: z.string().min(1), pullRequest: ScmPullRequestSummarySchema,
  contributionIds: z.array(z.string().min(1)),
}).strict());
const UsageWorkBranchSchema = lazyZodSchema(() => z.object({
  key: z.string().min(1), repositoryKey: z.string().min(1), branch: ScmBranchWorkIdentitySchema,
  contributionIds: z.array(z.string().min(1)),
}).strict());
export const UsageWorkProjectionSchema = lazyZodSchema(() => z.object({
  allocations: z.array(z.object({
    contribution: UsageAnalyticsContributionSchema, outcome: UsageWorkOutcomeSchema.nullable(),
    reason: z.enum(['allocated', 'missing_turn', 'missing_evidence', 'ambiguous_outcome', 'uncertain_writers']),
    evidence: z.array(ScmPullRequestWorkEvidenceSchema),
  }).strict()),
  outcomes: z.array(UsageWorkOutcomeSchema),
  branchAllocations: z.array(z.object({
    contribution: UsageAnalyticsContributionSchema, branch: UsageWorkBranchSchema.nullable(),
    reason: z.enum(['allocated', 'missing_turn', 'missing_evidence', 'ambiguous_outcome', 'uncertain_writers']),
    evidence: z.array(ScmBranchWorkEvidenceSchema),
  }).strict()),
  branches: z.array(UsageWorkBranchSchema),
}).strict().superRefine((projection, context) => {
  try {
    const canonical = allocateUsageOutcomes({ contributions: projection.allocations.map(row => row.contribution),
      evidence: projection.allocations.flatMap(row => row.evidence),
      branchEvidence: projection.branchAllocations.flatMap(row => row.evidence) });
    if (sameStrictJsonValue(projection, canonical)) return;
  } catch { /* Invalid contribution identities are rejected at this public boundary. */ }
  context.addIssue({ code: 'custom', message: 'Work must identify the canonical witnessed allocation' });
}));

export function allocateUsageOutcomes(input: Readonly<{
  contributions: readonly UsageWorkContribution[]; evidence: readonly UsageWorkEvidence[];
  branchEvidence?: readonly ScmBranchWorkEvidence[];
}>): UsageWorkProjection {
  const ids = new Set<string>();
  const byTurn = new Map<string, UsageWorkEvidence[]>();
  const turnKey = (sessionId: string, turnId: string) => JSON.stringify([sessionId, turnId]);
  const admittedTurns = new Set(input.contributions.flatMap(contribution => contribution.sessionId && contribution.turnId
    ? [turnKey(contribution.sessionId, contribution.turnId)] : []));
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
  const outcomes = new Map<string, UsageWorkOutcome & { contributionIds: string[] }>();
  const allocations: UsageWorkAllocation[] = input.contributions.map(contribution => {
    if (ids.has(contribution.id)) throw new Error('Resolved contribution identities must be unique');
    ids.add(contribution.id);
    const evidence = contribution.sessionId && contribution.turnId
      ? byTurn.get(turnKey(contribution.sessionId, contribution.turnId)) ?? [] : [];
    const keys = new Set(evidence.map(outcomeKey));
    const reason: UsageWorkAllocation['reason'] = !contribution.turnId || !contribution.sessionId ? 'missing_turn'
      : evidence.length === 0 ? 'missing_evidence'
        : keys.size !== 1 || [...keys].some(key => conflictingSummaries.has(key)) ? 'ambiguous_outcome'
          : evidence.some(witness => witness.attributionScope !== 'no_happier_checkpoint_overlap_observed') ? 'uncertain_writers'
            : 'allocated';
    if (reason !== 'allocated') return { contribution, outcome: null, reason, evidence };
    const witness = evidence[0]!;
    const key = outcomeKey(witness);
    const outcome = outcomes.get(key) ?? { key, repositoryKey: witness.repositoryKey,
      pullRequest: witness.pullRequest, contributionIds: [] };
    outcome.contributionIds.push(contribution.id);
    outcomes.set(key, outcome);
    return { contribution, outcome, reason, evidence };
  });
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
