import { describe, expect, it, vi } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { executeSessionSectionActionV1, type SessionSectionActionPortV1, type SessionSectionFolderV1 } from './sessionSections.js';
import { SessionOrganizationFolderSchema, compareSessionSectionOrderV1, projectSessionSectionV1 } from '../sessions/organization/folders.js';
import { openSessionOrganizationDisplayEnvelopeV1 } from '../sessions/organization/content.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

describe('Session section Actions', () => {
  it('loads the semantic owner before its catalog without losing the declared schemas', async () => {
    vi.resetModules();
    await import('./sessionSections.js');
    const catalog = await import('./actionSpecs.js');
    expect(catalog.getActionSpec('session.sections.create').inputSchema.parse({ name: 'Launch' })).toEqual({ name: 'Launch' });
    expect(catalog.getActionSpec('session.section.set').inputSchema.parse({ sessionId: 's', sectionId: null })).toEqual({ sessionId: 's', sectionId: null });
  });
  it('admits semantic section inputs and refuses storage authority or empty updates', () => {
    expect(getActionSpec('session.sections.create').inputSchema.parse({ name: 'Launch', icon: null })).toEqual({ name: 'Launch', icon: null });
    expect(getActionSpec('session.sections.create').inputSchema.safeParse({ name: 'Launch', folderKey: 'forged' }).success).toBe(false);
    expect(getActionSpec('session.sections.update').inputSchema.safeParse({ sectionId: 'launch' }).success).toBe(false);
    expect(getActionSpec('session.section.set').inputSchema.parse({ sessionId: 's', sectionId: null })).toEqual({ sessionId: 's', sectionId: null });
    expect(getActionSpec('session.sections.delete').safety).toBe('safe');
  });

  it.each([
    { name: 'mixed retained keys', keys: [null, 'a0', 'a0', 'a1', 'a2', 'zzz'], expectedKey: 'a3' },
    { name: 'only null or invalid retained keys', keys: [null, '0001', 'zzz'], expectedKey: 'a0' },
  ])('creates exactly one section without repairing $name', async ({ keys, expectedKey }) => {
    // The predecessor folder schema permits null, duplicate and non-fractional
    // keys; opening an unreadable retained display must not block a new row.
    const folders: SessionSectionFolderV1[] = keys.map((sortKey, index) => ({
      folderId: index === keys.length - 2 ? 'qa-live-locked' : `legacy-${index}`,
      folderKey: `legacy-key-${index}`, parentFolderId: null, parentFolderKey: null,
      sortKey, display: { t: 'plain', v: { name: `Legacy ${index}` } },
      displayState: index === keys.length - 2
        ? { status: 'locked', reason: 'invalid_stored_display' }
        : { status: 'available', value: { name: `Legacy ${index}` } },
      archivedAt: null, createdAt: 1, updatedAt: 1,
    }));
    const originalFolders = structuredClone(folders);
    const writes: Parameters<SessionSectionActionPortV1['upsertFolder']>[0][] = [];
    let allocations = 0;
    const port: SessionSectionActionPortV1 = {
      assertCurrent: () => {}, allocateFolderId: () => { allocations++; return 'new-section'; },
      readSnapshot: async () => ({ folders, folderAssignments: [] }),
      upsertFolder: async request => {
        writes.push(request);
        const stored: SessionSectionFolderV1 = { ...request, folderId: request.folderId!,
          displayState: { status: 'available', value: request.display?.t === 'plain' ? request.display.v : null },
          archivedAt: null, createdAt: 2, updatedAt: 2 };
        const index = folders.findIndex(folder => folder.folderId === stored.folderId);
        if (index === -1) folders.push(stored);
        else folders[index] = stored;
        return stored;
      },
      deleteFolder: async () => { throw new Error('unexpected_delete'); },
      setAssignment: async () => { throw new Error('unexpected_assignment'); },
    };
    expect(await executeSessionSectionActionV1('session.sections.create', { name: 'New' }, port)).toEqual({
      section: { sectionId: 'new-section', sortKey: expectedKey,
        displayState: { status: 'available', value: { name: 'New', icon: null } } },
    });
    expect(allocations).toBe(1);
    expect(writes).toEqual([{ folderId: 'new-section', folderKey: 'new-section', parentFolderId: null,
      parentFolderKey: null, sortKey: expectedKey, display: { t: 'plain', v: { name: 'New', icon: null } } }]);
    expect(folders.filter(folder => folder.folderId !== 'new-section')).toEqual(originalFolders);
  });
  it('reorders named sections beside retained 0.2 null displays without rewriting their content or rejecting stored extras', async () => {
    // ../0.2 8a8ddce845f4a5cf33403e44c5f671481060084f:
    // sessionOrganization/{folders,mutations}.ts admit null displays/keys; the
    // legacySessionOrganizationImport mapper writes {name,workspace} for named folders.
    const storedReader = createStoredReadSchema(SessionOrganizationFolderSchema);
    const folders: SessionSectionFolderV1[] = ['first', 'second', 'qa-live2-intake', 'qa-live2-questions',
      'qa-live3b-intake', 'qa-live3b-questions'].map((folderId, index) => {
      const row = storedReader.parse({ folderId, folderKey: folderId, parentFolderId: null, parentFolderKey: null,
        sortKey: index < 2 ? '00000001' : null, futureRecordField: true,
        display: index < 2 ? { t: 'plain', futureEnvelopeField: true, v: { name: folderId,
          workspace: { t: 'workspaceScope', serverId: 'home', machineId: 'machine', rootPath: '/repo' },
          futureDisplayField: true } } : null,
        archivedAt: null, createdAt: 1, updatedAt: 1 });
      return { ...row, displayState: openSessionOrganizationDisplayEnvelopeV1({ envelope: row.display }) };
    });
    const original = structuredClone(folders);
    const port: SessionSectionActionPortV1 = {
      assertCurrent: () => {}, allocateFolderId: () => 'unused',
      readSnapshot: async () => ({ folders, folderAssignments: [] }),
      // Genuine persistence boundary: run the real display/read/order owners above it.
      upsertFolder: async request => {
        const index = folders.findIndex(folder => folder.folderId === request.folderId);
        const row = folders[index]!;
        folders[index] = { ...row, ...request, updatedAt: row.updatedAt + 1 };
        return folders[index]!;
      },
      deleteFolder: async () => { throw new Error('unexpected_delete'); },
      setAssignment: async () => { throw new Error('unexpected_assignment'); },
    };
    expect(projectSessionSectionV1(folders[0]!).displayState).toEqual({ status: 'available', value: { name: 'first', icon: null } });
    expect(projectSessionSectionV1(folders[2]!).displayState).toEqual({ status: 'locked', reason: 'invalid_stored_display' });
    const result = await executeSessionSectionActionV1('session.sections.reorder', { sectionId: 'second', beforeSectionId: 'first' }, port);
    expect(result).toMatchObject({ sectionId: 'second', sortKey: expect.any(String) });
    expect(folders.map(projectSessionSectionV1).sort(compareSessionSectionOrderV1).map(section => section.sectionId))
      .toEqual(['second', 'first', 'qa-live2-intake', 'qa-live2-questions', 'qa-live3b-intake', 'qa-live3b-questions']);
    expect(folders.map(({ sortKey: _sortKey, updatedAt: _updatedAt, ...row }) => row))
      .toEqual(original.map(({ sortKey: _sortKey, updatedAt: _updatedAt, ...row }) => row));
  });

  it('preserves unreadable stored evidence when reordering would otherwise rewrite a locked definition', async () => {
    const writes: unknown[] = [];
    const locked = { folderId: 'locked', folderKey: 'locked', parentFolderId: null, parentFolderKey: null,
      sortKey: null, display: null, displayState: { status: 'locked' as const, reason: 'invalid_stored_display' as const },
      archivedAt: null, createdAt: 1, updatedAt: 1 };
    const port: SessionSectionActionPortV1 = {
      assertCurrent: () => {}, allocateFolderId: () => 'new',
      readSnapshot: async () => ({ folders: [locked], folderAssignments: [] }),
      upsertFolder: async request => { writes.push(request); return { ...locked, ...request, folderId: request.folderId ?? 'new', displayState: locked.displayState }; },
      deleteFolder: async () => { throw new Error('unexpected_delete'); },
      setAssignment: async () => { throw new Error('unexpected_assignment'); },
    };
    expect(await executeSessionSectionActionV1('session.sections.reorder', { sectionId: 'locked', beforeSectionId: null }, port)).toMatchObject({ ok: false, errorCode: 'invalid_stored_display' });
    expect(writes).toEqual([]);
    const named: SessionSectionFolderV1 = { ...locked, folderId: 'named', folderKey: 'named',
      display: { t: 'plain', v: { name: 'Named' } }, displayState: { status: 'available', value: { name: 'Named' } } };
    expect(await executeSessionSectionActionV1('session.sections.reorder', { sectionId: 'named', beforeSectionId: 'locked' }, {
      ...port, readSnapshot: async () => ({ folders: [named, locked], folderAssignments: [] }),
    })).toMatchObject({ ok: false, errorCode: 'invalid_stored_display' });
    expect(writes).toEqual([]);
  });
  it('does not report an unknown member outcome when currentness refused before archive admission', async () => {
    let reads = 0;
    const port: SessionSectionActionPortV1 = {
      assertCurrent: () => { if (reads) throw new Error('retired'); }, allocateFolderId: () => 'unused',
      readSnapshot: async () => { reads++; return { folders: [{ folderId: 'section', folderKey: 'section',
        parentFolderId: null, parentFolderKey: null, sortKey: 'a0', display: null,
        displayState: { status: 'available', value: { name: 'Launch', icon: null } },
        archivedAt: null, createdAt: 1, updatedAt: 1 }], folderAssignments: [{ sessionId: 'member', folderId: 'section' }] }; },
      upsertFolder: async () => { throw new Error('unexpected_write'); },
      deleteFolder: async () => { throw new Error('unexpected_delete'); },
      setAssignment: async () => { throw new Error('unexpected_assignment'); },
      archiveSession: async () => { throw new Error('must_not_enter_archive'); },
    };
    expect(await executeSessionSectionActionV1('session.sections.archive', { sectionId: 'section' }, port))
      .toEqual({ archivedSessionIds: [], failures: [{ sessionId: 'member', code: 'action_not_admitted' }], unknownSessionIds: [] });
  });
});
