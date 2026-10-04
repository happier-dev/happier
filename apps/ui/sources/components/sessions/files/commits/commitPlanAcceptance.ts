import {
    isScmCommitPlanApplicationLocked,
    type ScmCommitPlanAcceptance,
    type ScmCommitPlanApplication,
    type ScmComparison,
    type ScmDiffSummaryCommitPlan,
} from '@happier-dev/protocol';

/** Bind explicit acceptance to captured mutation authority and the verified remaining suffix. */
export function buildCommitPlanAcceptance(input: Readonly<{
    comparison: ScmComparison;
    plan: ScmDiffSummaryCommitPlan;
    application: ScmCommitPlanApplication | null;
}>): ScmCommitPlanAcceptance | null {
    const { comparison, plan, application } = input;
    if (comparison.source.kind !== 'workingTree' || !comparison.commitTarget) return null;
    if (isScmCommitPlanApplicationLocked(application ?? undefined)) return null;
    const landed = new Map<string, string>();
    for (const step of application?.steps ?? []) {
        if (step.state === 'published' && step.commitSha) landed.set(step.groupId, step.commitSha);
    }
    const remaining = plan.groups.filter((group) => !landed.has(group.id));
    if (remaining.length === 0 || remaining.some((group) => group.changeRefs.length === 0)) return null;
    const lastLanded = [...plan.groups].reverse().find((group) => landed.has(group.id));
    return {
        comparisonId: comparison.id,
        repositoryRootPath: comparison.repository.rootPath,
        expectedHeadOid: lastLanded ? landed.get(lastLanded.id)! : comparison.commitTarget.headOid,
        expectedRef: comparison.commitTarget.ref,
        groups: remaining,
        leftOutChangeRefs: plan.leftOutChangeRefs,
    };
}
