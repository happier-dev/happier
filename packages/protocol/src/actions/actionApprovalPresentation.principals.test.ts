import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';

describe('approval principal references', () => {
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
});
