import { describe, expect, it } from 'vitest';

import { ProjectKeyV1Schema, WorkspaceRefV1Schema } from './workspaceRefV1.js';

describe('workspaceRefV1', () => {
  it('parses WorkspaceRefV1 as a forward-compatible workspace reference', () => {
    const parsed = WorkspaceRefV1Schema.parse({
      id: 'workspace_1',
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
      label: 'Repo',
      createdAtMs: 1,
      lastOpenedAtMs: null,
      futureField: { keep: true },
    });

    expect(parsed).toMatchObject({
      id: 'workspace_1',
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
      label: 'Repo',
      createdAtMs: 1,
      lastOpenedAtMs: null,
      futureField: { keep: true },
    });
  });

  it('preserves stored workspace reference string fields without normalization', () => {
    const parsed = WorkspaceRefV1Schema.parse({
      id: ' workspace_1 ',
      serverId: ' server_1 ',
      machineId: ' machine_1 ',
      rootPath: ' /repo with spaces ',
      label: ' Repo ',
      createdAtMs: 1,
      lastOpenedAtMs: null,
    });

    expect(parsed).toMatchObject({
      id: ' workspace_1 ',
      serverId: ' server_1 ',
      machineId: ' machine_1 ',
      rootPath: ' /repo with spaces ',
      label: ' Repo ',
    });
  });

  it('accepts only id or scope tuple project lookup keys', () => {
    expect(ProjectKeyV1Schema.parse({ id: 'workspace_1' })).toEqual({ id: 'workspace_1' });
    expect(ProjectKeyV1Schema.parse({
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
    })).toEqual({
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
    });
    expect(ProjectKeyV1Schema.safeParse({ serverId: 'server_1', machineId: 'machine_1' }).success).toBe(false);
  });
});
