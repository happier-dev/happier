import { describe, expect, it } from 'vitest';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ManagedWorkspaceRefV2WriteSchema, WorkspaceRefV1WriteSchema } from '../workspaces/workspaceRefV1.js';
import { ProjectAccountWorkspaceRefKeyV1Schema, ProjectAccountRowPayloadV1Schema, StoredProjectAccountRowPayloadV1Schema } from './projectAccountRowsV1.js';
import { ProjectWorkspaceUpdateOutputV1Schema } from './projectWorkspaceActionsV1.js';

describe('managed Project Account workspace rows', () => {
  it('round trips the complete native locator while the old Machine row reader fails closed', () => {
    const value = ManagedWorkspaceRefV2WriteSchema.parse({ v: 2, kind: 'managed', id: 'native', serverId: 'home',
      managedId: 'guest', controller: { machineId: 'host', installationId: 'host-current' },
      rootPath: '/repo', createdAtMs: 1, label: 'Guest' });
    const payload = { key: { kind: 'workspace-ref', serverId: 'home', id: 'native' }, value };
    expect(ProjectAccountRowPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(StoredProjectAccountRowPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(StoredProjectAccountRowPayloadV1Schema.safeParse({ ...payload, value: { ...value, machineId: 'host' } }).success).toBe(false);
    expect(ProjectWorkspaceUpdateOutputV1Schema.parse({ ok: true, workspaceRef: value })).toEqual({ ok: true, workspaceRef: value });
    // The prior row value contains only the unchanged Machine V1 fields. Its stored projection
    // must not discard the native locator and reinterpret the guest root on the controller.
    const oldReader = createStoredReadSchema(z.strictObject({ key: ProjectAccountWorkspaceRefKeyV1Schema,
      value: WorkspaceRefV1WriteSchema }));
    expect(oldReader.safeParse(payload).success).toBe(false);
    const machine = { id: 'host', serverId: 'home', machineId: 'host', rootPath: '/repo', createdAtMs: 1 };
    expect(StoredProjectAccountRowPayloadV1Schema.parse({ key: { ...payload.key, id: machine.id }, value: machine }))
      .toEqual({ key: { ...payload.key, id: machine.id }, value: machine });
  });
});
