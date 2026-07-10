import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

const protocolExports = protocol as Record<string, unknown>;

function getSchema(name: 'SessionFoldersV1Schema' | 'SessionFolderV1Schema') {
  const schema = protocolExports[name] as { safeParse?: unknown; parse?: unknown } | undefined;
  expect(typeof schema?.safeParse).toBe('function');
  return typeof schema?.safeParse === 'function' && typeof schema.parse === 'function'
    ? schema as { safeParse: (value: unknown) => { success: boolean }; parse: (value: unknown) => unknown }
    : null;
}

describe('session folder settings schemas', () => {
  it('exports folder settings through the canonical sessions subpath', async () => {
    const sessions = await import('@happier-dev/protocol/sessions');

    expect(typeof sessions.SessionFoldersV1Schema.safeParse).toBe('function');
    expect(typeof sessions.SetSessionFolderAssignmentRequestSchema.safeParse).toBe('function');
  }, 30_000);

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
