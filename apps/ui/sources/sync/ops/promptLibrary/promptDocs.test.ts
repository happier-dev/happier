import { afterEach, describe, expect, it } from 'vitest';
import { createPlainArtifactHomeFixture, createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MachineAdministrationTargetV1Schema } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { createPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { resolvePromptDocCreateActionInputV1 } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import {
  createPromptDoc,
  updatePromptDoc,
  duplicatePromptDoc,
  findPromptExternalLink,
  upsertPromptExternalLink,
} from './promptDocs';

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
let catalog = createPromptLibraryCatalogBoundary();
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});
async function home(receivedId?: string) {
  catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: { v: 1,
    folders: [{ id: 'folder-1', name: 'Personal' }] } }] });
  return (fixture = await createPlainArtifactHomeFixture(
    'https://prompt-doc-operations.test',
    { handleRequest: async (path, init) => {
      const response = await catalog.handle(path, init);
      if (response) return response;
      if (receivedId && path === `/v1/artifacts/${receivedId}` && (init?.method ?? 'GET') === 'GET') {
        const row = fixture?.boundary.read(receivedId);
        if (row) return Response.json({ ...row, access: 'view', ownerAccountId: 'foreign-account' });
      }
      if (receivedId && new URL(path, 'https://prompt-doc-operations.test').pathname === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
        const inventory = await fixture?.boundary.handle(path, init);
        if (inventory) {
          const rows = await inventory.json();
          return Response.json(rows.map((row: { id: string }) => row.id === receivedId
            ? { ...row, access: 'view', ownerAccountId: 'foreign-account' } : row));
        }
      }
      return null;
    } },
  ));
}

describe('promptDocs qualified operations', () => {
  it.each(['update', 'duplicate'] as const)('refuses a disabled %s through Action admission without changing the source or creating a copy', async operation => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Original', markdown: 'Original' });
    const before = f.boundary.list();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account/settings') return Response.json({ version: 3, content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: { [operation === 'duplicate' ? 'prompt_doc.create' : 'prompt_doc.update']: { disabledSurfaces: ['ui'] } } },
      } } });
      if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
      return await catalog.handle(`${url.pathname}${url.search}`, init) ?? await f.boundary.handle(`${url.pathname}${url.search}`, init)
        ?? Response.json({}, { status: 404 });
    });
    await f.hydrateAccountSettings();
    await expect(operation === 'duplicate' ? duplicatePromptDoc(id)
      : updatePromptDoc({ artifactId: id, title: 'Changed', markdown: 'Changed', expectedRevision: {
        headerVersion: before[0]!.headerVersion, bodyVersion: before[0]!.bodyVersion,
      } })).rejects.toThrow();
    expect(f.boundary.list()).toEqual(before);
  });
  it('creates a built-in guide only in its captured document Home while another Home is focused', async () => {
    const f = await home();
    const guideHome = f.home.id;
    const guideUrl = f.home.serverUrl;
    const otherUrl = 'https://other-guide-home.test';
    const otherArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'artifact-account', encryptionMode: 'plain' });
    const otherCatalog = createPromptLibraryCatalogBoundary();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (['/health', '/v1/auth/ping', '/v1/features'].includes(url.pathname)) return Response.json({});
      if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
      const guide = url.origin === new URL(guideUrl).origin;
      if (!guide && url.origin !== otherUrl) throw new Error('Unexpected guide Home');
      const path = `${url.pathname}${url.search}`;
      return await (guide ? catalog : otherCatalog).handle(path, init)
        ?? await (guide ? f.boundary : otherArtifacts).handle(path, init)
        ?? Response.json({ error: 'not_found' }, { status: 404 });
    });
    const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const other = await upsertAndActivateServer({ serverUrl: otherUrl, scope: 'device' });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ settingsScope: { serverId: other.id, accountId: 'artifact-account' },
      profileScope: { serverId: other.id, accountId: 'artifact-account' }, artifacts: {} });
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());

    const id = await createPromptDoc({ starter: 'happier_guide', serverId: guideHome });
    expect(f.boundary.read(id)?.ownerAccountId).toBe('artifact-account');
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: resolvePromptDocCreateActionInputV1({ starter: 'happier_guide' }).markdown });
    expect(otherArtifacts.list()).toEqual([]);
    expect(decodePlainArtifactStoredContent(f.boundary.read(id)!.header)).toMatchObject({ origin: 'built_in' });
  });

  it('duplicates received content without copying the owner organization', async () => {
    const f = await home('received');
    await f.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'received',
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Received',
        folderId: 'foreign-folder', tags: ['private-owner'] }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Shared content', createdAtMs: 1, updatedAtMs: 1 }) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    const copyId = await duplicatePromptDoc('received');
    expect(JSON.parse(f.boundary.readPlainBody(copyId)!)).toMatchObject({ markdown: 'Shared content' });
    expect(decodePlainArtifactStoredContent(f.boundary.read(copyId)!.header)).not.toHaveProperty('folderId');
    expect(decodePlainArtifactStoredContent(f.boundary.read(copyId)!.header)).not.toHaveProperty('tags');
    const folders = catalog.read('folders');
    if (folders.key !== 'folders') throw new Error('Wrong catalog');
    expect(folders.value.artifactHeadersById?.[copyId]?.folderId ?? null).toBeNull();
    expect(folders.value.artifactHeadersById?.[copyId]?.tags ?? []).toEqual([]);
  });
  it('returns the acknowledged revision so a second editor save uses its own accepted base', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Original', markdown: 'Original' });
    const original = f.boundary.read(id)!;
    const accepted = await updatePromptDoc({ artifactId: id, title: 'First', markdown: 'First', expectedRevision: {
      headerVersion: original.headerVersion, bodyVersion: original.bodyVersion,
    } });
    const afterFirst = f.boundary.read(id)!;
    expect(accepted).toEqual({ headerVersion: afterFirst.headerVersion, bodyVersion: afterFirst.bodyVersion });
    await updatePromptDoc({ artifactId: id, title: 'Second', markdown: 'Second', expectedRevision: accepted });
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Second' });
  });

  it('retains a newer document when an editor saves its stale reviewed revision', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Original', markdown: 'Original' });
    const preview = f.boundary.read(id)!;
    await updatePromptDoc({ artifactId: id, title: 'Newer', markdown: 'Newer' });
    await expect(updatePromptDoc({ artifactId: id, title: 'Draft', markdown: 'Draft', expectedRevision: {
      headerVersion: preview.headerVersion, bodyVersion: preview.bodyVersion,
    } })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Newer' });
    expect(decodePlainArtifactStoredContent(f.boundary.read(id)!.header)).toMatchObject({ title: 'Newer' });
  });

  it('creates and duplicates an imported document through the qualified owner without losing its organization', async () => {
    const f = await home();
    // Seed host-imported content through the real qualified owner, not a public operand claiming provenance.
    const { artifactId } = await withUiPromptLibraryArtifactStore(store => createPromptDocInLibrary({ store, request: {
      title: 'Imported prompt',
      markdown: '# Imported',
      origin: 'imported',
      folderId: 'folder-1',
      tags: ['alpha', 'beta'],
    } }));
    expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: {
      [artifactId]: { folderId: 'folder-1', tags: ['alpha', 'beta'] },
    } });
    expect(decodePlainArtifactStoredContent(f.boundary.read(artifactId)!.header)).not.toHaveProperty('folderId');
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(artifactId)!.header),
    ).toMatchObject({
      kind: 'prompt_doc.v2',
      title: 'Imported prompt',
      origin: 'imported',
    });
    const copyId = await duplicatePromptDoc(artifactId);
    expect(copyId).not.toBe(artifactId);
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(copyId)!.header),
    ).toMatchObject({
      kind: 'prompt_doc.v2',
      title: 'Imported prompt Copy',
      origin: 'user',
    });
    expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: {
      [copyId]: { folderId: 'folder-1', tags: ['alpha', 'beta'] },
    } });
    expect(JSON.parse(f.boundary.readPlainBody(copyId)!)).toMatchObject({
      markdown: '# Imported',
    });
  });

  it('updates current content, preserves creation time and changes only the selected document', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Old', markdown: 'old' });
    const other = await createPromptDoc({
      title: 'Other',
      markdown: 'untouched',
    });
    const original = JSON.parse(f.boundary.readPlainBody(id)!);
    await updatePromptDoc({
      artifactId: id,
      title: 'New',
      markdown: 'new',
      folderId: null,
      tags: ['beta', 'alpha'],
    });
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({
      markdown: 'new',
      createdAtMs: original.createdAtMs,
    });
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(id)!.header),
    ).toMatchObject({ title: 'New' });
    expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: {
      [id]: { folderId: null, tags: ['beta', 'alpha'] },
    } });
    expect(JSON.parse(f.boundary.readPlainBody(other)!)).toMatchObject({
      markdown: 'untouched',
    });
  });

  it('refuses malformed current content before a write', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Broken', markdown: 'original' });
    const row = f.boundary.read(id)!;
    const { encodePlainArtifactStoredContent } =
      await import('@happier-dev/protocol/storage/artifactStoredContent');
    const nativeWrite = await f.boundary.handle(`/v1/artifacts/${id}`, {
      method: 'POST',
      body: JSON.stringify({
        body: encodePlainArtifactStoredContent({ body: '{' }),
        expectedBodyVersion: row.bodyVersion,
        // This is retained/native malformed content without private revision
        // metadata, not a current writer's provenance bound to the old version.
        provenance: null,
        provenanceDataEncryptionKey: null,
      }),
    });
    expect(nativeWrite?.ok).toBe(true);
    expect(f.boundary.read(id)).toMatchObject({ headerVersion: row.headerVersion, bodyVersion: row.bodyVersion + 1 });
    await expect(
      updatePromptDoc({ artifactId: id, title: 'Broken', markdown: 'new' }),
    ).rejects.toThrow('prompt_doc_invalid_body');
    expect(f.boundary.readPlainBody(id)).toBe('{');
    expect(f.requests.some(request => request.path === `/v1/artifacts/${id}` && request.method === 'POST')).toBe(false);
  });

  it('replaces an external link by semantic export identity even when its id changed', () => {
    const target = MachineAdministrationTargetV1Schema.parse({ serverIdentityId: 'srv_library', machineId: 'machine-1' });
    const context = { target, libraryServerIdentityId: target.serverIdentityId };
    const old = {
      id: 'old-link',
      artifactId: 'doc-1',
      assetTypeId: 'agents.skill',
      machineId: 'machine-1',
      scope: 'project' as const,
      workspacePath: '/Users/test',
      externalRef: { skillName: 'old-skill' },
      lastLibraryDigest: 'sha256:old',
      lastExternalDigest: 'sha256:stale',
    };
    const next = {
      ...old,
      id: 'new-link',
      serverIdentityId: target.serverIdentityId,
      externalRef: { skillName: 'new-skill' },
      lastLibraryDigest: 'sha256:new',
      lastExternalDigest: 'sha256:fresh',
    };
    expect(upsertPromptExternalLink({ v: 1, links: [old] }, next, context)).toEqual({
      v: 1,
      links: [next],
    });
    expect(
      findPromptExternalLink(
        { v: 1, links: [old, next] },
        {
          artifactId: 'doc-1',
          assetTypeId: 'agents.skill',
          ...context,
          scope: 'project',
          workspacePath: '/Users/test',
        },
      ),
    ).toEqual(next);
  });
});
