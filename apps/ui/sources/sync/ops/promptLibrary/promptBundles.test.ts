import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { PromptBundleBodyV1Schema, type PromptBundleBodyV1 } from '@happier-dev/protocol';

const createArtifactWithHeaderMock = vi.hoisted(() =>
  vi.fn(async (_header: unknown, _body: string | null) => 'b1'),
);
const updateArtifactWithHeaderMock = vi.hoisted(() =>
  vi.fn(async (_artifactId: string, _header: unknown, _body: string | null) => undefined),
);
const fetchArtifactWithBodyMock = vi.hoisted(
  () => vi.fn<(artifactId: string) => Promise<DecryptedArtifact | null>>(),
);

vi.mock('@/sync/sync', () => ({
  sync: {
    createArtifactWithHeader: createArtifactWithHeaderMock,
    updateArtifactWithHeader: updateArtifactWithHeaderMock,
    fetchArtifactWithBody: fetchArtifactWithBodyMock,
  },
}));

describe('promptBundles ops', () => {
  beforeEach(() => {
    createArtifactWithHeaderMock.mockReset();
    updateArtifactWithHeaderMock.mockReset();
    fetchArtifactWithBodyMock.mockReset();
    fetchArtifactWithBodyMock.mockResolvedValue(null);
    storage.setState({ artifacts: {}, isDataReady: true } as any);
  });

  it('creates a prompt_bundle.v2 skill bundle with SKILL.md', async () => {
    const { createSkillPromptBundle } = await import('./promptBundles');

    const artifactId = await createSkillPromptBundle({ title: 'My skill', skillMarkdown: '# Skill' });
    expect(artifactId).toBe('b1');

    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) {
      throw new Error('Expected createArtifactWithHeader to be called');
    }
    const header = createCall[0] as { kind: string; bundleSchemaId: string; title: string };
    const body = createCall[1] as string;
    expect(header.kind).toBe('prompt_bundle.v2');
    expect(header.bundleSchemaId).toBe('skills.skill_md_v1');
    expect(header.title).toBe('My skill');

    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entries.some((e) => e.path === 'SKILL.md')).toBe(true);
    }
  });

  it('creates a starter SKILL.md when the new skill editor passes empty markdown', async () => {
    const { createSkillPromptBundle, readSkillMarkdownFromPromptBundleBody } = await import('./promptBundles');

    await createSkillPromptBundle({ title: 'Starter skill', skillMarkdown: '' });

    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) {
      throw new Error('Expected createArtifactWithHeader to be called');
    }
    const body = createCall[1] as string;
    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(readSkillMarkdownFromPromptBundleBody(parsed.data)).toContain('## When to use');
    }
  });

  it('creates a prompt_bundle.v2 skill bundle from imported entries and preserves supporting files', async () => {
    const { createPromptBundleArtifact } = await import('./promptBundles');

    const artifactId = await createPromptBundleArtifact({
      title: 'Imported skill',
      bundleSchemaId: 'skills.skill_md_v1',
      origin: 'imported',
      folderId: 'folder-1',
      tags: ['ops', 'review'],
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Imported skill', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
        {
          path: 'templates/example.txt',
          contentBase64: Buffer.from('example', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
    });

    expect(artifactId).toBe('b1');

    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) {
      throw new Error('Expected createArtifactWithHeader to be called');
    }
    const header = createCall[0] as {
      kind: string;
      bundleSchemaId: string;
      title: string;
      origin: string;
      folderId?: string | null;
      tags?: string[];
    };
    const body = createCall[1] as string;
    expect(header.kind).toBe('prompt_bundle.v2');
    expect(header.bundleSchemaId).toBe('skills.skill_md_v1');
    expect(header.title).toBe('Imported skill');
    expect(header.origin).toBe('imported');
    expect(header.folderId).toBe('folder-1');
    expect(header.tags).toEqual(['ops', 'review']);

    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entries).toHaveLength(2);
      expect(parsed.data.entries.some((e) => e.path === 'templates/example.txt')).toBe(true);
    }
  });

  it('creates a prompt_bundle.v2 generic bundle from imported entries', async () => {
    const { createPromptBundleArtifact } = await import('./promptBundles');

    await createPromptBundleArtifact({
      title: 'Shared prompts',
      bundleSchemaId: 'bundle.generic_v1',
      origin: 'imported',
      entries: [
        {
          path: 'prompts/review.md',
          contentBase64: Buffer.from('Review checklist', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
    });

    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) {
      throw new Error('Expected createArtifactWithHeader to be called');
    }

    const header = createCall[0] as { bundleSchemaId: string; title: string };
    expect(header.bundleSchemaId).toBe('bundle.generic_v1');
    expect(header.title).toBe('Shared prompts');
  });

  it('updates SKILL.md and preserves createdAtMs', async () => {
    const { updateSkillPromptBundle } = await import('./promptBundles');

    const initialBody = PromptBundleBodyV1Schema.parse({
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('old', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 10,
      updatedAtMs: 10,
    });
    storage.setState({
      artifacts: {
        b1: {
          id: 'b1',
          header: { v: 1, kind: 'prompt_bundle.v2', title: 'Old', bundleSchemaId: 'skills.skill_md_v1', folderId: 'folder-1', tags: ['alpha'] },
          title: 'Old',
          body: JSON.stringify(initialBody),
          headerVersion: 1,
          bodyVersion: 1,
          seq: 1,
          createdAt: 0,
          updatedAt: 0,
          isDecrypted: true,
        },
      },
      isDataReady: true,
    } as any);

    vi.spyOn(Date, 'now').mockReturnValueOnce(99);
    await updateSkillPromptBundle({ artifactId: 'b1', title: 'New', skillMarkdown: 'new', folderId: null, tags: ['beta'] });

    const updateCall = updateArtifactWithHeaderMock.mock.calls[0];
    if (!updateCall) {
      throw new Error('Expected updateArtifactWithHeader to be called');
    }
    const _artifactId = updateCall[0] as string;
    const header = updateCall[1] as { kind: string; title: string; folderId?: string | null; tags?: string[] };
    const body = updateCall[2] as string;
    expect(_artifactId).toBe('b1');
    expect(header.kind).toBe('prompt_bundle.v2');
    expect(header.title).toBe('New');
    expect(header.folderId).toBeNull();
    expect(header.tags).toEqual(['beta']);

    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.createdAtMs).toBe(10);
      expect(parsed.data.updatedAtMs).toBe(99);
      const entry = parsed.data.entries.find((e) => e.path === 'SKILL.md');
      expect(entry).toBeTruthy();
    }
  });

  it('duplicates a skill bundle into a new user-owned artifact', async () => {
    const { duplicatePromptBundle } = await import('./promptBundles');

    storage.setState({
      artifacts: {
        b1: {
          id: 'b1',
          header: {
            v: 1,
            kind: 'prompt_bundle.v2',
            title: 'Original skill',
            bundleSchemaId: 'skills.skill_md_v1',
            origin: 'imported',
            folderId: 'folder-1',
            tags: ['shared'],
          },
          title: 'Original skill',
          body: JSON.stringify({
            v: 1,
            entries: [
              {
                path: 'SKILL.md',
                contentBase64: Buffer.from('# Original skill', 'utf8').toString('base64'),
                contentKind: 'utf8',
              },
            ],
            createdAtMs: 10,
            updatedAtMs: 20,
          }),
          headerVersion: 1,
          bodyVersion: 1,
          seq: 1,
          createdAt: 0,
          updatedAt: 0,
          isDecrypted: true,
        },
      },
      isDataReady: true,
    } as any);

    const artifactId = await duplicatePromptBundle('b1');
    expect(artifactId).toBe('b1');

    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) throw new Error('Expected createArtifactWithHeader to be called');
    expect(createCall[0]).toMatchObject({
      kind: 'prompt_bundle.v2',
      title: 'Original skill Copy',
      bundleSchemaId: 'skills.skill_md_v1',
      origin: 'user',
      folderId: 'folder-1',
      tags: ['shared'],
    });
    expect(JSON.parse(createCall[1] as string)).toMatchObject({
      entries: [
        expect.objectContaining({ path: 'SKILL.md' }),
      ],
    });
  });

  it('lists supporting entries without SKILL.md and updates them without dropping other files', async () => {
    const {
      listPromptBundleSupportingEntries,
      upsertPromptBundleUtf8Entry,
      updateSkillPromptBundle,
    } = await import('./promptBundles');

    const initialBody = PromptBundleBodyV1Schema.parse({
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('old skill', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
        {
          path: 'templates/review.md',
          contentBase64: Buffer.from('review body', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 10,
      updatedAtMs: 10,
    });

    expect(listPromptBundleSupportingEntries(initialBody)).toEqual([
      expect.objectContaining({ path: 'templates/review.md', contentKind: 'utf8' }),
    ]);

    const nextEntries = upsertPromptBundleUtf8Entry(initialBody.entries, {
      path: 'docs/checklist.md',
      content: 'checklist',
    });
    expect(nextEntries.some((entry) => entry.path === 'docs/checklist.md')).toBe(true);
    expect(nextEntries.some((entry) => entry.path === 'SKILL.md')).toBe(true);

    storage.setState({
      artifacts: {
        b1: {
          id: 'b1',
          header: { v: 1, kind: 'prompt_bundle.v2', title: 'Old', bundleSchemaId: 'skills.skill_md_v1' },
          title: 'Old',
          body: JSON.stringify({
            ...initialBody,
            entries: nextEntries,
          }),
          headerVersion: 1,
          bodyVersion: 1,
          seq: 1,
          createdAt: 0,
          updatedAt: 0,
          isDecrypted: true,
        },
      },
      isDataReady: true,
    } as any);

    await updateSkillPromptBundle({ artifactId: 'b1', title: 'New', skillMarkdown: 'updated skill' });

    const updateCall = updateArtifactWithHeaderMock.mock.calls.at(-1);
    if (!updateCall) {
      throw new Error('Expected updateArtifactWithHeader to be called');
    }
    const body = updateCall[2] as string;
    const parsed = PromptBundleBodyV1Schema.parse(JSON.parse(body));
    expect(parsed.entries.some((entry) => entry.path === 'docs/checklist.md')).toBe(true);
    expect(parsed.entries.some((entry) => entry.path === 'templates/review.md')).toBe(true);
  });

  it('removes a supporting file without touching SKILL.md', async () => {
    const { removePromptBundleEntry } = await import('./promptBundles');

    const next = removePromptBundleEntry([
      {
        path: 'SKILL.md',
        contentBase64: Buffer.from('skill', 'utf8').toString('base64'),
        contentKind: 'utf8',
      },
      {
        path: 'templates/review.md',
        contentBase64: Buffer.from('review', 'utf8').toString('base64'),
        contentKind: 'utf8',
      },
    ], 'templates/review.md');

    expect(next).toEqual([
      expect.objectContaining({ path: 'SKILL.md' }),
    ]);
  });

  it('updates a supporting file by reusing the stored header title after fetching a missing body', async () => {
    const { updateSkillPromptBundleWithEntry } = await import('./promptBundles');

    storage.setState({
      artifacts: {
        b1: {
          id: 'b1',
          header: { v: 1, kind: 'prompt_bundle.v2', title: 'Stored title', bundleSchemaId: 'skills.skill_md_v1' },
          title: 'Stored title',
          body: undefined,
          headerVersion: 1,
          bodyVersion: 1,
          seq: 1,
          createdAt: 0,
          updatedAt: 0,
          isDecrypted: true,
        },
      },
      isDataReady: true,
    } as any);

    fetchArtifactWithBodyMock.mockResolvedValueOnce({
      id: 'b1',
      header: { v: 1, kind: 'prompt_bundle.v2', title: 'Stored title', bundleSchemaId: 'skills.skill_md_v1' },
      title: 'Stored title',
      body: JSON.stringify({
        v: 1,
        entries: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('skill', 'utf8').toString('base64'),
            contentKind: 'utf8',
          },
        ],
        createdAtMs: 10,
        updatedAtMs: 10,
      }),
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      isDecrypted: true,
    });

    await updateSkillPromptBundleWithEntry({
      artifactId: 'b1',
      path: 'templates/review.md',
      content: 'review body',
    });

    const updateCall = updateArtifactWithHeaderMock.mock.calls.at(-1);
    if (!updateCall) {
      throw new Error('Expected updateArtifactWithHeader to be called');
    }
    expect(updateCall[1]).toEqual(expect.objectContaining({ title: 'Stored title' }));
    const parsed = PromptBundleBodyV1Schema.parse(JSON.parse(updateCall[2] as string));
    expect(parsed.entries.some((entry) => entry.path === 'templates/review.md')).toBe(true);
  });

  it('removes a supporting file by reusing the stored header title after fetching a missing body', async () => {
    const { removeSkillPromptBundleEntry } = await import('./promptBundles');

    storage.setState({
      artifacts: {
        b1: {
          id: 'b1',
          header: { v: 1, kind: 'prompt_bundle.v2', title: 'Stored title', bundleSchemaId: 'skills.skill_md_v1' },
          title: 'Stored title',
          body: undefined,
          headerVersion: 1,
          bodyVersion: 1,
          seq: 1,
          createdAt: 0,
          updatedAt: 0,
          isDecrypted: true,
        },
      },
      isDataReady: true,
    } as any);

    fetchArtifactWithBodyMock.mockResolvedValueOnce({
      id: 'b1',
      header: { v: 1, kind: 'prompt_bundle.v2', title: 'Stored title', bundleSchemaId: 'skills.skill_md_v1' },
      title: 'Stored title',
      body: JSON.stringify({
        v: 1,
        entries: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('skill', 'utf8').toString('base64'),
            contentKind: 'utf8',
          },
          {
            path: 'templates/review.md',
            contentBase64: Buffer.from('review', 'utf8').toString('base64'),
            contentKind: 'utf8',
          },
        ],
        createdAtMs: 10,
        updatedAtMs: 10,
      }),
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      isDecrypted: true,
    });

    await removeSkillPromptBundleEntry({
      artifactId: 'b1',
      path: 'templates/review.md',
    });

    const updateCall = updateArtifactWithHeaderMock.mock.calls.at(-1);
    if (!updateCall) {
      throw new Error('Expected updateArtifactWithHeader to be called');
    }
    expect(updateCall[1]).toEqual(expect.objectContaining({ title: 'Stored title' }));
    const parsed = PromptBundleBodyV1Schema.parse(JSON.parse(updateCall[2] as string));
    expect(parsed.entries.map((entry) => entry.path)).toEqual(['SKILL.md']);
  });
});
