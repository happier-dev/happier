import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPromptDocInLibrary, updatePromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
  decodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { mutateArtifactOrganizationV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { storage } from '@/sync/domains/state/storage';
import {
  resetRuntimeFetch,
  setRuntimeFetch,
} from '@/utils/system/runtimeFetch';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
  withUiPromptLibraryArtifactReader,
  withUiPromptLibraryArtifactStore,
} from './promptLibraryArtifactStore';
import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { importPromptAssetToLibrary } from './importPromptAssetToLibrary';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import {
  updateSkillPromptBundleWithEntry,
  removeSkillPromptBundleEntry,
} from './promptBundles';

// The third-party markdown renderer is outside this Artifact-only journey.
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({
    splitStreamingRevealTextParts: () => {
      throw new Error('Unexpected markdown rendering in Artifact test');
    },
  }),
);
let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
  resetRuntimeFetch();
  vi.restoreAllMocks();
});

async function home(
  kind = 'prompt_doc.v2',
  body = JSON.stringify({
    v: 1,
    markdown: 'original',
    createdAtMs: 1,
    updatedAtMs: 1,
  }),
) {
  fixture = await createPlainArtifactHomeFixture(
    'https://prompt-qualified-read.test',
  );
  await fixture.boundary.handle('/v1/artifacts', {
    method: 'POST',
    body: JSON.stringify({
      id: 'current',
      header: encodePlainArtifactStoredContent({
        v: 1,
        kind,
        title: 'Current',
        ...(kind === 'prompt_bundle.v2'
          ? { bundleSchemaId: 'skills.skill_md_v1' }
          : {}),
      }),
      body: encodePlainArtifactStoredContent({ body }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }),
  });
  return fixture;
}

describe('UI qualified prompt-library Artifact authority', () => {
  it.each(['doc', 'bundle'] as const)('refuses a downloaded %s import after its captured active library Account retires', async libraryKind => {
    const originalUrl = 'https://captured-import-library.test';
    const nextUrl = 'https://next-import-library.test';
    const originalCatalog = createPromptLibraryCatalogBoundary();
    const nextCatalog = createPromptLibraryCatalogBoundary();
    const f = fixture = await createPlainArtifactHomeFixture(originalUrl, { handleRequest: originalCatalog.handle });
    const nextArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'artifact-account', encryptionMode: 'plain' });
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return Response.json({});
      if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
      const original = url.origin === originalUrl;
      if (!original && url.origin !== nextUrl) throw new Error(`Unexpected Home ${url.origin}`);
      const path = `${url.pathname}${url.search}`;
      return await (original ? originalCatalog : nextCatalog).handle(path, init)
        ?? await (original ? f.boundary : nextArtifacts).handle(path, init)
        ?? Response.json({ error: 'not_found' }, { status: 404 });
    });
    const importing = withUiPromptLibraryArtifactStore(async store => {
      const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
      const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
      const nextHome = await upsertAndActivateServer({ serverUrl: nextUrl, scope: 'device' });
      storage.setState({ profileScope: { serverId: nextHome.id, accountId: 'artifact-account' }, settingsScope: { serverId: nextHome.id, accountId: 'artifact-account' } });
      publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
      const common = { assetTypeId: 'agents.skill', scope: 'user' as const, externalRef: { name: 'review' },
        title: 'Downloaded review', digest: 'digest-1', displayPath: 'review' };
      const item = libraryKind === 'doc' ? { ...common, libraryKind, markdown: '# Review' }
        : { ...common, libraryKind, bundleSchemaId: 'skills.skill_md_v1' as const,
          bundleBody: { v: 1 as const, entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Review').toString('base64'), contentKind: 'utf8' as const }], createdAtMs: 1, updatedAtMs: 1 } };
      return await importPromptAssetToLibrary({ item, machineId: 'machine-1', promptExternalLinks: { v: 1, links: [] } }, store);
    }, { serverId: f.home.id });
    await expect(importing).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    expect(f.boundary.list()).toEqual([]);
    expect(nextArtifacts.list()).toEqual([]);
  });
  it('keeps authored placement in the captured private catalog rather than shared Artifact bytes', async () => {
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: {
      v: 1, folders: [{ id: 'mine', name: 'Mine' }],
    } }], revision: 4 });
    const f = fixture = await createPlainArtifactHomeFixture('https://personal-folder-owner.test', { handleRequest: catalog.handle });
    const result = await withUiPromptLibraryArtifactStore(store => createPromptDocInLibrary({ store,
      request: { title: 'Shared prompt', markdown: 'Content', folderId: 'mine', tags: [' Personal '] },
    }), { serverId: f.home.id });
    const header = decodePlainArtifactStoredContent(f.boundary.read(result.artifactId)!.header);
    expect(header).not.toHaveProperty('folderId');
    expect(header).not.toHaveProperty('tags');
    expect(catalog.read('folders')).toMatchObject({ value: { artifactHeadersById: {
      [result.artifactId]: { folderId: 'mine', tags: ['Personal'] },
    } } });
    expect(catalog.revision('folders')).toBe(5);
    const created = f.boundary.read(result.artifactId)!;
    // This retained row has unreadable body bytes, not a stale body-bound
    // private-metadata envelope left behind by the fixture's direct write.
    await f.boundary.handle(`/v1/artifacts/${result.artifactId}`, { method: 'POST', body: JSON.stringify({
      body: 'unreadable retained body envelope', expectedBodyVersion: created.bodyVersion,
      provenance: null, provenanceDataEncryptionKey: null,
    }) });
    const unreadable = f.boundary.read(result.artifactId)!;
    await withUiPromptLibraryArtifactStore(async store => {
      if (!store.organization) throw new Error('Missing personal owner');
      await expect(mutateArtifactOrganizationV1({ port: store.organization, artifactId: result.artifactId,
        change: { folderId: null }, expectedRevision: 5 })).resolves.toEqual({ status: 'updated', revision: 6 });
    }, { serverId: f.home.id });
    expect(f.boundary.read(result.artifactId)).toEqual(unreadable);
    expect(catalog.read('folders')).toMatchObject({ value: { artifactHeadersById: {
      [result.artifactId]: { folderId: null, tags: ['Personal'] },
    } } });
  });
  it('does not report missing from an incomplete header inventory', async () => {
    const f = await home();
    const row = f.boundary.read('current')!;
    // The genuine Home transport may carry an unreadable row; the canonical
    // header loader must preserve partial coverage rather than invent absence.
    setRuntimeFetch(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), { status: 200 });
      if (path === '/v1/artifacts') return new Response(JSON.stringify([{ ...row, header: 'invalid stored header' }]), { status: 200 });
      return (await f.boundary.handle(path, init)) ?? new Response('{}', { status: 404 });
    });
    await expect(withUiPromptLibraryArtifactReader(reader => reader.readArtifactHeader({ kind: 'doc', artifactId: 'missing' }),
      { serverId: f.home.id })).rejects.toMatchObject({ code: 'artifact_read_unavailable' });
  });
  it('reads the current Home document again even when its display projection has a body', async () => {
    const f = await home();
    const stale: DecryptedArtifact = {
      id: 'current',
      title: 'Current',
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Current' },
      body: 'stale display body',
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      isDecrypted: true,
      storageMode: 'plain',
    };
    storage.setState({ artifacts: { current: stale } });
    expect(
      (
        await withUiPromptLibraryArtifactStore(
          (store) => store.read('current'),
          { serverId: f.home.id },
        )
      )?.body,
    ).toContain('original');
    await f.boundary.handle('/v1/artifacts/current', {
      method: 'POST',
      body: JSON.stringify({
        body: encodePlainArtifactStoredContent({ body: 'second current body' }),
        expectedBodyVersion: 1,
      }),
    });
    expect(
      (
        await withUiPromptLibraryArtifactStore(
          (store) => store.read('current'),
          { serverId: f.home.id },
        )
      )?.body,
    ).toBe('second current body');
  });

  it('rejects another Artifact kind even when it has a prompt-shaped body', async () => {
    const f = await home('role.v1');
    await expect(
      expandPromptTemplateInvocation({
        targetArtifactId: 'current',
        argsText: '',
        serverId: f.home.id,
      }),
    ).rejects.toThrow();
  });

  it('refuses an aborted caller before capturing credentials or issuing HTTP', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    setRuntimeFetch(request);
    await expect(
      withUiPromptLibraryArtifactStore((store) => store.read('current'), {
        serverId: 'retired',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves a concurrent write through the real qualified Artifact CAS', async () => {
    const f = await home();
    f.boundary.beforeNextUpdate(async () => {
      await f.boundary.handle('/v1/artifacts/current', {
        method: 'POST',
        body: JSON.stringify({
          body: encodePlainArtifactStoredContent({ body: 'concurrent' }),
          expectedBodyVersion: 1,
        }),
      });
    });
    await expect(
      withUiPromptLibraryArtifactStore(
        (store) =>
          updatePromptDocInLibrary({
            store,
            request: {
              artifactId: 'current',
              title: 'Stale overwrite',
              markdown: 'stale',
            },
          }),
        { serverId: f.home.id },
      ),
    ).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(f.boundary.readPlainBody('current')).toBe('concurrent');
  });

  it.each(['update', 'remove'] as const)(
    'refuses a stale supporting-entry %s without rebasing the bundle revision',
    async (operation) => {
      const f = await home(
        'prompt_bundle.v2',
        JSON.stringify({
          v: 1,
          entries: [
            {
              path: 'SKILL.md',
              contentBase64: 'IyBTa2lsbA==',
              contentKind: 'utf8',
            },
            {
              path: 'notes.md',
              contentBase64: 'b3JpZ2luYWw=',
              contentKind: 'utf8',
            },
          ],
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      );
      f.boundary.beforeNextUpdate(async () => {
        await f.boundary.handle('/v1/artifacts/current', {
          method: 'POST',
          body: JSON.stringify({
            body: encodePlainArtifactStoredContent({
              body: 'concurrent bundle',
            }),
            expectedBodyVersion: 1,
          }),
        });
      });
      await expect(
        operation === 'update'
          ? updateSkillPromptBundleWithEntry({
              artifactId: 'current',
              path: 'notes.md',
              content: 'stale',
            })
          : removeSkillPromptBundleEntry({
              artifactId: 'current',
              path: 'notes.md',
            }),
      ).rejects.toMatchObject({ code: 'version_mismatch' });
      expect(f.boundary.readPlainBody('current')).toBe('concurrent bundle');
    },
  );

  it('suppresses a required memory document using only current header facts', async () => {
    const f = await home(
      'memory_doc.v1',
      '{ malformed body must never be loaded }',
    );
    // The owning Artifact route admits 500 rows per structural page. Put the
    // selected document on the next page to distinguish absence from a window.
    for (let index = 0; index < 500; index++) {
      await f.boundary.handle('/v1/artifacts', {
        method: 'POST',
        body: JSON.stringify({
          id: `zz-other-${index}`,
          header: encodePlainArtifactStoredContent({
            v: 1,
            kind: 'prompt_doc.v2',
            title: 'Other',
          }),
          body: encodePlainArtifactStoredContent({ body: 'Never loaded' }),
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
      });
    }
    const blocks = await withUiPromptLibraryArtifactReader(
      (reader) =>
        resolvePromptStackSystemAppendBlocksV1({
          surface: 'coding',
          accountEntries: [
            {
              id: 'memory',
              ref: { kind: 'doc', artifactId: 'current' },
              enabled: true,
              required: true,
              placement: 'system_append',
            },
          ],
          memoryEnabled: false,
          ...reader,
        }),
      { serverId: f.home.id },
    );
    expect(blocks).toEqual({ blocks: [], admittedEntries: [] });
    expect(
      f.requests.filter(
        (request) =>
          request.method === 'GET' && request.path === '/v1/artifacts/current',
      ),
    ).toEqual([]);
  });
});
