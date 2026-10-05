import { describe, expect, it, vi } from 'vitest';

import {
  createPromptDocInLibrary,
  setPromptDocFavorite,
  listPromptLibrary,
  type PromptLibraryArtifactStore,
  exportPromptLibraryArtifact,
  installPromptRegistryItemInLibrary,
  updatePromptDocInLibrary,
  updatePromptBundleInLibrary,
  readPromptDocInLibrary,
} from './promptLibraryActionOperations.js';

describe('prompt library action operations', () => {
  it('creates canonical documents with verbatim text and normalized metadata', async () => {
    let saved: Parameters<NonNullable<PromptLibraryArtifactStore['create']>>[0] | undefined;
    const result = await createPromptDocInLibrary({
      store: { read: async () => null, update: async () => {}, create: async (input) => { saved = input; return 'new'; } },
      request: { title: 'Prompt', markdown: '  keep\n\ntext  ', folderId: 'folder', tags: [' Alpha ', 'alpha'], favorite: true },
      nowMs: () => 42,
    });
    expect(result).toEqual({ ok: true, artifactId: 'new' });
    expect(saved?.header).toMatchObject({ kind: 'prompt_doc.v2', title: 'Prompt', folderId: 'folder', tags: ['Alpha'], favorite: true });
    expect(JSON.parse(saved!.body)).toEqual({ v: 1, markdown: '  keep\n\ntext  ', createdAtMs: 42, updatedAtMs: 42 });
  });

  it('favourites preserve every other field and reject concurrent newer markdown', async () => {
    let stored = { id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt', folderId: 'folder', tags: ['tag'], extension: { keep: true } },
      body: JSON.stringify({ v: 1, markdown: 'old', createdAtMs: 1, updatedAtMs: 1 }) };
    let race = false;
    const store: PromptLibraryArtifactStore = {
      read: async () => stored,
      update: async (input) => {
        if (race) stored = { ...stored, revision: { headerVersion: 2, bodyVersion: 2 }, body: stored.body.replace('old', 'newer') };
        if (input.expectedRevision.bodyVersion !== stored.revision.bodyVersion) throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
        stored = { ...stored, header: { ...stored.header, ...input.header }, body: input.body };
      },
    };
    const original = stored;
    await setPromptDocFavorite({ store, request: { artifactId: 'doc', favorite: true } });
    expect(stored.header).toEqual({ ...original.header, favorite: true });
    expect(stored.body).toBe(original.body);
    race = true;
    await expect(setPromptDocFavorite({ store, request: { artifactId: 'doc', favorite: false } })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(JSON.parse(stored.body).markdown).toBe('newer');
    expect(stored.header).toMatchObject({ favorite: true, folderId: 'folder', tags: ['tag'] });
  });

  it('lists headers only, excludes bundles and reports unreadable coverage', async () => {
    const read = vi.fn(async () => { throw new Error('inventory must not read bodies'); });
    const result = await listPromptLibrary({ store: { read, update: async () => {}, list: async () => ({
      coverage: 'partial', items: [
        { id: 'doc', header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt', tags: ['topic'] }, updatedAtMs: 7 },
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
    const store: PromptLibraryArtifactStore = { read: async () => { throw new Error('no body read'); }, update: async () => {},
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
      header: { v: 1, kind: `prompt_${kind}.v2`, title: 'Original' }, body: JSON.stringify(body) };
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
      } })).toEqual({ ok: false, errorCode: 'prompt_doc_invalid_body', error: 'prompt_doc_invalid_body' });
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
        tags: [' Alpha ', 'alpha', 'Beta'],
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
        tags: ['Alpha', 'Beta'],
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
