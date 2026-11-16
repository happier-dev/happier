import { describe, expect, it } from 'vitest';

import type {
  ManagedDefaultsV1,
  ManagedSessionDefaultsV1,
} from '@happier-dev/protocol/teams';

import {
  buildMemberDefaultsPatch,
  memberDefaultsAccess,
  memberDefaultsConflicts,
  memberDefaultsSummary,
  readMemberDefaults,
  withPermissionMode,
  withPlacement,
} from './memberDefaults';

const CLAUDE = 'claude';
const machineA = {
  kind: 'machine',
  target: { serverId: 'home-a', machineId: 'machine-a' },
} as const;
const machineB = {
  kind: 'machine',
  target: { serverId: 'home-a', machineId: 'machine-b' },
} as const;

function stored(overrides: Partial<ManagedDefaultsV1> = {}): ManagedDefaultsV1 {
  return {
    team: { permissionModeByAgentTargetKey: { [CLAUDE]: 'read-only' } },
    groups: {
      design: { placement: machineA },
      platform: {
        placement: machineB,
        permissionModeByAgentTargetKey: { [CLAUDE]: 'safe-yolo' },
      },
    },
    ...overrides,
  };
}

describe('member defaults', () => {
  it('saves a Team edit as a whole Team replacement that keeps every Group default', () => {
    const current = stored();
    const next = withPlacement(
      readMemberDefaults(current, { kind: 'team' }),
      machineA,
    );
    expect(buildMemberDefaultsPatch(current, { kind: 'team' }, next)).toEqual({
      managedDefaults: {
        team: {
          permissionModeByAgentTargetKey: { [CLAUDE]: 'read-only' },
          placement: machineA,
        },
        groups: current.groups,
      },
    });
  });

  it("saves a Group edit as that Group's patch only, and clears it when nothing is left", () => {
    const current = stored();
    const scope = { kind: 'group', groupId: 'design' } as const;
    const changed = withPermissionMode(
      readMemberDefaults(current, scope),
      CLAUDE,
      'plan',
    );
    expect(buildMemberDefaultsPatch(current, scope, changed)).toEqual({
      managedGroupDefaults: {
        teamGroupId: 'design',
        defaults: {
          placement: machineA,
          permissionModeByAgentTargetKey: { [CLAUDE]: 'plan' },
        },
      },
    });
    const cleared = withPlacement(
      readMemberDefaults(current, scope),
      undefined,
    );
    expect(buildMemberDefaultsPatch(current, scope, cleared)).toEqual({
      managedGroupDefaults: { teamGroupId: 'design', defaults: null },
    });
  });

  it('removes an Agent entry entirely when its last default is cleared', () => {
    const team: ManagedSessionDefaultsV1 = {
      permissionModeByAgentTargetKey: { [CLAUDE]: 'read-only' },
    };
    expect(withPermissionMode(team, CLAUDE, undefined)).toEqual({});
  });

  it('reads no defaults (None) for a Team that has never set any', () => {
    expect(readMemberDefaults(null, { kind: 'team' })).toEqual({});
    expect(
      readMemberDefaults(null, { kind: 'group', groupId: 'design' }),
    ).toEqual({});
  });

  it('lets Team settings managers edit Team defaults and says why others cannot', () => {
    expect(
      memberDefaultsAccess(
        { kind: 'team' },
        { manageSettings: true, manageGroups: false },
      ),
    ).toEqual({ editable: true });
    expect(
      memberDefaultsAccess(
        { kind: 'team' },
        { manageSettings: false, manageGroups: true },
      ),
    ).toEqual({ editable: false, reason: 'team' });
  });

  it("lets Group managers edit a Group's defaults only when they manage that Group", () => {
    const scope = { kind: 'group', groupId: 'design' } as const;
    expect(
      memberDefaultsAccess(
        scope,
        { manageSettings: false, manageGroups: true },
        { manageNativeMembers: true },
      ),
    ).toEqual({ editable: true });
    expect(
      memberDefaultsAccess(
        scope,
        { manageSettings: true, manageGroups: true },
        { manageNativeMembers: false },
      ),
    ).toEqual({ editable: false, reason: 'group' });
    expect(
      memberDefaultsAccess(
        scope,
        { manageSettings: true, manageGroups: false },
        { manageNativeMembers: true },
      ),
    ).toEqual({ editable: false, reason: 'group' });
  });

  it('reports Group disagreement the way the precedence reader decides it', () => {
    const current = stored();
    const team = memberDefaultsConflicts(current, { kind: 'team' }, CLAUDE);
    expect(team.placement).toBe(true);
    // Only one Group sets a permission mode, so nothing disagrees.
    expect(team.permissionMode).toBe(false);

    const design = memberDefaultsConflicts(
      current,
      { kind: 'group', groupId: 'design' },
      CLAUDE,
    );
    expect(design.placement).toBe(true);
    const agreeing = stored({
      groups: {
        design: { placement: machineA },
        platform: { placement: machineA },
      },
    });
    expect(
      memberDefaultsConflicts(
        agreeing,
        { kind: 'group', groupId: 'design' },
        CLAUDE,
      ).placement,
    ).toBe(false);
  });

  it('names the connected-service purpose whose Group defaults disagree, even when nothing else sets it', () => {
    const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' };
    const service = { pluginId: 'happier.connect.github', localId: 'github' };
    const binding = (purpose: string, resourceId: string) => ({
      purpose: { consumer, purpose },
      service,
      target: null,
      // The reader compares values structurally; the selection's own shape is not under test.
      teamResource: { teamId: 'team-1', selection: { resourceId } as never },
    });
    const current = stored({
      groups: {
        design: { connectedServicesByAgentTargetKey: { [CLAUDE]: [binding('git', 'r1'), binding('api', 'r9')] } },
        platform: { connectedServicesByAgentTargetKey: { [CLAUDE]: [binding('git', 'r2'), binding('api', 'r9')] } },
      },
    });
    const conflicts = [...memberDefaultsConflicts(current, { kind: 'team' }, CLAUDE).connectedServices];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('git');
  });
});

describe('memberDefaultsSummary', () => {
  it('says nothing is set for an empty layer', () => {
    expect(memberDefaultsSummary({})).toEqual({ machine: false, agents: 0 });
  });

  it('counts each Agent once whatever it sets, and the Machine apart', () => {
    expect(memberDefaultsSummary({
      placement: machineA,
      permissionModeByAgentTargetKey: { [CLAUDE]: 'read-only', codex: 'read-only' },
      modelByAgentTargetKey: { [CLAUDE]: {} as never, cursor: {} as never },
      connectedServicesByAgentTargetKey: { gemini: [], opencode: [{ purpose: 'git' } as never] },
    } as ManagedSessionDefaultsV1)).toEqual({ machine: true, agents: 4 });
  });
});
