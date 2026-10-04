import { describe, expect, it } from 'vitest';
import type { ScmComparison, ScmDiffSummaryCommitPlan } from '@happier-dev/protocol/scm';
import { projectScmCommitPlanGroupSelection, reconcileScmCommitPlanGroupSelection, selectScmCommitPlanGroupIntent } from './commitPlanSelection';

const comparison: ScmComparison = { id: 'pending', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{ path: 'src/a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '' }, occurrences: ['first', 'second'].map((id, position) => ({ id, alias: `alias-${id}`, path: 'src/a.ts', before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 }, position })) }] } };
const plan: ScmDiffSummaryCommitPlan = { groups: [{ id: 'one', message: 'First', rationale: '', changeRefs: ['second'] }, { id: 'two', message: 'Second', rationale: '', changeRefs: ['first'] }], leftOutChangeRefs: [] };
describe('compact commit proposal selection', () => {
  it('selects exact occurrences first and opens only on the selected group second tap', () => {
    const first = selectScmCommitPlanGroupIntent(null, { resultId: 'saved', comparison, plan, groupId: 'one' });
    expect(first).toEqual({ kind: 'select', selection: { resultId: 'saved', comparisonId: 'pending', groupId: 'one', changeRefs: ['second'], paths: ['src/a.ts'] } });
    expect(selectScmCommitPlanGroupIntent(first.selection, { resultId: 'saved', comparison, plan, groupId: 'one' }).kind).toBe('open');
    expect(selectScmCommitPlanGroupIntent(first.selection, { resultId: 'saved', comparison, plan, groupId: 'two' }).kind).toBe('select');
  });
  it('retains stable selection across prose revisions and clears removed or changed groups', () => {
    const selected = projectScmCommitPlanGroupSelection({ resultId: 'saved', comparison, plan, groupId: 'one' })!;
    expect(selected).not.toBeNull();
    expect(reconcileScmCommitPlanGroupSelection(selected, { resultId: 'saved', comparison, plan: { ...plan, groups: plan.groups.map((group) => ({ ...group, message: 'Edited' })) } })).toBe(selected);
    expect(reconcileScmCommitPlanGroupSelection(selected, { resultId: 'saved', comparison, plan: { ...plan, groups: plan.groups.slice(1) } })).toBeNull();
    expect(reconcileScmCommitPlanGroupSelection(selected, { resultId: 'saved', comparison, plan: { ...plan, groups: [{ ...plan.groups[0], changeRefs: ['first'] }] } })).toBeNull();
  });
  it('rejects aliases, foreign occurrences and historical comparisons', () => {
    for (const changeRefs of [['alias-second'], ['foreign']]) expect(projectScmCommitPlanGroupSelection({ resultId: 'saved', comparison, plan: { ...plan, groups: [{ ...plan.groups[0], changeRefs }] }, groupId: 'one' })).toBeNull();
    expect(projectScmCommitPlanGroupSelection({ resultId: 'saved', comparison: { ...comparison, source: { kind: 'commit', commit: 'abc' } }, plan, groupId: 'one' })).toBeNull();
  });
});
