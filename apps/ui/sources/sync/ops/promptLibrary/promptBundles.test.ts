import { afterEach, describe, expect, it } from 'vitest';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { PromptLibraryArtifactStore, PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import {
  createPromptBundleArtifact,
  createSkillPromptBundle,
  duplicatePromptBundle,
  listPromptBundleSupportingEntries,
  readSkillMarkdownFromPromptBundleBody,
  removeSkillPromptBundleEntry,
  updateSkillPromptBundle,
  updateSkillPromptBundleWithEntry,
} from './promptBundles';

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
let catalog = createPromptLibraryCatalogBoundary();
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});
async function home() {
  catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: { v: 1,
    folders: [{ id: 'folder-1', name: 'Personal' }] } }] });
  return (fixture = await createPlainArtifactHomeFixture(
    'https://prompt-bundle-operations.test',
    { handleRequest: (path, init) => catalog.handle(path, init) },
  ));
}

describe('promptBundles qualified operations', () => {
  it.each([false, true])('keeps bundle placement personal and retains the created identity if its row write conflicts (%s)', async conflict => {
    let stored: PromptLibraryStoredArtifact | null = null;
    let created = 0;
    let record: Extract<PromptLibraryRecordV1, { key: 'folders' }> = {
      key: 'folders', value: { v: 1, folders: [{ id: 'mine', name: 'Mine' }] },
    };
    const store = {
      read: async () => stored,
      create: async (input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string }>) => {
        created += 1;
        stored = { id: 'created-bundle', header: input.header, body: input.body, revision: { headerVersion: 1, bodyVersion: 1 } };
        return 'created-bundle';
      },
      update: async () => { throw new Error('Creation cannot update an Artifact'); },
      organization: {
        serverId: 'home', assertCurrent: () => {},
        readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record, revision: 1 }], tombstones: [], diagnostics: [] } satisfies PromptLibraryCatalogSnapshotV1 }),
        readArtifactHeader: async () => stored ? { header: stored.header ?? {}, owned: true } : null,
        listArtifactHeaders: async () => ({ items: stored ? [{ artifactId: stored.id, header: stored.header ?? {}, owned: true }] : [], coverage: 'complete' as const }),
        writeRecord: async (input: Readonly<{ record: PromptLibraryRecordV1; expectedRevision: number | 'absent' }>) => {
          if (conflict || input.expectedRevision !== 1) return { status: 'conflict' as const, revision: 2 };
          if (input.record.key !== 'folders') throw new Error('wrong-domain');
          record = input.record;
          return { status: 'updated' as const, revision: 2, cursor: 2 };
        },
      },
    } satisfies PromptLibraryArtifactStore;
    const create = createPromptBundleArtifact({ title: 'Shared prompts', bundleSchemaId: 'bundle.generic_v1',
      entries: [{ path: 'review.md', contentBase64: Buffer.from('Review').toString('base64'), contentKind: 'utf8' }],
      folderId: 'mine', tags: [' Personal '],
    }, store);
    if (conflict) await expect(create).rejects.toMatchObject({ code: 'artifact_organization_failed', details: {
      artifactId: 'created-bundle', organization: { status: 'conflict', revision: 2 },
    } });
    else {
      await expect(create).resolves.toBe('created-bundle');
      expect(record.value.artifactHeadersById?.['created-bundle']).toEqual({ folderId: 'mine', tags: ['Personal'] });
    }
    const saved = await store.read();
    expect(saved?.header).not.toHaveProperty('folderId');
    expect(saved?.header).not.toHaveProperty('tags');
    expect(saved?.header).toMatchObject({ bundleSchemaId: 'bundle.generic_v1' });
    expect(created).toBe(1);
  });
  it('creates a starter SKILL.md for empty authoring and preserves imported files on duplication', async () => {
    const f = await home();
    const starterId = await createSkillPromptBundle({
      title: 'Starter',
      skillMarkdown: '',
    });
    expect(
      readSkillMarkdownFromPromptBundleBody(
        PromptBundleBodyV1Schema.parse(
          JSON.parse(f.boundary.readPlainBody(starterId)!),
        ),
      ),
    ).toContain('## When to use');
    const importedId = await createPromptBundleArtifact({
      title: 'Imported',
      bundleSchemaId: 'skills.skill_md_v1',
      origin: 'imported',
      folderId: 'folder-1',
      tags: ['shared'],
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Skill').toString('base64'),
          contentKind: 'utf8',
        },
        {
          path: 'templates/example.txt',
          contentBase64: Buffer.from('example').toString('base64'),
          contentKind: 'utf8',
        },
      ],
    });
    const copyId = await duplicatePromptBundle(importedId);
    expect(copyId).not.toBe(importedId);
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(copyId)!.header),
    ).toMatchObject({
      kind: 'prompt_bundle.v2',
      title: 'Imported Copy',
      origin: 'user',
    });
    expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: {
      [copyId]: { folderId: 'folder-1', tags: ['shared'] },
    } });
    expect(JSON.parse(f.boundary.readPlainBody(copyId)!).entries).toEqual(
      JSON.parse(f.boundary.readPlainBody(importedId)!).entries,
    );
  });

  it('preserves the generic bundle schema for imported non-skill entries', async () => {
    const f = await home();
    const id = await createPromptBundleArtifact({
      title: 'Shared prompts',
      bundleSchemaId: 'bundle.generic_v1',
      entries: [
        {
          path: 'prompts/review.md',
          contentBase64: Buffer.from('Review checklist').toString('base64'),
          contentKind: 'utf8',
        },
      ],
    });
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(id)!.header),
    ).toMatchObject({ bundleSchemaId: 'bundle.generic_v1' });
    const copyId = await duplicatePromptBundle(id);
    expect(decodePlainArtifactStoredContent(f.boundary.read(copyId)!.header)).toMatchObject({ bundleSchemaId: 'bundle.generic_v1' });
    expect(JSON.parse(f.boundary.readPlainBody(copyId)!).entries).toEqual(JSON.parse(f.boundary.readPlainBody(id)!).entries);
  });

  it('updates SKILL.md and supporting files through current reads while preserving creation time and title', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({
      title: 'Stored title',
      skillMarkdown: 'old skill',
    });
    const original = JSON.parse(f.boundary.readPlainBody(id)!);
    await updateSkillPromptBundleWithEntry({
      artifactId: id,
      path: 'templates/review.md',
      content: 'review body',
    });
    const acceptedRevision = await updateSkillPromptBundle({
      artifactId: id,
      title: 'New title',
      skillMarkdown: 'new skill',
      expectedRevision: { headerVersion: 2, bodyVersion: 2 },
    });
    expect(acceptedRevision).toEqual({ headerVersion: 3, bodyVersion: 3 });
    const withSupporting = PromptBundleBodyV1Schema.parse(
      JSON.parse(f.boundary.readPlainBody(id)!),
    );
    expect(withSupporting.createdAtMs).toBe(original.createdAtMs);
    expect(readSkillMarkdownFromPromptBundleBody(withSupporting)).toBe(
      'new skill',
    );
    expect(
      listPromptBundleSupportingEntries(withSupporting).map(
        (entry) => entry.path,
      ),
    ).toEqual(['templates/review.md']);
    await removeSkillPromptBundleEntry({
      artifactId: id,
      path: 'templates/review.md',
    });
    expect(
      PromptBundleBodyV1Schema.parse(
        JSON.parse(f.boundary.readPlainBody(id)!),
      ).entries.map((entry) => entry.path),
    ).toEqual(['SKILL.md']);
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(id)!.header),
    ).toMatchObject({ title: 'New title' });
  });

  it('refuses a stale reviewed skill revision without rebasing its draft over a native winner', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Reviewed', skillMarkdown: 'Reviewed instructions' });
    const reviewed = { headerVersion: 1, bodyVersion: 1 };
    await updateSkillPromptBundle({ artifactId: id, title: 'Native winner', skillMarkdown: 'Native winner instructions' });
    const winner = f.boundary.read(id)!;
    await expect(updateSkillPromptBundle({ artifactId: id, title: 'Stale draft', skillMarkdown: 'Stale reviewed instructions',
      expectedRevision: reviewed })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(f.boundary.read(id)).toEqual(winner);
    expect(readSkillMarkdownFromPromptBundleBody(PromptBundleBodyV1Schema.parse(JSON.parse(f.boundary.readPlainBody(id)!))))
      .toBe('Native winner instructions');
  });

  it('refuses to convert a wrong-kind Artifact with a bundle-shaped body into a skill', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Original', skillMarkdown: 'Non-skill content' });
    const response = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Not a skill' }),
      expectedHeaderVersion: 1,
    }) });
    expect(response?.ok).toBe(true);
    const original = f.boundary.read(id)!;
    await expect(updateSkillPromptBundle({ artifactId: id, title: 'Converted', skillMarkdown: 'Overwrite' }))
      .rejects.toMatchObject({ code: 'prompt_bundle_invalid_kind' });
    expect(f.boundary.read(id)).toEqual(original);
  });

  it('returns the exact committed content revision when independent personal placement loses CAS', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Reviewed', skillMarkdown: 'Reviewed instructions' });
    catalog = createPromptLibraryCatalogBoundary({ records: [catalog.read('folders')], mutationOutcome: 'conflict', revision: 4 });
    await expect(updateSkillPromptBundle({ artifactId: id, title: 'Committed content', skillMarkdown: 'Committed instructions',
      expectedRevision: { headerVersion: 1, bodyVersion: 1 }, tags: ['uncommitted placement'] }))
      .rejects.toMatchObject({ code: 'artifact_organization_failed', details: { artifactId: id,
        contentRevision: { headerVersion: 2, bodyVersion: 2 }, organization: { status: 'conflict', revision: 4 } } });
    expect(f.boundary.read(id)).toMatchObject({ headerVersion: 2, bodyVersion: 2 });
    expect(readSkillMarkdownFromPromptBundleBody(PromptBundleBodyV1Schema.parse(JSON.parse(f.boundary.readPlainBody(id)!))))
      .toBe('Committed instructions');
    const folders = catalog.read('folders');
    if (folders.key !== 'folders') throw new Error('Wrong catalog');
    expect(folders.value.artifactHeadersById?.[id]?.tags ?? []).toEqual([]);
  });

  it.each(['edit', 'remove'] as const)('refuses a stale reviewed supporting-file %s without rebasing on a native winner', async operation => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Reviewed', skillMarkdown: 'Reviewed instructions' });
    await updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Reviewed reference' });
    const expectedRevision = { headerVersion: 2, bodyVersion: 2 };
    await updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Native winner reference' });
    const winner = f.boundary.read(id)!;
    const change = operation === 'edit'
      ? updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Stale draft', expectedRevision })
      : removeSkillPromptBundleEntry({ artifactId: id, path: 'reference.txt', expectedRevision });
    await expect(change).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(f.boundary.read(id)).toEqual(winner);
  });
});
