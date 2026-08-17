import { describe, expect, it, vi } from 'vitest';

import {
  exportPromptLibraryArtifact,
  installPromptRegistryItemInLibrary,
  updatePromptDocInLibrary,
} from './promptLibraryActionOperations.js';

describe('prompt library action operations', () => {
  it('updates a prompt document through the injected canonical artifact store', async () => {
    const update = vi.fn(async () => undefined);
    const signal = new AbortController().signal;

    await expect(updatePromptDocInLibrary({
      store: {
        read: async () => ({
          id: 'doc-1',
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
