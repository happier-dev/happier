import { describe, expect, it, vi, beforeEach } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';
import { PromptDocBodyV1Schema } from '@happier-dev/protocol';

const createArtifactWithHeaderMock = vi.hoisted(() =>
  vi.fn(async (_header: unknown, _body: string | null) => 'p1'),
);
const updateArtifactWithHeaderMock = vi.hoisted(() =>
  vi.fn(async (_artifactId: string, _header: unknown, _body: string | null) => undefined),
);
const fetchArtifactWithBodyMock = vi.hoisted(() => vi.fn(async (_artifactId: string) => null));

vi.mock('@/sync/sync', () => ({
  sync: {
    createArtifactWithHeader: createArtifactWithHeaderMock,
    updateArtifactWithHeader: updateArtifactWithHeaderMock,
    fetchArtifactWithBody: fetchArtifactWithBodyMock,
  },
}));

describe('promptDocs ops', () => {
  beforeEach(() => {
    createArtifactWithHeaderMock.mockReset();
    updateArtifactWithHeaderMock.mockReset();
    fetchArtifactWithBodyMock.mockReset();
    storage.setState({ artifacts: {}, isDataReady: true } as any);
  });

  it('creates a prompt_doc.v2 artifact', async () => {
    const { createPromptDoc } = await import('./promptDocs');

    const artifactId = await createPromptDoc({ title: 'My prompt', markdown: '# Hello' });
    expect(artifactId).toBe('p1');

    expect(createArtifactWithHeaderMock).toHaveBeenCalledTimes(1);
    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) {
      throw new Error('Expected createArtifactWithHeader to be called');
    }
    const header = createCall[0] as { kind: string; title: string };
    const body = createCall[1] as string;

    expect(header.kind).toBe('prompt_doc.v2');
    expect(header.title).toBe('My prompt');
    expect(typeof body).toBe('string');

    const parsed = PromptDocBodyV1Schema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.markdown).toBe('# Hello');
    }
  });

  it('creates an imported prompt_doc.v2 artifact when origin is provided', async () => {
    const { createPromptDoc } = await import('./promptDocs');

    const artifactId = await createPromptDoc({
      title: 'Imported prompt',
      markdown: '# Imported',
      origin: 'imported',
      folderId: 'folder-1',
      tags: ['alpha', 'beta'],
    });
    expect(artifactId).toBe('p1');

    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) {
      throw new Error('Expected createArtifactWithHeader to be called');
    }
    const header = createCall[0] as {
      kind: string;
      title: string;
      origin: string;
      folderId?: string | null;
      tags?: string[];
    };
    expect(header.kind).toBe('prompt_doc.v2');
    expect(header.title).toBe('Imported prompt');
    expect(header.origin).toBe('imported');
    expect(header.folderId).toBe('folder-1');
    expect(header.tags).toEqual(['alpha', 'beta']);
  });

  it('updates prompt doc body timestamps and preserves createdAtMs', async () => {
    const { updatePromptDoc } = await import('./promptDocs');

    const initialBody = {
      v: 1,
      markdown: 'old',
      createdAtMs: 10,
      updatedAtMs: 10,
    };
    storage.setState({
      artifacts: {
        p1: {
          id: 'p1',
          header: { v: 1, kind: 'prompt_doc.v2', title: 'Old', folderId: 'folder-1', tags: ['alpha'] },
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
    await updatePromptDoc({ artifactId: 'p1', title: 'New', markdown: 'new', folderId: null, tags: ['beta', 'alpha'] });

    expect(updateArtifactWithHeaderMock).toHaveBeenCalledTimes(1);
    const updateCall = updateArtifactWithHeaderMock.mock.calls[0];
    if (!updateCall) {
      throw new Error('Expected updateArtifactWithHeader to be called');
    }
    const _artifactId = updateCall[0] as string;
    const header = updateCall[1] as { kind: string; title: string; folderId?: string | null; tags?: string[] };
    const body = updateCall[2] as string;
    expect(_artifactId).toBe('p1');
    expect(header.kind).toBe('prompt_doc.v2');
    expect(header.title).toBe('New');
    expect(header.folderId).toBeNull();
    expect(header.tags).toEqual(['beta', 'alpha']);

    const parsed = PromptDocBodyV1Schema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.createdAtMs).toBe(10);
      expect(parsed.data.updatedAtMs).toBe(99);
      expect(parsed.data.markdown).toBe('new');
    }
  });

  it('surfaces prompt_doc_invalid_body for malformed stored body json', async () => {
    const { updatePromptDoc } = await import('./promptDocs');

    storage.setState({
      artifacts: {
        p1: {
          id: 'p1',
          header: { v: 1, kind: 'prompt_doc.v2', title: 'Broken' },
          title: 'Broken',
          body: '{',
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

    await expect(updatePromptDoc({ artifactId: 'p1', title: 'Broken', markdown: 'new' })).rejects.toThrow('prompt_doc_invalid_body');
    expect(updateArtifactWithHeaderMock).not.toHaveBeenCalled();
  });

  it('duplicates a prompt doc into a new user-owned artifact', async () => {
    const { duplicatePromptDoc } = await import('./promptDocs');

    storage.setState({
      artifacts: {
        p1: {
          id: 'p1',
          header: {
            v: 1,
            kind: 'prompt_doc.v2',
            title: 'Original prompt',
            origin: 'imported',
            folderId: 'folder-1',
            tags: ['shared'],
          },
          title: 'Original prompt',
          body: JSON.stringify({
            v: 1,
            markdown: '# Original',
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

    const artifactId = await duplicatePromptDoc('p1');
    expect(artifactId).toBe('p1');

    const createCall = createArtifactWithHeaderMock.mock.calls[0];
    if (!createCall) throw new Error('Expected createArtifactWithHeader to be called');
    expect(createCall[0]).toMatchObject({
      kind: 'prompt_doc.v2',
      title: 'Original prompt Copy',
      origin: 'user',
      folderId: 'folder-1',
      tags: ['shared'],
    });
    expect(JSON.parse(createCall[1] as string)).toMatchObject({
      markdown: '# Original',
    });
  });

  it('replaces an existing external link with the same semantic export identity even if the link id changed', async () => {
    const { upsertPromptExternalLink } = await import('./promptDocs');

    const next = upsertPromptExternalLink({
      v: 1,
      links: [
        {
          id: 'old-link',
          artifactId: 'doc-1',
          assetTypeId: 'agents.skill',
          machineId: 'machine-1',
          scope: 'project',
          workspacePath: '/Users/test',
          externalRef: { skillName: 'old-skill' },
          syncMode: 'manual',
          baseDigest: 'sha256:base-old',
          lastLibraryDigest: 'sha256:library-old',
          lastExternalDigest: 'sha256:stale',
          lastSyncAtMs: 100,
        },
      ],
    }, {
      id: 'new-link',
      artifactId: 'doc-1',
      assetTypeId: 'agents.skill',
      machineId: 'machine-1',
      scope: 'project',
      workspacePath: '/Users/test',
      externalRef: { skillName: 'new-skill' },
      syncMode: 'manual',
      baseDigest: 'sha256:base-new',
      lastLibraryDigest: 'sha256:library-new',
      lastExternalDigest: 'sha256:fresh',
      lastSyncAtMs: 200,
    });

    expect(next).toEqual({
      v: 1,
      links: [
        {
          id: 'new-link',
          artifactId: 'doc-1',
          assetTypeId: 'agents.skill',
          machineId: 'machine-1',
          scope: 'project',
          workspacePath: '/Users/test',
          externalRef: { skillName: 'new-skill' },
          syncMode: 'manual',
          baseDigest: 'sha256:base-new',
          lastLibraryDigest: 'sha256:library-new',
          lastExternalDigest: 'sha256:fresh',
          lastSyncAtMs: 200,
        },
      ],
    });
  });

  it('prefers the newest matching external link when duplicate semantic identities already exist', async () => {
    const { findPromptExternalLink } = await import('./promptDocs');

    const match = findPromptExternalLink({
      v: 1,
      links: [
        {
          id: 'old-link',
          artifactId: 'doc-1',
          assetTypeId: 'agents.skill',
          machineId: 'machine-1',
          scope: 'project',
          workspacePath: '/Users/test',
          externalRef: { skillName: 'old-skill' },
          lastLibraryDigest: 'sha256:library-old',
          lastExternalDigest: 'sha256:stale',
        },
        {
          id: 'new-link',
          artifactId: 'doc-1',
          assetTypeId: 'agents.skill',
          machineId: 'machine-1',
          scope: 'project',
          workspacePath: '/Users/test',
          externalRef: { skillName: 'new-skill' },
          lastLibraryDigest: 'sha256:library-new',
          lastExternalDigest: 'sha256:fresh',
        },
      ],
    }, {
      artifactId: 'doc-1',
      assetTypeId: 'agents.skill',
      machineId: 'machine-1',
      scope: 'project',
      workspacePath: '/Users/test',
    });

    expect(match?.id).toBe('new-link');
    expect(match?.lastExternalDigest).toBe('sha256:fresh');
    expect(match?.lastLibraryDigest).toBe('sha256:library-new');
  });
});
