import { describe, expect, it } from 'vitest';
import * as sessions from '@happier-dev/protocol/sessions';

import * as protocol from './folderSettings.js';

const protocolExports = protocol as Record<string, unknown>;

function getSchema(name: 'SessionFoldersV1Schema' | 'SessionFolderV1Schema') {
  const schema = protocolExports[name] as { safeParse?: unknown; parse?: unknown } | undefined;
  expect(typeof schema?.safeParse).toBe('function');
  return typeof schema?.safeParse === 'function' && typeof schema.parse === 'function'
    ? schema as { safeParse: (value: unknown) => { success: boolean }; parse: (value: unknown) => unknown }
    : null;
}

describe('session folder settings schemas', () => {
  it('reads known stored folder fields recursively while keeping input validation strict', () => {
    const workspace = { t: 'workspaceScope', serverId: 'server_1', machineId: 'machine_1', rootPath: '/repo' };
    const folder = { id: 'folder_1', workspace, parentId: null, name: 'Work', createdAt: 1, updatedAt: 2 };
    const stored = {
      v: 1,
      folders: [{ ...folder, savedBy: 'older-client', workspace: { ...workspace, displayPath: '/repo' } }],
      savedBy: 'older-client',
    };
    const schema = protocol.SessionFoldersV1StoredSchema;
    const parsed = schema.safeParse(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ v: 1, folders: [folder] });
    expect(protocol.SessionFoldersV1Schema.parse(parsed.data)).toEqual(parsed.data);
    expect(protocol.SessionFoldersV1Schema.safeParse(stored).success).toBe(false);
    expect(protocol.SessionFolderWorkspaceRefV1StoredSchema.parse({ ...workspace, displayPath: '/repo' })).toEqual(workspace);
    expect(protocol.SessionFolderWorkspaceRefV1Schema.safeParse({ ...workspace, displayPath: '/repo' }).success).toBe(false);
    expect(schema.safeParse({ v: 1, folders: [{ ...folder, name: undefined }] }).success).toBe(false);
    expect(schema.safeParse({ v: 1, folders: [{ ...folder, workspace: { ...workspace, machineId: 1 } }] }).success).toBe(false);
  });
  it('accepts a managed-session bucket without a filesystem path', () => {
    const workspace = { t: 'managedSessions', serverId: 'server_1', machineId: 'machine_1' };
    expect(protocol.SessionFolderWorkspaceRefV1Schema.parse(workspace)).toEqual(workspace);
    expect(protocol.SessionFolderWorkspaceRefV1Schema.safeParse({ ...workspace, rootPath: '/fake' }).success).toBe(false);
  });
  it('exports folder settings through the canonical sessions subpath', () => {
    expect(typeof sessions.SessionFoldersV1Schema.safeParse).toBe('function');
    expect(typeof sessions.SetSessionFolderAssignmentRequestSchema.safeParse).toBe('function');
  });

  it('parses a remote-dev-compatible sessionFoldersV1 fixture', () => {
    const schema = getSchema('SessionFoldersV1Schema');
    if (!schema) return;

    const parsed = schema.parse({
      v: 1,
      folders: [
        {
          id: 'folder_root',
          workspace: {
            t: 'workspaceRef',
            serverId: 'server_1',
            workspaceRefId: 'workspace_ref_1',
          },
          renderWorkspaceKey: 'wl_old_render_key',
          parentId: null,
          name: 'Research',
          createdAt: 1_714_000_000_000,
          updatedAt: 1_714_000_001_000,
          sortKey: '0001',
        },
        {
          id: 'folder_child',
          workspace: {
            t: 'workspaceScope',
            serverId: 'server_1',
            machineId: 'machine_1',
            rootPath: '/Users/alice/project',
          },
          parentId: 'folder_root',
          name: 'Follow ups',
          createdAt: 1_714_000_002_000,
          updatedAt: 1_714_000_003_000,
        },
      ],
    }) as { folders: Array<{ workspace: unknown }> };

    expect(parsed.folders[0]?.workspace).toEqual({
      t: 'workspaceRef',
      serverId: 'server_1',
      workspaceRefId: 'workspace_ref_1',
    });
    expect(parsed.folders[1]?.workspace).toEqual({
      t: 'workspaceScope',
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/Users/alice/project',
    });
  });

  it('defaults sessionFoldersV1 to an empty folder list', () => {
    const schema = getSchema('SessionFoldersV1Schema');
    if (!schema) return;

    expect(schema.parse({ v: 1 })).toEqual(protocolExports.DefaultSessionFoldersV1);
  });

  it('rejects folders without a durable workspace reference', () => {
    const schema = getSchema('SessionFolderV1Schema');
    if (!schema) return;

    const parsed = schema.safeParse({
      id: 'folder_1',
      renderWorkspaceKey: 'render_only',
      parentId: null,
      name: 'Render only',
      createdAt: 1,
      updatedAt: 1,
    });

    expect(parsed.success).toBe(false);
  });
});
