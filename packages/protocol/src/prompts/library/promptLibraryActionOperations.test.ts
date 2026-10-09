import { describe, expect, it, vi } from 'vitest';
import type { PromptLibraryCatalogSnapshotV1 } from './promptLibraryCatalogV1.js';
import type { PromptLibraryRecordV1 } from './promptLibraryRowsV1.js';
import type { ArtifactFolderActionPortV1 } from './promptFolderActionsV1.js';

import {
  createPromptDocInLibrary,
  setPromptDocFavorite,
  listPromptLibrary,
  listMemoryDocsInLibrary,
  type PromptLibraryArtifactStore,
  exportPromptLibraryArtifact,
  installPromptRegistryItemInLibrary,
  updatePromptDocInLibrary,
  updatePromptBundleInLibrary,
  readPromptDocInLibrary,
  rememberMemoryFactInLibrary,
  updateMemoryFactInLibrary,
  forgetMemoryFactInLibrary,
  readMemoryDocInLibrary,
  createMemoryDocInLibrary,
  type PromptLibraryStoredArtifact,
} from './promptLibraryActionOperations.js';

// Persistence-boundary fixture; catalog admission and organization projection stay real.
function emptyOrganizationPort(): ArtifactFolderActionPortV1 {
  return {
    serverId: 'home', assertCurrent: () => {},
    readCatalog: async () => ({ catalog: { status: 'ready', rows: [
      { record: { key: 'folders', value: { v: 1, folders: [] } }, revision: 1 },
    ], tombstones: [], diagnostics: [] } }),
    readArtifactHeader: async () => null,
    listArtifactHeaders: async () => ({ items: [], coverage: 'complete' }),
    writeRecord: async () => { throw new Error('Read-only inventory fixture'); },
  };
}

describe('prompt library action operations', () => {
  it('lists memory content without requiring personal folder authority', async () => {
    const store: PromptLibraryArtifactStore = {
      read: async () => null,
      update: async () => {},
      list: async () => ({ coverage: 'complete', items: [{ id: 'memory', updatedAtMs: 1,
        header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' } }] }),
    };
    expect(await listMemoryDocsInLibrary({ store, request: {} })).toEqual({
      items: [{ artifactId: 'memory', title: 'Memory', updatedAtMs: 1 }], coverage: 'complete',
    });
  });
  it('does not infer personal organization authority from a missing catalog port', async () => {
    const store: PromptLibraryArtifactStore = {
      read: async () => null,
      update: async () => {},
      list: async () => ({ coverage: 'complete', items: [{ id: 'received', updatedAtMs: 1,
        header: { v: 1, kind: 'prompt_doc.v2', title: 'Shared', folderId: 'foreign', tags: ['Owner private'] } }] }),
    };
    const result = await listPromptLibrary({ store, request: { query: 'Owner private' } });
    expect(result).toEqual({ items: [], coverage: 'unavailable' });
  });
  it('returns the acknowledged Artifact revision for repeated reviewed saves', async () => {
    let stored: PromptLibraryStoredArtifact = { id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Original' },
      body: JSON.stringify({ v: 1, markdown: 'Original', createdAtMs: 1, updatedAtMs: 1 }) };
    const store = { read: async () => stored, update: async (input: Parameters<PromptLibraryArtifactStore['update']>[0]) => {
      stored = { ...stored, header: input.header, body: input.body,
        revision: { headerVersion: stored.revision.headerVersion + 1, bodyVersion: stored.revision.bodyVersion + 1 } };
      return { revision: stored.revision };
    } };
    const first = await updatePromptDocInLibrary({ store, request: { artifactId: 'doc', title: 'First', markdown: 'First', expectedRevision: stored.revision } });
    expect(first).toEqual({ ok: true, artifactId: 'doc', revision: stored.revision });
    const second = await updatePromptDocInLibrary({ store, request: { artifactId: 'doc', title: 'Second', markdown: 'Second', expectedRevision: stored.revision } });
    expect(second).toEqual({ ok: true, artifactId: 'doc', revision: stored.revision });
    expect(JSON.parse(stored.body!)).toMatchObject({ markdown: 'Second' });
  });

  it('refuses personal placement without its Account owner before editing Artifact content', async () => {
    let writes = 0;
    const store: PromptLibraryArtifactStore = {
      read: async () => ({ id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'prompt_doc.v2', title: 'Original' },
        body: JSON.stringify({ v: 1, markdown: 'Original', createdAtMs: 1, updatedAtMs: 1 }) }),
      update: async () => { writes += 1; },
    };
    await expect(updatePromptDocInLibrary({ store, request: { artifactId: 'doc', title: 'Edited', markdown: 'Edited', folderId: 'missing' } }))
      .rejects.toMatchObject({ code: 'artifact_organization_unavailable' });
    expect(writes).toBe(0);
  });
  it('returns the actual preview revision and refuses a reviewed edit after either Artifact version changes', async () => {
    for (const changedVersion of ['headerVersion', 'bodyVersion'] as const) {
      let stored: PromptLibraryStoredArtifact = { id: 'doc', revision: { headerVersion: 3, bodyVersion: 7 },
        header: { v: 1, kind: 'prompt_doc.v2', title: 'Original' },
        body: JSON.stringify({ v: 1, markdown: 'Original', createdAtMs: 1, updatedAtMs: 1 }) };
      const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
        stored = { ...stored, header: input.header, body: input.body };
      } };
      const preview = await readPromptDocInLibrary({ store, artifactId: 'doc' });
      expect(preview).toEqual({ ok: true, artifactId: 'doc', title: 'Original', markdown: 'Original', revision: stored.revision });
      if (!preview.ok) throw new Error('Expected admitted preview');
      const reviewedRevision = { headerVersion: 3, bodyVersion: 7 };
      stored = { ...stored, revision: { ...stored.revision, [changedVersion]: stored.revision[changedVersion] + 1 },
        header: { ...stored.header, title: 'Concurrent' },
        body: JSON.stringify({ v: 1, markdown: 'Concurrent', createdAtMs: 1, updatedAtMs: 2 }) };
      const newer = stored;
      await expect(updatePromptDocInLibrary({ store, request: { artifactId: 'doc', title: 'Reviewed', markdown: 'Reviewed',
        expectedRevision: reviewedRevision } })).rejects.toMatchObject({ code: 'version_mismatch' });
      expect(stored).toBe(newer);
    }
  });

  it('normalizes stored known fields without promoting extensions into canonical document writes', async () => {
    let stored: PromptLibraryStoredArtifact = { id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Original', locked: false, extension: { authority: true } },
      body: JSON.stringify({ v: 1, markdown: '', createdAtMs: 1, updatedAtMs: 1, extension: { authority: true } }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      stored = { ...stored, header: input.header, body: input.body };
    } };
    await updatePromptDocInLibrary({ store, request: { artifactId: 'doc', title: 'Edited', markdown: '' }, nowMs: () => 2 });
    expect(stored.header).not.toHaveProperty('extension');
    expect(JSON.parse(stored.body!)).toEqual({ v: 1, markdown: '', createdAtMs: 1, updatedAtMs: 2 });
    expect(stored.header).toMatchObject({ kind: 'prompt_doc.v2', title: 'Edited', locked: false });
  });

  it('creates one canonical memory Artifact with the first sanitized fact in its requested topic', async () => {
    let saved: Parameters<NonNullable<PromptLibraryArtifactStore['create']>>[0] | undefined;
    const result = await createMemoryDocInLibrary({
      store: { read: async () => null, update: async () => { throw new Error('Creation is not an update'); },
        create: async input => { saved = input; return 'memory'; } },
      request: { title: 'Account memory', text: 'Build rule; password=secret', topic: 'Build', expiresAtMs: 50 },
      randomId: () => 'first', nowMs: () => 10, sourceSessionRef: { serverId: 'home', sessionId: 'session' },
    });
    expect(result).toEqual({ ok: true, artifactId: 'memory', factId: 'first' });
    expect(saved?.header).toEqual({ v: 1, kind: 'memory_doc.v1', title: 'Account memory' });
    expect(JSON.parse(saved!.body)).toEqual({ v: 1, index: [], topics: [{ title: 'Build', summary: 'Facts about Build.',
      facts: [{ id: 'first', text: 'Build rule; password: [REDACTED]', createdAtMs: 10,
        sourceSessionRef: { serverId: 'home', sessionId: 'session' }, expiresAtMs: 50 }] }] });
  });

  it('keeps prompt organization personal instead of writing it into the shared Artifact', async () => {
    let stored: PromptLibraryStoredArtifact | null = null;
    let folderRecord: Extract<PromptLibraryRecordV1, { key: 'folders' }> = {
      key: 'folders', value: { v: 1, folders: [{ id: 'personal', name: 'Personal' }] },
    };
    let folderRevision = 1;
    const store = {
      read: async () => stored,
      create: async (input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string }>) => {
        stored = { id: 'doc', header: input.header, body: input.body, revision: { headerVersion: 1, bodyVersion: 1 } };
        return 'doc';
      },
      update: async (input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string }>) => {
        stored = { id: 'doc', header: input.header, body: input.body, revision: { headerVersion: 2, bodyVersion: 2 } };
      },
      organization: {
        serverId: 'home', assertCurrent: () => {},
        readCatalog: async () => ({ catalog: {
          status: 'ready', rows: [{ record: folderRecord, revision: folderRevision }], tombstones: [], diagnostics: [],
        } satisfies PromptLibraryCatalogSnapshotV1 }),
        readArtifactHeader: async () => stored ? { header: stored.header ?? {}, owned: true } : null,
        listArtifactHeaders: async () => ({ items: stored ? [{ artifactId: stored.id, header: stored.header ?? {}, owned: true }] : [], coverage: 'complete' as const }),
        writeRecord: async (input: Readonly<{ record: PromptLibraryRecordV1; expectedRevision: number | 'absent' }>) => {
          if (input.expectedRevision !== folderRevision) return { status: 'conflict' as const, revision: folderRevision };
          if (input.record.key !== 'folders') throw new Error('wrong-domain');
          folderRecord = input.record;
          folderRevision += 1;
          return { status: 'updated' as const, revision: folderRevision, cursor: folderRevision };
        },
      },
    } satisfies PromptLibraryArtifactStore & { organization: unknown };
    await createPromptDocInLibrary({ store, request: { title: 'Prompt', markdown: 'Original', folderId: 'personal', tags: [' Work ', 'work'] } });
    expect((await store.read())?.header).not.toHaveProperty('folderId');
    expect((await store.read())?.header).not.toHaveProperty('tags');
    expect(folderRecord.value).toMatchObject({ artifactHeadersById: { doc: { folderId: 'personal', tags: ['Work'] } } });
    await updatePromptDocInLibrary({ store, request: { artifactId: 'doc', title: 'Prompt', markdown: 'Edited', folderId: null } });
    expect((await store.read())?.header).not.toHaveProperty('folderId');
    expect(folderRecord.value).toMatchObject({ artifactHeadersById: { doc: { folderId: null, tags: ['Work'] } } });
  });

  it('sanitizes memory writes, retains provenance/history and refuses stale reviewed revisions', async () => {
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, facts: [], archive: [] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async (input) => {
      if (input.expectedRevision.bodyVersion !== stored.revision.bodyVersion) throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
      stored = { ...stored, revision: { headerVersion: stored.revision.headerVersion + 1, bodyVersion: stored.revision.bodyVersion + 1 }, header: input.header, body: input.body };
    } };
    const sourceSessionRef = { serverId: 'home', sessionId: 'session' };
    await rememberMemoryFactInLibrary({ store, request: { ref: { kind: 'doc', artifactId: 'memory' }, expectedRevision: stored.revision, text: 'Prefer tea; password=secret', expiresAtMs: 50 }, randomId: () => 'first', nowMs: () => 2, sourceSessionRef });
    const read = await readMemoryDocInLibrary({ store, artifactId: 'memory', nowMs: () => 10 });
    expect(read).toMatchObject({ ok: true, body: { index: [{ id: 'first', text: 'Prefer tea; password: [REDACTED]', createdAtMs: 2, sourceSessionRef, expiresAtMs: 50 }], topics: [] } });
    const reviewedRevision = stored.revision;
    await updateMemoryFactInLibrary({ store, request: { ref: { kind: 'doc', artifactId: 'memory' }, expectedRevision: reviewedRevision, factId: 'first', text: 'Prefer coffee', expiresAtMs: null }, randomId: () => 'second', nowMs: () => 3, sourceSessionRef: null });
    expect(JSON.parse(stored.body!)).toMatchObject({ index: [{ id: 'second', supersedes: 'first', text: 'Prefer coffee', sourceSessionRef: null }], topics: [{ title: 'archive', facts: [{ id: 'first' }] }] });
    expect(JSON.parse(stored.body!).index[0]).not.toHaveProperty('expiresAtMs');
    const latest = stored;
    await expect(forgetMemoryFactInLibrary({ store, request: { ref: { kind: 'doc', artifactId: 'memory' }, expectedRevision: reviewedRevision, factId: 'second' } })).rejects.toMatchObject({
      code: 'version_mismatch', details: { current: { ok: true, artifactId: latest.id,
        revision: latest.revision, header: latest.header, body: JSON.parse(latest.body!) } },
    });
    expect(stored).toBe(latest);
    await forgetMemoryFactInLibrary({ store, request: { ref: { kind: 'doc', artifactId: 'memory' }, expectedRevision: stored.revision, factId: 'second' } });
    expect(JSON.parse(stored.body!)).toMatchObject({ index: [], topics: [{ title: 'archive', facts: [{ id: 'first' }, { id: 'second', supersedes: 'first' }] }] });
  });
  it('returns the currently readable memory version after a CAS race without retrying the write', async () => {
    const fact = { id: 'first', text: 'Original', createdAtMs: 1, sourceSessionRef: null };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, facts: [fact], archive: [] }) };
    const latest: PromptLibraryStoredArtifact = { ...stored, revision: { headerVersion: 2, bodyVersion: 2 },
      body: JSON.stringify({ v: 1, index: [{ ...fact, text: 'Concurrent truth' }], topics: [] }) };
    let attempts = 0;
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async () => {
      attempts += 1;
      stored = latest;
      throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
    } };
    await expect(updateMemoryFactInLibrary({ store, request: {
      ref: { kind: 'doc', artifactId: 'memory' }, expectedRevision: stored.revision,
      factId: 'first', text: 'Stale replacement',
    }, randomId: () => 'second', nowMs: () => 2, sourceSessionRef: null })).rejects.toMatchObject({
      code: 'version_mismatch', details: { current: { ok: true, artifactId: 'memory', revision: latest.revision,
        header: latest.header, body: JSON.parse(latest.body!) } },
    });
    expect(stored).toBe(latest);
    expect(attempts).toBe(1);
  });

  it('does not disclose a raced memory version when the current store read loses access', async () => {
    let readable = true;
    const stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, facts: [], archive: [] }) };
    const store: PromptLibraryArtifactStore = { read: async () => {
      if (!readable) throw Object.assign(new Error('revoked'), { code: 'access_denied' });
      return stored;
    }, update: async () => {
      readable = false;
      throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
    } };
    await expect(rememberMemoryFactInLibrary({ store, request: {
      ref: { kind: 'doc', artifactId: 'memory' }, expectedRevision: stored.revision, text: 'Draft',
    }, randomId: () => 'new', nowMs: () => 2, sourceSessionRef: null })).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('creates topics in one Artifact, moves an updated key fact into detail and reads only the selected section', async () => {
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, facts: [], archive: [] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      if (input.expectedRevision.bodyVersion !== stored.revision.bodyVersion) throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
      stored = { ...stored, revision: { headerVersion: stored.revision.headerVersion + 1, bodyVersion: stored.revision.bodyVersion + 1 }, header: input.header, body: input.body };
    } };
    const ref = { kind: 'doc' as const, artifactId: 'memory' };
    await rememberMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, text: 'Key preference' },
      randomId: () => 'key', nowMs: () => 1, sourceSessionRef: null });
    await rememberMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, topic: 'Build', text: 'Use package scripts; password=secret' },
      randomId: () => 'build', nowMs: () => 2, sourceSessionRef: null });
    await updateMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, factId: 'key', topic: 'Build', text: 'Detailed preference' },
      randomId: () => 'replacement', nowMs: () => 3, sourceSessionRef: null });
    expect(JSON.parse(stored.body!)).toMatchObject({ v: 1, index: [], topics: [
      { title: 'Build', summary: 'Facts about Build.', facts: [{ id: 'build', text: 'Use package scripts; password: [REDACTED]' }, { id: 'replacement', supersedes: 'key' }] },
      { title: 'archive', facts: [{ id: 'key' }] },
    ] });
    const index = await readMemoryDocInLibrary({ store, artifactId: 'memory' });
    expect(index).toMatchObject({ body: { v: 1, index: [], topics: [{ title: 'Build', summary: 'Facts about Build.' }, { title: 'archive' }] } });
    expect(JSON.stringify(index)).not.toContain('Detailed preference');
    const section = await readMemoryDocInLibrary({ store, artifactId: 'memory', topic: 'Build', nowMs: () => 4 });
    expect(section).toMatchObject({ ok: true, artifactId: 'memory', revision: stored.revision,
      topic: { title: 'Build', summary: 'Facts about Build.', facts: [{ id: 'build' }, { id: 'replacement' }] } });
    expect(section).not.toHaveProperty('body');
    const beforeInvalidForget = stored;
    await expect(forgetMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, factId: 'replacement' } })).rejects.toMatchObject({ code: 'memory_fact_not_found' });
    expect(stored).toBe(beforeInvalidForget);
    await forgetMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, factId: 'replacement', topic: 'Build' } });
    expect(JSON.parse(stored.body!)).toMatchObject({ topics: [{ title: 'Build', facts: [{ id: 'build' }] },
      { title: 'archive', facts: [{ id: 'key' }, { id: 'replacement' }] }] });
  });

  it('projects expired facts with stored archive on demand without modifying the index or topic storage', async () => {
    const fact = (id: string) => ({ id, text: id, createdAtMs: 1, sourceSessionRef: null });
    const stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1,
        index: [{ ...fact('expired-key'), expiresAtMs: 5 }, fact('active')], topics: [
          { title: 'Build', summary: 'Build details', facts: [{ ...fact('expired-topic'), expiresAtMs: 5 }, fact('detail')] },
          { title: 'archive', summary: 'Earlier facts', facts: [fact('forgotten')] },
        ] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async () => { throw new Error('Reads cannot mutate'); } };
    expect(await readMemoryDocInLibrary({ store, artifactId: 'memory', topic: 'archive', nowMs: () => 5 })).toMatchObject({
      topic: { title: 'archive', facts: [{ id: 'forgotten' }, { id: 'expired-key' }, { id: 'expired-topic' }] },
    });
    expect(await readMemoryDocInLibrary({ store, artifactId: 'memory', nowMs: () => 5 })).toMatchObject({ body: {
      index: [fact('active')], topics: [{ title: 'Build', summary: 'Build details' }, { title: 'archive', summary: 'Earlier facts' }],
    } });
    await expect(readMemoryDocInLibrary({ store, artifactId: 'memory', topic: 'missing' })).rejects.toMatchObject({ code: 'memory_topic_not_found' });
    expect(JSON.parse(stored.body!).index).toHaveLength(2);
    expect(JSON.parse(stored.body!).topics[0].facts).toHaveLength(2);
  });
  it('creates canonical documents with verbatim text and content metadata', async () => {
    let saved: Parameters<NonNullable<PromptLibraryArtifactStore['create']>>[0] | undefined;
    const result = await createPromptDocInLibrary({
      store: { read: async () => null, update: async () => {}, create: async (input) => { saved = input; return 'new'; } },
      request: { title: 'Prompt', markdown: '  keep\n\ntext  ', favorite: true },
      nowMs: () => 42,
    });
    expect(result).toEqual({ ok: true, artifactId: 'new' });
    expect(saved?.header).toMatchObject({ kind: 'prompt_doc.v2', title: 'Prompt', favorite: true });
    expect(JSON.parse(saved!.body)).toEqual({ v: 1, markdown: '  keep\n\ntext  ', createdAtMs: 42, updatedAtMs: 42 });
  });

  it('favourites preserve known fields and reject concurrent newer markdown', async () => {
    let stored: { id: string; revision: PromptLibraryStoredArtifact['revision']; header: Readonly<Record<string, unknown>>; body: string } = { id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt', folderId: 'folder', tags: ['tag'], extension: { keep: true } },
      body: JSON.stringify({ v: 1, markdown: 'old', createdAtMs: 1, updatedAtMs: 1 }) };
    let race = false;
    const store: PromptLibraryArtifactStore = {
      read: async () => stored,
      update: async (input) => {
        if (race) stored = { ...stored, revision: { headerVersion: 2, bodyVersion: 2 }, body: stored.body.replace('old', 'newer') };
        if (input.expectedRevision.bodyVersion !== stored.revision.bodyVersion) throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
        stored = { ...stored, header: input.header, body: input.body };
      },
    };
    const original = stored;
    await setPromptDocFavorite({ store, request: { artifactId: 'doc', favorite: true } });
    const { extension: _ignoredExtension, ...knownHeader } = original.header;
    expect(stored.header).toEqual({ ...knownHeader, favorite: true });
    expect(stored.body).toBe(original.body);
    race = true;
    await expect(setPromptDocFavorite({ store, request: { artifactId: 'doc', favorite: false } })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(JSON.parse(stored.body).markdown).toBe('newer');
    expect(stored.header).toMatchObject({ favorite: true, folderId: 'folder', tags: ['tag'] });
  });

  it('lists headers only, excludes bundles and reports unreadable coverage', async () => {
    const read = vi.fn(async () => { throw new Error('inventory must not read bodies'); });
    const result = await listPromptLibrary({ store: { read, organization: emptyOrganizationPort(), update: async () => {}, list: async () => ({
      coverage: 'partial', items: [
        { id: 'doc', owned: true, header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt', tags: ['topic'] }, updatedAtMs: 7 },
        { id: 'bundle', header: { v: 1, kind: 'prompt_bundle.v2', title: 'Skill' }, updatedAtMs: 8 },
      ],
    }) }, request: { query: 'TOPIC', includeBundles: false } });
    expect(result).toEqual({ items: [{ artifactId: 'doc', title: 'Prompt', folderId: null, tags: ['topic'], favorite: false, updatedAtMs: 7 }], coverage: 'partial' });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps update as an update, never creating a missing id', async () => {
    const create = vi.fn(async () => 'new');
    await expect(updatePromptDocInLibrary({ store: { read: async () => null, update: async () => {}, create },
      request: { artifactId: 'missing', title: 'Prompt', markdown: 'text' } })).rejects.toThrow('prompt_doc_missing_body');
    expect(create).not.toHaveBeenCalled();
  });
  it('exhausts header pages without imposing a library ceiling', async () => {
    const store: PromptLibraryArtifactStore = { organization: emptyOrganizationPort(), read: async () => { throw new Error('no body read'); }, update: async () => {},
      list: async (options) => ({ coverage: 'complete', items: [{ id: options?.cursor ? 'second' : 'first',
        header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' }, updatedAtMs: 1 }],
        ...(!options?.cursor ? { nextCursor: 'page-two' } : {}),
      }),
    };
    expect(await listPromptLibrary({ store, request: {} })).toMatchObject({ coverage: 'complete', items: [{ artifactId: 'first' }, { artifactId: 'second' }] });
  });
  it.each(['doc', 'bundle'] as const)('refuses a stale %s update and preserves the concurrent write', async (kind) => {
    const body = kind === 'doc'
      ? { v: 1, markdown: 'original', createdAtMs: 1, updatedAtMs: 1 }
      : { v: 1, entries: [{ path: 'SKILL.md', contentBase64: 'b3JpZ2luYWw=', contentKind: 'utf8' }], createdAtMs: 1, updatedAtMs: 1 };
    let stored = { id: 'prompt-1', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: `prompt_${kind}.v2`, title: 'Original',
        ...(kind === 'bundle' ? { bundleSchemaId: 'skills.skill_md_v1' } : {}) }, body: JSON.stringify(body) };
    const concurrent = { ...stored, revision: { headerVersion: 2, bodyVersion: 2 },
      header: { ...stored.header, title: 'Concurrent' }, body: JSON.stringify({ ...body, updatedAtMs: 2 }) };
    const params = {
      store: {
        read: async () => stored,
        update: async (input: { header: Readonly<Record<string, unknown>>; body: string; expectedRevision?: { headerVersion: number; bodyVersion: number } }) => {
          if (input.expectedRevision && (input.expectedRevision.headerVersion !== stored.revision.headerVersion
            || input.expectedRevision.bodyVersion !== stored.revision.bodyVersion)) {
            throw Object.assign(new Error('artifact_version_mismatch'), { code: 'version_mismatch' });
          }
          stored = { ...stored, header: { ...stored.header, ...input.header }, body: input.body };
        },
      },
      nowMs: () => { stored = concurrent; return 3; },
    };
    const update = kind === 'doc'
      ? updatePromptDocInLibrary({ ...params, request: { artifactId: 'prompt-1', title: 'Stale', markdown: 'stale' } })
      : updatePromptBundleInLibrary({ ...params, request: { artifactId: 'prompt-1', title: 'Stale', skillMarkdown: 'stale' } });
    await expect(update).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(stored).toEqual(concurrent);
  });
  it('refuses non-doc Artifacts and unreadable bodies without disclosing content', async () => {
    for (const artifact of [
      { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 }, header: { kind: 'role.v1', title: 'Private' }, body: JSON.stringify({ v: 1, markdown: 'private', createdAtMs: 1, updatedAtMs: 1 }) },
      { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 }, header: { kind: 'prompt_doc.v2', title: 'Private' }, body: null },
    ]) {
      expect(await readPromptDocInLibrary({ artifactId: 'memory', store: {
        read: async () => artifact, update: async () => {},
      } })).toEqual({ ok: false,
        errorCode: artifact.header.kind === 'role.v1' ? 'prompt_doc_wrong_kind' : 'prompt_doc_invalid_body',
        error: artifact.header.kind === 'role.v1' ? 'prompt_doc_wrong_kind' : 'prompt_doc_invalid_body' });
    }
  });
  it('updates a prompt document through the injected canonical artifact store', async () => {
    const update = vi.fn(async () => undefined);
    const signal = new AbortController().signal;

    await expect(updatePromptDocInLibrary({
      store: {
        read: async () => ({
          id: 'doc-1',
          revision: { headerVersion: 1, bodyVersion: 1 },
          header: { v: 1, kind: 'prompt_doc.v2', title: 'Old', tags: ['old'] },
          body: JSON.stringify({ v: 1, markdown: 'old', createdAtMs: 1, updatedAtMs: 1 }),
        }),
        update,
      },
      request: {
        artifactId: 'doc-1',
        title: 'New',
        markdown: 'new',
      },
      nowMs: () => 2,
      signal,
    })).resolves.toEqual({ ok: true, artifactId: 'doc-1' });

    expect(update).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: expect.objectContaining({
        kind: 'prompt_doc.v2',
        title: 'New',
        tags: ['old'],
      }),
      body: JSON.stringify({ v: 1, markdown: 'new', createdAtMs: 1, updatedAtMs: 2 }),
      signal,
    });
  });

  it('exports a stored document through the canonical asset writer and returns the link mutation', async () => {
    const signal = new AbortController().signal;
    const write = vi.fn(async () => ({
      ok: true as const,
      externalRef: { path: '/tmp/prompt.md' },
      digest: 'external-digest',
    }));

    const result = await exportPromptLibraryArtifact({
      store: {
        read: async () => ({
          id: 'doc-1',
          revision: { headerVersion: 1, bodyVersion: 1 },
          header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' },
          body: JSON.stringify({ v: 1, markdown: '# Prompt', createdAtMs: 1, updatedAtMs: 1 }),
        }),
        update: async () => undefined,
      },
      write,
      request: {
        artifactId: 'doc-1',
        machineId: 'machine-1',
        assetTypeId: 'markdown',
        scope: 'user',
        targetInput: 'prompt.md',
        promptExternalLinks: { v: 1, links: [] },
      },
      randomId: () => 'link-1',
      nowMs: () => 3,
      signal,
    });

    expect(write).toHaveBeenCalledWith({
      machineId: 'machine-1',
      request: expect.objectContaining({
        assetTypeId: 'markdown',
        scope: 'user',
        targetPath: 'prompt.md',
        markdown: '# Prompt',
        previewOnly: false,
      }),
      signal,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      artifactId: 'doc-1',
      exported: true,
      nextPromptExternalLinks: {
        v: 1,
        links: [expect.objectContaining({ id: 'link-1', artifactId: 'doc-1' })],
      },
    }));
  });

  it('installs one fetched registry bundle into the artifact store and optional asset route', async () => {
    const create = vi.fn(async () => 'bundle-1');
    const install = vi.fn(async () => ({
      ok: true as const,
      externalRef: { name: 'skill' },
      digest: 'external-digest',
    }));
    const item = {
      sourceId: 'source-1',
      itemId: 'item-1',
      title: 'Skill',
      bundleSchemaId: 'skills.skill_md_v1' as const,
      bundleBody: {
        v: 1 as const,
        entries: [{ path: 'SKILL.md', contentBase64: 'IyBTa2lsbA==', contentKind: 'utf8' as const }],
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    };

    const result = await installPromptRegistryItemInLibrary({
      store: { read: async () => null, update: async () => undefined, create },
      fetchItem: async () => ({ ok: true, item }),
      install,
      request: {
        machineId: 'machine-1',
        sourceId: 'source-1',
        itemId: 'item-1',
        configuredSources: [],
        installTarget: {
          assetTypeId: 'skills',
          scope: 'user',
          targetName: 'skill',
        },
        promptExternalLinks: { v: 1, links: [] },
      },
      randomId: () => 'link-1',
      nowMs: () => 4,
    });

    expect(install).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      header: expect.objectContaining({ kind: 'prompt_bundle.v2', title: 'Skill' }),
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      artifactId: 'bundle-1',
      exported: true,
    }));
  });

  it('does not begin a store mutation when the caller is already retired', async () => {
    const controller = new AbortController();
    controller.abort();
    const update = vi.fn(async () => undefined);

    await expect(updatePromptDocInLibrary({
      store: {
        read: async () => ({
          id: 'doc-1',
          revision: { headerVersion: 1, bodyVersion: 1 },
          header: { title: 'Old' },
          body: JSON.stringify({ v: 1, markdown: 'old', createdAtMs: 1, updatedAtMs: 1 }),
        }),
        update,
      },
      request: { artifactId: 'doc-1', title: 'New', markdown: 'new' },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(update).not.toHaveBeenCalled();
  });
});
