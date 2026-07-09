import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionFolderSettingsSnapshotFromOrganizationSnapshot,
  buildSessionOrganizationImportRequestFromFolderSettings,
  importSessionOrganization,
  readPinnedSessionIdsFromOrganizationSnapshot,
  readSessionTagLabelsFromOrganizationSnapshot,
  type SessionFoldersSetting,
} from './sessionOrganization';

const workspace = {
  t: 'workspaceScope' as const,
  serverId: 'server-a',
  machineId: 'machine-a',
  rootPath: '/repo',
};

const sessionFoldersV1: SessionFoldersSetting = {
  v: 1,
  folders: [
    {
      id: 'folder-alpha',
      workspace,
      parentId: null,
      name: 'Alpha',
      createdAt: 1,
      updatedAt: 2,
      sortKey: 'a',
    },
    {
      id: 'folder-child',
      workspace,
      parentId: 'folder-alpha',
      name: 'Child',
      createdAt: 3,
      updatedAt: 4,
      sortKey: 'b',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session organization ui e2e testkit helpers', () => {
  it('builds a server-backed organization import request from folder drag settings', () => {
    const request = buildSessionOrganizationImportRequestFromFolderSettings({
      serverId: 'server-a',
      sessionFoldersV1,
      sessionListGroupOrderV1: {
        'pinned-v1': ['server-a:session-a', 'server-b:other-session'],
        'project-a': ['server-a:session-a', 'folder:folder-alpha'],
      },
    });

    expect(request.folders).toEqual([
      {
        folderId: 'folder-alpha',
        folderKey: 'folder-alpha',
        parentFolderId: null,
        parentFolderKey: null,
        sortKey: 'a',
        display: { t: 'plain', v: { name: 'Alpha', workspace } },
      },
      {
        folderId: 'folder-child',
        folderKey: 'folder-child',
        parentFolderId: 'folder-alpha',
        parentFolderKey: 'folder-alpha',
        sortKey: 'b',
        display: { t: 'plain', v: { name: 'Child', workspace } },
      },
    ]);
    expect(request.orderEntries).toEqual([
      {
        scopeKind: 'pinned',
        scopeKey: 'pins',
        itemKind: 'session',
        itemKey: 'session-a',
        sortKey: '00000001',
      },
      {
        scopeKind: 'group',
        scopeKey: 'project-a',
        itemKind: 'session',
        itemKey: 'session-a',
        sortKey: '00000001',
      },
      {
        scopeKind: 'group',
        scopeKey: 'project-a',
        itemKind: 'folder',
        itemKey: 'folder-alpha',
        sortKey: '00000002',
      },
    ]);
  });

  it('maps a server organization snapshot back to the folder drag assertion shape', () => {
    const snapshot = buildSessionFolderSettingsSnapshotFromOrganizationSnapshot({
      serverId: 'server-a',
      snapshot: {
        schemaVersion: 1,
        version: 5,
        pins: [],
        folders: [
          {
            folderId: 'folder-alpha',
            folderKey: 'folder-alpha',
            parentFolderId: null,
            parentFolderKey: null,
            sortKey: 'a',
            display: { t: 'plain', v: { name: 'Alpha', workspace } },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
          },
          {
            folderId: 'archived-folder',
            folderKey: 'archived-folder',
            parentFolderId: null,
            parentFolderKey: null,
            sortKey: 'z',
            display: { t: 'plain', v: { name: 'Archived', workspace } },
            archivedAt: 10,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        folderAssignments: [],
        tags: [],
        tagAssignments: [],
        orderEntries: [
          {
            scopeKind: 'pinned',
            scopeKey: 'pins',
            itemKind: 'session',
            itemKey: 'session-a',
            sortKey: '00000001',
          },
          {
            scopeKind: 'group',
            scopeKey: 'project-a',
            itemKind: 'folder',
            itemKey: 'folder-alpha',
            sortKey: '00000001',
          },
        ],
        labels: [],
      },
    });

    expect(snapshot.sessionFoldersV1).toEqual({
      v: 1,
      folders: [{
        id: 'folder-alpha',
        workspace,
        parentId: null,
        name: 'Alpha',
        createdAt: 1,
        updatedAt: 2,
        sortKey: 'a',
      }],
    });
    expect(snapshot.sessionListGroupOrderV1).toEqual({
      'pinned-v1': ['server-a:session-a'],
      'project-a': ['folder:folder-alpha'],
    });
  });

  it('reads pinned session ids from an organization snapshot in server order', () => {
    expect(readPinnedSessionIdsFromOrganizationSnapshot({
      schemaVersion: 1,
      version: 1,
      pins: [
        { sessionId: 'session-b', sortKey: 'b', pinnedAt: 1 },
        { sessionId: 'session-a', sortKey: 'a', pinnedAt: 2 },
        { sessionId: 'session-c', sortKey: null, pinnedAt: 0 },
      ],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    })).toEqual(['session-a', 'session-b', 'session-c']);
  });

  it('imports seeded organization through the server organization route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      imported: {
        pins: 0,
        folders: 2,
        tags: 0,
        orderEntries: 0,
        labels: 0,
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await importSessionOrganization({
      baseUrl: 'http://server.test/',
      token: 'token-a',
      request: buildSessionOrganizationImportRequestFromFolderSettings({
        serverId: 'server-a',
        sessionFoldersV1,
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://server.test/v2/session-organization/import',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-a',
          'Content-Type': 'application/json',
        },
      }),
    );
  });

  it('reads assigned tag labels from a scoped organization snapshot', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      snapshot: {
        schemaVersion: 1,
        version: 12,
        pins: [],
        folders: [],
        folderAssignments: [],
        tags: [
          {
            tagId: 'tag-a',
            tagKey: 'fallback-a',
            display: { t: 'plain', v: { label: 'Release' } },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
          },
          {
            tagId: 'tag-b',
            tagKey: 'fallback-b',
            display: { t: 'plain', v: {} },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        tagAssignments: [
          { sessionId: 'session-a', tagIds: ['tag-b', 'tag-a'] },
          { sessionId: 'session-other', tagIds: ['tag-a'] },
        ],
        orderEntries: [],
        labels: [],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readSessionTagLabelsFromOrganizationSnapshot({
      baseUrl: 'http://server.test/',
      token: 'token-a',
      sessionId: 'session-a',
    })).resolves.toEqual(['fallback-b', 'Release']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://server.test/v2/session-organization?includeFolders=false&includeTags=true&includeLabels=false&assignmentSessionIds=session-a',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer token-a',
          'Content-Type': 'application/json',
        },
      }),
    );
  });
});
