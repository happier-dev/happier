import type { ScmComparison, ScmDiffSummaryCommitPlan } from '@happier-dev/protocol/scm';
import { selectScmCommitPlanGroup } from '@happier-dev/protocol/scm';

export type ScmCommitPlanGroupSelection = Readonly<{
  resultId: string; comparisonId: string; groupId: string;
  changeRefs: readonly string[]; paths: readonly string[];
}>;
type Proposal = Readonly<{ resultId: string; comparison: ScmComparison; plan: ScmDiffSummaryCommitPlan }>;
export function projectScmCommitPlanGroupSelection(proposal: Proposal & Readonly<{ groupId: string }>): ScmCommitPlanGroupSelection | null {
  if (proposal.comparison.source.kind !== 'workingTree') return null;
  const group = selectScmCommitPlanGroup(proposal.plan, proposal.groupId);
  if (!group) return null;
  const pathsByRef = new Map(proposal.comparison.inventory.files.flatMap((file) => file.occurrences.map((occurrence) => [occurrence.id, file.path] as const)));
  const paths = new Set<string>();
  for (const ref of group.changeRefs) {
    const path = pathsByRef.get(ref);
    if (!path) return null;
    paths.add(path);
  }
  return { resultId: proposal.resultId, comparisonId: proposal.comparison.id, groupId: group.groupId, changeRefs: group.changeRefs, paths: [...paths] };
}
function sameSelection(left: ScmCommitPlanGroupSelection, right: ScmCommitPlanGroupSelection): boolean {
  return left.resultId === right.resultId && left.comparisonId === right.comparisonId && left.groupId === right.groupId
    && left.changeRefs.length === right.changeRefs.length && left.changeRefs.every((ref, index) => ref === right.changeRefs[index])
    && left.paths.length === right.paths.length && left.paths.every((path, index) => path === right.paths[index]);
}
export function reconcileScmCommitPlanGroupSelection(selection: ScmCommitPlanGroupSelection | null, proposal: Proposal): ScmCommitPlanGroupSelection | null {
  if (!selection) return null;
  const projected = projectScmCommitPlanGroupSelection({ ...proposal, groupId: selection.groupId });
  return projected && sameSelection(selection, projected) ? selection : null;
}
export function selectScmCommitPlanGroupIntent(selection: ScmCommitPlanGroupSelection | null, proposal: Proposal & Readonly<{ groupId: string }>):
  Readonly<{ kind: 'select' | 'open'; selection: ScmCommitPlanGroupSelection }> | Readonly<{ kind: 'none'; selection: null }> {
  const projected = projectScmCommitPlanGroupSelection(proposal);
  if (!projected) return { kind: 'none', selection: null };
  return { kind: selection && sameSelection(selection, projected) ? 'open' : 'select', selection: projected };
}
