import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

const protocolExports = protocol as Record<string, unknown>;

type Schema = Readonly<{
  safeParse: (value: unknown) => { success: boolean };
  parse: (value: unknown) => unknown;
}>;

function getSchema(
  name:
    | 'SessionFolderAssignmentListResponseSchema'
    | 'SetSessionFolderAssignmentRequestSchema'
    | 'QuerySessionFolderSessionsRequestSchema'
    | 'MoveSessionFolderAssignmentsRequestSchema'
    | 'MoveSessionFolderAssignmentsResponseSchema',
): Schema | null {
  const schema = protocolExports[name] as Partial<Schema> | undefined;
  expect(typeof schema?.safeParse).toBe('function');
  return typeof schema?.safeParse === 'function' && typeof schema.parse === 'function' ? schema as Schema : null;
}

function readNumberExport(name: string, fallback: number): number {
  const value = protocolExports[name];
  return typeof value === 'number' ? value : fallback;
}

describe('session folder assignment schemas', () => {
  it('parses assignment list responses', () => {
    const schema = getSchema('SessionFolderAssignmentListResponseSchema');
    if (!schema) return;

    const parsed = schema.parse({
      assignments: [{ sessionId: 'session_1', folderId: 'folder_1' }],
    }) as { assignments: unknown };

    expect(parsed.assignments).toEqual([{ sessionId: 'session_1', folderId: 'folder_1' }]);
  });

  it('accepts assigning and clearing a session folder', () => {
    const schema = getSchema('SetSessionFolderAssignmentRequestSchema');
    if (!schema) return;

    expect(schema.parse({ folderId: 'folder_1' })).toEqual({ folderId: 'folder_1' });
    expect(schema.parse({ folderId: null })).toEqual({ folderId: null });
  });

  it('rejects empty or oversized assignment folder ids', () => {
    const schema = getSchema('SetSessionFolderAssignmentRequestSchema');
    if (!schema) return;

    expect(schema.safeParse({ folderId: '' }).success).toBe(false);
    expect(
      schema.safeParse({
        folderId: 'f'.repeat(readNumberExport('SESSION_FOLDER_MAX_ID_LENGTH', 2_000) + 1),
      }).success,
    ).toBe(false);
  });

  it('parses folder session query requests with bounded pagination inputs', () => {
    const schema = getSchema('QuerySessionFolderSessionsRequestSchema');
    if (!schema) return;

    const parsed = schema.parse({
      folderIds: ['folder_1', 'folder_2'],
      cursor: 'cursor_1',
      limit: readNumberExport('SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_LIMIT', 200),
      archived: false,
    }) as { folderIds: unknown };

    expect(parsed.folderIds).toEqual(['folder_1', 'folder_2']);
    expect(
      schema.safeParse({
        folderIds: Array.from(
          { length: readNumberExport('SESSION_FOLDER_ASSIGNMENT_QUERY_MAX_FOLDER_IDS', 100) + 1 },
          (_, index) => `folder_${index}`,
        ),
      }).success,
    ).toBe(false);
  });

  it('parses bulk move requests without exposing folder names', () => {
    const schema = getSchema('MoveSessionFolderAssignmentsRequestSchema');
    if (!schema) return;

    const parsed = schema.parse({
      fromFolderIds: ['deleted_folder'],
      toFolderId: null,
    });

    expect(parsed).toEqual({ fromFolderIds: ['deleted_folder'], toFolderId: null });
  });

  it('parses bulk move responses with rollback metadata', () => {
    const schema = getSchema('MoveSessionFolderAssignmentsResponseSchema');
    if (!schema) return;

    const parsed = schema.parse({
      assignments: [{ sessionId: 's1', folderId: 'deleted_folder' }],
      affectedCount: 1,
      toFolderId: null,
    });

    expect(parsed).toEqual({
      assignments: [{ sessionId: 's1', folderId: 'deleted_folder' }],
      affectedCount: 1,
      toFolderId: null,
    });
  });
});
