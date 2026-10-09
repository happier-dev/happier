import { describe, expect, it } from 'vitest';
import { PromptLibraryRecordV1Schema, PromptLibraryRowMutationV1Schema, PromptLibraryRowMutationResponseV1Schema, StoredPromptLibraryRecordV1Schema, openPromptLibraryContentV1, sealPromptLibraryContentV1 } from './promptLibraryRowsV1.js';
import { PromptFoldersV1WriteSchema } from './promptFoldersV1.js';

describe('Prompt library Account catalog rows', () => {
  it('rejects uncaptured first writes, including an absent tombstone', () => {
    const content = { t: 'plain', v: { key: 'folders', value: { v: 1, folders: [] } } };
    expect(PromptLibraryRowMutationV1Schema.safeParse({ expectedRevision: 'absent', content }).success).toBe(false);
    expect(PromptLibraryRowMutationV1Schema.safeParse({ expectedRevision: 'absent', content: null }).success).toBe(false);
  });
  it('admits captured source Settings CAS only for first destination authority', () => {
    const content = { t: 'plain', v: { key: 'folders', value: { v: 1, folders: [] } } };
    expect(PromptLibraryRowMutationV1Schema.safeParse({ expectedRevision: 'absent', sourceSettingsVersion: 7, content }).success).toBe(true);
    expect(PromptLibraryRowMutationV1Schema.safeParse({ expectedRevision: 4, sourceSettingsVersion: 7, content }).success).toBe(false);
    expect(PromptLibraryRowMutationV1Schema.safeParse({ expectedRevision: 'absent', sourceSettingsVersion: 7, content: null }).success).toBe(false);
    expect(PromptLibraryRowMutationResponseV1Schema.safeParse({ status: 'settings-conflict', revision: 8 }).success).toBe(true);
  });
  it('rejects ambiguous duplicate entry identities before catalog activation', () => {
    expect(PromptLibraryRecordV1Schema.safeParse({ key: 'folders', value: { v: 1,
      folders: [{ id: 'folder', name: 'First' }, { id: 'folder', name: 'Second' }] } }).success).toBe(false);
  });

  it.each(['plain', 'e2ee'] as const)('stores personal placement for every Artifact kind in the existing %s folders row', mode => {
    const record = { key: 'folders', value: { v: 1,
      folders: [{ id: 'root', name: 'Library' }, { id: 'child', name: 'Research', parentId: 'root' }],
      artifactHeadersById: {
        'workflow-id': { folderId: 'child', tags: ['daily'] },
        'memory-id': { folderId: null, tags: ['facts'] },
      },
    } };
    const parsed = PromptLibraryRecordV1Schema.parse(record);
    const material = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    expect(openPromptLibraryContentV1({ key: 'folders', mode, material,
      content: sealPromptLibraryContentV1({ record: parsed, mode, material,
        randomBytes: length => new Uint8Array(length).fill(2) }) })).toEqual({ status: 'opened', record });
    expect(StoredPromptLibraryRecordV1Schema.parse({ ...record, future: true,
      value: { ...record.value, future: true, artifactHeadersById: {
        ...record.value.artifactHeadersById, 'workflow-id': { ...record.value.artifactHeadersById['workflow-id'], future: true },
      } } })).toEqual(record);
  });

  it('transfers retained topology without repair while semantic folder writes refuse dangling parents and cycles', () => {
    const retained = { key: 'folders', value: { v: 1, folders: [{ id: 'orphan', name: 'Retained', parentId: 'missing' }] } };
    expect(StoredPromptLibraryRecordV1Schema.parse(retained)).toEqual(retained);
    expect(openPromptLibraryContentV1({ key: 'folders', mode: 'plain', material: null,
      content: sealPromptLibraryContentV1({ record: PromptLibraryRecordV1Schema.parse(retained), mode: 'plain', material: null }),
    })).toEqual({ status: 'opened', record: retained });
    expect(PromptFoldersV1WriteSchema.safeParse(retained.value).success).toBe(false);
    const cyclic = { key: 'folders', value: { v: 1, folders: [
      { id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' },
    ] } };
    expect(PromptLibraryRecordV1Schema.parse(cyclic)).toEqual(cyclic);
    expect(PromptFoldersV1WriteSchema.safeParse(cyclic.value).success).toBe(false);
    expect(StoredPromptLibraryRecordV1Schema.safeParse({ key: 'folders', value: { v: 1,
      folders: [{ id: 'broken', name: 42 }],
    } }).success).toBe(false);
  });

  it('opens retained placements and nested extras without letting malformed known catalogs become empty', () => {
    const stored = StoredPromptLibraryRecordV1Schema.parse({ key: 'coding', future: true, value: { v: 1, future: true,
      scope: { kind: 'coding', future: true }, entries: [{ id: 'skill', ref: { kind: 'bundle', artifactId: 'bundle', future: true },
        enabled: true, placement: 'skill_instructions', maxChars: 1000, future: true }] } });
    expect(stored.value).toMatchObject({ entries: [{ id: 'skill', placement: 'skill_instructions', maxChars: 1000 }] });
    expect(stored).not.toHaveProperty('future');
    expect(StoredPromptLibraryRecordV1Schema.safeParse({ key: 'invocations', value: { v: 1, entries: [{ id: 'broken' }] } }).success).toBe(false);
    expect(StoredPromptLibraryRecordV1Schema.safeParse({ key: 'registry-sources', value: { v: 9, sources: [] } }).success).toBe(false);
  });

  it('keeps Plain keyless, binds encrypted content to the catalog address and refuses unavailable material', () => {
    const record = PromptLibraryRecordV1Schema.parse({ key: 'role-overrides', value: { v: 1,
      overrides: { reviewer: { roleId: 'reviewer', workspaceWrites: 'deny', instructionsOverride: 'Keep deny' } } } });
    const plain = sealPromptLibraryContentV1({ record, mode: 'plain', material: null });
    expect(openPromptLibraryContentV1({ key: 'role-overrides', mode: 'plain', material: null, content: plain })).toEqual({ status: 'opened', record });
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(4) };
    const encrypted = sealPromptLibraryContentV1({ record, mode: 'e2ee', material, randomBytes: length => new Uint8Array(length).fill(7) });
    expect(openPromptLibraryContentV1({ key: 'role-overrides', mode: 'e2ee', material, content: encrypted })).toEqual({ status: 'opened', record });
    expect(openPromptLibraryContentV1({ key: 'coding', mode: 'e2ee', material, content: encrypted })).toMatchObject({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(openPromptLibraryContentV1({ key: 'role-overrides', mode: 'e2ee', material: null, content: encrypted })).toMatchObject({ status: 'unavailable', reason: 'encryption-material-unavailable' });
    expect(openPromptLibraryContentV1({ key: 'role-overrides', mode: 'plain', material: null, content: encrypted })).toMatchObject({ status: 'unavailable', reason: 'account-mode-mismatch' });
  });
});
