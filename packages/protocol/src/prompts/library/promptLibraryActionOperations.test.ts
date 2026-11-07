import { describe, expect, it, vi } from 'vitest';
import type { PromptLibraryCatalogSnapshotV1 } from './promptLibraryCatalogV1.js';
import type { PromptLibraryRecordV1 } from './promptLibraryRowsV1.js';
import { sealPromptLibraryContentV1 } from './promptLibraryRowsV1.js';
import { MemoryDocBodyV1Schema, type MemoryFactV1 } from './memoryDocV1.js';
import type { ArtifactFolderActionPortV1 } from './promptFolderActionsV1.js';

import {
  createPromptDocInLibrary,
  createPromptBundleInLibrary,
  setPromptDocFavorite,
  listPromptLibrary,
  listMemoryDocsInLibrary,
  type PromptLibraryArtifactStore,
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
    writeRecord: async () => { throw new Error('Read-only inventory fixture'); },
  };
}

describe('prompt library action operations', () => {
  it.each([
    { label: 'expired topic fact', topic: 'Storage', expiresAtMs: 5, destination: undefined, expectedTopic: 'Storage' },
    { label: 'expired index fact', topic: undefined, expiresAtMs: 5, destination: undefined, expectedTopic: undefined },
    { label: 'active topic fact', topic: 'Storage', expiresAtMs: 50, destination: undefined, expectedTopic: 'Storage' },
    { label: 'explicit topic move', topic: 'Storage', expiresAtMs: 5, destination: 'Deploy', expectedTopic: 'Deploy' },
  ])('preserves placement on update unless explicitly changed ($label)', async ({ topic, expiresAtMs, destination, expectedTopic }) => {
    const original = { id: 'old', text: 'Use PostgreSQL for storage', createdAtMs: 1, expiresAtMs, sourceSessionRef: null };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1,
        index: topic === undefined ? [original] : [],
        topics: topic === undefined ? [] : [{ title: topic, summary: 'Storage choices', facts: [original] }] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      stored = { ...stored, body: input.body, revision: { headerVersion: 1, bodyVersion: 2 } };
    } };
    const before = await readMemoryDocInLibrary({ store, artifactId: stored.id, topic: 'archive', nowMs: () => 10 });
    expect('topic' in before ? before.topic.facts : []).toEqual(expiresAtMs <= 10 ? [{ ...original, archivedByMutation: false }] : []);
    expect(await updateMemoryFactInLibrary({ store, nowMs: () => 10, randomId: () => 'renewed', sourceSessionRef: null,
      request: { ref: { kind: 'doc', serverId: 'home', artifactId: stored.id }, expectedRevision: stored.revision,
        factId: original.id, text: original.text, expiresAtMs: 100,
        ...(destination === undefined ? {} : { topic: destination }) } })).toMatchObject({ ok: true, factId: 'renewed' });
    const body = MemoryDocBodyV1Schema.parse(JSON.parse(stored.body!));
    const replacement = { ...original, id: 'renewed', createdAtMs: 10, expiresAtMs: 100, supersedes: original.id };
    expect(body.index).toEqual(expectedTopic === undefined ? [replacement] : []);
    expect(body.topics.find(entry => entry.title === 'archive')?.facts).toEqual([original]);
    if (expectedTopic !== undefined) {
      expect(body.topics.find(entry => entry.title === expectedTopic)?.facts).toEqual([replacement]);
      const active = await readMemoryDocInLibrary({ store, artifactId: stored.id, topic: expectedTopic, nowMs: () => 10 });
      expect('topic' in active ? active.topic.facts : []).toEqual([replacement]);
    }
  });
  it.each([
    ['single meaningful token', 'Store billing reports monthly', 'Water garden plants monthly'],
    ['repeated shared token', 'Store billing reports monthly monthly', 'Water garden plants monthly monthly'],
    ['stop-words', 'The backups are on the server', 'The flowers are on the balcony'],
    ['single characters', 'Route x y z through Paris', 'Send x y z toward Berlin'],
    ['CJK single characters', '山 川 林', '山 川 海'],
    ['one CJK bigram', '搜索账单', '搜索花卉'],
  ])('saves without a duplicate choice for %s overlap', async (_label, existingText, text) => {
    const existing = { id: 'old', text: existingText, createdAtMs: 1, sourceSessionRef: null };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify({ v: 1, index: [existing], topics: [] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      stored = { ...stored, body: input.body, revision: { headerVersion: 1, bodyVersion: 2 } };
    } };
    expect(await rememberMemoryFactInLibrary({ store, nowMs: () => 10, randomId: () => 'new', sourceSessionRef: null,
      request: { ref: { kind: 'doc', serverId: 'home', artifactId: 'memory' }, expectedRevision: stored.revision, text } }))
      .toMatchObject({ ok: true, factId: 'new' });
    expect(MemoryDocBodyV1Schema.parse(JSON.parse(stored.body!)).index).toEqual([
      existing, { id: 'new', text, createdAtMs: 10, sourceSessionRef: null },
    ]);
  });
  it.each([
    ['Unicode words', 'Déployer mémoire durable', 'Préférer mémoire durable'],
    ['CJK bigrams', '使用内存搜索', '启用内存搜索'],
    ['normalized tokenless exact match', '🚀', '  🚀  '],
  ])('keeps duplicate review for %s', async (_label, existingText, text) => {
    const stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify({ v: 1, index: [{ id: 'old', text: existingText, createdAtMs: 1, sourceSessionRef: null }], topics: [] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored,
      update: async () => { throw new Error('Duplicate review must not write'); } };
    expect(await rememberMemoryFactInLibrary({ store, nowMs: () => 10, randomId: () => 'new', sourceSessionRef: null,
      request: { ref: { kind: 'doc', serverId: 'home', artifactId: 'memory' }, expectedRevision: stored.revision, text } }))
      .toMatchObject({ ok: false, errorCode: 'memory_duplicate_choice_required', revision: stored.revision,
        candidates: [{ factId: 'old', match: _label === 'normalized tokenless exact match' ? 'exact' : 'related' }] });
  });
  it.each(['keep_both', 'update', 'replace'] as const)('edits A against reviewed candidate B atomically (%s)', async kind => {
    const earlier = { id: 'A-prior', text: 'Prefer black tea', createdAtMs: 0, sourceSessionRef: null };
    const edited = { id: 'A', text: 'Prefer green tea', createdAtMs: 1, sourceSessionRef: null, expiresAtMs: 500,
      supersedes: earlier.id,
      decision: { reason: 'Tea review', sourceMessageRef: { kind: 'session', session: { serverId: 'home', sessionId: 'tea' },
        messageId: 'tea-answer' }, approvedBy: { accountId: 'tea-reviewer', atMs: 1 } } } satisfies MemoryFactV1;
    const candidate = { id: 'B', text: 'Use PostgreSQL for storage', createdAtMs: 2, sourceSessionRef: null, expiresAtMs: 900,
      decision: { reason: 'Storage review', sourceMessageRef: { kind: 'session', session: { serverId: 'home', sessionId: 'storage' },
        messageId: 'storage-answer' }, approvedBy: { accountId: 'storage-reviewer', atMs: 2 } } } satisfies MemoryFactV1;
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 2, bodyVersion: 7 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, index: [edited],
        topics: [{ title: 'Storage', summary: 'Storage choices', facts: [candidate] },
          { title: 'archive', summary: 'Earlier facts', facts: [earlier] }] }) };
    let writes = 0;
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      expect(input.expectedRevision).toEqual(stored.revision);
      writes++;
      stored = { ...stored, body: input.body, revision: { headerVersion: 3, bodyVersion: 8 } };
      return { revision: stored.revision };
    } };
    const request = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' }, expectedRevision: stored.revision,
      factId: edited.id, text: 'Prefer PostgreSQL for storage' };
    const params = { store, randomId: () => 'replacement', nowMs: () => 10, sourceSessionRef: null };
    const review = await updateMemoryFactInLibrary({ ...params, request });
    expect(review).toMatchObject({ ok: false, errorCode: 'memory_duplicate_choice_required', revision: request.expectedRevision,
      candidates: [{ factId: candidate.id, topic: 'Storage' }] });
    expect(writes).toBe(0);
    const duplicateChoice = kind === 'keep_both' ? { kind, expectedRevision: request.expectedRevision }
      : { kind, factId: candidate.id, expectedRevision: request.expectedRevision };
    expect(await updateMemoryFactInLibrary({ ...params, request: { ...request, duplicateChoice } }))
      .toMatchObject({ ok: true, factId: 'replacement', revision: { headerVersion: 3, bodyVersion: 8 } });
    expect(writes).toBe(1);
    const body = MemoryDocBodyV1Schema.parse(JSON.parse(stored.body!));
    const active = [...body.index, ...body.topics.filter(topic => topic.title !== 'archive').flatMap(topic => topic.facts)];
    const next = active.find(fact => fact.id === 'replacement');
    expect(active.map(fact => fact.id).sort()).toEqual(kind === 'keep_both' ? ['B', 'replacement'] : ['replacement']);
    expect(next).toEqual({ id: 'replacement', text: request.text, createdAtMs: 10, sourceSessionRef: null,
      supersedes: kind === 'keep_both' ? edited.id : candidate.id, expiresAtMs: kind === 'update' ? 900 : 500,
      ...(kind === 'replace' ? {} : { decision: { ...(kind === 'update' ? candidate.decision : edited.decision), approvedBy: null } }) });
    if (kind === 'keep_both') expect(active.find(fact => fact.id === candidate.id)).toEqual(candidate);
    expect(body.index).toEqual(kind === 'update' ? [] : [next]);
    expect(body.topics.find(topic => topic.title === 'Storage')?.facts).toEqual(kind === 'update' ? [next] : kind === 'keep_both' ? [candidate] : []);
    expect(body.topics.find(topic => topic.title === 'archive')?.facts).toEqual(kind === 'keep_both' ? [earlier, edited]
      : kind === 'update' ? [earlier, candidate, edited] : [earlier, edited, candidate]);
    const saved = stored;
    await expect(updateMemoryFactInLibrary({ ...params, request: { ...request, duplicateChoice } }))
      .rejects.toMatchObject({ code: 'version_mismatch' });
    expect(stored).toBe(saved);
    expect(writes).toBe(1);
  });
  it('reviews exact and lexical duplicates across active topics before writing, then requires a current explicit choice', async () => {
    const old = { id: 'old', text: 'Use PostgreSQL for storage', createdAtMs: 1, expiresAtMs: 500, sourceSessionRef: null };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 2, bodyVersion: 7 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, index: [], topics: [
        { title: 'Storage', summary: 'Storage choices', facts: [old] },
        { title: 'archive', summary: 'History', facts: [{ ...old, id: 'archived' }] },
      ] }) };
    let writes = 0;
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      writes += 1;
      stored = { ...stored, body: input.body, revision: { headerVersion: 3, bodyVersion: stored.revision.bodyVersion + 1 } };
    } };
    const request = { ref: { kind: 'doc' as const, serverId: 'home', artifactId: 'memory' }, expectedRevision: stored.revision,
      text: '  Use  PostgreSQL for storage  ' };
    const author = { store, nowMs: () => 10, randomId: () => 'new', sourceSessionRef: null };
    expect(await rememberMemoryFactInLibrary({ ...author, request })).toMatchObject({ ok: false,
      errorCode: 'memory_duplicate_choice_required', ref: request.ref, revision: stored.revision,
      candidates: [{ factId: 'old', topic: 'Storage', match: 'exact' }] });
    expect(writes).toBe(0);
    expect(await rememberMemoryFactInLibrary({ ...author, request: { ...request, text: 'Prefer PostgreSQL for storage' } }))
      .toMatchObject({ ok: false, candidates: [{ factId: 'old', match: 'related' }] });
    await rememberMemoryFactInLibrary({ ...author, request: { ...request,
      duplicateChoice: { kind: 'update', factId: 'old', expectedRevision: stored.revision } } });
    expect(writes).toBe(1);
    expect(JSON.parse(stored.body!)).toMatchObject({ index: [],
      topics: [{ title: 'Storage', facts: [{ id: 'new', supersedes: 'old', expiresAtMs: 500 }] },
        { title: 'archive', facts: [{ id: 'archived' }, { id: 'old' }] }] });
    await expect(rememberMemoryFactInLibrary({ ...author, request: { ...request, expectedRevision: stored.revision,
      duplicateChoice: { kind: 'keep_both', expectedRevision: request.expectedRevision } } }))
      .rejects.toMatchObject({ code: 'version_mismatch' });
    const result = await rememberMemoryFactInLibrary({ ...author, randomId: () => 'both', request: { ...request,
      expectedRevision: stored.revision, duplicateChoice: { kind: 'keep_both', expectedRevision: stored.revision } } });
    expect(result).toMatchObject({ ok: true, factId: 'both' });
    expect(JSON.parse(stored.body!).index.map((fact: { id: string }) => fact.id)).toEqual(['both']);
  });
  it('keeps prior decision provenance in history, clears human approval on changed wording and ignores expired/history duplicates', async () => {
    const decision = { reason: 'Reviewed the alternatives', sourceMessageRef: { kind: 'session',
      session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' }, approvedBy: { accountId: 'person', atMs: 2 } };
    const original = { id: 'old', text: 'Use PostgreSQL', createdAtMs: 1, expiresAtMs: 500, sourceSessionRef: null, decision };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, index: [original], topics: [] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      stored = { ...stored, body: input.body, revision: { headerVersion: 1, bodyVersion: stored.revision.bodyVersion + 1 } };
    } };
    const ref = { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' };
    await updateMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, factId: 'old',
      text: original.text, expiresAtMs: 800 }, randomId: () => 'renewed', nowMs: () => 10, sourceSessionRef: null });
    expect(JSON.parse(stored.body!).index[0]).toMatchObject({ id: 'renewed', decision, expiresAtMs: 800 });
    await updateMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, factId: 'renewed', text: 'Use SQLite' },
      randomId: () => 'edited', nowMs: () => 10, sourceSessionRef: null });
    expect(JSON.parse(stored.body!)).toMatchObject({ index: [{ id: 'edited', expiresAtMs: 800,
      decision: { ...decision, approvedBy: null } }], topics: [{ title: 'archive', facts: [original, { id: 'renewed', decision }] }] });
    expect(await rememberMemoryFactInLibrary({ store, request: { ref, expectedRevision: stored.revision, text: 'Use PostgreSQL' },
      randomId: () => 'fresh', nowMs: () => 800, sourceSessionRef: null })).toMatchObject({ ok: true, factId: 'fresh' });
  });
  it('refuses direct generic-bundle authoring before persistent creation', async () => {
    const writes: unknown[] = [];
    await expect(createPromptBundleInLibrary({ store: { read: async () => null, update: async () => {},
      create: async input => { writes.push(input); return 'must-not-be-created'; } },
      // @ts-expect-error Predecessor generic bundles remain readable, not authorable.
      request: { title: 'Predecessor generic bundle', bundleSchemaId: 'bundle.generic_v1', entries: [] } }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(writes).toEqual([]);
  });
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

  it('projects only the accepted actor, not private workspace provenance, into document reads', async () => {
    const savedBy = { kind: 'agent', accountId: 'owner', sessionId: 'author' } as const;
    const result = await readPromptDocInLibrary({ artifactId: 'doc', store: { read: async () => ({
      id: 'doc', revision: { headerVersion: 1, bodyVersion: 2 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' },
      body: JSON.stringify({ v: 1, markdown: 'Accepted', createdAtMs: 1, updatedAtMs: 2 }),
      provenance: { savedBy, source: { sessionId: 'author', machineId: 'machine', path: '/private/project', sha: 'a'.repeat(64) }, restoredFromBodyVersion: 1 },
    }) } });
    expect(result).toMatchObject({ ok: true, provenance: { savedBy } });
    if (!result.ok) throw new Error('Expected readable document');
    expect(result.provenance).toEqual({ savedBy });
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

  it.each([false, true])('creates one canonical memory Artifact with the first sanitized fact in its requested topic (receipt: %s)', async receipt => {
    let saved: Parameters<NonNullable<PromptLibraryArtifactStore['create']>>[0] | undefined;
    const result = await createMemoryDocInLibrary({
      store: { read: async () => null, update: async () => { throw new Error('Creation is not an update'); },
        create: async input => { saved = input; return receipt ? { artifactId: 'memory', revision: { headerVersion: 1, bodyVersion: 1 } } : 'memory'; } },
      request: { title: 'Account memory', text: 'Build rule; password=secret', topic: 'Build', expiresAtMs: 50 },
      randomId: () => 'first', nowMs: () => 10, sourceSessionRef: { serverId: 'home', sessionId: 'session' },
    });
    expect(result).toEqual({ ok: true, artifactId: 'memory', factId: 'first',
      ...(receipt ? { revision: { headerVersion: 1, bodyVersion: 1 } } : {}) });
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
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) };
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
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [fact], topics: [] })) };
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

  it.each([undefined, 'Build'])('restores a forgotten fact unchanged to its original section (%s)', async (topic) => {
    const original = { id: 'original', text: 'Use the checked-in build script.', createdAtMs: 10, expiresAtMs: 500,
      sourceSessionRef: { serverId: 'source-home', sessionId: 'source-session' }, supersedes: 'older' };
    const older = { id: 'older', text: 'Use make.', createdAtMs: 1, sourceSessionRef: null };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1,
        index: topic === undefined ? [original] : [], topics: [
          ...(topic === undefined ? [] : [{ title: topic, summary: 'Build details', facts: [original] }]),
          { title: 'archive', summary: 'Earlier facts', facts: [older] },
        ] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      stored = { ...stored, body: input.body, header: input.header,
        revision: { headerVersion: stored.revision.headerVersion + 1, bodyVersion: stored.revision.bodyVersion + 1 } };
    } };
    const ref = { kind: 'doc' as const, artifactId: 'memory' };
    const beforeForget = stored.revision;
    await forgetMemoryFactInLibrary({ store, request: { ref, expectedRevision: beforeForget, factId: original.id, topic } });
    const archived = stored;
    const restore = { ref, expectedRevision: beforeForget, topic: 'archive' as const, factId: original.id,
      restore: true as const, ...(topic === undefined ? {} : { restoreTopic: topic }) };
    await expect(updateMemoryFactInLibrary({ store, request: restore, randomId: () => 'wrong-new-id',
      nowMs: () => 100, sourceSessionRef: null })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(stored).toBe(archived);
    const restored = await updateMemoryFactInLibrary({ store, request: { ...restore, expectedRevision: stored.revision },
      randomId: () => 'wrong-new-id', nowMs: () => 100, sourceSessionRef: null });
    expect(restored).toEqual({ ok: true, artifactId: 'memory', factId: original.id });
    const reopened = await readMemoryDocInLibrary({ store, artifactId: 'memory', topic, nowMs: () => 100 });
    expect('body' in reopened ? reopened.body.index : reopened.topic.facts).toEqual([original]);
    expect(await readMemoryDocInLibrary({ store, artifactId: 'memory', topic: 'archive', nowMs: () => 100 }))
      .toMatchObject({ topic: { facts: [older] } });
  });

  it('refuses archive restore while a replacement retains its supersedes link', async () => {
    const original = { id: 'original', text: 'Old fact', createdAtMs: 1, sourceSessionRef: null };
    const stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1,
        index: [{ ...original, id: 'replacement', text: 'Current fact', supersedes: original.id }],
        topics: [{ title: 'archive', summary: 'History', facts: [original] }] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async () => { throw new Error('Must not write'); } };
    await expect(updateMemoryFactInLibrary({ store, request: { ref: { kind: 'doc', artifactId: 'memory' },
      expectedRevision: stored.revision, factId: original.id, topic: 'archive', restore: true },
      randomId: () => 'wrong-new-id', sourceSessionRef: null })).rejects.toMatchObject({ code: 'memory_fact_superseded' });
  });

  it.each(['keep_both', 'update', 'replace'] as const)('reviews duplicate archive restorations before changing history (%s)', async kind => {
    const original = { id: 'archived', text: 'Use PostgreSQL', createdAtMs: 1, sourceSessionRef: null };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1,
        index: [{ ...original, id: 'active' }], topics: [{ title: 'archive', summary: 'History', facts: [original] }] }) };
    const store: PromptLibraryArtifactStore = { read: async () => stored, update: async input => {
      stored = { ...stored, body: input.body, revision: { headerVersion: 1, bodyVersion: stored.revision.bodyVersion + 1 } };
    } };
    const request = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' }, expectedRevision: stored.revision,
      topic: 'archive' as const, restore: true as const, factId: original.id };
    const params = { store, randomId: () => 'replacement', sourceSessionRef: null, nowMs: () => 10 };
    expect(await updateMemoryFactInLibrary({ ...params, request })).toMatchObject({ ok: false,
      errorCode: 'memory_duplicate_choice_required', candidates: [{ factId: 'active' }] });
    expect(JSON.parse(stored.body!).index).toHaveLength(1);
    const duplicateChoice = kind === 'keep_both' ? { kind, expectedRevision: stored.revision }
      : { kind, expectedRevision: stored.revision, factId: 'active' };
    expect(await updateMemoryFactInLibrary({ ...params, request: { ...request, duplicateChoice } }))
      .toMatchObject({ ok: true, factId: kind === 'keep_both' ? original.id : 'replacement' });
    expect(JSON.parse(stored.body!)).toMatchObject(kind === 'keep_both'
      ? { index: [{ id: 'active' }, original], topics: [{ title: 'archive', facts: [] }] }
      : { index: [{ id: 'replacement', text: original.text, supersedes: 'active' }],
        topics: [{ title: 'archive', facts: [original, { id: 'active' }] }] });
  });

  it('does not disclose a raced memory version when the current store read loses access', async () => {
    let readable = true;
    const stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) };
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
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) };
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
      topic: { title: 'archive', facts: [{ id: 'forgotten', archivedByMutation: true },
        { id: 'expired-key', archivedByMutation: false }, { id: 'expired-topic', archivedByMutation: false }] },
    });
    expect(await readMemoryDocInLibrary({ store, artifactId: 'memory', nowMs: () => 5 })).toMatchObject({ body: {
      index: [fact('active')], topics: [{ title: 'Build', summary: 'Build details' }, { title: 'archive', summary: 'Earlier facts' }],
    } });
    await expect(readMemoryDocInLibrary({ store, artifactId: 'memory', topic: 'missing' })).rejects.toMatchObject({ code: 'memory_topic_not_found' });
    expect(JSON.parse(stored.body!).index).toHaveLength(2);
    expect(JSON.parse(stored.body!).topics[0].facts).toHaveLength(2);
  });
  it.each([false, true])('creates canonical documents with verbatim text and content metadata (receipt: %s)', async receipt => {
    let saved: Parameters<NonNullable<PromptLibraryArtifactStore['create']>>[0] | undefined;
    const result = await createPromptDocInLibrary({
      store: { read: async () => null, update: async () => {}, create: async (input) => { saved = input; return receipt ? { artifactId: 'new', revision: { headerVersion: 1, bodyVersion: 1 } } : 'new'; } },
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
    const selections: unknown[] = [];
    const result = await listPromptLibrary({ store: { read, organization: emptyOrganizationPort(), update: async () => {}, list: async options => {
      selections.push(options);
      return {
        coverage: 'partial', items: [
          { id: 'doc', owned: true, header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt', tags: ['topic'] }, updatedAtMs: 7 },
          { id: 'bundle', header: { v: 1, kind: 'prompt_bundle.v2', title: 'Skill' }, updatedAtMs: 8 },
        ],
      };
    } }, request: { query: 'TOPIC' } });
    expect(result).toEqual({ items: [{ artifactId: 'doc', title: 'Prompt', folderId: null, tags: ['topic'], favorite: false, updatedAtMs: 7 }], coverage: 'partial' });
    expect(read).not.toHaveBeenCalled();
    expect(selections).toEqual([{ limit: 500, kinds: ['prompt_doc.v2'] }]);
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
