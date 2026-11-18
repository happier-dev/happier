import { describe, expect, it } from 'vitest';
import { loadManagedSessionDefaultsContextV1, ProjectSessionDefaultsGetOutputV1Schema, type ManagedSessionDefaultsContextLoaderV1 } from './loadManagedSessionDefaultsContextV1.js';
import { ManagedSessionDefaultsV1Schema } from '../teams/managedSessionDefaultsV1.js';

describe('demanded project Session defaults context', () => {
  it('omits an unavailable Home reader while retaining captured Machine defaults', async () => {
    const loaded = await loadManagedSessionDefaultsContextV1({ creationMachineApprovalProfileId: 'captured-machine' }, {
      readSource: async () => { throw new Error('no Source selected'); },
      readTeam: async () => { throw new Error('no Team selected'); },
    });
    expect(loaded.context.homeDefaults).toBeNull();
    expect(loaded.context.memberDefaults?.approvalProfileId).toBe('captured-machine');
  });

  it('notes an unexpected Source failure while retaining available Home and captured Machine defaults', async () => {
    const loaded = await loadManagedSessionDefaultsContextV1({ sourceRef: { serverId: 'home', sourceId: 'selected' },
      creationMachineApprovalProfileId: 'captured-machine' }, {
      readSource: async () => { throw new Error('network disconnected'); },
      readHome: async () => ({ homeDefaults: { approvalProfileId: 'home-profile' } }),
    });
    expect(loaded.context.homeDefaults).toEqual({ approvalProfileId: 'home-profile' });
    expect(loaded.context.memberDefaults?.approvalProfileId).toBe('captured-machine');
    expect(loaded.unavailableDefaults).toMatchObject([{ errorCode: 'defaults_unavailable', effectAttempted: false }]);
    expect(loaded.source).toBeNull();
    expect(loaded.canManageSource).toBe(false);
  });

  it('keeps admitted Project and Team layers when the personal row is unreadable', async () => {
    const loaded = await loadManagedSessionDefaultsContextV1({ projectRef: { serverId: 'home', projectKey: 'private' },
      sourceRef: { serverId: 'home', sourceId: 'selected' } }, {
      readPersonalDefaults: async () => { throw new Error('private key unavailable'); },
      readSource: async () => ({ ok: true, source: { id: 'selected', name: 'Shared', revision: 1,
        owner: { kind: 'team', teamId: 'owner-team' } }, canManage: false,
        sessionDefaults: { revision: 1, defaults: { approvalProfileId: 'project-profile' } } }),
      readTeam: async id => ({ id, policy: { managedDefaults: { team: { approvalProfileId: 'team-profile' }, groups: {} } } }),
    });
    expect(loaded.personalDefaultsRow).toBeNull();
    expect(loaded.context.projectDefaults).toEqual({ approvalProfileId: 'project-profile' });
    expect(loaded.context.teamDefaults?.team).toEqual({ approvalProfileId: 'team-profile' });
    expect(loaded.unavailableDefaults).toMatchObject([{ errorCode: 'defaults_unavailable', effectAttempted: false }]);
  });

  it('retains member and captured Machine defaults when Home is unreadable', async () => {
    const memberDefaults = ManagedSessionDefaultsV1Schema.parse({ permissionModeByAgentTargetKey: {
      'agent:happier.agent.codex/codex': 'read-only',
    } });
    const loaded = await loadManagedSessionDefaultsContextV1({ memberDefaults,
      creationMachineApprovalProfileId: 'captured-machine' }, {
      readSource: async () => { throw new Error('no Source selected'); },
      readHome: async () => { throw new Error('Home unreachable'); },
    });
    expect(loaded.context.homeDefaults).toBeNull();
    expect(loaded.context.memberDefaults).toEqual({ ...memberDefaults, approvalProfileId: 'captured-machine' });
    expect(loaded.unavailableDefaults).toMatchObject([{ errorCode: 'defaults_unavailable', effectAttempted: false }]);
    expect(ProjectSessionDefaultsGetOutputV1Schema.parse(loaded)).toEqual(loaded);
  });

  it('skips unavailable requester-private rows while retaining admitted Project and Team defaults', async () => {
    const loaded = await loadManagedSessionDefaultsContextV1({
      projectRef: { serverId: 'home', projectKey: 'private-project' },
      sourceRef: { serverId: 'home', sourceId: 'shared-project' },
      creationMachineApprovalProfileId: 'machine-profile',
    }, {
      // No requester custody means there is no private reader to invoke.
      readSource: async () => ({ ok: true, source: { id: 'shared-project', name: 'Shared', revision: 1,
        owner: { kind: 'team', teamId: 'owner-team' } }, canManage: false,
        sessionDefaults: { revision: 1, defaults: { approvalProfileId: 'project-profile' } } }),
      readTeam: async teamId => ({ id: teamId, policy: {
        managedDefaults: { team: { approvalProfileId: 'team-profile' }, groups: {} },
        homeDefaults: { approvalProfileId: 'home-profile' },
      } }),
      readHome: async () => { throw new Error('selected Team supplies Home defaults'); },
    });
    expect(loaded.personalDefaultsRow).toBeNull();
    expect(loaded.context).toMatchObject({ personalProjectDefaults: null,
      projectDefaults: { approvalProfileId: 'project-profile' },
      teamDefaults: { team: { approvalProfileId: 'team-profile' } },
      homeDefaults: { approvalProfileId: 'home-profile' },
      memberDefaults: { approvalProfileId: 'machine-profile' }, memberApprovalProfileSource: 'machine' });
  });

  it('loads only selected addresses and uses the linked owner Team even without a defaults leaf', async () => {
    const reads: string[] = [];
    // Storage and governance I/O are the loader's boundaries. Context and
    // precedence remain the real shared owners under those boundary adapters.
    const ports: ManagedSessionDefaultsContextLoaderV1 = {
      readPersonalDefaults: async project => { reads.push(`personal:${project.projectKey}`); return null; },
      readSource: async source => {
        reads.push(`source:${source.sourceId}`);
        return { ok: true, source: { id: source.sourceId, name: 'Selected', revision: 1,
          owner: { kind: 'team', teamId: 'owner-team' } }, canManage: false };
      },
      readTeam: async teamId => { reads.push(`team:${teamId}`); return { id: teamId, policy: {} }; },
      readHome: async () => { reads.push('home'); return { homeDefaults: null }; },
    };
    const loaded = await loadManagedSessionDefaultsContextV1({
      projectRef: { serverId: 'home', projectKey: 'selected' }, sourceRef: { serverId: 'home', sourceId: 'linked' },
      sharedTeamIds: ['different-audience'],
    }, ports);
    expect(loaded.context.primaryTeamId).toBe('owner-team');
    expect(loaded.context.projectDefaults).toBeNull();
    expect(reads).toEqual(['personal:selected', 'source:linked', 'team:owner-team']);
  });

  it('uses explicit Team selection without discarding the admitted Project Source layer', async () => {
    const ports: ManagedSessionDefaultsContextLoaderV1 = {
      readPersonalDefaults: async () => ({ revision: 4, defaults: {} }),
      readSource: async () => ({ ok: true, source: { id: 'linked', name: 'Selected', revision: 1,
        owner: { kind: 'team', teamId: 'owner-team' } },
        // An audience Team admin manages metadata but never the owner side's defaults.
        canManage: true, canManageSessionDefaults: false, sessionDefaults: { revision: 2, defaults: {} } }),
      readTeam: async teamId => ({ id: teamId, policy: {} }),
      readHome: async () => { throw new Error('Team context must not load Home independently'); },
    };
    const loaded = await loadManagedSessionDefaultsContextV1({ primaryTeamId: 'explicit-team',
      projectRef: { serverId: 'home', projectKey: 'selected' }, sourceRef: { serverId: 'home', sourceId: 'linked' },
    }, ports);
    expect(loaded.context.primaryTeamId).toBe('explicit-team');
    // Owner ruling 2026-11-16: Source admission determines project defaults;
    // selecting a different Team changes only the general Team/Group context.
    expect(loaded.context.projectDefaults).toEqual({});
    expect(loaded.personalDefaultsRow).toEqual({ revision: 4, defaults: {} });
    expect(loaded.canManageSource).toBe(false);
  });

  it('notes an optional Source refusal without disclosing its identity or edit authority', async () => {
    const loaded = await loadManagedSessionDefaultsContextV1({ sourceRef: { serverId: 'home', sourceId: 'linked' } }, {
      readSource: async () => ({ ok: false, error: 'source_access_denied' }),
      readHome: async () => ({ homeDefaults: { approvalProfileId: 'available-home' } }),
    });
    expect(loaded.context.homeDefaults).toEqual({ approvalProfileId: 'available-home' });
    expect(loaded.source).toBeNull();
    expect(loaded.canManageSource).toBe(false);
    expect(loaded.unavailableDefaults).toMatchObject([{ errorCode: 'source_access_denied', effectAttempted: false }]);
  });

  it('applies an admitted Account-owned Source layer without acquiring a Team projection', async () => {
    const ports: ManagedSessionDefaultsContextLoaderV1 = {
      readPersonalDefaults: async () => null,
      readSource: async () => ({ ok: true, source: { id: 'linked', name: 'Selected', revision: 1,
        owner: { kind: 'account', accountId: 'source-owner' } },
        canManage: true, canManageSessionDefaults: true, sessionDefaults: { revision: 1, defaults: {} } }),
      readTeam: async () => { throw new Error('Account-owned Source does not select a Team'); },
      readHome: async () => ({ homeDefaults: null }),
    };
    const loaded = await loadManagedSessionDefaultsContextV1({ sourceRef: { serverId: 'home', sourceId: 'linked' } }, ports);
    expect(loaded.context.primaryTeamId).toBeNull();
    expect(loaded.context.projectDefaults).toEqual({});
    expect(loaded.canManageSource).toBe(true);
  });

  it('retains admitted Source defaults when its owner Team projection is inaccessible', async () => {
    const loaded = await loadManagedSessionDefaultsContextV1({ sourceRef: { serverId: 'home', sourceId: 'linked' } }, {
      readPersonalDefaults: async () => null,
      readSource: async () => ({ ok: true, source: { id: 'linked', name: 'Shared Project', revision: 1,
        owner: { kind: 'team', teamId: 'owner-team' } }, canManage: false,
        sessionDefaults: { revision: 1, defaults: { approvalProfileId: null } } }),
      readTeam: async () => ({ ok: false, errorCode: 'team_not_found', error: 'team_not_found' }),
      readHome: async () => ({ homeDefaults: null }),
    });
    expect(loaded.context).toMatchObject({ primaryTeamId: 'owner-team', projectDefaults: { approvalProfileId: null }, teamDefaults: null });
    expect(loaded.unavailableDefaults).toMatchObject([{ errorCode: 'team_not_found' }]);
    expect(loaded.canManageSource).toBe(false);
  });
});
