import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';

describe('approval principal references', () => {
  it.each(['teams.members.remove', 'teams.members.role.set', 'teams.members.suspend', 'teams.members.reactivate',
    'teams.members.management.set'])('identifies the exact Team membership operand for %s', actionId => {
    const rows = describeApprovalActionFields({ actionId,
      actionArgs: { v: 1, teamId: 'team-1', membershipId: 'membership-1', role: 'member', management: { kind: 'native' } } }).rows;
    expect(rows.find(row => row.path === 'membershipId')).toHaveProperty('reference',
      { kind: 'teamMembership', id: 'membership-1', teamId: 'team-1' });
  });

  it.each(['account', 'team', 'group'])('identifies %s access principals without borrowing a Session identity', (kind) => {
    const principal = { kind, ...(kind === 'group' ? { teamId: 'team-1' } : {}), [`${kind}Id`]: 'session-shaped-id' };
    const rows = describeApprovalActionFields({ actionId: 'machines.access.grant.set',
      actionArgs: { serverId: 'home', machineId: 'machine', principal, level: 'view' } }).rows;
    expect(rows.find(row => row.path === 'principal')).toMatchObject({ kind: 'value', path: 'principal', value: JSON.stringify(principal) });
    expect(rows.find(row => row.path === 'principal')).toHaveProperty('reference', {
      kind, id: 'session-shaped-id', ...(kind === 'group' ? { teamId: 'team-1' } : {}),
    });
  });

  it('projects each public preview audience principal as one readable reference', () => {
    const audience = [{ kind: 'account', accountId: 'person' }, { kind: 'team', teamId: 'team' },
      { kind: 'group', teamId: 'team', groupId: 'group' }];
    const row = describeApprovalActionFields({ actionId: 'localServices.publicPreview.create', actionArgs: {
      machineId: 'machine', sessionId: 'session', previewId: 'preview', mode: 'people', audience,
      ttlMs: 600_000, confirmation: { acknowledged: true },
    } }).rows.find(row => row.path === 'audience');
    expect(row?.kind === 'value' && row.entries?.map(entry => entry.reference)).toEqual([
      { kind: 'account', id: 'person' }, { kind: 'team', id: 'team' }, { kind: 'group', id: 'group', teamId: 'team' },
    ]);
  });

  it('names the Team and Group a Team membership Action acts in, so their raw ids leave Details', () => {
    const rows = describeApprovalActionFields({ actionId: 'teams.groups.members.remove',
      actionArgs: { v: 1, teamId: 'team-1', groupId: 'group-1', accountId: 'account-1' } }).rows;
    expect(rows.find(row => row.path === 'teamId')).toMatchObject({ reference: { kind: 'team', id: 'team-1' },
      // The Group reads with its Team, so the Team row moves to Technical details rather than repeating it.
      technical: true });
    expect(rows.find(row => row.path === 'groupId')).toHaveProperty('reference', { kind: 'group', id: 'group-1', teamId: 'team-1' });
    expect(rows.find(row => row.path === 'accountId')).toHaveProperty('reference', { kind: 'account', id: 'account-1' });
    // `groupId` is not a Team Group outside Team Actions (a widget group, a paused commit).
    const commitRow = describeApprovalActionFields({ actionId: 'scm.diffSummary.commitPlan.includeHookChanges',
      actionArgs: { cwd: '/repo', resultId: 'result', expectedRevision: 2, groupId: 'first', teamId: 'team-1',
        beforeTreeOid: '1'.repeat(40), afterTreeOid: '2'.repeat(40) } }).rows.find(row => row.path === 'groupId');
    expect(commitRow).not.toHaveProperty('reference');
  });
});
