import { describe, expect, it } from 'vitest';
import { loadManagedSessionDefaultsContextV1, type ManagedSessionDefaultsContextLoaderV1 } from './loadManagedSessionDefaultsContextV1.js';

describe('demanded project Session defaults context', () => {
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

  it('propagates an admitted Source refusal without reading another defaults scope', async () => {
    let governanceReads = 0;
    const ports: ManagedSessionDefaultsContextLoaderV1 = {
      readPersonalDefaults: async () => null,
      readSource: async () => ({ ok: false, error: 'source_access_denied' }),
      readTeam: async () => { governanceReads += 1; return { id: 'unused', policy: {} }; },
      readHome: async () => { governanceReads += 1; return { homeDefaults: null }; },
    };
    await expect(loadManagedSessionDefaultsContextV1({ sourceRef: { serverId: 'home', sourceId: 'linked' } }, ports))
      .rejects.toMatchObject({ errorCode: 'source_access_denied' });
    expect(governanceReads).toBe(0);
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
    expect(loaded.context).toMatchObject({ projectDefaults: { approvalProfileId: null }, teamDefaults: null });
    expect(loaded.canManageSource).toBe(false);
  });
});
