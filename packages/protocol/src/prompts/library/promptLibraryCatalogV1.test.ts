import { describe, expect, it, vi } from 'vitest';
import { emptyPromptLibraryRecordV1, loadPromptLibraryCatalogV1, readPromptLibraryCatalogRecordV1, readRetainedPromptLibraryInventoryV1 } from './promptLibraryCatalogV1.js';
import { PromptLibraryCatalogKeyV1Schema, sealPromptLibraryContentV1, type PromptLibraryRowsListResponseV1Schema } from './promptLibraryRowsV1.js';
import { retainLegacyRoleArtifactsV1, type RoleArtifactStoreV1 } from '../roles/accountRoleActions.js';

/** Test adapter: drive the batched first-activation write through a per-record fake. */
function initializeEach(write: (input: Readonly<{ record: any; expectedRevision: 'absent'; sourceSettingsVersion: number }>) => Promise<any>) {
  return async (input: Readonly<{ records: readonly any[]; sourceSettingsVersion: number }>): Promise<any> => {
    const rows: Array<{ key: any; revision: number; cursor: number }> = [];
    for (const record of input.records) {
      const receipt = await write({ record, expectedRevision: 'absent', sourceSettingsVersion: input.sourceSettingsVersion });
      if (receipt.status !== 'updated') return receipt;
      rows.push({ key: record.key, revision: receipt.revision, cursor: receipt.cursor });
    }
    return { status: 'updated', rows };
  };
}

describe('Prompt library destination authority', () => {
  it('activates retained rows for a finite read without source cleanup, then respects destination deletion', async () => {
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = [];
    let sourceReads = 0;
    const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null, maintainSource: false,
      readRows: async () => ({ status: 'listed', rows }), transfer: {
        readSourceSnapshot: async () => {
          sourceReads++;
          return { raw: { promptFoldersV1: { v: 1, folders: [{ id: 'retained', name: 'Retained' }] } }, version: 7 };
        },
        initializeRecords: initializeEach(async input => {
          expect(input.sourceSettingsVersion).toBe(7);
          rows.push({ key: input.record.key, revision: 1,
            content: sealPromptLibraryContentV1({ record: input.record, mode: 'plain', material: null }) });
          return { status: 'updated', revision: 1, cursor: 1 };
        }),
        replaceSource: async () => { throw new Error('Finite read must leave source cleanup to hydration'); },
        normalizeHistory: async () => { throw new Error('Finite read must not read history'); },
      } });
    expect(readPromptLibraryCatalogRecordV1({ catalog: await load(), key: 'folders' })).toMatchObject({
      status: 'ready', revision: 1, authority: 'active', record: { value: { folders: [{ id: 'retained', name: 'Retained' }] } },
    });
    expect(sourceReads).toBe(1);
    const index = rows.findIndex(row => row.key === 'folders');
    rows[index] = { key: 'folders', revision: 2, content: null };
    expect(readPromptLibraryCatalogRecordV1({ catalog: await load(), key: 'folders' })).toMatchObject({
      status: 'ready', revision: 2, authority: 'active', record: { value: { folders: [] } },
    });
    expect(sourceReads).toBe(1);
  });
  it('transfers only the demanded registry row from Settings and never reseeds its deletion', async () => {
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = [];
    const readRows = vi.fn(async () => ({ status: 'listed' as const, rows }));
    const readSourceSnapshot = vi.fn(async () => ({ version: 7, raw: {
      promptRegistrySourcesV1: { v: 2, sources: [], disabledSourceIds: ['disabled-on-predecessor'] },
      promptFoldersV1: { v: 1, folders: [{ id: 'unrelated', name: 'Unrelated' }] },
    } }));
    const initializeRecords = vi.fn(initializeEach(async ({ record }) => {
      rows.push({ key: record.key, revision: 1, content: sealPromptLibraryContentV1({ record, mode: 'plain', material: null }) });
      return { status: 'updated', revision: 1, cursor: 1 };
    }));
    const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null, transferKeys: ['registry-sources'],
      readRows, transfer: { readSourceSnapshot, initializeRecords } });

    expect(readPromptLibraryCatalogRecordV1({ catalog: await load(), key: 'registry-sources' })).toMatchObject({
      status: 'ready', revision: 1, record: { value: { disabledSourceIds: ['disabled-on-predecessor'] } },
    });
    expect(initializeRecords).toHaveBeenCalledTimes(1);
    expect(initializeRecords.mock.calls[0]?.[0]).toMatchObject({
      sourceSettingsVersion: 7, records: [{ key: 'registry-sources' }],
    });
    expect(readRows).toHaveBeenCalledTimes(2);

    rows[0] = { key: 'registry-sources', revision: 2, content: null };
    expect(readPromptLibraryCatalogRecordV1({ catalog: await load(), key: 'registry-sources' })).toMatchObject({
      status: 'ready', revision: 2, record: { value: { disabledSourceIds: [] } },
    });
    expect(readSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(initializeRecords).toHaveBeenCalledTimes(1);
    expect(readRows).toHaveBeenCalledTimes(3);
  });

  it('classifies retained skills before admitting rule authority, then publishes before cleanup', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let published = false;
    let started!: () => void;
    const classificationStarted = new Promise<void>(resolve => { started = resolve; });
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] =
      PromptLibraryCatalogKeyV1Schema.options.map(key => {
        const record = emptyPromptLibraryRecordV1(key);
        return { key, revision: 1, content: { t: 'plain', v: record.key === 'coding' ? { ...record,
          value: { ...record.value, entries: [{ id: 'retained', ref: { kind: 'bundle', artifactId: 'legacy-skill' },
            placement: 'system_append', enabled: true }] } } : record } };
      });
    const loading = loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => ({ status: 'listed', rows }),
      onReadyBeforeCleanup: async catalog => { expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'skill-rules' }).status).toBe('ready'); published = true; },
      skillMigration: { readArtifact: async () => { started(); await held; return { header: { v: 1, kind: 'prompt_bundle.v2', title: 'Legacy', bundleSchemaId: 'skills.skill_md_v1' } }; },
        writeRecord: async ({ record }) => { const index = rows.findIndex(row => row.key === record.key);
          rows[index] = { key: record.key, revision: 2, content: { t: 'plain', v: record } };
          return { status: 'updated', revision: 2, cursor: 2 }; } },
      transfer: { readSourceSnapshot: async () => ({ raw: {}, version: 7 }),
        initializeRecords: initializeEach(async () => { throw new Error('Complete received authority must not initialize'); }),
        replaceSource: async () => ({ status: 'applied', settingsVersion: 8 }) } });
    try { await classificationStarted; expect(published).toBe(false); } finally { release(); }
    const final = await loading;
    expect(published).toBe(true);
    expect(readPromptLibraryCatalogRecordV1({ catalog: final, key: 'skill-rules' })).toMatchObject({ status: 'ready',
      record: { value: { rules: expect.arrayContaining([expect.objectContaining({ skillId: 'legacy-skill', enabled: true })]) } } });
  });
  it('initializes the root-less skills row once without retiring a nonexistent Settings root or reseeding deletion', async () => {
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] =
      PromptLibraryCatalogKeyV1Schema.options.filter(key => String(key) !== 'skill-rules').map(key => ({ key, revision: 1,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } }));
    const initialized: unknown[] = [];
    let retired: readonly string[] = [];
    let raw: Readonly<Record<string, unknown>> = { undefined: 'keep', null: 'keep',
      promptStacksV1: { v: 1, surfaces: { coding: [], voice: [], profilesById: {} } },
      promptFoldersV1: { v: 1, folders: [] }, promptInvocationsV1: { v: 1, entries: [] },
      promptExternalLinksV1: { v: 1, links: [] }, promptRegistrySourcesV1: { v: 1, sources: [] },
      contextSelectionsV1: { v: 1, selectionsByKey: {} }, rolesV1: { v: 1, overrides: {} } };
    const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => ({ status: 'listed', rows }), transfer: {
      readSourceSnapshot: async () => ({ raw, version: 7 }),
      initializeRecords: initializeEach(async input => {
        initialized.push(input.record);
        rows.push({ key: input.record.key, revision: 1, content: { t: 'plain', v: input.record } });
        return { status: 'updated', revision: 1, cursor: 1 };
      }),
      replaceSource: async input => { raw = input.raw; return { status: 'applied', settingsVersion: 8 }; },
      normalizeHistory: async input => { retired = input.activeTransferredRoots; return { status: 'complete' }; },
    } });
    expect(await load()).toMatchObject({ status: 'ready', rows: expect.arrayContaining([
      { record: { key: 'skill-rules', value: { v: 1, rules: [] } }, revision: 1 },
    ]) });
    expect(initialized).toMatchObject([{ key: 'skill-rules', value: { v: 1, rules: [] } }]);
    expect(raw).toEqual({ undefined: 'keep', null: 'keep',
      promptStacksV1: { v: 1, surfaces: { profilesById: {} } } });
    expect(retired.every(root => typeof root === 'string' && root !== 'undefined' && root !== 'null')).toBe(true);
    const index = rows.findIndex(row => String(row.key) === 'skill-rules');
    rows[index] = { ...rows[index]!, revision: 2, content: null };
    const deleted = await load();
    expect(deleted).toMatchObject({ status: 'ready', tombstones: expect.arrayContaining([{ key: 'skill-rules', revision: 2 }]) });
    expect(readPromptLibraryCatalogRecordV1({ catalog: deleted, key: 'skill-rules' })).toEqual({ status: 'ready',
      record: { key: 'skill-rules', value: { v: 1, rules: [] } }, revision: 2, authority: 'active' });
    expect(initialized).toHaveLength(1);
  });
  it('publishes complete destination authority before a pending retained-source maintenance read', async () => {
    let releaseSource!: () => void;
    const source = new Promise<void>(resolve => { releaseSource = resolve; });
    let reachedSource!: () => void;
    const sourceIssued = new Promise<void>(resolve => { reachedSource = resolve; });
    let readable = false;
    const load = loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key,
        revision: 4, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) }),
      onReadyBeforeCleanup: async catalog => {
        readable = readPromptLibraryCatalogRecordV1({ catalog, key: 'role-overrides' }).status === 'ready';
      }, transfer: {
        readSourceSnapshot: async () => { reachedSource(); await source; return { raw: {}, version: 7 }; },
        initializeRecords: initializeEach(async () => { throw new Error('Existing authority cannot reseed'); }),
        replaceSource: async () => ({ status: 'applied', settingsVersion: 8 }),
      } });
    try {
      await sourceIssued;
      expect(readable).toBe(true);
    } finally { releaseSource(); await load; }
  });
  it('activates predecessor folders with retained dangling topology without repairing or losing them', async () => {
    const retained = { v: 1 as const, folders: [{ id: 'retained', name: 'Retained', parentId: 'missing' }] };
    const response: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }> = { status: 'listed', rows: [] };
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => response,
      transfer: {
        readSourceSnapshot: async () => ({ raw: { promptFoldersV1: retained }, version: 7 }),
        initializeRecords: initializeEach(async input => {
          const content = sealPromptLibraryContentV1({ record: input.record, mode: 'plain', material: null });
          response.rows.push({ key: input.record.key, revision: 1, content });
          return { status: 'updated', revision: 1, cursor: 1 };
        }),
      },
    });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'folders' })).toMatchObject({ status: 'ready',
      authority: 'active', revision: 1, record: { key: 'folders', value: retained } });
  });
  it('retries guidance history sanitation from the cleaned current source without recreating a user-deleted Role', async () => {
    let raw: Readonly<Record<string, unknown>> = { executionRunsGuidanceEnabled: true,
      executionRunsGuidanceEntries: [{ id: 'legacy', description: 'Retained guidance' }] };
    let sourceVersion = 7;
    let historyAttempts = 0;
    let creations = 0;
    const artifacts = new Map<string, NonNullable<Awaited<ReturnType<RoleArtifactStoreV1['read']>>>>();
    // Artifact persistence is a genuine boundary; inventory, retention and cleanup logic remain real.
    const artifactStore: RoleArtifactStoreV1 = {
      read: async id => artifacts.get(id) ?? null,
      create: async input => {
        creations += 1;
        const artifact = { artifactId: input.artifactId, header: input.header, body: input.body,
          revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account', access: 'owner' as const };
        artifacts.set(input.artifactId, artifact);
        return { artifactId: artifact.artifactId, revision: artifact.revision };
      },
      list: async () => ({ items: [] }),
      update: async () => ({ ok: false, errorCode: 'unsupported', error: 'Not part of retention' }),
      delete: async id => { artifacts.delete(id); return { ok: true }; },
    };
    const rows = PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 4,
      content: { t: 'plain' as const, v: emptyPromptLibraryRecordV1(key) } }));
    const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows }), transfer: {
        readSourceSnapshot: async () => ({ raw, version: sourceVersion }),
        initializeRecords: initializeEach(async () => { throw new Error('Existing rows cannot reseed'); }),
        retainLegacyRoleArtifacts: rawSettings => retainLegacyRoleArtifactsV1({ rawSettings, accountId: 'account', artifactStore }),
        replaceSource: async input => { raw = input.raw; sourceVersion += 1; return { status: 'applied', settingsVersion: sourceVersion }; },
        normalizeHistory: async input => {
          historyAttempts += 1;
          const completeCurrentProof = 'legacyRoleArtifactTransfers' in input && Array.isArray(input.legacyRoleArtifactTransfers);
          return historyAttempts === 1 || !completeCurrentProof ? { status: 'cleanup-pending', versions: [6] } : { status: 'complete' };
        },
      } });
    expect(await load()).toMatchObject({ status: 'ready', cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } });
    expect(raw).toEqual({});
    expect(creations).toBe(1);
    artifacts.clear(); // The user deletes the retained Role after the source CAS succeeded.
    expect(await load()).toMatchObject({ status: 'ready', cleanup: { status: 'complete' } });
    expect(artifacts.size).toBe(0);
    expect(creations).toBe(1);
  });
  it('admits an existing row independently when absent neighbors cannot read their retained source', async () => {
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows: [{ key: 'role-overrides', revision: 4,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1('role-overrides') } }] }),
      transfer: {
        readSourceSnapshot: async () => { throw new Error('Home Settings read unavailable'); },
        initializeRecords: initializeEach(async () => { throw new Error('Unobserved source cannot initialize'); }),
      },
    });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'role-overrides' })).toMatchObject({ status: 'ready', authority: 'active', revision: 4 });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'coding', rawSettings: {} }).status).toBe('unavailable');
  });
  it('keeps an existing row authoritative when an absent neighbor import loses its transport', async () => {
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows: [{ key: 'role-overrides', revision: 4,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1('role-overrides') } }] }),
      transfer: {
        readSourceSnapshot: async () => ({ raw: {}, version: 7 }),
        initializeRecords: initializeEach(async () => { throw new Error('Home mutation transport unavailable'); }),
      },
    });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'role-overrides' })).toMatchObject({ status: 'ready', authority: 'active', revision: 4 });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'coding', rawSettings: {} })).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
  });
  it('keeps admitted destination authority ready when retained source cleanup is unavailable', async () => {
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = PromptLibraryCatalogKeyV1Schema.options.map(key => ({
      key, revision: 4, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
    }));
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => ({ status: 'listed', rows }),
      transfer: {
        readSourceSnapshot: async () => { throw new Error('Home Settings read unavailable'); },
        initializeRecords: initializeEach(async () => { throw new Error('Existing authority cannot be reseeded'); }),
        replaceSource: async () => { throw new Error('Unavailable source cannot be removed'); },
      },
    });
    expect(catalog).toMatchObject({ status: 'ready', cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'coding' })).toMatchObject({ status: 'ready', authority: 'active', revision: 4 });
  });
  it('retires only activated Account source fields while keeping the Profile source until its own owner contracts it', async () => {
    const profileStack = [{ id: 'profile-entry', ref: { kind: 'doc', artifactId: 'profile-doc' }, enabled: true, placement: 'system_append' }];
    let raw: Readonly<Record<string, unknown>> = { preference: true, promptFoldersV1: { v: 1, folders: [{ id: 'retained', name: 'Retained' }] },
      promptStacksV1: { v: 1, surfaces: { coding: [], voice: [], profilesById: { codex: profileStack } } } };
    const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = PromptLibraryCatalogKeyV1Schema.options.map(key => ({
      key, revision: 4, content: key === 'folders' ? null : { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
    }));
    await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => ({ status: 'listed', rows }),
      transfer: {
        readSourceSnapshot: async () => ({ raw, version: 7 }),
        initializeRecords: initializeEach(async () => ({ status: 'conflict', revision: 4 })),
        replaceSource: async input => {
          if (input.expectedVersion !== 7) return { status: 'conflict', currentSettingsVersion: 7 };
          raw = input.raw;
          return { status: 'applied', settingsVersion: 8 };
        },
      },
    });
    expect(raw).toEqual({ preference: true, promptStacksV1: { v: 1, surfaces: { profilesById: { codex: profileStack } } } });
  });
  it('publishes the actual imported destination rows with retained order and captured Settings admission', async () => {
    const response: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }> = { status: 'listed', rows: [] };
    const stack = { id: 'skill', ref: { kind: 'bundle', artifactId: 'bundle' }, enabled: true, placement: 'skill_instructions', editPolicy: 'user_only' };
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => response,
      transfer: {
        readSourceSnapshot: async () => ({ raw: { promptStacksV1: { v: 1, surfaces: { coding: [stack], voice: [], profilesById: {} } } }, version: 7 }),
        initializeRecords: initializeEach(async input => {
          if (input.sourceSettingsVersion !== 7) return { status: 'settings-conflict', revision: 7 };
          response.rows.push({ key: input.record.key, revision: 1, content: { t: 'plain', v: input.record } });
          return { status: 'updated', revision: 1, cursor: 1 };
        }),
      },
    });
    const coding = readPromptLibraryCatalogRecordV1({ catalog, key: 'coding' });
    expect(coding).toMatchObject({ status: 'ready', authority: 'active', revision: 1, record: { key: 'coding', value: { entries: [
      { id: 'skill', placement: 'skill_instructions' },
    ] } } });
    if (coding.status === 'ready' && coding.record.key === 'coding') expect(coding.record.value.entries[0]).not.toHaveProperty('editPolicy');
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'contexts' })).toMatchObject({ status: 'ready', authority: 'active' });
  });
  it('activates complete retained catalogs through their single CAS while never reseeding tombstones', async () => {
    const rows: Array<{ key: 'folders'; revision: number; content: null }> = [{ key: 'folders', revision: 9, content: null }];
    const imported: string[] = [];
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows }),
      transfer: {
        readSourceSnapshot: async () => ({ raw: {}, version: 4 }),
        initializeRecords: initializeEach(async input => { imported.push(input.record.key); return { status: 'conflict', revision: 2 }; }),
      },
    });
    expect(imported).toContain('coding');
    expect(imported).not.toContain('folders');
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'folders' })).toMatchObject({
      status: 'ready', authority: 'active', revision: 9,
      record: { key: 'folders', value: { v: 1, folders: [] } },
    });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'coding', rawSettings: {} })).toMatchObject({
      status: 'unavailable', reason: 'authority-not-confirmed',
    });
  });
  it('retains every ordered predecessor placement and Profile scope; malformed known data is incomplete', () => {
    const entry = { id: 'skill', ref: { kind: 'bundle', artifactId: 'bundle' }, enabled: true, placement: 'skill_instructions', editPolicy: 'user_only' };
    const inventory = readRetainedPromptLibraryInventoryV1({ promptStacksV1: { v: 1, surfaces: {
      coding: [entry], voice: [], profilesById: { profile: [entry] }, future: true,
    } }, promptFoldersV1: { v: 1, folders: [{ id: 'folder', name: 'Folder', future: true }] } });
    expect(inventory.status).toBe('ready');
    if (inventory.status !== 'ready') return;
    expect(inventory.profileStacksById.profile?.[0]).toMatchObject({ id: 'skill', placement: 'skill_instructions' });
    expect(inventory.records.find(record => record.key === 'coding')?.value).toMatchObject({ entries: [{ id: 'skill', placement: 'skill_instructions' }] });
    expect(inventory.profileStacksById.profile?.[0]).not.toHaveProperty('editPolicy');
    expect(readRetainedPromptLibraryInventoryV1({ promptInvocationsV1: { v: 1, entries: [{ id: 'broken' }] } })).toMatchObject({ status: 'partial' });
    expect(readRetainedPromptLibraryInventoryV1({ contextSelectionsV1: { v: 8, selectionsByKey: {} } })).toMatchObject({ status: 'partial' });
  });

  // cli-v0.2.17 (a2c45c86804b24e60ac0b76146a3ef36dfcaa15b) and ui-web-v0.2.19
  // (63829e3cd6a8f1f48b10891af0c8b2313e51ac7e): promptLibrary/promptRegistriesV1.ts
  // permits arbitrary adapter ids and config dictionaries.
  it.each(['custom-adapter', 'unrepresented-config', 'duplicate', 'malformed'] as const)(
    'keeps an incomplete registry source and its history unactivated: %s', async variant => {
      const valid = { id: 'team', adapterId: 'git', title: 'Team', enabled: true,
        config: { repositoryUrl: 'https://github.com/team/skills', subdirectory: 'skills', ref: 'main' } };
      const unresolved = variant === 'custom-adapter'
        ? { id: 'private', adapterId: 'custom-adapter', title: 'Private', enabled: true, config: { endpoint: 'https://private.example' } }
        : variant === 'unrepresented-config' ? { ...valid, id: 'private', config: { ...valid.config, customOption: 'retain' } }
        : variant === 'duplicate' ? { ...valid, title: 'Other definition' } : { id: 'broken' };
      const original = { v: 1, sources: [valid, unresolved] };
      let raw: Readonly<Record<string, unknown>> = { promptRegistrySourcesV1: original,
        promptFoldersV1: { v: 1, folders: [{ id: 'folder', name: 'Folder' }] } };
      const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = [];
      const normalizedRoots: string[] = [];
      const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
        readRows: async () => ({ status: 'listed', rows }), transfer: {
          readSourceSnapshot: async () => ({ raw, version: 7 }),
          initializeRecords: initializeEach(async ({ record }) => {
            rows.push({ key: record.key, revision: 1, content: sealPromptLibraryContentV1({ record, mode: 'plain', material: null }) });
            return { status: 'updated', revision: 1, cursor: 1 };
          }),
          replaceSource: async input => { raw = input.raw; return { status: 'applied', settingsVersion: 8 }; },
          normalizeHistory: async input => { normalizedRoots.push(...input.activeTransferredRoots); return { status: 'complete' }; },
        } });
      for (let attempt = 0; attempt < 2; attempt++) {
        const catalog = await load();
        expect(catalog).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining([
          { key: 'registry-sources', revision: 'absent', reason: 'invalid-stored-content' },
        ]), cleanup: { status: 'cleanup-pending' } });
        expect(rows.some(row => row.key === 'registry-sources')).toBe(false);
        expect(raw.promptRegistrySourcesV1).toEqual(original);
        expect(normalizedRoots).not.toContain('promptRegistrySourcesV1');
        expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'folders' })).toMatchObject({ status: 'ready', authority: 'active' });
      }
      // Repairing the unresolved source through its owner permits the ordinary transfer and cleanup.
      raw = { ...raw, promptRegistrySourcesV1: { v: 1, sources: [valid] } };
      const repaired = await load();
      expect(repaired).toMatchObject({ status: 'ready', cleanup: { status: 'complete' } });
      expect(readPromptLibraryCatalogRecordV1({ catalog: repaired, key: 'registry-sources' })).toMatchObject({
        status: 'ready', authority: 'active', record: { value: { sources: [
          { id: 'team', format: 'git', url: valid.config.repositoryUrl, path: 'skills', ref: 'main' },
        ] } },
      });
      expect(raw).not.toHaveProperty('promptRegistrySourcesV1');
      expect(normalizedRoots).toContain('promptRegistrySourcesV1');
    });

  it('destination rows and tombstones win over retained Settings while absent domains read only their compatibility owner', async () => {
    const raw = { promptFoldersV1: { v: 1, folders: [{ id: 'old', name: 'Old' }] } };
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
      readRows: async () => ({ status: 'listed', rows: [{ key: 'folders', revision: 5, content: null }] }) });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'folders', rawSettings: raw })).toMatchObject({ status: 'ready', authority: 'active', revision: 5,
      record: { key: 'folders', value: { v: 1, folders: [] } } });
    expect(readPromptLibraryCatalogRecordV1({ catalog, key: 'contexts', rawSettings: raw })).toMatchObject({ status: 'ready', authority: 'inactive', revision: 'absent' });
    const unavailable = { status: 'unavailable', reason: 'account-mode-mismatch' } as const;
    expect(readPromptLibraryCatalogRecordV1({ catalog: unavailable, key: 'folders', rawSettings: raw })).toEqual(unavailable);
  });

  it('does not expose earlier Plain rows when any later row violates Account mode', async () => {
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => ({ status: 'listed', rows: [
      { key: 'folders', revision: 2, content: { t: 'plain', v: { key: 'folders', value: { v: 1, folders: [] } } } },
      { key: 'coding', revision: 3, content: { t: 'encrypted', c: 'broken' } },
    ] }) });
    expect(catalog).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
  });
});
