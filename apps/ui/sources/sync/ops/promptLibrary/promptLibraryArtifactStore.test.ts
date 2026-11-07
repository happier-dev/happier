import { afterEach, describe, expect, it, vi } from 'vitest';
import NativeAbortController from 'abort-controller';
import { createPromptDocInLibrary, createPromptBundleInLibrary, updatePromptDocInLibrary, listPromptLibrary, readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
  decodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture, createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { mutateArtifactOrganizationV1, readArtifactOrganizationV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
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
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createDeferred } from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { encodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { PROMPT_LIBRARY_ARTIFACT_KINDS, type ArtifactInventoryPublication } from '@/sync/domains/artifacts/artifactInventory';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';

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
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  resetRuntimeFetch();
  vi.restoreAllMocks();
  resetServerFeaturesClientForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
});

async function home(
  kind = 'prompt_doc.v2',
  body = JSON.stringify({
    v: 1,
    markdown: 'original',
    createdAtMs: 1,
    updatedAtMs: 1,
  }),
  options?: Parameters<typeof createPlainArtifactHomeFixture>[1],
) {
  fixture = await createPlainArtifactHomeFixture(
    'https://prompt-qualified-read.test', options,
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
  it('reads the accepted private revision actor without adding provenance to document content', async () => {
    const f = await home();
    const savedBy = { kind: 'agent' as const, accountId: 'artifact-account', sessionId: 'author-session' };
    await withUiPromptLibraryArtifactStore(async store => {
      await updatePromptDocInLibrary({ store, savedBy, request: { artifactId: 'current', title: 'Current', markdown: 'Accepted' } });
      expect(await readPromptDocInLibrary({ store, artifactId: 'current' })).toMatchObject({ ok: true,
        provenance: { savedBy } });
      const row = await store.read('current');
      expect(row?.header).not.toHaveProperty('savedBy');
      expect(JSON.parse(row!.body!)).not.toHaveProperty('savedBy');
      const before = f.requests.length;
      expect(store.readHeadersByIds).toBeTypeOf('function');
      expect(await store.readHeadersByIds!(['current'])).toMatchObject([{ status: 'fulfilled', value: {
        id: 'current', body: null, provenance: { savedBy }, revision: row!.revision,
      } }]);
      expect(f.requests.slice(before)).toMatchObject([{ path: '/v1/artifacts/read', projection: 'headers' }]);
    }, { serverId: f.home.id });
  });
  it('reads and updates one Artifact organization through exact headers without enumerating the Account', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const headerRequests: unknown[] = [];
    const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
      if (path === '/v1/artifacts/read') headerRequests.push(JSON.parse(String(init?.body)));
      return catalog.handle(path, init);
    } });
    await Promise.all(Array.from({ length: 512 }, (_, index) => f.boundary.handle('/v1/artifacts', {
      method: 'POST', body: JSON.stringify({ id: `unrelated-organization-${index}`,
        header: encodePlainArtifactStoredContent({ kind: 'role.v1', title: 'Unrelated' }),
        body: encodePlainArtifactStoredContent({ body: 'Not demanded' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }),
    })));
    await withUiPromptLibraryArtifactStore(async store => {
      if (!store.organization) throw new Error('Expected organization owner');
      const before = f.requests.length;
      expect(await readArtifactOrganizationV1({ port: store.organization, artifactId: 'current' })).toMatchObject({ status: 'ready' });
      expect(await mutateArtifactOrganizationV1({ port: store.organization, artifactId: 'current', change: { tags: ['review'] } }))
        .toMatchObject({ status: 'updated' });
      const reads = f.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts'));
      expect(reads).toEqual([{ path: '/v1/artifacts/read', method: 'POST', projection: 'headers' },
        { path: '/v1/artifacts/read', method: 'POST', projection: 'headers' }]);
      expect(headerRequests).toEqual([{ artifactIds: ['current'], projection: 'headers' }, { artifactIds: ['current'], projection: 'headers' }]);
    }, { serverId: f.home.id });
  });

  it('distinguishes an unavailable exact organization header from absence and honors cancellation', async () => {
    const f = await home();
    await withUiPromptLibraryArtifactStore(async store => {
      if (!store.organization) throw new Error('Expected organization owner');
      const stored = f.boundary.read('current')!;
      f.boundary.replaceStoredRow({ ...stored, header: 'invalid-stored-header' });
      await expect(store.organization.readArtifactHeader('current')).rejects.toBeDefined();
      expect(await store.organization.readArtifactHeader('missing')).toBeNull();
      const before = f.requests.length;
      const controller = new AbortController(); controller.abort();
      await expect(store.organization.readArtifactHeader('current', controller.signal)).rejects.toBeDefined();
      expect(f.requests).toHaveLength(before);
    }, { serverId: f.home.id });
  });

  it.each(['scoped', 'full'] as const)('reuses %s admitted Prompt membership despite a locked row of a different known kind', async mode => {
    const f = await home();
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      const prompt = await account.fetchArtifact('current');
      if (!prompt?.isDecrypted) throw new Error('Expected admitted Prompt');
      const locked: DecryptedArtifact = { id: 'locked-role', kindHint: 'role.v1', title: null,
        headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'e2ee', isDecrypted: false,
        availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
      storage.getState().applyArtifacts([prompt, locked], storage.getState().artifacts,
        mode === 'scoped' ? ['prompt_doc.v2'] : undefined);
      const before = f.requests.length;
      expect(await store.list!({ kinds: ['prompt_doc.v2'], limit: 500 })).toMatchObject({ coverage: 'complete', items: [{ id: 'current' }] });
      expect(f.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts'))).toEqual([]);
    }, { serverId: f.home.id });
  });

  it.each(['prompt_doc.v2', undefined] as const)('does not reuse membership after a later locked matching or unknown kind arrives (%s)', async kindHint => {
    const f = await home();
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      const prompt = await account.fetchArtifact('current');
      if (!prompt?.isDecrypted) throw new Error('Expected admitted Prompt');
      storage.getState().applyArtifacts([prompt], storage.getState().artifacts, ['prompt_doc.v2']);
      storage.getState().updateArtifact({ id: 'locked-prompt', kindHint, title: null,
        headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'e2ee', isDecrypted: false,
        availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
      const before = f.requests.length;
      expect(await store.list!({ kinds: ['prompt_doc.v2'], limit: 500 })).toMatchObject({ coverage: 'complete', items: [{ id: 'current' }] });
      expect(f.requests.slice(before).some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true);
    }, { serverId: f.home.id });
  });

  it('selects only Prompt Docs through the captured indexed query without repair or bodies', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    // More than a transport page of unrelated, classified headers must never
    // be opened merely to discover the one Prompt Doc.
    await Promise.all(Array.from({ length: 512 }, (_, index) => f.boundary.handle('/v1/artifacts', {
      method: 'POST', body: JSON.stringify({ id: `unrelated-bundle-${index}`,
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: `Bundle ${index}` }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }),
    })));
    expect(f.boundary.list()).toHaveLength(513);
    storage.setState({ artifacts: {}, artifactsLoaded: false });
    const before = f.requests.length;
    const result = await withUiPromptLibraryArtifactStore(store => listPromptLibrary({ store, request: {} }), { serverId: f.home.id });
    expect(result).toMatchObject({ coverage: 'complete', items: [{ artifactId: 'current', title: 'Current' }] });
    const requests = f.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts'));
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    const query = new URL(requests[0].path, 'https://home.test').searchParams;
    expect(Object.fromEntries(query)).toEqual({ limit: '500', kinds: '["prompt_doc.v2"]' });
  });

  it.each([
    { legacyKind: null, unreadableLegacy: false },
    { legacyKind: 'prompt', unreadableLegacy: false },
    { legacyKind: null, unreadableLegacy: true },
  ] as const)('resolves unhinted Prompt Docs through canonical header selection with truthful read coverage (stored kind: $legacyKind, unreadable legacy: $unreadableLegacy)', async ({ legacyKind, unreadableLegacy }) => {
    const catalog = createPromptLibraryCatalogBoundary();
    const pages: { query: Record<string, string>; ids: string[]; classificationCoverage: unknown }[] = [];
    const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
      if (path.startsWith('/v1/artifacts?')) {
        const response = await f.boundary.handle(path, init);
        if (!response) throw new Error('Expected the Artifact list HTTP boundary');
        const body: unknown = await response.clone().json();
        if (!body || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items))
          throw new Error('Expected the filtered Artifact list envelope');
        const ids = body.items.map((item: unknown) => {
          if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string')
            throw new Error('Expected a stored Artifact header identity');
          expect(item).not.toHaveProperty('body');
          return item.id;
        });
        pages.push({ query: Object.fromEntries(new URL(path, 'https://home.test').searchParams),
          ids, classificationCoverage: Reflect.get(body, 'coverage') });
        return response;
      }
      return catalog.handle(path, init);
    } });
    const current = f.boundary.read('current');
    if (!current) throw new Error('Expected the stored Prompt Doc');
    // Persistence-boundary predecessor bytes: no public exact-kind hint. The
    // real private header still identifies the Prompt Doc after decoding.
    const { kindHint: _hint, ...legacy } = current;
    f.boundary.replaceStoredRow({ ...legacy, kind: legacyKind });
    if (unreadableLegacy) f.boundary.replaceStoredRow({ ...legacy, id: 'unreadable-legacy', kind: legacyKind,
      header: 'unreadable-stored-header' });
    await Promise.all(Array.from({ length: 512 }, (_, index) => f.boundary.handle('/v1/artifacts', {
      method: 'POST', body: JSON.stringify({ id: `unrelated-bundle-${index}`,
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: `Bundle ${index}` }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }),
    })));
    storage.setState({ artifacts: {}, artifactsLoaded: false });
    const before = f.requests.length;
    const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
    const action = await withUiPromptLibraryArtifactStore(async (_store, account) =>
      executeDefaultActionInCapturedAccount(account, 'prompts.library.list', {},
        { surface: 'ui', authority: 'present_user', serverId: f.home.id, expectedAccountId: account.accountId }),
    { serverId: f.home.id });
    expect(action).toMatchObject({ ok: true, result: { items: [{ artifactId: 'current', title: 'Current' }] } });
    if (!action.ok) throw new Error('Expected the canonical Prompt library Action result');
    expect(action.result).toEqual({ coverage: unreadableLegacy ? 'partial' : 'complete',
      items: [{ artifactId: 'current', title: 'Current', folderId: null, tags: [], favorite: false,
        updatedAtMs: current.updatedAt }] });
    const requests = f.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts'));
    expect(requests.map(({ method, path }) => ({ method, query: Object.fromEntries(new URL(path, 'https://home.test').searchParams) })))
      .toEqual([{ method: 'GET', query: { limit: '500', kinds: '["prompt_doc.v2"]' } },
        { method: 'GET', query: { limit: '500', unclassified: 'true' } }]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ ids: [], classificationCoverage: {
      status: 'partial', unclassifiedCount: unreadableLegacy ? 2 : 1, reason: 'unclassified_legacy_rows' } });
    expect(pages[1].classificationCoverage).toEqual(pages[0].classificationCoverage);
    expect(pages[1].ids.sort()).toEqual(unreadableLegacy ? ['current', 'unreadable-legacy'] : ['current']);
    expect(storage.getState()).toMatchObject({ artifacts: {}, artifactsLoaded: false });
    expect(f.boundary.read('current')).toEqual({ ...legacy, kind: legacyKind });
  });

  it('does not join an unrelated pending full inventory before reading Prompt Docs', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const inventoryRequested = createDeferred<void>();
    const releaseInventory = createDeferred<void>();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
      if (path.startsWith('/v1/artifacts?') && !new URL(path, 'https://home.test').searchParams.has('kinds')) {
        inventoryRequested.resolve();
        await releaseInventory.promise;
      }
      return catalog.handle(path, init);
    } });
    storage.setState({ artifacts: {}, artifactsLoaded: false });
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
      const basis = storage.getState().artifacts;
      const inventory = fetchAndApplyArtifactsList({ credentials: account.credentials, request: account.request,
        inventoryScope: account.accountLifetime.scope, encryption: null, artifactDataKeys: new Map(),
        applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? basis : undefined) });
      await inventoryRequested.promise;
      const action = listPromptLibrary({ store, request: {} });
      try {
        await vi.waitFor(() => expect(f.requests.some(request => request.path.startsWith('/v1/artifacts?')
          && new URL(request.path, 'https://home.test').searchParams.get('kinds') === '["prompt_doc.v2"]')).toBe(true));
        expect(await action).toMatchObject({ coverage: 'complete', items: [{ artifactId: 'current' }] });
      } finally {
        releaseInventory.resolve();
        await Promise.allSettled([inventory, action]);
      }
    }, { serverId: f.home.id });
  });


  it('shares finite catalog rows without starting retained Settings maintenance', async () => {
    const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
    const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    const before = f.requests.length;
    await withUiPromptLibraryArtifactStore(async store => {
      if (!store.organization) throw new Error('Expected captured organization reader');
      const rows = await Promise.all((['skill-rules', 'skill-usage', 'folders'] as const)
        .map(key => store.organization!.readCatalog(undefined, key)));
      expect(rows.every(row => row.catalog.status === 'ready')).toBe(true);
    }, { serverId: f.home.id });
    const requests = f.requests.slice(before);
    expect(requests.filter(request => request.method === 'GET'
      && request.path === '/v1/account/entity-rows/prompt-library')).toHaveLength(1);
    expect(requests.filter(request => request.path === '/v2/account/settings')).toHaveLength(0);
    expect(catalog.requests).toEqual([]);
  });
  it('keeps independent finite catalog callers live when a sibling cancels', async () => {
    const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
    const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    const catalog = createPromptLibraryCatalogBoundary();
    const requested = createDeferred<void>();
    const release = createDeferred<void>();
    let reads = 0;
    const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
      if (path === '/v1/account/entity-rows/prompt-library' && (init?.method ?? 'GET') === 'GET') {
        reads++;
        if (reads === 1) { requested.resolve(); await release.promise; }
      }
      return catalog.handle(path, init);
    } });
    await withUiPromptLibraryArtifactStore(async store => {
      if (!store.organization) throw new Error('Expected captured organization reader');
      const controller = new AbortController();
      let cancelledSettled = false;
      const cancelled = store.organization.readCatalog(controller.signal).catch(error => error).then(outcome => {
        cancelledSettled = true;
        return outcome;
      });
      let surviving: ReturnType<typeof store.organization.readCatalog> | undefined;
      try {
        await requested.promise;
        surviving = store.organization.readCatalog();
        controller.abort();
        await vi.waitFor(() => expect(cancelledSettled).toBe(true));
        expect(reads).toBe(1);
      } finally { release.resolve(); }
      expect((await surviving)?.catalog.status).toBe('ready');
      expect(reads).toBe(1);
      const outcome = await cancelled;
      expect(outcome).not.toMatchObject({ catalog: { status: 'ready' } });
    }, { serverId: f.home.id });
  });
  it('forgets settled finite acquisitions and fences pending joins after a Home change', async () => {
    const { readPromptLibraryCatalogProjectionInContext } = await import('@/sync/api/account/apiPromptLibraryCatalog');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { buildPromptLibraryPhysicalKeyV1, PromptLibraryRowMutationV1Schema, sealPromptLibraryContentV1 } =
      await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
    const catalog = createPromptLibraryCatalogBoundary();
    const requested = createDeferred<void>();
    const release = createDeferred<void>();
    let reads = 0;
    const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
      const response = await catalog.handle(path, init);
      if (path === '/v1/account/entity-rows/prompt-library' && (init?.method ?? 'GET') === 'GET') {
        reads++;
        if (reads === 1) { requested.resolve(); await release.promise; }
      }
      return response;
    } });
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      const pending = readPromptLibraryCatalogProjectionInContext(account);
      try {
        await requested.promise;
        const changedRow = await catalog.handle('/v1/account/entity-rows/prompt-library/folders', {
          method: 'POST', body: JSON.stringify(PromptLibraryRowMutationV1Schema.parse({ expectedRevision: 1,
            content: sealPromptLibraryContentV1({ mode: 'plain', material: null,
              record: { key: 'folders', value: { v: 1, folders: [{ id: 'current', name: 'Current folder' }] } } }) })),
        });
        expect(await changedRow?.json()).toMatchObject({ status: 'updated', revision: 2 });
        publishHomeAccountChange(f.home.id, [buildPromptLibraryPhysicalKeyV1('folders')]);
        const changed = await readPromptLibraryCatalogProjectionInContext(account);
        expect(changed.catalog).toMatchObject({ status: 'ready', rows: expect.arrayContaining([
          expect.objectContaining({ revision: 2, record: { key: 'folders', value: {
            v: 1, folders: [{ id: 'current', name: 'Current folder' }],
          } } }),
        ]) });
        expect(reads).toBe(2);
      } finally { release.resolve(); }
      expect((await pending).catalog).toMatchObject({ status: 'ready', rows: expect.arrayContaining([
        expect.objectContaining({ revision: 1, record: { key: 'folders', value: { v: 1, folders: [] } } }),
      ]) });
      expect((await readPromptLibraryCatalogProjectionInContext(account)).catalog.status).toBe('ready');
      expect(reads).toBe(3);
    }, { serverId: f.home.id });
  });
  it('returns typed unavailability after a captured finite reader retires', async () => {
    const { readPromptLibraryCatalogProjectionInContext } = await import('@/sync/api/account/apiPromptLibraryCatalog');
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      await f.dispose();
      fixture = undefined;
      expect((await readPromptLibraryCatalogProjectionInContext(account)).catalog)
        .toMatchObject({ status: 'unavailable', reason: 'scope-retired' });
    }, { serverId: f.home.id });
  });
  it('releases a captured invocation cancellation while the foreground catalog remains pending', async () => {
    const { observePromptLibraryCatalog, readPromptLibraryCatalogInCapturedAccount, resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    const catalog = createPromptLibraryCatalogBoundary();
    const requested = createDeferred<void>();
    const release = createDeferred<void>();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
      if (path === '/v1/account/entity-rows/prompt-library') { requested.resolve(); await release.promise; }
      return catalog.handle(path, init);
    } });
    const controller = new AbortController();
    const account = await captureLazyActionAccountContext(f.home.id, controller.signal);
    const stop = observePromptLibraryCatalog({ serverId: account.serverId, accountId: account.accountId });
    let pending: ReturnType<typeof readPromptLibraryCatalogInCapturedAccount> | undefined;
    try {
      await requested.promise;
      pending = readPromptLibraryCatalogInCapturedAccount(account);
      let refused = false;
      void pending.catch(() => { refused = true; });
      controller.abort();
      await vi.waitFor(() => expect(refused).toBe(true));
      expect(f.requests.filter(request => request.path === '/v1/account/entity-rows/prompt-library')).toHaveLength(1);
    } finally {
      release.resolve();
      await pending?.catch(() => {});
      stop(); account.dispose(); resetPromptLibraryCatalogEngineForTests();
    }
  });
  it('prepares addressed skill reach from independent current catalog and content reads before writing', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const catalogRequested = createDeferred<void>();
    const releaseCatalog = createDeferred<void>();
    let holdCatalog = true;
    let contentRequested = false;
    let wroteRules = false;
    const f = await home('prompt_bundle.v2', JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
      entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: current\ndescription: Current skill\n---\n# Current'), 'base64') }] }), {
      handleRequest: async (path, init) => {
        if (path === '/v1/artifacts/current' || path === '/v1/artifacts/read') contentRequested = true;
        if (path === '/v1/account/entity-rows/prompt-library' && holdCatalog) {
          catalogRequested.resolve();
          await releaseCatalog.promise;
        }
        if (path === '/v1/account/entity-rows/prompt-library/skill-rules' && init?.method === 'POST') wroteRules = true;
        return catalog.handle(path, init);
      },
    });
    const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      const pending = executeDefaultActionInCapturedAccount(account, 'skills.rules.set', {
        items: [{ skillId: 'current' }], change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
      }, { surface: 'ui', authority: 'present_user', serverId: f.home.id, expectedAccountId: account.accountId });
      try {
        await catalogRequested.promise;
        await vi.waitFor(() => expect(contentRequested).toBe(true));
        expect(wroteRules).toBe(false);
      } finally {
        holdCatalog = false;
        releaseCatalog.resolve();
        await pending;
      }
      expect(await pending).toMatchObject({ ok: true, result: { ok: true, items: [
        expect.objectContaining({ skillId: 'current', rules: [expect.objectContaining({ enabled: true })] }),
      ] } });
      expect(wroteRules).toBe(true);
    }, { serverId: f.home.id });
  });
  it.each([true, false])('reads Skills through captured filtered pages with truthful unclassified refusal (%s)', async hasUnclassified => {
    const catalog = createPromptLibraryCatalogBoundary();
    const inventoryQueries: string[] = [];
    const contentRequests: string[] = [];
    const f = await home('prompt_bundle.v2', JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
      entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: current\ndescription: Current skill\n---\n# Current'), 'base64') }] }), {
      handleRequest: async (path, init) => {
        if (path === '/v1/artifacts/current' || path === '/v1/artifacts/read') contentRequests.push(path);
        if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
          inventoryQueries.push(path);
          const rows = f.boundary.list();
          const headers = rows.map(({ body: _body, ...row }) => row);
          return Response.json(new URL(path, 'https://home.test').searchParams.has('kind')
            ? { items: headers, hasUnclassified } : headers);
        }
        return catalog.handle(path, init);
      },
    });
    const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
    const requestsBefore = f.requests.length;
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      const result = await executeDefaultActionInCapturedAccount(account, 'skills.list', {},
        { surface: 'ui', authority: 'present_user', serverId: f.home.id, expectedAccountId: account.accountId });
      if (hasUnclassified) expect(result).toEqual({ ok: false, errorCode: 'library_unavailable', error: 'library_unavailable' });
      else expect(result).toMatchObject({ ok: true, result: { items: expect.arrayContaining([expect.objectContaining({ skillId: 'current' })]) } });
    }, { serverId: f.home.id });
    expect(inventoryQueries).toEqual(['/v1/artifacts?limit=500&kind=skill']);
    expect(contentRequests).toEqual(hasUnclassified ? [] : ['/v1/artifacts/read']);
    if (hasUnclassified) expect(f.requests.slice(requestsBefore).filter(request => request.path.startsWith('/v1/artifacts'))
      .map(({ method, path }) => ({ method, path })))
      .toEqual([{ method: 'GET', path: '/v1/artifacts?limit=500&kind=skill' }]);
  });
  it.each(['complete', 'incomplete', 'unreadable', 'failed', 'different-account', 'different-credentials', 'cancelled'] as const)(
    'joins only an eligible cold inventory attempt through the unfiltered store (%s)', async scenario => {
      const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
      const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
      resetPromptLibraryCatalogEngineForTests();
      resetPromptLibraryCatalogSnapshotsForTests();
      const catalog = createPromptLibraryCatalogBoundary();
      const inventoryRequested = createDeferred<void>();
      const releaseInventory = createDeferred<void>();
      let inventoryGets = 0;
      const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
        if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET'
          && !new URL(path, 'https://home.test').searchParams.has('kind')) {
          inventoryGets += 1;
          if (inventoryGets === 1) {
            inventoryRequested.resolve();
            await releaseInventory.promise;
            if (scenario === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
            if (scenario === 'unreadable') return Response.json(f.boundary.list().map(row => ({ ...row, header: 'invalid header' })));
          }
        }
        return catalog.handle(path, init);
      } });
      storage.setState({ artifacts: {}, artifactsLoaded: false });
      const controller = new AbortController();
      await withUiPromptLibraryArtifactStore(async (store, account) => {
        const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
        const basis = storage.getState().artifacts;
        const params = { credentials: scenario === 'different-credentials' ? { token: 'restricted-credential' } : account.credentials,
          inventoryScope: scenario === 'different-account' ? { ...account.accountLifetime.scope, accountId: 'another-account' } : account.accountLifetime.scope,
          encryption: null, artifactDataKeys: new Map(), request: account.request,
          shouldContinue: () => scenario !== 'incomplete' || inventoryGets === 0,
          applyArtifacts: (rows: DecryptedArtifact[], source?: ArtifactInventoryPublication) =>
            storage.getState().applyArtifacts(rows, source !== undefined ? basis : undefined, undefined, source) };
        const inventory = fetchAndApplyArtifactsList(params).catch(error => error);
        await inventoryRequested.promise;
        const action = store.list!({ signal: controller.signal });
        try {
          if (scenario === 'different-account' || scenario === 'different-credentials') {
            // The unrelated attempt stays held while the captured list finishes.
            expect(await action).toMatchObject({ coverage: 'complete' });
            expect(inventoryGets).toBe(2);
          } else if (scenario === 'cancelled') {
            controller.abort();
            const outcome = await action.catch((error: unknown) => error);
            expect(outcome).not.toMatchObject({ coverage: 'complete' });
            expect(inventoryGets).toBe(1);
            expect(storage.getState().artifactsLoaded).toBe(false);
          } else {
            releaseInventory.resolve();
            await inventory;
            expect(await action).toMatchObject({ coverage: 'complete' });
            expect(inventoryGets).toBe(scenario === 'complete' ? 1 : 2);
          }
        } finally {
          releaseInventory.resolve();
          await inventory;
          await action.catch(() => undefined);
        }
        if (scenario === 'cancelled') expect(storage.getState().artifactsLoaded).toBe(true);
      }, { serverId: f.home.id });
    });
  it('keeps decision source admission metadata through the captured store on create and update', async () => {
    const { CoordinationMessageRefV1Schema } = await import('@happier-dev/protocol/discussions/messageRefs');
    const memoryDecisionSource = CoordinationMessageRefV1Schema.parse({ kind: 'discussion',
      discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'committed' });
    const writes: unknown[] = [];
    const f: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> = fixture = await createPlainArtifactHomeFixture('https://memory-decision.test', {
      handleRequest: async (path, init) => {
        if (path.startsWith('/v1/artifacts') && init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
        // Persistence boundary for the dedicated source-admitted operations;
        // the server suite exercises the real source/disclosure predicate.
        if (path === '/v1/artifacts/memory-decision/create') return f.boundary.handle('/v1/artifacts', init);
        if (/^\/v1\/artifacts\/[^/]+\/memory-decision$/.test(path)) return f.boundary.handle(path.slice(0, -'/memory-decision'.length), init);
        return null;
      },
    });
    await withUiPromptLibraryArtifactStore(async store => {
      const header = { v: 1, kind: 'memory_doc.v1', title: 'Memory' };
      const created = await store.create!({ header, body: 'saved decision', memoryDecisionSource });
      if (typeof created === 'string') throw new Error('Expected acknowledged creation revision');
      await store.update({ artifactId: created.artifactId, expectedRevision: created.revision,
        header, body: 'corrected decision', memoryDecisionSource });
      expect((await store.read(created.artifactId))?.body).toBe('corrected decision');
    }, { serverId: f.home.id });
    expect(writes).toMatchObject([{ memoryDecisionSource }, { memoryDecisionSource }]);
  });
  it('lists synced headers without HTTP or repeated opening, with live membership and Account fencing', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
    const codec = await import('@/sync/engine/artifacts/syncArtifacts');
    const opening = vi.spyOn(codec, 'decryptArtifactListItems');
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      storage.setState({ artifactsLoaded: false });
      await store.list!({ limit: 500 });
      expect(opening).toHaveBeenCalled();
      const readStartedWith = storage.getState().artifacts;
      await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
        request: account.request,
        applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? readStartedWith : undefined) });
      const requestsBefore = f.requests.length;
      opening.mockClear();
      const read = () => listPromptLibrary({ store, request: {} });
      expect(await read()).toMatchObject({ coverage: 'complete', items: [{ artifactId: 'current', title: 'Current' }] });
      const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
      const action = await executeDefaultActionInCapturedAccount(account, 'prompts.library.list', {},
        { surface: 'ui', authority: 'present_user', serverId: f.home.id, expectedAccountId: account.accountId });
      expect(action).toMatchObject({ ok: true, result: { coverage: 'complete', items: [{ artifactId: 'current' }] } });
      expect(f.requests.slice(requestsBefore).filter(request => request.method === 'GET' && request.path.startsWith('/v1/artifacts'))).toEqual([]);
      const current = storage.getState().artifacts.current!;
      if (!current.isDecrypted) throw new Error('Expected readable header');
      storage.getState().updateArtifact({ ...current, headerVersion: 2,
        rawHeader: { ...current.rawHeader, title: 'Updated' } });
      storage.getState().addArtifact({ ...current, id: 'new', rawHeader: { ...current.rawHeader, title: 'New' } });
      expect((await read()).items.map(item => item.title).sort()).toEqual(['New', 'Updated']);
      storage.getState().deleteArtifact('current');
      expect((await read()).items.map(item => item.artifactId)).toEqual(['new']);
      expect(f.requests.slice(requestsBefore).filter(request => request.method === 'GET' && request.path.startsWith('/v1/artifacts'))).toEqual([]);
      expect(opening).not.toHaveBeenCalled();
      // Real credential retirement, not display focus, withdraws captured read authority.
      await TokenStorage.removeCredentialsForServerUrl(f.home.serverUrl, { serverId: f.home.id });
      const requestsAtRetirement = f.requests.length;
      await expect(read()).rejects.toMatchObject({ code: 'action_account_scope_changed' });
      expect(f.requests).toHaveLength(requestsAtRetirement);
    }, { serverId: f.home.id });
  });
  it('reuses complete granted header pages and re-observes unreadable coverage over HTTP', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    storage.setState({ artifactsLoaded: false });
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      expect((await listPromptLibrary({ store, request: {} })).items.map(item => item.artifactId)).toEqual(['current']);
      expect(f.requests.some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true);
      const current = await account.fetchArtifact('current');
      if (!current?.isDecrypted) throw new Error('Expected readable prompt');
      const heads = Array.from({ length: 502 }, (_, index) => ({ ...current, id: `prompt-${index}`,
        updatedAt: index === 500 ? 501 : index, access: index === 0 ? 'view' as const : 'owner' as const,
        rawHeader: { ...current.rawHeader, title: `Prompt ${index}` } }));
      const locked: DecryptedArtifact = { id: 'locked', createdAt: 0, updatedAt: 0, headerVersion: 1, seq: 0,
        title: null, storageMode: 'e2ee', isDecrypted: false, availability: { kind: 'locked', reason: 'decryption_failed' } };
      storage.getState().applyArtifacts(heads, storage.getState().artifacts);
      const requestsBefore = f.requests.length;
      const firstPage = await store.list!({ limit: 500, kinds: ['prompt_doc.v2'] });
      expect(firstPage.items).toHaveLength(500);
      expect(firstPage.items.slice(0, 2).map(item => item.id)).toEqual(['prompt-501', 'prompt-500']);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = await store.list!({ limit: 500, kinds: ['prompt_doc.v2'], cursor: firstPage.nextCursor });
      expect(secondPage.items).toHaveLength(2);
      expect(secondPage.nextCursor).toBeUndefined();
      expect(secondPage.items.every(item => !firstPage.items.some(first => first.id === item.id))).toBe(true);
      await expect(store.list!({ limit: 500, kinds: ['prompt_doc.v2'], cursor: 'unknown-cursor' }))
        .rejects.toMatchObject({ code: 'invalid_cursor' });
      const result = await listPromptLibrary({ store, request: {} });
      expect(result.coverage).toBe('complete');
      expect(result.items).toHaveLength(502);
      expect(new Set(result.items.map(item => item.artifactId)).size).toBe(502);
      expect(result.items.at(-1)?.artifactId).toBe('prompt-0');
      expect(f.requests.slice(requestsBefore).filter(request => request.path.startsWith('/v1/artifacts'))).toEqual([]);
      storage.getState().addArtifact(locked);
      const recovered = await listPromptLibrary({ store, request: {} });
      expect(recovered).toMatchObject({ coverage: 'complete', items: [{ artifactId: 'current' }] });
      expect(recovered.items).toHaveLength(1);
      expect(f.requests.slice(requestsBefore).some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true);
      // A background Home's complete store cannot stand in for this captured Account.
      storage.setState({ settingsScope: { serverId: 'another-home', accountId: account.accountId } });
      expect((await listPromptLibrary({ store, request: {} })).items.map(item => item.artifactId)).toEqual(['current']);
      expect(f.requests.slice(requestsBefore).some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true);
    }, { serverId: f.home.id });
  });
  it('reads the replacement Account inventory after reset instead of the previous Account projection', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const first = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      const basis = storage.getState().artifacts;
      await fetchAndApplyArtifactsList({ credentials: account.credentials, request: account.request,
        encryption: null, artifactDataKeys: new Map(),
        applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? basis : undefined) });
    }, { serverId: first.home.id });
    expect(storage.getState().artifacts.current).toBeDefined();
    await first.dispose();
    fixture = undefined;
    const nextCatalog = createPromptLibraryCatalogBoundary();
    const next = fixture = await createPlainArtifactHomeFixture(first.home.serverUrl,
      { accountId: 'replacement-account', handleRequest: nextCatalog.handle });
    storage.setState({ artifacts: {}, artifactsLoaded: false });
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      expect(account.accountId).toBe('replacement-account');
      const created = await createPromptDocInLibrary({ store, request: { title: 'Next Account prompt', markdown: 'New content' } });
      const result = await listPromptLibrary({ store, request: {} });
      expect(result).toMatchObject({ coverage: 'complete', items: [{ artifactId: created.artifactId, title: 'Next Account prompt' }] });
      expect(result.items).toHaveLength(1);
    }, { serverId: next.home.id });
  });
  it('returns the real bundle creation revision even when a subsequent content read is unavailable', async () => {
    const f = fixture = await createPlainArtifactHomeFixture('https://creation-receipt.test', {
      handleRequest: async (path, init) => path.startsWith('/v1/artifacts/') && (!init?.method || init.method === 'GET')
        ? Response.json({ error: 'unavailable' }, { status: 503 }) : null,
    });
    const result = await withUiPromptLibraryArtifactStore(store => createPromptBundleInLibrary({ store,
      request: { title: 'Sample', bundleSchemaId: 'skills.skill_md_v1', entries: [{ path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: sample\n---\nInstructions').toString('base64'), contentKind: 'utf8' }] },
    }), { serverId: f.home.id });
    const row = f.boundary.read(result.artifactId)!;
    expect(result).toMatchObject({ revision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } });
    expect(storage.getState().artifacts[result.artifactId]).toMatchObject({ id: result.artifactId });
  });
  it('keeps native-signal finite reads observational while explicit Artifact refresh publishes the captured row', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    storage.setState({ artifacts: {}, artifactsLoaded: false });
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      const controller = new NativeAbortController();
      // React Native installs this genuine platform signal without modern convenience methods.
      const signal = controller.signal as unknown as AbortSignal;
      expect(signal.throwIfAborted).toBeUndefined();
      const read = await readPromptDocInLibrary({ store, artifactId: 'current', signal });
      expect(read).toMatchObject({ ok: true, artifactId: 'current', title: 'Current', markdown: 'original' });
      expect(await listPromptLibrary({ store, request: {}, signal })).toMatchObject({
        coverage: 'complete', items: [{ artifactId: 'current', title: 'Current' }],
      });
      expect(storage.getState().artifacts.current).toBeUndefined();
      expect(storage.getState().artifactsLoaded).toBe(false);
      const requestsBeforeAbort = f.requests.length;
      controller.abort();
      await expect(readPromptDocInLibrary({ store, artifactId: 'current', signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.requests).toHaveLength(requestsBeforeAbort);
      await account.fetchArtifact('current');
      expect(storage.getState().artifacts.current).toMatchObject({ id: 'current' });
      expect(storage.getState().artifactsLoaded).toBe(false);
    }, { serverId: f.home.id });
  });
  it.each(['doc', 'bundle'] as const)('refuses a %s create after its captured active library Account retires', async libraryKind => {
    const originalUrl = 'https://captured-import-library.test';
    const nextUrl = 'https://next-import-library.test';
    const originalCatalog = createPromptLibraryCatalogBoundary();
    const nextCatalog = createPromptLibraryCatalogBoundary();
    const f = fixture = await createPlainArtifactHomeFixture(originalUrl, { handleRequest: originalCatalog.handle });
    const nextArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'artifact-account', encryptionMode: 'plain' });
    let retired = false;
    const requestsAfterRetirement: string[] = [];
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (retired) requestsAfterRetirement.push(url.href);
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
      await TokenStorage.removeCredentialsForServerUrl(originalUrl, { serverId: f.home.id });
      retired = true;
      return libraryKind === 'doc'
        ? await createPromptDocInLibrary({ store, request: { title: 'Review', markdown: '# Review' } })
        : await createPromptBundleInLibrary({ store, request: { title: 'Review', bundleSchemaId: 'skills.skill_md_v1',
          entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Review').toString('base64'), contentKind: 'utf8' }] } });
    }, { serverId: f.home.id });
    await expect(importing).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    expect(requestsAfterRetirement).toEqual([]);
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
  it('establishes exact absence beside unreadable inventory and distinguishes an unreadable requested header', async () => {
    const f = await home();
    const row = f.boundary.read('current')!;
    // An unrelated unreadable census row cannot turn an authoritative exact
    // miss into uncertainty. The requested unreadable row remains unavailable.
    setRuntimeFetch(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), { status: 200 });
      if (path === '/v1/artifacts') return createArtifactListHttpResponse(new URL(String(input)), [{ ...row, header: 'invalid stored header' }]);
      return (await f.boundary.handle(path, init)) ?? new Response('{}', { status: 404 });
    });
    await expect(withUiPromptLibraryArtifactReader(reader => reader.readArtifactHeader({ kind: 'doc', artifactId: 'missing' }),
      { serverId: f.home.id })).resolves.toBeNull();
    f.boundary.replaceStoredRow({ ...row, header: 'invalid stored header' });
    await expect(withUiPromptLibraryArtifactReader(reader => reader.readArtifactHeader({ kind: 'doc', artifactId: 'current' }),
      { serverId: f.home.id })).rejects.toMatchObject({ code: 'content_unavailable' });
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
