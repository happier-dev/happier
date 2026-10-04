import { describe, expect, it } from 'vitest';
import { ScmDiffSummaryResultEditSchema } from './diffSummaryResult.js';

describe('saved commit-plan edit admission', () => {
  it('admits explicit group edits and closes every mutation envelope', () => {
    const move = { kind: 'moveCommitChanges', changeRefs: ['exact-change'], target: { kind: 'newGroup',
      group: { id: 'group', message: 'fix: change', rationale: '' } } };
    expect(ScmDiffSummaryResultEditSchema.safeParse(move).success).toBe(true);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ ...move, accepted: true }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ ...move, target: { ...move.target, command: 'commit' } }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ ...move, target: { ...move.target,
      group: { ...move.target.group, changeRefs: ['hidden-change'] } } }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'editCommitGroup', groupId: 'group', rationale: '' }).success).toBe(true);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'editCommitGroup', groupId: 'group' }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'editCommitGroup', groupId: 'group', message: ' ' }).success).toBe(false);
  });

  it('rejects repeated move references and group identities before owner mutation', () => {
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'moveCommitChanges', changeRefs: ['change', 'change'],
      target: { kind: 'leftOut' } }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'reorderCommitGroups', groupIds: ['group', 'group'] }).success).toBe(false);
    expect(ScmDiffSummaryResultEditSchema.safeParse({ kind: 'mergeCommitGroups', groupIds: ['group', 'group'], targetGroupId: 'group' }).success).toBe(false);
  });
});
