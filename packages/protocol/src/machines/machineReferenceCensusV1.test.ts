import { describe, expect, it } from 'vitest';
import type { AutomationDefinitionListResponse } from '../automations/automationApiV3.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';
import type { ProfileCatalogSnapshotV1 } from '../profiles/profileCatalogV1.js';
import type { MachinePoolListOutputV1 } from './pools/v1.js';
import { readMachineReferenceCensusV1, type MachineReferenceCensusPortsV1 } from './machineReferenceCensusV1.js';

describe('readMachineReferenceCensusV1', () => {
  it('pages exact qualified deployment references and keeps unavailable deployment coverage partial', async () => {
    const selections: unknown[] = [];
    const ports: MachineReferenceCensusPortsV1 = {
      artifacts: { list: async () => ({ coverage: 'complete', items: [] }), read: async () => null, readMany: async () => [] },
      readSettings: async () => ({}),
      readProfileCatalog: async () => ({ status: 'ready', source: 'destination', records: [], diagnostics: [],
        referenceGuardRevision: 'absent', authority: 'active', control: null, controlRevision: 'absent' }),
      readPools: async () => ({ pools: [] }), readAssignments: async () => ({ automations: [], nextCursor: null }),
      readDeployments: async selection => {
        selections.push(selection);
        return { homeId: 'home', machineId: 'machine', coverage: 'complete',
          references: [{ kind: 'deployment_environment', id: selection.cursor ? 'retained' : 'current', name: '',
            deploymentRoles: selection.cursor ? ['retiring', 'detached'] : ['runtime', 'data', 'controller', 'build', 'edge'] }],
          nextCursor: selection.cursor ? null : 'current' };
      },
    };
    const result = await readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine' }, ports);
    expect(result).toMatchObject({ coverage: 'complete', unavailable: [], references: [
      { kind: 'deployment_environment', id: 'current', deploymentRoles: ['runtime', 'data', 'controller', 'build', 'edge'] },
      { kind: 'deployment_environment', id: 'retained', deploymentRoles: ['retiring', 'detached'] },
    ] });
    expect(selections).toEqual([{ homeId: 'home', machineId: 'machine' }, { homeId: 'home', machineId: 'machine', cursor: 'current' }]);
    await expect(readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine' }, { ...ports,
      readDeployments: async () => { throw new Error('old_server_or_unavailable'); },
    })).resolves.toMatchObject({ coverage: 'partial', unavailable: ['deployments'] });
    await expect(readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine' }, { ...ports,
      readDeployments: async () => ({ homeId: 'other-home', machineId: 'machine', coverage: 'complete', references: [], nextCursor: null }),
    })).resolves.toMatchObject({ coverage: 'partial', unavailable: ['deployments'] });
  });
  it.each(['malformed-source', 'missing-shared-body'] as const)('keeps Profile coverage partial for %s', async failure => {
    const result = await readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine' }, {
      artifacts: {
        list: async options => ({ coverage: 'complete', items: options.kind === 'launch-profile.v1' && failure === 'missing-shared-body'
          ? [{ artifactId: 'shared', header: { kind: 'launch-profile.v1' }, headerVersion: 1,
              ownerAccountId: 'another-account', access: 'view' }] : [] }),
        read: async () => null, readMany: async ids => ids.map(() => null),
      },
      readSettings: async () => failure === 'malformed-source' ? { profiles: 'unreadable' } : {},
      readProfileCatalog: async () => ({ status: 'ready', source: failure === 'malformed-source' ? 'legacy' : 'destination',
        records: [], diagnostics: [], referenceGuardRevision: 'absent', authority: 'active', control: null, controlRevision: 'absent' }),
      readPools: async () => ({ pools: [] }),
      readAssignments: async () => ({ automations: [], nextCursor: null }),
      readDeployments: async input => ({ ...input, coverage: 'complete', references: [], nextCursor: null }),
    });
    expect(result).toMatchObject({ coverage: 'partial', unavailable: ['profiles'] });
  });

  it('starts independent fresh sources without waiting for a slow Board page', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const result = readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine' }, {
      artifacts: {
        list: async () => { started.push('boards'); await gate; return { items: [], coverage: 'complete' }; },
        read: async () => null, readMany: async () => [],
      },
      readSettings: async () => { started.push('profiles'); throw new Error('settings_unavailable'); },
      readPools: async () => { started.push('pools'); return { pools: [] }; },
      readAssignments: async () => { started.push('assignments'); return { automations: [], nextCursor: null }; },
      readDeployments: async input => ({ ...input, coverage: 'complete', references: [], nextCursor: null }),
    });
    try {
      expect(started).toHaveLength(4);
      expect(started).toEqual(expect.arrayContaining(['boards', 'profiles', 'pools', 'assignments']));
    }
    finally { release(); await result; }
    await expect(result).resolves.toMatchObject({ coverage: 'partial', unavailable: ['profiles'] });
  });

  it('completely checks private and shared profiles and pages Board bodies without per-Board reads', async () => {
    const machineId = 'machine-one';
    const board = {
      ...createWorkBoardV1({ id: 'board-one', name: 'Board one' }),
      source: { picked: [{ kind: 'machine' as const, qualifiedId: { serverId: 'home-alias', id: machineId } }] },
    };
    const artifacts = new Map([
      ['board-one', {
        artifactId: 'board-one', header: { kind: 'work-board.v1', v: 1 }, body: JSON.stringify(board),
        revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account', access: 'owner' as const,
      }],
      ['profile-one', {
        artifactId: 'profile-one', access: 'view' as const,
        header: { kind: 'launch-profile.v1', profileId: 'profile-one', name: 'Profile one' },
        body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
          v: 2, id: 'profile-one', name: 'Profile one', createdAt: 1, updatedAt: 1,
          placement: { fixed: { serverId: 'home', machineId } },
        } }),
        revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account',
      }],
    ]);
    const listCalls: Parameters<MachineReferenceCensusPortsV1['artifacts']['list']>[0][] = [];
    const shared = artifacts.get('profile-one')!;
    artifacts.set('shared-profile', { ...shared, artifactId: 'shared-profile',
      header: { kind: 'launch-profile.v1', profileId: 'shared-profile', name: 'Shared profile' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
        v: 2, id: 'shared-profile', name: 'Shared profile', createdAt: 1, updatedAt: 1,
        placement: { fixed: { serverId: 'home-alias', machineId } },
      } }),
    });
    const boards = [artifacts.get('board-one')!, ...Array.from({ length: 1_000 }, (_, index) => ({
      ...artifacts.get('board-one')!, artifactId: `other-board-${index}`,
      body: JSON.stringify(createWorkBoardV1({ id: `other-board-${index}`, name: 'Other board' })),
    }))];
    const readCalls: { artifactId: string; fresh: boolean | undefined }[] = [];
    const readManyCalls: { artifactIds: readonly string[]; fresh: boolean | undefined }[] = [];
    const unrelatedOtherArtifacts = Array.from({ length: 5_000 }, (_, index) => ({
      artifactId: `unrelated-other-${index}`, header: { kind: 'unrelated-other.v1' }, headerVersion: 1,
      updatedAt: index, ownerAccountId: 'account', access: 'owner' as const,
    }));
    let assignmentReads = 0;
    const ports: MachineReferenceCensusPortsV1 = {
      artifacts: {
        async list(options) {
          listCalls.push(options);
          if (options.kind === 'work-board.v1' && options.coarseKind === 'work_board') {
            const start = Number(options.cursor ?? 0);
            return { items: boards.slice(start, start + 500).map(row => ({ ...row,
              body: options.includeBody ? row.body : undefined, headerVersion: 1, bodyVersion: 1 })), coverage: 'complete',
              ...(start + 500 < boards.length ? { nextCursor: String(start + 500) } : {}) };
          }
          if (options.kind === 'launch-profile.v1') {
            return { items: [artifacts.get('profile-one')!, artifacts.get('shared-profile')!]
              .map(row => ({ ...row, headerVersion: 1, bodyVersion: 1 })), coverage: 'complete' };
          }
          if (options.coarseKind === 'other') {
            const page = options.cursor ? Number(options.cursor) : 0;
            const start = page * 500;
            return { items: unrelatedOtherArtifacts.slice(start, start + 500), coverage: 'complete',
              ...(start + 500 < unrelatedOtherArtifacts.length ? { nextCursor: String(page + 1) } : {}) };
          }
          throw new Error('unscoped_artifact_list');
        },
        async read(artifactId, options) {
          readCalls.push({ artifactId, fresh: options?.fresh });
          return artifacts.get(artifactId) ?? null;
        },
        async readMany(artifactIds, options) {
          readManyCalls.push({ artifactIds, fresh: options?.fresh });
          return artifactIds.map(artifactId => artifacts.get(artifactId) ?? null);
        },
      },
      readDeployments: async input => ({ ...input, coverage: 'complete', references: [], nextCursor: null }),
      readSettings: async () => ({}),
      readProfileCatalog: async () => ({
        status: 'ready', records: [{ record: { v: 1, id: 'profile-one',
          definition: { kind: 'artifact', artifactId: 'profile-one' }, enabled: true,
          promptStack: [], skillSeeds: [], secretBindings: {} }, revision: 1 }],
        diagnostics: [], referenceGuardRevision: 'absent',
        authority: 'active', source: 'destination', control: null, controlRevision: 'absent',
      } as ProfileCatalogSnapshotV1),
      readPools: async () => ({ pools: [{
        pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Pool one', description: null,
          revision: 1, createdAt: 1, updatedAt: 1,
          members: [{ machineId, priorityTier: 0, enabled: true, state: 'connected' }] },
        availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
      }] } as MachinePoolListOutputV1),
      readAssignments: async () => { assignmentReads += 1; return { automations: [
        { id: 'workflow-assignment', name: 'Workflow assignment', description: null, enabled: true,
          workflowDefinitionId: 'workflow-definition', scopeSessionId: null, targetType: 'executionRun', existingSessionId: null,
          templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
          assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }], triggers: [] },
        { id: 'automation-assignment', name: 'Automation assignment', description: null, enabled: true,
          scopeSessionId: null, targetType: 'executionRun', existingSessionId: null,
          templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
          assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }], triggers: [] },
      ], nextCursor: null } as AutomationDefinitionListResponse; },
    };

    await expect(readMachineReferenceCensusV1({
      homeId: 'home', homeAliases: ['home-alias'], machineId,
    }, ports)).resolves.toEqual({
      homeId: 'home', machineId, coverage: 'complete', unavailable: [], references: [
        { kind: 'board', id: 'board-one', name: 'Board one' },
        { kind: 'profile', id: 'profile-one', name: 'Profile one' },
        { kind: 'profile', id: 'shared-profile', name: 'Shared profile' },
        { kind: 'machine_pool', id: '00000000-0000-4000-8000-000000000001', name: 'Pool one' },
        { kind: 'workflow_assignment', id: 'workflow-assignment', name: 'Workflow assignment' },
        { kind: 'automation_assignment', id: 'automation-assignment', name: 'Automation assignment' },
      ],
    });
    expect(listCalls.filter(row => row.kind === 'work-board.v1')).toHaveLength(3);
    expect(listCalls.filter(row => row.kind === 'work-board.v1').every(row => row.includeBody === true)).toBe(true);
    expect(listCalls.filter(row => row.kind === 'launch-profile.v1')).toHaveLength(1);
    expect(listCalls.every(row => row.kind === 'work-board.v1' || row.kind === 'launch-profile.v1')).toBe(true);
    expect(readCalls).toEqual([]);
    expect(readManyCalls).toEqual([{ artifactIds: ['profile-one', 'shared-profile'], fresh: true }]);
    expect(assignmentReads).toBe(1);
  });

  it('reports only Boards unavailable when a listed Board body is unavailable', async () => {
    const readCalls: { artifactId: string; fresh: boolean | undefined }[] = [];
    const result = await readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine-one' }, {
      artifacts: {
        list: async options => options.kind === 'work-board.v1'
          ? { items: [{ artifactId: 'unavailable-board', header: { kind: 'work-board.v1' }, headerVersion: 1,
              updatedAt: 1, ownerAccountId: 'account', access: 'owner' }], coverage: 'complete' }
          : { items: [], coverage: 'complete' },
        read: async (artifactId, options) => {
          readCalls.push({ artifactId, fresh: options?.fresh });
          throw new Error('artifact_content_unavailable');
        },
        readMany: async () => [],
      },
      readSettings: async () => ({}),
      readProfileCatalog: async () => ({
        status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent',
        authority: 'active', source: 'destination', control: null, controlRevision: 'absent',
      } as ProfileCatalogSnapshotV1),
      readPools: async () => ({ pools: [] }),
      readAssignments: async () => ({ automations: [], nextCursor: null }),
      readDeployments: async input => ({ ...input, coverage: 'complete', references: [], nextCursor: null }),
    });

    expect(result).toEqual({
      homeId: 'home', machineId: 'machine-one', coverage: 'partial', references: [], unavailable: ['artifacts'],
    });
    expect(readCalls).toEqual([]);
  });
});
