import { describe, expect, it, vi } from 'vitest';

describe('Team credential action registry import lifetime', () => {
  it.each(['resource', 'actions'] as const)('admits %s-first imports and preserves strict action parsing', async (first) => {
    vi.resetModules();
    // SDK activation and the action catalog enter this cycle from opposite owners.
    if (first === 'resource') await import('./resourceV1.js');
    else await import('./actionsV1.js');
    const resource = await import('./resourceV1.js');
    const actions = await import('./actionsV1.js');
    const input = actions.TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1['teams.credentials.list'];
    const output = actions.TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1['teams.credentials.list'];

    expect(input).toBe(resource.TeamCredentialResourceListInputV1Schema);
    expect(input.parse({ teamId: 'team-1' })).toEqual({ teamId: 'team-1', limit: 50, filter: 'all' });
    expect(input.safeParse({ teamId: 'team-1', unknown: true }).success).toBe(false);
    expect(output).toBe(resource.TeamCredentialResourcePageV1Schema);
    expect(output.parse({ resources: [], viewer: { manageCredentials: false, offerOwnCredential: false } }))
      .toEqual({ resources: [], viewer: { manageCredentials: false, offerOwnCredential: false }, nextCursor: null });
    expect(output.safeParse({ resources: [], viewer: { manageCredentials: false, offerOwnCredential: false }, unknown: true }).success)
      .toBe(false);
    expect(Object.keys(actions.TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)).toEqual(actions.TEAM_CREDENTIAL_ACTION_IDS_V1);
    expect(Object.keys(actions.TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)).toEqual(actions.TEAM_CREDENTIAL_ACTION_IDS_V1);
  });
});
