import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { z } from 'zod';

import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent,
  encodeBase64, decodeBase64, signAccountContentKeyBindingV1, computeContentPublicKeyFingerprint,
  sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1, createWorkflowDefinitionActions,
  workflowDefinitionArtifactSharingAdapterV1, readLaunchProfileArtifactV1,
  launchProfileArtifactSharingAdapterV1, prepareArtifactWorkspaceFileV1 } from '@happier-dev/protocol';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBlobWriteV1Schema, type ArtifactBlobReadResponseV1 } from '@happier-dev/protocol';
import { decryptWithDataKeyResult, decryptWithDataKey, encryptWithDataKey } from '@/api/encryption';
import { createCliArtifactActions } from '@/session/actions/artifactActions';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { createAccountArtifactStore, createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore, encodeAccountArtifactListCursor } from './accountArtifactStore';
import { readCarrierMutation } from './accountArtifactStore.testkit';
import { buildHomeHubArtifactIdV1, createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { createWidgetDefinitionArtifactPortV1, createWidgetSurfaceArtifactPortV1, type WidgetDefinitionDraftV1 } from '@happier-dev/protocol/widgets';
import { createActionExecutor } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createWorkBoardV1, buildWorkBoardArtifactHeaderV1 } from '@happier-dev/protocol';

const { mockDelete, mockGet, mockPost } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({ default: { delete: mockDelete, get: mockGet, post: mockPost } }));
vi.mock('@/configuration', () => ({ configuration: { apiServerUrl: 'http://127.0.0.1:24599' } }));

describe('createAccountArtifactStore', () => {
  beforeEach(() => {
    mockDelete.mockReset();
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it.each([401, 403, 503])('keeps HTTP %i distinct from definitive Artifact absence', async (status) => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    mockGet.mockResolvedValue({ status, data: { error: 'unavailable' } });
    await expect(store.read('required-doc')).rejects.toMatchObject({ code: 'artifact_read_unavailable' });
    mockGet.mockResolvedValue({ status: 404, data: { error: 'not_found' } });
    expect(await store.read('required-doc')).toBeNull();
  });

  it('projects current widget sharing and header-only revision from the actual Artifact access boundary', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    let access: 'owner' | 'view' | 'edit' = 'owner';
    let grants: unknown[] = [];
    const id = '11111111-1111-4111-8111-111111111111';
    const row = () => ({ id, ownerAccountId: 'owner', access, publicAudience: 'none', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ kind: 'widget-area-layout.v1', v: 1, title: 'Dashboard' }),
      body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 2, bodyVersion: 3, seq: 3, createdAt: 1, updatedAt: 3 });
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname === '/v1/artifacts' ? [row()]
      : url.endsWith('/access/grants') ? { artifactId: id, ownerAccountId: 'owner', access, grants } : row() }));
    const transport = createAcknowledgedAccountArtifactTransport(store);
    expect(await transport.read(id)).toMatchObject({ ownerAccountId: 'owner', access: 'owner', shared: false });
    grants = [{ principal: { kind: 'account', accountId: 'viewer' }, accessLevel: 'view', createdByAccountId: 'owner', createdAt: 1, display: { name: 'Viewer' } }];
    expect(await transport.read(id)).toMatchObject({ access: 'owner', shared: true });
    access = 'view';
    expect(await transport.read(id)).toMatchObject({ access: 'view', shared: true });
    expect(await store.list({ includeBody: false })).toMatchObject({ items: [{ artifactId: id, headerVersion: 2, bodyVersion: 3 }] });
    const ordinaryActions = createCliArtifactActions({ store, resolvePublishCaller: async () => null });
    const ordinaryPage = ArtifactActionOutputSchemasV1['artifact.list'].parse(await ordinaryActions({ actionId: 'artifact.list', input: {}, context: { surface: 'cli' } }));
    expect(ordinaryPage.items[0]).toMatchObject({ artifactId: id, headerVersion: 2, access: 'view', publicAudience: 'none' });
    expect(ordinaryPage.items[0]).not.toHaveProperty('bodyVersion');
    expect(await store.list({ includeBody: false })).toMatchObject({ items: [{ artifactId: id, bodyVersion: 3 }] });
  });

  it.each(['owner', 'edit'] as const)('refuses generic shared WorkBoard private pins for an admitted %s and permits safe edits', async access => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'board' } } as const;
    const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'private-definition' }, bindings: {} } as const;
    const board = { ...createWorkBoardV1({ id: 'board', name: 'Board' }), widgets: [{ kind: 'widget' as const,
      ref: { surface, instanceId: instance.id }, instance, size: 'medium' as const }] };
    const header = buildWorkBoardArtifactHeaderV1(board);
    let row = { id: board.id, ownerAccountId: 'owner', access, encryptionMode: 'plain', header: encodePlainArtifactStoredContent(header),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const before = { ...row };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/access/grants')
      ? { artifactId: board.id, ownerAccountId: 'owner', access, grants: [{ principal: { kind: 'account', accountId: 'viewer' },
        accessLevel: 'view', createdByAccountId: 'owner', createdAt: 1, display: { name: 'Viewer' } }] } : row }));
    mockPost.mockImplementation(async (_url: string, wire: unknown) => {
      const input = readCarrierMutation(wire);
      row = { ...row, header: String(input.header), body: String(input.body), headerVersion: 2, bodyVersion: 2 };
      return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const pinned = { ...board, widgets: [{ ...board.widgets[0], instance: { ...instance, bindings: { cloud: { kind: 'value', value: {
      nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' }],
    } } } } }] };
    for (const candidateHeader of [header, { kind: 'ordinary' }]) {
      await expect(store.update({ artifactId: board.id, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
        header: candidateHeader, body: JSON.stringify(pinned) })).rejects.toMatchObject({ code: 'artifact_shared_content_forbidden' });
      expect(row).toEqual(before);
    }
    const safe = { ...board, name: 'Safe rename' };
    expect(await store.update({ artifactId: board.id, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: buildWorkBoardArtifactHeaderV1(safe), body: JSON.stringify(safe) })).toMatchObject({ ok: true, revision: { bodyVersion: 2 } });
    expect(decodePlainArtifactStoredContent(row.body)).toEqual({ body: JSON.stringify(safe) });
  });

  it('keeps public-link-only WorkBoard writes and restores private-pin safe until expiry or revocation', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'board' } } as const;
    const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'private-definition' }, bindings: {} } as const;
    const board = { ...createWorkBoardV1({ id: 'board', name: 'Board' }), widgets: [{ kind: 'widget' as const,
      ref: { surface, instanceId: instance.id }, instance, size: 'medium' as const }] };
    const header = buildWorkBoardArtifactHeaderV1(board);
    const pinned = { ...board, widgets: [{ ...board.widgets[0], instance: { ...instance, bindings: { cloud: { kind: 'value', value: {
      nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' }],
    } } } } }] };
    let publication: { expiresAt: number | null } | null = { expiresAt: null };
    let audienceUnavailable = false;
    let row = { id: board.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', header: encodePlainArtifactStoredContent(header),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2 };
    mockGet.mockImplementation(async (url: string) => new URL(url).pathname === '/v1/public-shares'
      ? { status: 404, data: { error: 'not_found' } } : ({ status: 200, data: url.endsWith('/access/grants') ? { artifactId: board.id, ownerAccountId: 'owner', access: 'owner', grants: [] }
      : url.endsWith('/revisions') ? { revisions: [{ bodyVersion: 1, body: encodePlainArtifactStoredContent({ body: JSON.stringify(pinned) }),
        createdAt: 1, sizeBytes: 1 }], retentionCount: 3 } : { ...row, publicAudience: audienceUnavailable ? undefined
          : publication && publication.expiresAt === null ? 'retained' : 'none' } }));
    mockPost.mockImplementation(async (_url: string, wire: unknown) => {
      const input = readCarrierMutation(wire);
      row = { ...row, header: String(input.header), body: typeof input.body === 'string' ? input.body : row.body,
        headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
    });
    const before = { ...row };
    await expect(store.update({ artifactId: board.id, expectedRevision: { headerVersion: 2, bodyVersion: 2 }, header,
      body: JSON.stringify(pinned) })).rejects.toMatchObject({ code: 'artifact_shared_content_forbidden' });
    await expect(store.revisions.restore({ artifactId: board.id, expectedRevision: { headerVersion: 2, bodyVersion: 2 }, bodyVersion: 1 }))
      .rejects.toMatchObject({ code: 'artifact_shared_content_forbidden' });
    expect(row).toEqual(before);
    expect(await store.read(board.id)).toMatchObject({ shared: true, publicAudience: 'retained' });
    const actions = createCliArtifactActions({ store, resolvePublishCaller: async () => null });
    expect(ArtifactActionOutputSchemasV1['artifact.get'].parse(await actions({ actionId: 'artifact.get', input: { artifactId: board.id }, context: { surface: 'cli' } })))
      .toMatchObject({ artifact: { publicAudience: 'retained' } });
    audienceUnavailable = true;
    await expect(store.update({ artifactId: board.id, expectedRevision: { headerVersion: 2, bodyVersion: 2 }, header,
      body: JSON.stringify(pinned) })).rejects.toMatchObject({ code: 'content_unavailable' });
    await expect(store.revisions.restore({ artifactId: board.id, expectedRevision: { headerVersion: 2, bodyVersion: 2 }, bodyVersion: 1 }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
    await expect(store.read(board.id)).rejects.toMatchObject({ code: 'content_unavailable' });
    const ordinary = await actions({ actionId: 'artifact.get', input: { artifactId: board.id }, context: { surface: 'cli' } });
    expect(ordinary).toMatchObject({ artifact: { body: JSON.stringify(board), access: 'owner', publicAudience: 'unknown' } });
    expect(ordinary).not.toHaveProperty('artifact.shared');
    expect(await store.update({ artifactId: board.id, expectedRevision: { headerVersion: 2, bodyVersion: 2 }, header,
      body: JSON.stringify(board) })).toMatchObject({ ok: true });
    audienceUnavailable = false;
    publication = { expiresAt: 0 };
    expect(await store.read(board.id)).toMatchObject({ shared: false });
    publication = null;
    expect(await store.read(board.id)).toMatchObject({ shared: false });
    expect(await store.update({ artifactId: board.id, expectedRevision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion },
      header, body: JSON.stringify(pinned) })).toMatchObject({ ok: true });
    expect(await store.revisions.restore({ artifactId: board.id, expectedRevision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion }, bodyVersion: 1 }))
      .toMatchObject({ ok: true });
    expect(mockGet.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/public-shares')).toBe(false);
  });

  it('lets the operation lifecycle govern slow Artifact HTTP responses and cancellation', async () => {
    // Keep Axios real: the loopback HTTP peer is the only substituted boundary,
    // so a phase-local Axios timeout rejects valid work in this regression.
    const { default: http } = await vi.importActual<typeof import('axios')>('axios');
    mockGet.mockImplementation(http.get);
    mockPost.mockImplementation(http.post);
    mockDelete.mockImplementation(http.delete);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const lifecycle = new AbortController();
    const cancelled = new AbortController();
    const row = { id: 'read', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ title: 'Slow document' }),
      body: encodePlainArtifactStoredContent({ body: 'valid content' }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1 };
    const usage = { usedBytes: 80, limitBytes: null, documentLimitBytes: null, revisionRetentionCount: 10 };
    const server = createServer((request, response) => {
      request.resume();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/v1/artifacts/cancel') { cancelled.abort(); return; }
      if (path === '/v1/artifacts/network-failure') { request.socket.destroy(); return; }
      const data = request.method === 'DELETE' ? {}
        : request.method === 'POST' ? { id: 'create', success: true, headerVersion: 2, bodyVersion: 2 }
        : path === '/v1/artifacts/storage/usage' ? usage
        : path === '/v1/artifacts' ? [row] : row;
      const respond = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
      // The update's prerequisite read is fast; its write exercises the slow path.
      if (request.method === 'GET' && path === '/v1/artifacts/update') { respond(); return; }
      const timer = setTimeout(respond, 15_100);
      response.once('close', () => clearTimeout(timer));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing_loopback_address');
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const results = await Promise.allSettled([
          store.read('read', { signal: lifecycle.signal }),
          store.list({ signal: lifecycle.signal }),
          store.storageUsage(lifecycle.signal),
          store.create({ artifactId: 'create', header: {}, body: 'valid content', signal: lifecycle.signal }),
          store.update({ artifactId: 'update', header: {}, body: 'changed',
            expectedRevision: { headerVersion: 1, bodyVersion: 1 }, signal: lifecycle.signal }),
          store.delete('delete', { signal: lifecycle.signal }),
        ]);
        expect(results).toMatchObject([
          { status: 'fulfilled', value: { artifactId: 'read', body: 'valid content' } },
          { status: 'fulfilled', value: { coverage: 'complete', items: [{ artifactId: 'read' }] } },
          { status: 'fulfilled', value: usage },
          { status: 'fulfilled', value: { artifactId: 'create', revision: { headerVersion: 2, bodyVersion: 2 } } },
          { status: 'fulfilled', value: { ok: true, revision: { headerVersion: 2, bodyVersion: 2 } } },
          { status: 'fulfilled', value: { ok: true } },
        ]);
        await expect(store.delete('cancel', { signal: cancelled.signal })).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        await expect(store.read('network-failure', { signal: lifecycle.signal })).rejects.toMatchObject({ code: 'ECONNRESET' });
        expect(lifecycle.signal.aborted).toBe(false);
      });
    } finally {
      lifecycle.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(['plain', 'e2ee'] as const)('runs widget definition Actions through the real %s Account Artifact transport and refuses mode mismatch before writing', async mode => {
    const secret = randomBytes(32);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    const rows = new Map<string, Record<string, unknown>>();
    mockPost.mockImplementation(async (url: string, wire: unknown) => {
      const input = readCarrierMutation(wire);
      const artifactId = typeof input.id === 'string' ? input.id : new URL(url).pathname.split('/')[3]!;
      const before = rows.get(artifactId);
      const version = Number(before?.bodyVersion ?? 0) + 1;
      const row = { ...before, ...input, id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      rows.set(artifactId, row);
      return { status: 200, data: { ...row, success: true } };
    });
    mockGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/artifacts') return { status: 200, data: [...rows.values()] };
      const artifactId = path.split('/')[3]!;
      const row = rows.get(artifactId);
      if (!row) return { status: 404, data: { error: 'not_found' } };
      if (path.endsWith('/access/grants')) return { status: 200, data: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] } };
      return { status: 200, data: path.endsWith('/recipients') ? {
        artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [],
      } : { ...row, publicAudience: 'none' } };
    });
    const port = createWidgetDefinitionArtifactPortV1(store, { accountId: 'owner' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'owner' }), widgetDefinitionArtifacts: port });
    const account = { serverId: 'home', accountId: 'owner' };
    const definition = { name: 'Private count', body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Private data' } } },
      sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } } satisfies WidgetDefinitionDraftV1;
    const id = '11111111-1111-4111-8111-111111111111';
    const created = await executor.execute('widgets.definition.create', { account, artifactId: id, definition }, { surface: 'ui', serverId: 'home' });
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(created).toMatchObject({ ok: true, result: { definition: { id, name: 'Private count' } } });
    // Transport contract runs the host's approved replay; policy itself is covered at its owner.
    const updated = await executor.execute('widgets.definition.update', { account, artifactId: id, patch: { name: 'Current count' } }, { surface: 'ui', serverId: 'home', bypassApprovals: true });
    if (!updated.ok) throw new Error(JSON.stringify(updated));
    expect(updated)
      .toMatchObject({ ok: true, result: { definition: { name: 'Current count' } } });
    expect((await port.get(id))?.name).toBe('Current count');
    if (mode === 'e2ee') expect(JSON.stringify(mockPost.mock.calls)).not.toContain('Private data');
    else expect(rows.get(id)?.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
    const before = mockPost.mock.calls.length;
    // The authenticated owner Account-mode projection, not key presence, must match its stored envelope.
    const originalDefinitionRow = rows.get(id)!;
    rows.set(id, { ...originalDefinitionRow, encryptionMode: mode === 'plain' ? 'e2ee' : 'plain' });
    await expect(port.update(id, { name: 'Wrong mode' })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    expect(mockPost.mock.calls.length).toBe(before);
    rows.set(id, originalDefinitionRow);
    const surface = { ...account, owner: { kind: 'pluginArea' as const, pluginId: 'example', pageId: 'overview', area: 'pinned' } };
    const area = createWidgetSurfaceArtifactPortV1(createAcknowledgedAccountArtifactTransport(store), { surface, isCurrent: () => true });
    const instance = { v: 1 as const, id: 'private-copy', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
    await area.apply({ kind: 'add', instance });
    await area.apply({ kind: 'size', instanceId: instance.id, size: 'full' });
    expect((await createWidgetSurfaceArtifactPortV1(createAcknowledgedAccountArtifactTransport(store), { surface, isCurrent: () => true }).read()).instances)
      .toEqual([{ instance, size: 'full' }]);
    if (mode === 'e2ee') expect(JSON.stringify(mockPost.mock.calls)).not.toContain('private-copy');
    const calls = mockPost.mock.calls.length;
    const wrongModeStore = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => mode === 'plain' ? 'e2ee' : 'plain' });
    const wrongMode = createWidgetSurfaceArtifactPortV1(createAcknowledgedAccountArtifactTransport(wrongModeStore), { surface, isCurrent: () => true });
    await expect(wrongMode.apply({ kind: 'remove', instanceId: instance.id })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    await expect(wrongModeStore.list()).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    expect(mockPost.mock.calls.length).toBe(calls);
  });

  it.each(['plain', 'e2ee'] as const)('round-trips the Home layout and setup through the incumbent %s Account Artifact codec', async mode => {
    const secret = randomBytes(32);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    let stored: Record<string, unknown> | null = null;
    mockPost.mockImplementation(async (_url: string, wire: unknown) => {
      const input = readCarrierMutation(wire);
      const version = Number(stored?.bodyVersion ?? 0) + 1;
      stored = { ...stored, ...input, id: buildHomeHubArtifactIdV1('owner'), ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: { ...stored, success: true } };
    });
    mockGet.mockImplementation(async (url: string) => stored ? { status: 200, data: url.endsWith('/recipients') ? {
      artifactId: stored.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
      dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey, recipients: [],
    } : stored } : { status: 404, data: { error: 'not_found' } });
    const port = createHomeHubArtifactPortV1(createAcknowledgedAccountArtifactTransport(store), { accountId: 'owner' });
    const instance = { v: 1 as const, id: 'configured', definition: { kind: 'builtin' as const, id: 'count' }, bindings: {} };
    await port.apply({ kind: 'widget_add', instance });
    await port.apply({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true });
    const reloaded = createHomeHubArtifactPortV1(createAcknowledgedAccountArtifactTransport(store), { accountId: 'owner' });
    expect(await reloaded.read()).toMatchObject({ instances: [instance], hidden: expect.arrayContaining(['setup:addPhone']) });
    if (mode === 'e2ee') expect(JSON.stringify(mockPost.mock.calls)).not.toContain('setup:addPhone');
    else await expect(mockPost.mock.results.at(-1)?.value).resolves.toMatchObject({ data: { dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } });
  });

  it('retains truthful coverage through a logical header inventory when a transport row is unreadable', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    mockGet.mockResolvedValue({ status: 200, data: [{ id: 'doc',
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Prompt' }),
      headerVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 1,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
    }, { id: 'unreadable' }] });
    expect(await store.list({ sort: 'title_asc' })).toMatchObject({ coverage: 'partial', items: [{ artifactId: 'doc' }] });
  });

  it.each(['plain', 'e2ee'] as const)('opens opt-in batched list bodies with the existing %s Artifact codec', async (mode) => {
    const secret = randomBytes(32);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    const workflowBody = JSON.stringify({ kind: 'workflow-definition.v1', definition: {
      version: 1, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'review', document: { text: 'Authored workflow', references: [], attachments: [] },
        input: [], result: { kind: 'text' } }],
    } });
    let stored: Record<string, unknown> = {};
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => {
      stored = { ...input, id: 'workflow-list', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: stored };
    });
    await store.create({ artifactId: 'workflow-list', header: { kind: 'workflow-definition.v1', definitionId: 'workflow-list',
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Authored workflow' } }, body: workflowBody });
    mockGet.mockResolvedValue({ status: 200, data: [stored,
      { ...stored, id: 'missing-body', body: undefined, bodyVersion: undefined },
      { ...stored, id: 'bad-body', body: 'not encoded content' },
    ] });
    const result = await store.list({ ...{ includeBody: true }, limit: 4 });
    expect(result.items[0]).toMatchObject({ body: workflowBody, bodyVersion: 1 });
    expect(result.items.slice(1).map(row => ({ id: row.artifactId, kind: row.header.kind, body: row.body })))
      .toEqual([{ id: 'missing-body', kind: 'workflow-definition.v1', body: undefined },
        { id: 'bad-body', kind: 'workflow-definition.v1', body: undefined }]);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(new URL(mockGet.mock.calls[0]![0]).searchParams.get('includeBody')).toBe('true');
    if (mode === 'e2ee') {
      mockGet.mockResolvedValueOnce({ status: 200, data: [stored, { ...stored, id: 'bad-key', dataEncryptionKey: 'not-an-envelope' }] });
      expect(await store.list({ includeBody: true })).toMatchObject({ coverage: 'partial', items: [{ artifactId: 'workflow-list', body: workflowBody }] });
    }
  });

  it.each(['plain', 'e2ee'] as const)('returns private HTML create/update previews assembled locally in %s mode', async (mode) => {
    const secret = randomBytes(32);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    let stored: Record<string, unknown> = {};
    let version = 0;
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => {
      version += 1;
      stored = { ...stored, ...input, id: 'html-document', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: { ...stored, success: true } };
    });
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/html-preview')
      ? { url: 'https://artifact-isolated.example/a/html-document' } : stored }));
    const body = '<!doctype html><h1>Private HTML</h1><script>document.title="Ready"</script>';
    const created = await store.create({ artifactId: 'html-document', header: { kind: 'html' }, body });
    expect(created).toMatchObject({ artifactId: 'html-document', previewUrl: expect.stringMatching(/^https:\/\/artifact-isolated.example\/a\/html-document#d=.+$/) });
    const previewUrl = Reflect.get(created, 'previewUrl') as string;
    const bundle = JSON.parse(Buffer.from(new URL(previewUrl).hash.slice(3), 'base64url').toString('utf8'));
    expect(Buffer.from(bundle.files[bundle.entrypoint].contentBase64, 'base64').toString('utf8')).toBe(body);
    const updated = await store.update({ artifactId: 'html-document', expectedRevision: created.revision,
      header: { kind: 'html' }, body: '<h1>Changed</h1>' });
    expect(updated).toMatchObject({ ok: true, revision: { bodyVersion: 2 }, previewUrl: expect.any(String) });
    expect(mockPost.mock.calls).toHaveLength(2);
    expect(JSON.stringify(mockGet.mock.calls)).not.toContain('#d=');
    expect(JSON.stringify(mockPost.mock.calls)).not.toContain('#d=');
  });

  it('keeps a committed HTML mutation truthful when the isolated preview origin is unavailable', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => ({ status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } }));
    mockGet.mockResolvedValue({ status: 503, data: { error: 'artifact_html_preview_unavailable' } });
    await expect(store.create({ artifactId: 'html-document', header: { kind: 'html' }, body: '<p>Saved</p>' })).resolves.toEqual({
      artifactId: 'html-document', revision: { headerVersion: 1, bodyVersion: 1 }, previewError: 'artifact_html_preview_unavailable',
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('never substitutes an origin for another Artifact after a committed HTML update', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const stored = { id: 'html-document', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind: 'html' }),
      body: encodePlainArtifactStoredContent({ body: '<p>Before</p>' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/html-preview')
      ? { url: 'https://isolated.example/a/another-artifact' } : stored }));
    mockPost.mockResolvedValue({ status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } });
    await expect(store.update({ artifactId: 'html-document', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'html' }, body: '<p>After</p>' })).resolves.toEqual({ ok: true,
      revision: { headerVersion: 2, bodyVersion: 2 }, previewError: 'artifact_html_preview_unavailable' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('classifies a text body as one HTML document rather than a bundle from header metadata', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => ({ status: 200,
      data: { id: input.id, headerVersion: 1, bodyVersion: 1 } }));
    mockGet.mockResolvedValue({ status: 200, data: { url: 'https://isolated.example/a/html-document' } });
    const result = await store.create({ artifactId: 'html-document', header: { kind: 'html', mime: 'application/vnd.happier.html-bundle+json' }, body: '<p>Single HTML</p>' });
    expect(result).toMatchObject({ previewUrl: expect.any(String) });
    const bundle = JSON.parse(Buffer.from(new URL(Reflect.get(result, 'previewUrl') as string).hash.slice(3), 'base64url').toString('utf8'));
    expect(bundle.entrypoint).toBe('index.html');
    expect(Buffer.from(bundle.files['index.html'].contentBase64, 'base64').toString('utf8')).toBe('<p>Single HTML</p>');
    expect(mockPost.mock.calls[0]?.[1]).not.toHaveProperty('blob');
  });

  it('does not issue an HTML preview on the captured application origin', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => ({ status: 200,
      data: { id: input.id, headerVersion: 1, bodyVersion: 1 } }));
    mockGet.mockResolvedValue({ status: 200, data: { url: 'https://app.example/a/html-document' } });
    const result = await runWithServerHttpBaseUrl('https://app.example', () => store.create({ artifactId: 'html-document', header: { kind: 'html' }, body: '<p>HTML</p>' }));
    expect(result).toEqual({ artifactId: 'html-document', revision: { headerVersion: 1, bodyVersion: 1 },
      previewError: 'artifact_html_preview_unavailable' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

it.each(['plain', 'e2ee'] as const)('retains every HTML bundle asset in one private blob and its %s preview', async (mode) => {
    const secret = randomBytes(32);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    const bundle = { v: 1, entrypoint: 'pages/index.html', files: {
      'pages/index.html': { mime: 'text/html', contentBase64: Buffer.from('<script src="../assets/main.js"></script>').toString('base64') },
      'assets/main.js': { mime: 'application/javascript', contentBase64: Buffer.from('document.title="Ready"').toString('base64') },
      'assets/icon.png': { mime: 'image/png', contentBase64: Buffer.from([0, 255, 128]).toString('base64') },
    } };
    const bytes = Buffer.from(JSON.stringify(bundle));
    let stored: Record<string, unknown> = {};
    let blob: ArtifactBlobReadResponseV1 | undefined;
    mockPost.mockImplementation(async (_url: string, wire: Record<string, unknown> | Buffer) => {
      const input = readCarrierMutation(wire);
      const write = ArtifactBlobWriteV1Schema.parse(input.blob);
      if (!write.content) throw new Error('Expected new blob');
      blob = { blobId: write.blobId, content: write.content };
      stored = { ...input, id: '00000000-0000-4000-8000-000000000011', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: stored };
    });
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/html-preview')
      ? { url: 'https://isolated.example/a/00000000-0000-4000-8000-000000000011' } : url.includes('/blobs/') ? blob
      : url.endsWith('/recipients') ? { artifactId: '00000000-0000-4000-8000-000000000011', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey, recipients: [] } : stored }));
    const result = await store.create({ artifactId: '00000000-0000-4000-8000-000000000011', header: { kind: 'html' },
      binary: { bytes, mime: 'application/vnd.happier.html-bundle+json' } });
    expect(result).toMatchObject({ previewUrl: expect.any(String) });
    const previewUrl = Reflect.get(result, 'previewUrl') as string;
    expect(JSON.parse(Buffer.from(new URL(previewUrl).hash.slice(3), 'base64url').toString('utf8'))).toEqual(bundle);
    const artifact = await store.read('00000000-0000-4000-8000-000000000011');
    expect(Buffer.from(await store.readBinary({ artifactId: '00000000-0000-4000-8000-000000000011', body: artifact!.body! }))).toEqual(bytes);
    expect(mockPost.mock.calls).toHaveLength(1);
    if (mode === 'e2ee') expect(JSON.stringify(mockPost.mock.calls)).not.toContain(bundle.files['assets/main.js'].contentBase64);
  });

  it('rejects an unsafe HTML bundle before storing any mutation', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => ({ status: 200,
      data: { id: input.id, headerVersion: 1, bodyVersion: 1 } }));
    await expect(store.create({ header: { kind: 'html' }, binary: { mime: 'application/vnd.happier.html-bundle+json',
      bytes: Buffer.from(JSON.stringify({ v: 1, entrypoint: '../escape.html', files: { '../escape.html': { mime: 'text/html', contentBase64: 'PGgxLz4=' } } })) } }))
      .rejects.toMatchObject({ code: 'artifact_html_content_invalid' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('returns committed self-revocation without attempting to prepare keys after access was removed', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const revoked = { artifactId: 'artifact', ownerAccountId: 'owner', access: null, grants: [], changed: true };
    mockDelete.mockResolvedValue({ status: 200, data: revoked });
    mockGet.mockResolvedValue({ status: 404, data: { error: 'Artifact not found' } });
    await expect(store.accessGrants.remove({ artifactId: 'artifact', principal: { kind: 'account', accountId: 'admin' } }))
      .resolves.toEqual(revoked);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('uploads bytes beyond the JSON body boundary through the request-bound carrier', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000001';
    const bytes = new Uint8Array(1_100_000).fill(255);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    let received: Uint8Array | undefined;
    mockPost.mockImplementation(async (url: string, input: unknown, options: { headers: Record<string, string> }) => {
      if (!url.endsWith('/v1/artifacts/content/upload')) return { status: 413, data: { error: 'request_too_large' } };
      expect(options.headers['Content-Type']).toBe('application/vnd.happier.artifact-upload-v1');
      if (!Buffer.isBuffer(input)) throw new Error('Expected binary HTTP body');
      const separator = input.indexOf(10);
      const metadata = JSON.parse(input.subarray(0, separator).toString('utf8'));
      expect(metadata).toMatchObject({ kind: 'create', artifactId, t: 'plain', sizeBytes: bytes.length });
      received = new Uint8Array(input.subarray(separator + 1));
      return { status: 200, data: { id: artifactId, headerVersion: 1, bodyVersion: 1 } };
    });
    await expect(store.create({ artifactId, header: { title: 'Large file' }, binary: { bytes, mime: 'application/octet-stream' } }))
      .resolves.toMatchObject({ artifactId, revision: { bodyVersion: 1 } });
    expect(received).toEqual(bytes);
  });

it.each(['plain', 'e2ee'] as const)('round trips binary content under the same Artifact key in %s mode and rejects corrupted bytes', async (mode) => {
    const secret = randomBytes(32);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    const bytes = Uint8Array.from([0, 255, 128, 10, 42]);
    let stored: Record<string, unknown> = {};
    let blob: ArtifactBlobReadResponseV1 | undefined;
    const blobs = new Map<string, ArtifactBlobReadResponseV1>();
    let version = 0;
    mockPost.mockImplementation(async (url: string, wire: Record<string, unknown> | Buffer) => {
      const input = readCarrierMutation(wire);
      const binaryRoute = url.endsWith('/v1/artifacts/content/upload') || url.endsWith('/v1/artifacts/content/binary') || url.endsWith('/v1/artifacts/00000000-0000-4000-8000-000000000012/content/binary');
      if (!binaryRoute && !url.endsWith('/v1/artifacts/00000000-0000-4000-8000-000000000012')) {
        return { status: 404, data: { error: 'Not Found' } };
      }
      // The authenticated server refuses unaware body writes against a binary head.
      if (!binaryRoute && blob) return { status: 409, data: { error: 'artifact_binary_write_required' } };
      if (binaryRoute && input.blob === null && !blob) return { status: 400, data: { error: 'artifact_invalid_body' } };
      if (binaryRoute && input.blob === null) {
        expect(input.expectedBodyVersion).toBe(version);
        expect(typeof input.body).toBe('string');
        blob = undefined;
      } else if (binaryRoute) {
        const write = ArtifactBlobWriteV1Schema.parse(input.blob);
        if (write.content) {
          blob = { blobId: write.blobId, content: write.content };
          blobs.set(blob.blobId, blob);
        } else blob = blobs.get(write.blobId);
        if (!blob) return { status: 404, data: { error: 'Artifact blob not found' } };
      }
      version += 1;
      stored = { ...stored, ...input, id: '00000000-0000-4000-8000-000000000012', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: { ...stored, success: true } };
    });
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.includes('/blobs/') ? blobs.get(url.split('/blobs/')[1])
      : url.endsWith('/recipients') ? { artifactId: '00000000-0000-4000-8000-000000000012', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey, recipients: [] }
      : stored }));
    await store.create({ artifactId: '00000000-0000-4000-8000-000000000012', header: { title: 'Image', excerpt: 'stale preview' }, binary: { bytes, mime: 'image/png' } });
    const document = await store.read('00000000-0000-4000-8000-000000000012');
    expect(document?.body).toEqual({ blobId: blob?.blobId, mime: 'image/png', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(document?.header).toEqual({ title: 'Image' });
    expect(blob?.content).toMatchObject({ t: mode === 'plain' ? 'plain' : 'encrypted' });
    await expect(store.readBinary({ artifactId: '00000000-0000-4000-8000-000000000012', body: document!.body! })).resolves.toEqual(bytes);
    const nextBytes = Uint8Array.from([42, 0, 128, 255]);
    await expect(store.update({ artifactId: '00000000-0000-4000-8000-000000000012', expectedRevision: document!.revision, header: document!.header,
      binary: { bytes: nextBytes, mime: 'application/pdf' } })).resolves.toMatchObject({ ok: true, revision: { bodyVersion: 2 } });
    const updated = await store.read('00000000-0000-4000-8000-000000000012');
    expect(updated?.body).toMatchObject({ mime: 'application/pdf', sizeBytes: nextBytes.length,
      sha256: createHash('sha256').update(nextBytes).digest('hex') });
    await expect(store.readBinary({ artifactId: '00000000-0000-4000-8000-000000000012', body: updated!.body! })).resolves.toEqual(nextBytes);
    await expect(store.update({ artifactId: '00000000-0000-4000-8000-000000000012', expectedRevision: updated!.revision, header: { title: 'Renamed file' },
      body: updated!.body! })).resolves.toMatchObject({ ok: true, revision: { bodyVersion: 3 } });
    await expect(store.readBinary({ artifactId: '00000000-0000-4000-8000-000000000012', body: document!.body! })).resolves.toEqual(bytes);
    await expect(store.readBinary({ artifactId: '00000000-0000-4000-8000-000000000012', body: updated!.body! })).resolves.toEqual(nextBytes);
    blob = { blobId: blob!.blobId, content: { t: 'plain', v: Buffer.from([1, 2]).toString('base64') } };
    blobs.set(blob.blobId, blob);
    await expect(store.readBinary({ artifactId: '00000000-0000-4000-8000-000000000012', body: updated!.body! })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    const reused = await store.read('00000000-0000-4000-8000-000000000012');
    await expect(store.update({ artifactId: '00000000-0000-4000-8000-000000000012', expectedRevision: reused!.revision,
      header: { title: 'Text replacement' }, body: 'intentional text' })).resolves.toMatchObject({ ok: true, revision: { bodyVersion: 4 } });
    const text = await store.read('00000000-0000-4000-8000-000000000012');
    expect(text?.body).toBe('intentional text');
    expect(blob).toBeUndefined();
    await expect(store.update({ artifactId: '00000000-0000-4000-8000-000000000012', expectedRevision: text!.revision,
      header: text!.header, body: 'normal text edit' })).resolves.toMatchObject({ ok: true, revision: { bodyVersion: 5 } });
    await expect(store.read('00000000-0000-4000-8000-000000000012')).resolves.toMatchObject({ body: 'normal text edit' });
  });

  it.each(['role.v1', 'approval_request.v1'])('refuses binary writes to specialized text document %s before committing content', async (kind) => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => ({ status: 200,
      data: { id: input.id, success: true, headerVersion: 1, bodyVersion: 1 } }));
    mockGet.mockResolvedValue({ status: 200, data: { id: 'typed', header: encodePlainArtifactStoredContent({ kind: 'role.v1' }),
      body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } });
    const binary = { bytes: Uint8Array.from([0, 255]), mime: 'image/png' };
    await expect(store.create({ artifactId: 'typed', header: { kind }, binary }))
      .rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    await expect(store.update({ artifactId: 'typed', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind }, binary })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('does not mutate a text-only Artifact server when the binary operation is unavailable', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    let mutations = 0;
    const stored = { id: 'existing', header: encodePlainArtifactStoredContent({ title: 'Keep' }),
      body: encodePlainArtifactStoredContent({ body: 'original' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    // Mutation schemas mirror ../0.2 at 388915739e64655b454e0bee8198833a54e6eabc.
    // Its text routes strip unknown blob fields; newer read authority is supplied separately.
    const oldCreate = z.object({ id: z.string().uuid(), header: z.string(), body: z.string(), dataEncryptionKey: z.string() });
    const oldUpdate = z.object({ header: z.string().optional(), expectedHeaderVersion: z.number().int().min(0).optional(),
      body: z.string().optional(), expectedBodyVersion: z.number().int().min(0).optional() });
    mockPost.mockImplementation(async (url: string, input: Record<string, unknown>) => {
      if (url.endsWith('/v1/artifacts')) {
        const parsed = oldCreate.parse(input);
        mutations += 1;
        return { status: 200, data: { id: parsed.id, headerVersion: 2, bodyVersion: 2 } };
      }
      if (url.endsWith('/v1/artifacts/existing')) {
        const parsed = oldUpdate.parse(input);
        mutations += 1;
        if (parsed.body !== undefined) stored.body = parsed.body;
        return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
      }
      return { status: 404, data: { error: 'Not Found' } };
    });
    mockGet.mockResolvedValue({ status: 200, data: stored });
    const binary = { bytes: Uint8Array.from([0, 255]), mime: 'image/png' };
    await expect(store.create({ artifactId: '22222222-2222-4222-8222-222222222222', header: {}, binary })).rejects.toMatchObject({ code: 'create_failed' });
    await expect(store.update({ artifactId: 'existing', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: {}, binary }))
      .resolves.toMatchObject({ ok: false });
    expect(mutations).toBe(0);
    await expect(store.read('existing')).resolves.toMatchObject({ body: 'original', revision: { bodyVersion: 1 } });
  });

  it('owns plain Artifact create/read/CAS/delete semantics for typed consumers', async () => {
    const credentials = { token: 'token', encryption: null } as const;
    const store = createAccountArtifactStore({
      credentials,
      getAccountEncryptionMode: async () => 'plain',
    });
    let created: Record<string, unknown> | undefined;
    mockPost.mockImplementationOnce(async (_url: string, body: Record<string, unknown>) => {
      created = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });

    const result = await store.create({
      artifactId: 'artifact-1',
      header: { kind: 'example.v1' },
      body: 'body',
    });
    expect(result).toEqual({ artifactId: 'artifact-1', revision: { headerVersion: 1, bodyVersion: 1 } });
    expect(created?.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);

    mockGet.mockResolvedValueOnce({ status: 200, data: {
      id: 'artifact-1', header: created?.header, headerVersion: 3,
      body: created?.body, bodyVersion: 4, dataEncryptionKey: created?.dataEncryptionKey,
      seq: 9, createdAt: 1, updatedAt: 2,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
    } });
    await expect(store.read('artifact-1')).resolves.toMatchObject({
      artifactId: 'artifact-1', header: { kind: 'example.v1' }, body: 'body',
      revision: { headerVersion: 3, bodyVersion: 4 },
    });

    mockGet.mockResolvedValueOnce({ status: 200, data: {
      id: 'artifact-1', header: created?.header, headerVersion: 3,
      body: created?.body, bodyVersion: 4, dataEncryptionKey: created?.dataEncryptionKey,
      seq: 9, createdAt: 1, updatedAt: 2,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
    } });
    mockPost.mockResolvedValueOnce({ status: 200, data: { success: false, error: 'version-mismatch' } });
    await expect(store.update({
      artifactId: 'artifact-1', expectedRevision: { headerVersion: 3, bodyVersion: 4 },
      header: { kind: 'example.v1' }, body: 'changed',
    })).resolves.toEqual({ ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' });

    mockDelete.mockResolvedValueOnce({ status: 200, data: {} });
    await expect(store.delete('artifact-1')).resolves.toEqual({ ok: true });
  });

  it.each(['plain', 'e2ee'] as const)('derives bounded header excerpts on %s create/update and clears stale previews for empty content', async (mode) => {
    const secret = randomBytes(32);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    let stored: Record<string, unknown> = {};
    let version = 0;
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => {
      version += 1;
      stored = { ...stored, ...input, id: 'note', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: version === 1 ? stored : { success: true, headerVersion: version, bodyVersion: version } };
    });
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/recipients')
      ? { artifactId: 'note', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey, recipients: [] }
      : stored }));
    const metadata = { kind: 'published.v1', title: 'Keep title' };
    const body = 'private'.repeat(100);
    await store.create({ artifactId: 'note', header: { ...metadata, excerpt: 'stale caller preview' }, body });
    const created = await store.read('note');
    expect(created?.header).toEqual({ ...metadata, excerpt: body.slice(0, 600) });
    expect(created?.body).toBe(body);
    if (mode === 'e2ee') expect(JSON.stringify(mockPost.mock.calls[0]?.[1])).not.toContain(body.slice(0, 600));

    await expect(store.update({ artifactId: 'note', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: created!.header, body: 'Fresh content' })).resolves.toMatchObject({ ok: true });
    const updated = await store.read('note');
    expect(updated?.header).toEqual({ ...metadata, excerpt: 'Fresh content' });
    expect(updated?.body).toBe('Fresh content');
    const unicodeBody = `${'x'.repeat(599)}😀tail`;
    await expect(store.update({ artifactId: 'note', expectedRevision: { headerVersion: 2, bodyVersion: 2 },
      header: updated!.header, body: unicodeBody })).resolves.toMatchObject({ ok: true });
    const unicodeUpdated = await store.read('note');
    expect(unicodeUpdated?.header).toEqual({ ...metadata, excerpt: 'x'.repeat(599) });
    expect(unicodeUpdated?.body).toBe(unicodeBody);
    await expect(store.update({ artifactId: 'note', expectedRevision: { headerVersion: 3, bodyVersion: 3 },
      header: unicodeUpdated!.header, body: '' })).resolves.toMatchObject({ ok: true });
    const emptied = await store.read('note');
    expect(emptied?.header).toEqual(metadata);
    expect(emptied?.body).toBe('');
  });

  it('derives Workflow header previews on generic create and update from the stored definition body', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const content = (text: string) => JSON.stringify({ kind: 'workflow-definition.v1', definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'review', document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    } });
    let stored: Record<string, unknown> = {};
    let version = 0;
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => {
      version += 1;
      stored = { ...stored, ...input, id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: version === 1 ? stored : { success: true, headerVersion: version, bodyVersion: version } };
    });
    mockGet.mockImplementation(async () => ({ status: 200, data: stored }));
    const header = { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 1 },
      metadata: { title: 'Flow' }, previewSteps: ['Stale label'] };
    await store.create({ artifactId, header, body: content('Created step') });
    expect((await store.read(artifactId))?.header).toMatchObject({ previewSteps: ['Created step'] });
    await store.update({ artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header, body: content('Updated step') });
    expect((await store.read(artifactId))?.header).toMatchObject({ previewSteps: ['Updated step'] });
  });

  it('rejects incomplete current Artifact authority projections on read and list', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const row = { id: 'artifact-1', header: encodePlainArtifactStoredContent({ title: 'Private' }),
      body: encodePlainArtifactStoredContent({ body: 'private' }), headerVersion: 1, bodyVersion: 1,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 1 };
    mockGet.mockResolvedValueOnce({ status: 200, data: row });
    await expect(store.read('artifact-1')).rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
    mockGet.mockResolvedValueOnce({ status: 200, data: [row] });
    await expect(store.list()).rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
  });

  it('searches and sorts decrypted headers across transport pages without sending private filters', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const row = (id: string, title: string, kind: string, updatedAt: number) => ({
      id, header: encodePlainArtifactStoredContent({ title, kind }),
      headerVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: updatedAt, updatedAt,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
    });
    const first = Array.from({ length: 500 }, (_, i) => row(`other-${i}`, 'Other', 'other.v1', 1000 - i));
    const second = [row('z', 'Private zebra', 'published.v1', 2), row('a', 'Private alpha', 'published.v1', 1)];
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).searchParams.has('cursor') ? second : first }));
    const options = { search: 'PRIVATE', kind: 'published.v1', sort: 'title_asc' as const, limit: 1 };
    const page = await store.list(options);
    expect(page.items.map((item) => item.artifactId)).toEqual(['a']);
    expect(page.nextCursor).toBeDefined();
    const next = await store.list({ ...options, cursor: page.nextCursor });
    expect(next.items.map((item) => item.artifactId)).toEqual(['z']);
    expect(next.nextCursor).toBeUndefined();
    for (const [url] of mockGet.mock.calls) {
      expect(new URL(url).searchParams.has('search')).toBe(false);
      expect(new URL(url).searchParams.has('kind')).toBe(false);
      expect(new URL(url).searchParams.has('sort')).toBe(false);
    }
  });

  it('returns an updated-desc page without opening later transport pages before the caller requests them', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `artifact-${i}`,
      header: encodePlainArtifactStoredContent({ title: `Note ${i}` }), headerVersion: 1,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: i, createdAt: 1, updatedAt: 1000 - i,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain' }));
    mockGet.mockImplementation(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.searchParams.has('cursor')) return { status: 503, data: { error: 'temporarily_unavailable' } };
      return { status: 200, data: rows.slice(0, Number(url.searchParams.get('limit') ?? 500)) };
    });
    await expect(store.list({ sort: 'updated_desc', limit: 1 })).resolves.toMatchObject({
      items: [{ artifactId: 'artifact-0' }], nextCursor: expect.any(String),
    });
  });

  it('keeps logical updated-desc limits larger than a transport page and omitted limits complete', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const rows = Array.from({ length: 502 }, (_, i) => ({ id: `artifact-${i}`,
      header: encodePlainArtifactStoredContent({ title: `Note ${i}` }), headerVersion: 1,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: i, createdAt: 1, updatedAt: 1000 - i,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain' }));
    mockGet.mockImplementation(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      const limit = Number(url.searchParams.get('limit') ?? 500);
      if (limit > 500) return { status: 400, data: { error: 'invalid_limit' } };
      return { status: 200, data: url.searchParams.has('cursor') ? rows.slice(500) : rows.slice(0, limit) };
    });
    const page = await store.list({ sort: 'updated_desc', limit: 501 });
    expect(page.items).toHaveLength(501);
    expect(page.nextCursor).toBeDefined();
    const next = await store.list({ sort: 'updated_desc', limit: 501, cursor: page.nextCursor });
    expect(next.items.map((item) => item.artifactId)).toEqual(['artifact-501']);
    expect(next.nextCursor).toBeUndefined();
    const complete = await store.list({ sort: 'updated_desc' });
    expect(complete.items).toHaveLength(502);
    expect(complete.nextCursor).toBeUndefined();
  });

  it.each(['prior', null, { blobId: '11111111-1111-4111-8111-111111111111', mime: 'image/png', sizeBytes: 0,
    sha256: createHash('sha256').update(new Uint8Array()).digest('hex') }])('decodes retained body %s with the Artifact owner codec and restores through revision CAS', async (priorBody) => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'e2ee' });
    const artifact = { id: 'shared', ownerAccountId: 'other', access: 'edit', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ title: 'Shared', excerpt: 'Current preview' }), body: encodePlainArtifactStoredContent({ body: 'current' }),
      headerVersion: 3, bodyVersion: 4, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 2 };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 2, body: encodePlainArtifactStoredContent({ body: priorBody }), createdAt: 1, sizeBytes: 20 }], retentionCount: 10 }
      : artifact }));
    await expect(store.revisions.list({ artifactId: 'shared' })).resolves.toEqual({ artifactId: 'shared',
      revisions: [{ bodyVersion: 2, body: priorBody, createdAt: 1, sizeBytes: 20 }], retentionCount: 10 });
    mockPost.mockResolvedValueOnce({ status: 200, data: { success: true, headerVersion: 4, bodyVersion: 5 } });
    await expect(store.revisions.restore({ artifactId: 'shared', bodyVersion: 2, expectedRevision: { headerVersion: 3, bodyVersion: 4 } }))
      .resolves.toEqual({ ok: true, revision: { headerVersion: 4, bodyVersion: 5 } });
    expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('/shared/revisions/2/restore'),
      { expectedHeaderVersion: 3, expectedBodyVersion: 4,
        header: encodePlainArtifactStoredContent({ title: 'Shared', ...(typeof priorBody === 'string' ? { excerpt: priorBody } : {}) }) }, expect.any(Object));
  });

  it.each(['plain', 'e2ee'] as const)('restores retained %s body custody without inferring new caller attribution', async mode => {
    const secret = randomBytes(32);
    const publicKey = x25519.getPublicKey(secret);
    const dataKey = randomBytes(32);
    const dataEncryptionKey = mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
      : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: publicKey, randomBytes }));
    const encode = (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
      : encodeBase64(encryptWithDataKey(value, dataKey));
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null
      : { type: 'dataKey', publicKey, machineKey: secret } }, getAccountEncryptionMode: async () => mode });
    const provenance = { savedBy: { kind: 'agent' as const, accountId: 'owner', sessionId: 'old-session' } };
    const retainedBody = encode({ body: 'prior', provenance });
    let stored = { id: 'shared', ownerAccountId: 'owner', access: 'edit', encryptionMode: mode,
      header: encode({ title: 'Shared' }), body: encode({ body: 'current' }),
      headerVersion: 3, bodyVersion: 4, dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 2 };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 2, body: retainedBody, createdAt: 1, sizeBytes: 20 }], retentionCount: 10 }
      : url.endsWith('/recipients') ? { artifactId: 'shared', ownerAccountId: 'owner', access: 'edit', encryptionMode: mode,
        dataEncryptionKey, callerDataEncryptionKey: dataEncryptionKey, recipients: [] }
      : stored }));
    await expect(store.revisions.list({ artifactId: 'shared' })).resolves.toEqual({ artifactId: 'shared',
      revisions: [{ bodyVersion: 2, body: 'prior', createdAt: 1, sizeBytes: 20 }], retentionCount: 10 });
    // The HTTP boundary models the incumbent server's omitted-body restore:
    // it selects retained bytes while the real CLI owner prepares the header and CAS.
    mockPost.mockImplementationOnce(async (url: string, wire: unknown) => {
      expect(url).toContain('/shared/revisions/2/restore');
      const request = z.object({ expectedHeaderVersion: z.literal(3), expectedBodyVersion: z.literal(4), header: z.string() }).strict().parse(wire);
      stored = { ...stored, header: request.header, body: retainedBody, headerVersion: 4, bodyVersion: 5 };
      return { status: 200, data: { success: true, headerVersion: 4, bodyVersion: 5 } };
    });
    const execute = createCliArtifactActions({ store, resolvePublishCaller: async () => null });
    await expect(execute({ actionId: 'artifact.revisions.restore', input: {
      artifactId: 'shared', bodyVersion: 2, expectedRevision: { headerVersion: 3, bodyVersion: 4 },
    }, context: { surface: 'cli' } })).resolves.toEqual({ artifactId: 'shared',
      revision: { headerVersion: 4, bodyVersion: 5 } });
    const wire: unknown = mockPost.mock.calls[0]![1];
    expect(wire).not.toHaveProperty('body');
    expect(JSON.stringify(wire)).not.toContain('editor');
    expect(JSON.stringify(wire)).not.toContain('old-session');
    const restored = await store.read('shared');
    expect(restored).toMatchObject({ body: 'prior', revision: { headerVersion: 4, bodyVersion: 5 } });
    expect(restored?.header).toEqual({ title: 'Shared', excerpt: 'prior' });
    expect(stored.body).toBe(retainedBody);
    const opened = mode === 'plain' ? decodePlainArtifactStoredContent(stored.body)
      : decryptWithDataKeyResult(decodeBase64(stored.body), dataKey);
    const expected = { body: 'prior', provenance };
    expect(opened).toEqual(mode === 'plain' ? expected : { status: 'authenticated', value: expected });
  });

  it('keeps a retained actor distinct from the new restore caller in private revision custody', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const provenance = { savedBy: { kind: 'agent' as const, accountId: 'owner', sessionId: 'old-session' } };
    const savedBy = { kind: 'person' as const, accountId: 'editor' };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 2, body: encodePlainArtifactStoredContent({ body: 'prior' }),
        provenance: encodePlainArtifactStoredContent({ v: 1, artifactId: 'shared', bodyVersion: 2, provenance }), createdAt: 1, sizeBytes: 20 }], retentionCount: 10 }
      : { id: 'shared', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ title: 'Shared' }), body: encodePlainArtifactStoredContent({ body: 'current' }),
        headerVersion: 3, bodyVersion: 4, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 2 } }));
    await expect(store.revisions.list({ artifactId: 'shared' })).resolves.toMatchObject({ revisions: [{ body: 'prior', provenance }] });
    mockPost.mockResolvedValueOnce({ status: 200, data: { success: true, headerVersion: 4, bodyVersion: 5 } });
    await expect(store.revisions.restore({ artifactId: 'shared', bodyVersion: 2, expectedRevision: { headerVersion: 3, bodyVersion: 4 }, savedBy }))
      .resolves.toMatchObject({ ok: true });
    expect(mockPost.mock.calls[0]![1]).not.toHaveProperty('body');
    expect(decodePlainArtifactStoredContent(mockPost.mock.calls[0]![1].provenance)).toEqual({ v: 1, artifactId: 'shared', bodyVersion: 5,
      provenance: { savedBy, restoredFromBodyVersion: 2 } });
  });

  it.each(['plain', 'e2ee'] as const)('keeps %s text and binary save provenance outside the public content key across create and update', async mode => {
    const secret = randomBytes(32);
    const savedBy = { kind: 'agent' as const, accountId: 'owner', sessionId: 'writer-session' };
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: mode === 'plain' ? null : {
      type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
    } }, getAccountEncryptionMode: async () => mode });
    let stored: Record<string, unknown> | null = null;
    mockPost.mockImplementation(async (_url: string, wire: unknown) => {
      const input = readCarrierMutation(wire);
      const version = Number(stored?.bodyVersion ?? 0) + 1;
      stored = { ...stored, ...input, id: input.id ?? stored?.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: { ...stored, success: true } };
    });
    mockGet.mockImplementation(async (url: string) => ({ status: 200,
      data: new URL(url).pathname === '/v1/artifacts' ? [stored] : url.endsWith('/revisions') ? { retentionCount: 10,
        revisions: [{ bodyVersion: 1, body: readCarrierMutation(mockPost.mock.calls[0]![1]).body,
          provenance: readCarrierMutation(mockPost.mock.calls[0]![1]).provenance, createdAt: 1, sizeBytes: 14 }] } : url.endsWith('/recipients') ? {
            artifactId: stored?.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
            dataEncryptionKey: stored?.dataEncryptionKey, callerDataEncryptionKey: stored?.dataEncryptionKey,
            provenanceDataEncryptionKey: stored?.provenanceDataEncryptionKey,
            callerProvenanceDataEncryptionKey: stored?.provenanceDataEncryptionKey, recipients: [],
          } : stored }));
    const source = { sessionId: 'source-session', runId: 'source-run', machineId: 'source-machine', path: 'private/workspace.txt', sha: 'a'.repeat(64) };
    const publication = prepareArtifactWorkspaceFileV1({ caller: source, file: { bytes: Buffer.from('public content'), name: 'workspace.txt', path: source.path, sha: source.sha }, input: { title: 'Private' } });
    const created = await store.create({ ...publication, savedBy });
    const first = readCarrierMutation(mockPost.mock.calls[0]![1]);
    const openKey = (value: unknown) => openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(String(value)), recipientSecretKeyOrSeed: secret })!;
    const open = (value: unknown, key?: Uint8Array) => mode === 'plain' ? decodePlainArtifactStoredContent(String(value))
      : decryptWithDataKey(decodeBase64(String(value)), key!);
    const contentKey = mode === 'e2ee' ? openKey(first.dataEncryptionKey) : undefined;
    const privateKey = mode === 'e2ee' ? openKey(first.provenanceDataEncryptionKey) : undefined;
    expect(open(first.header, contentKey)).not.toHaveProperty('source');
    expect(open(first.body, contentKey)).toEqual({ body: 'public content' });
    expect(open(first.provenance, privateKey)).toEqual({ v: 1, artifactId: created.artifactId, bodyVersion: 1, provenance: { savedBy, source } });
    if (mode === 'e2ee') {
      expect(privateKey).not.toEqual(contentKey);
      expect(open(first.provenance, contentKey)).toBeNull();
    } else expect(first).not.toHaveProperty('provenanceDataEncryptionKey');
    await expect(store.update({ artifactId: created.artifactId, expectedRevision: created.revision,
      header: { title: 'Binary' }, binary: { bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' }, savedBy })).resolves.toMatchObject({ ok: true });
    const updated = readCarrierMutation(mockPost.mock.calls[1]![1]);
    expect(open(updated.header, contentKey)).not.toHaveProperty('source');
    expect(open(updated.body, contentKey)).not.toHaveProperty('provenance');
    expect(open(updated.provenance, privateKey)).toEqual({ v: 1, artifactId: created.artifactId, bodyVersion: 2, provenance: { savedBy, source } });
    expect(updated).not.toHaveProperty('provenanceDataEncryptionKey');
    await expect(store.list({ includeBody: true })).resolves.toMatchObject({ items: [{ bodyVersion: 2, provenance: { savedBy, source } }] });
    const restoredBy = { kind: 'person' as const, accountId: 'restoring-owner' };
    await expect(store.revisions.restore({ artifactId: created.artifactId, bodyVersion: 1,
      expectedRevision: { headerVersion: 2, bodyVersion: 2 }, savedBy: restoredBy })).resolves.toMatchObject({ ok: true });
    const restored = readCarrierMutation(mockPost.mock.calls[2]![1]);
    expect(open(restored.header, contentKey)).not.toHaveProperty('source');
    expect(open(restored.provenance, privateKey)).toEqual({ v: 1, artifactId: created.artifactId, bodyVersion: 3,
      provenance: { savedBy: restoredBy, source, restoredFromBodyVersion: 1 } });
  });

  it('initializes a grant editor private key for the owner and delivers the independent editor wrap without replacing content custody', async () => {
    const ownerSecret = randomBytes(32);
    const editorSecret = randomBytes(32);
    const dataKey = randomBytes(32);
    const actor = { kind: 'agent' as const, accountId: 'editor', sessionId: 'editor-session' };
    const recipient = (id: string, secret: Uint8Array) => {
      const signingSecret = randomBytes(32);
      const signingPublic = ed25519.getPublicKey(signingSecret);
      const contentPublic = x25519.getPublicKey(secret);
      const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: contentPublic, randomBytes }));
      const fingerprint = computeContentPublicKeyFingerprint(contentPublic);
      return { recipientAccountId: id, encryptedDataKey: envelope, recipientContentPublicKeyFingerprint: fingerprint,
        contentPublicKeyFingerprint: fingerprint, encryptedProvenanceDataKey: null, contentKey: { status: 'available' as const,
          accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(contentPublic),
          contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic })) } };
    };
    const owner = recipient('owner', ownerSecret);
    const editor = recipient('editor', editorSecret);
    let privateOwnerEnvelope: string | null = null;
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/recipients') ? {
      artifactId: 'legacy', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'e2ee',
      dataEncryptionKey: owner.encryptedDataKey, callerDataEncryptionKey: editor.encryptedDataKey,
      provenanceDataEncryptionKey: privateOwnerEnvelope, callerProvenanceDataEncryptionKey: null, recipients: [owner, editor],
    } : { id: 'legacy', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'e2ee',
      header: encodeBase64(encryptWithDataKey({ title: 'Legacy' }, dataKey)), body: encodeBase64(encryptWithDataKey({ body: 'old' }, dataKey)),
      dataEncryptionKey: editor.encryptedDataKey, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } }));
    mockPost.mockImplementation(async (url: string, input: Record<string, unknown>) => {
      if (url.endsWith('/key-envelopes')) return { status: 200, data: { appliedRecipientAccountIds: ['editor'], skippedRecipientAccountIds: [] } };
      privateOwnerEnvelope = String(input.provenanceDataEncryptionKey);
      return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: {
      type: 'dataKey', publicKey: x25519.getPublicKey(editorSecret), machineKey: editorSecret,
    } }, getAccountEncryptionMode: async () => 'e2ee' });
    await expect(store.update({ artifactId: 'legacy', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: { title: 'New' }, body: 'new', savedBy: actor }))
      .resolves.toMatchObject({ ok: true });
    const mutation = mockPost.mock.calls.find(([url]) => !String(url).endsWith('/key-envelopes'))![1];
    const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(mutation.provenanceDataEncryptionKey), recipientSecretKeyOrSeed: ownerSecret });
    expect(key).not.toBeNull();
    expect(key).not.toEqual(dataKey);
    expect(mutation).not.toHaveProperty('dataEncryptionKey');
    expect(decryptWithDataKey(decodeBase64(mutation.body), dataKey)).toEqual({ body: 'new' });
    expect(decryptWithDataKey(decodeBase64(mutation.provenance), key!)).toEqual({ v: 1, artifactId: 'legacy', bodyVersion: 2, provenance: { savedBy: actor } });
    const commit = mockPost.mock.calls.find(([url]) => String(url).endsWith('/key-envelopes'))![1];
    expect(commit.expectedProvenanceDataEncryptionKey).toBe(privateOwnerEnvelope);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(commit.recipientKeyEnvelopes[0].encryptedProvenanceDataKey), recipientSecretKeyOrSeed: editorSecret })).toEqual(key);
  });

  it.each([{ artifactId: 'other', bodyVersion: 1 }, { artifactId: 'bound', bodyVersion: 2 }])('refuses private metadata substituted from another Artifact or revision (%j)', async binding => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    mockGet.mockResolvedValue({ status: 200, data: { id: 'bound', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ title: 'Bound' }), body: encodePlainArtifactStoredContent({ body: 'public content' }),
      provenance: encodePlainArtifactStoredContent({ v: 1, ...binding, provenance: { savedBy: { kind: 'person', accountId: 'owner' } } }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } });
    await expect(store.read('bound')).rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
  });

  it('reads unknown stored envelope fields and restores a Workflow with a canonical usable header', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain', savedBy: { kind: 'person', accountId: 'owner' } });
    const definitionId = '11111111-1111-4111-8111-111111111111';
    const revision = { headerVersion: 3, bodyVersion: 4 };
    const metadata = { title: 'Current title', description: 'Current description' };
    const savedBy = { kind: 'person', accountId: 'owner' };
    const workflowBody = (text: string) => JSON.stringify({ kind: 'workflow-definition.v1', definition: {
      version: 1, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'review', document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    } });
    const priorBody = JSON.stringify({ ...JSON.parse(workflowBody('Prior review')), unknown: true });
    let stored = { id: definitionId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId, revision, metadata, savedBy, unknown: true }),
      body: encodePlainArtifactStoredContent({ body: workflowBody('Current review'), unknown: true,
        provenance: { savedBy: { kind: 'person', accountId: 'untrusted-actor' } } }),
      provenance: encodePlainArtifactStoredContent({ v: 1, artifactId: definitionId, bodyVersion: 4, unknown: true,
        provenance: { savedBy: { ...savedBy, unknown: true }, unknown: true } }),
      ...revision, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 2 };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 2, body: encodePlainArtifactStoredContent({ body: priorBody,
        provenance: { savedBy: { kind: 'person', accountId: 'untrusted-actor' } } }), createdAt: 1, sizeBytes: 50 }], retentionCount: 10 }
      : stored }));
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => {
      stored = { ...stored, header: typeof input.header === 'string' ? input.header : stored.header,
        provenance: typeof input.provenance === 'string' ? input.provenance : stored.provenance,
        body: encodePlainArtifactStoredContent({ body: priorBody }), headerVersion: 4, bodyVersion: 5 };
      return { status: 200, data: { success: true, headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion } };
    });
    const workflows = createWorkflowDefinitionActions({ artifactStore: store,
      encodeListCursor: encodeAccountArtifactListCursor, assertDefinitionWriteAllowed: () => undefined });
    await expect(workflows.get({ definitionId })).resolves.toMatchObject({ metadata, savedBy, revision });
    const history = await store.revisions.list({ artifactId: definitionId });
    expect(history.revisions[0]).toEqual({ bodyVersion: 2, body: priorBody, createdAt: 1, sizeBytes: 50 });
    await expect(store.revisions.restore({ artifactId: definitionId, bodyVersion: 2, expectedRevision: revision }))
      .resolves.toEqual({ ok: true, revision: { headerVersion: 4, bodyVersion: 5 } });
    await expect(workflows.get({ definitionId })).resolves.toMatchObject({ metadata, savedBy,
      revision: { headerVersion: 4, bodyVersion: 5 },
      definition: { blocks: [{ document: { text: 'Prior review' } }] } });
    const restored = await store.read(definitionId);
    expect(restored && workflowDefinitionArtifactSharingAdapterV1.canShare(restored)).toBe(true);
    expect(restored?.header).not.toHaveProperty('savedBy');
    expect(restored?.header).not.toHaveProperty('unknown');
  });

  it('restores a renamed launch profile with a matching usable and sharable header', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const content = (name: string) => ({ kind: 'launch-profile.v1', profile: {
      v: 2, id: 'work', name, createdAt: 1, updatedAt: 1, extraEnvironmentVariables: [], envVarRequirements: [],
    }, secretBindings: {} });
    const prior = content('Prior name');
    let stored = { id: 'profile-artifact', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: 'work', name: 'Current name', title: 'Current name', custom: 'keep' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(content('Current name')) }),
      headerVersion: 3, bodyVersion: 4, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 2 };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 2, body: encodePlainArtifactStoredContent({ body: JSON.stringify(prior) }), createdAt: 1, sizeBytes: 50 }], retentionCount: 10 }
      : stored }));
    mockPost.mockImplementation(async (_url: string, input: Record<string, unknown>) => {
      stored = { ...stored, header: typeof input.header === 'string' ? input.header : stored.header,
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(prior) }), headerVersion: 4, bodyVersion: 5 };
      return { status: 200, data: { success: true, headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion } };
    });
    const current = await store.read('profile-artifact');
    expect(current && readLaunchProfileArtifactV1(current)?.profile.name).toBe('Current name');
    await expect(store.revisions.restore({ artifactId: 'profile-artifact', bodyVersion: 2,
      expectedRevision: { headerVersion: 3, bodyVersion: 4 } })).resolves.toMatchObject({ ok: true });
    const restored = await store.read('profile-artifact');
    expect(restored && readLaunchProfileArtifactV1(restored)?.profile.name).toBe('Prior name');
    expect(restored?.header).toMatchObject({ name: 'Prior name', title: 'Prior name', custom: 'keep' });
    expect(restored && launchProfileArtifactSharingAdapterV1.canShare(restored)).toBe(true);
  });

  it.each([{ headerVersion: 2, bodyVersion: 4 }, { headerVersion: 3, bodyVersion: 2 }])(
    'refuses restore before mutation when either expected revision is stale: %j', async (expectedRevision) => {
      const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
        getAccountEncryptionMode: async () => 'plain' });
      mockGet.mockResolvedValue({ status: 200, data: { id: 'shared', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ title: 'Current title' }), body: encodePlainArtifactStoredContent({ body: 'current' }),
        headerVersion: 3, bodyVersion: 4, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 2 } });
      mockPost.mockResolvedValue({ status: 200, data: { success: true, headerVersion: 4, bodyVersion: 5 } });
      await expect(store.revisions.restore({ artifactId: 'shared', bodyVersion: 1, expectedRevision }))
        .resolves.toEqual({ ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' });
      expect(mockPost).not.toHaveBeenCalled();
    });

  it('refuses malformed decrypted bodies consistently for current content and revision history', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const row = { id: 'artifact', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ title: 'Private' }), body: encodePlainArtifactStoredContent({ wrong: 'content' }),
      headerVersion: 1, bodyVersion: 2, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 2 };
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 1, body: row.body, createdAt: 1, sizeBytes: 10 }], retentionCount: 10 } : row }));
    await expect(store.read('artifact')).rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
    await expect(store.revisions.list({ artifactId: 'artifact' })).rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
  });

  it('preserves typed quota details on writes and exposes the configured Account storage usage', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const quota = { error: 'quota_exceeded', budget: 'account', limitBytes: 100, usedBytes: 120 };
    mockPost.mockResolvedValueOnce({ status: 413, data: quota });
    await expect(store.create({ header: {}, body: 'content' })).rejects.toMatchObject({ code: 'quota_exceeded',
      details: { budget: 'account', limitBytes: 100, usedBytes: 120 } });
    const usage = { usedBytes: 80, limitBytes: 100, documentLimitBytes: null, revisionRetentionCount: 10 };
    mockGet.mockResolvedValueOnce({ status: 200, data: usage });
    await expect(store.storageUsage()).resolves.toEqual(usage);
  });

  it('creates plain content from Account mode without probing older server support', async () => {
    const store = createCredentialedAccountArtifactStore({ token: 'token', encryption: null });
    mockGet.mockImplementation(async (url: string) => {
      if (!url.endsWith('/v1/account/encryption')) throw new Error('unexpected_server_probe');
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    mockPost.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1', headerVersion: 1, bodyVersion: 1 } });
    await expect(store.create({ artifactId: 'artifact-1', header: { title: 'Note' }, body: 'note' }))
      .resolves.toMatchObject({ artifactId: 'artifact-1' });
  });

  it('preserves current create revisions and rejects incomplete create/update acknowledgements', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const input = { artifactId: 'artifact-1', header: { title: 'Note' }, body: 'note' };
    mockPost.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1', headerVersion: 7, bodyVersion: 9 } });
    await expect(store.create(input)).resolves.toMatchObject({ revision: { headerVersion: 7, bodyVersion: 9 } });
    mockPost.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1' } });
    await expect(store.create(input)).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    mockPost.mockResolvedValueOnce({ status: 200, data: { id: 'different-artifact', headerVersion: 1, bodyVersion: 1 } });
    await expect(store.create(input)).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    mockGet.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent(input.header), body: encodePlainArtifactStoredContent({ body: input.body }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 7, bodyVersion: 9, seq: 1, createdAt: 1, updatedAt: 1 } });
    mockPost.mockResolvedValueOnce({ status: 200, data: { success: true } });
    await expect(store.update({ ...input, expectedRevision: { headerVersion: 7, bodyVersion: 9 } }))
      .rejects.toMatchObject({ code: 'artifact_content_unavailable' });
  });

  it('rejects malformed Artifact transport versions instead of manufacturing numeric currentness', async () => {
    const store = createAccountArtifactStore({
      credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain',
    });
    mockGet.mockResolvedValueOnce({ status: 200, data: {
      id: 'artifact-1',
      header: 'ignored',
      headerVersion: '1',
      body: 'ignored',
      bodyVersion: 1,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    } });

    await expect(store.read('artifact-1')).rejects.toMatchObject({ code: 'artifact_read_invalid' });
  });

  it('passes cancellation through Artifact delete without inventing a revision precondition', async () => {
    const store = createAccountArtifactStore({
      credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain',
    });
    const signal = new AbortController().signal;
    mockDelete.mockResolvedValueOnce({ status: 200, data: {} });

    await expect(store.delete('artifact-1', { signal })).resolves.toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith(expect.stringContaining('/v1/artifacts/artifact-1'), expect.objectContaining({ signal }));
    expect(mockDelete.mock.calls[0]?.[1]).not.toHaveProperty('data');
  });

  it('carries an explicit deletion revision to the atomic Artifact owner and reports conflicts', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    mockDelete.mockResolvedValueOnce({ status: 409, data: { error: 'version-mismatch' } });
    await expect(store.delete('artifact-1', { expectedRevision: { headerVersion: 2, bodyVersion: 4 } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(mockDelete).toHaveBeenCalledWith(expect.stringContaining('/v1/artifacts/artifact-1/revision/2/4'), expect.any(Object));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('refuses plain Artifact content under persisted E2EE Account mode before disclosure or update', async () => {
    const store = createAccountArtifactStore({
      credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'e2ee',
    });
    mockGet.mockResolvedValue({ status: 200, data: {
      id: 'artifact-1', header: encodePlainArtifactStoredContent({ kind: 'role.v1' }),
      body: encodePlainArtifactStoredContent({ body: 'private role' }),
      headerVersion: 1, bodyVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      seq: 1, createdAt: 1, updatedAt: 1,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
    } });
    await expect(store.read('artifact-1')).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    await expect(store.update({ artifactId: 'artifact-1', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'role.v1' }, body: 'changed' })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('uses the resource owner mode and retains shared access when a keyless viewer opens a plain grant', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'e2ee' });
    const row = { id: 'shared-1', ownerAccountId: 'other-owner', access: 'edit', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }), body: encodePlainArtifactStoredContent({ body: 'shared' }),
      headerVersion: 1, bodyVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 1 };
    mockGet.mockResolvedValueOnce({ status: 200, data: row });
    await expect(store.read('shared-1')).resolves.toMatchObject({ artifactId: 'shared-1', ownerAccountId: 'other-owner', access: 'edit', body: 'shared' });
    mockGet.mockResolvedValueOnce({ status: 200, data: [row] });
    await expect(store.list()).resolves.toMatchObject({ items: [{ artifactId: 'shared-1', ownerAccountId: 'other-owner', access: 'edit' }] });
  });

  it('opens actual 0.2 Artifact writer bytes through current authenticated read, list, and restore projections', async () => {
    // Produced by the clean sibling at 17ba05df68d4d3d4cad1c1241b58e63805db37ed:
    // apps/cli/src/api/encryption.ts encryptWithDataKeyAndNonce and Protocol's
    // serializedJsonValue.ts, boxBundle.ts, encryptedDataKeyEnvelopeV1.ts.
    const dataEncryptionKey = 'AKwBsiCehjVPuFMje13g9PqxPH/L9DOmHAGTaWF/7PELBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEFp2vL9F4qtFp456Ip/CLBk3sduq0hPJdydpvcpyDvxcC/u5pBQ8RJx6w/6IzrX2B';
    let row = { id: 'retained-0.2', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
      header: 'AAEBAQEBAQEBAQEBAQ3D1uj43px+uLGuchVFGVDEkm6RfN1IfDZnIg4T0WCK4Ih8wul2qaIqCzhu40TM8/10hyBxnIk+zjfCKuxZp+HAkzJVLPYUHU1qOQ7EUGS6LvI+dmsnbtYcvYynDW3Ibd9W',
      body: 'AAICAgICAgICAgICAmGWtlgzisVXczX05IfwpRumehKfFPxZ26hckiVv9O1CoOzi80adELG3z4GDttWiQ8EdZyWk1R/XZ7VZ/aIRpitcie/cum50+I58YJfP2KxJGI0nuiw2TLYejO/u6/bxTVjAoaQIdw==',
      dataEncryptionKey, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: { type: 'dataKey',
      publicKey: decodeBase64('Xf7dO2vUf2+ijuFdlp1bsOpTd01Ii9r53xxuASSz7yI='), machineKey: new Uint8Array(32).fill(3) } },
      getAccountEncryptionMode: async () => 'e2ee' });
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/recipients')
      ? { artifactId: row.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey, callerDataEncryptionKey: dataEncryptionKey, recipients: [] }
      : url.endsWith('/revisions') ? { revisions: [{ bodyVersion: 1, body: row.body, createdAt: 1, sizeBytes: 50 }], retentionCount: 10 }
        : url.endsWith('/v1/artifacts') ? [row] : row }));
    await expect(store.read(row.id)).resolves.toMatchObject({ header: { title: '0.2 note' }, body: 'retained note', access: 'owner' });
    await expect(store.list()).resolves.toMatchObject({ items: [{ header: { title: '0.2 note' }, ownerAccountId: 'owner', access: 'owner' }] });
    mockPost.mockImplementationOnce(async (_url: string, input: Record<string, unknown>) => {
      if (typeof input.header !== 'string') throw new Error('missing encoded restore header');
      row = { ...row, header: input.header, headerVersion: 2, bodyVersion: 2 };
      return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    await expect(store.revisions.restore({ artifactId: row.id, bodyVersion: 1,
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } })).resolves.toMatchObject({ ok: true });
    await expect(store.read(row.id)).resolves.toMatchObject({ header: { title: '0.2 note' }, body: 'retained note',
      revision: { headerVersion: 2, bodyVersion: 2 } });
  });

  it('prepares a late Team recipient on a key-holding editor open through the fenced envelope writer', async () => {
    const viewerSecret = randomBytes(32);
    const viewerPublic = x25519.getPublicKey(viewerSecret);
    const recipientSecret = randomBytes(32);
    const recipientPublic = x25519.getPublicKey(recipientSecret);
    const signingSecret = randomBytes(32);
    const signingPublic = ed25519.getPublicKey(signingSecret);
    const dataKey = randomBytes(32);
    const callerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: viewerPublic, randomBytes }));
    const ownerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipientPublic, randomBytes }));
    const fingerprint = computeContentPublicKeyFingerprint(recipientPublic);
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: viewerPublic, machineKey: viewerSecret } },
      getAccountEncryptionMode: async () => 'e2ee' });
    mockGet.mockImplementation(async (url: string) => url.endsWith('/recipients') ? { status: 200, data: {
      artifactId: 'shared-1', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'e2ee', dataEncryptionKey: ownerEnvelope,
      callerDataEncryptionKey: callerEnvelope, recipients: [{ recipientAccountId: 'late-member', contentPublicKeyFingerprint: fingerprint,
        encryptedDataKey: null, recipientContentPublicKeyFingerprint: null, contentKey: { status: 'available',
          accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(recipientPublic),
          contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: recipientPublic })) } }],
    } } : { status: 200, data: { id: 'shared-1', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'e2ee',
      header: encodeBase64(encryptWithDataKey({ kind: 'role.v1' }, dataKey)), body: encodeBase64(encryptWithDataKey({ body: 'role' }, dataKey)),
      dataEncryptionKey: callerEnvelope, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } });
    mockPost.mockResolvedValue({ status: 200, data: { appliedRecipientAccountIds: ['late-member'], skippedRecipientAccountIds: [] } });
    await expect(store.read('shared-1')).resolves.toMatchObject({ body: 'role', access: 'edit' });
    const request = mockPost.mock.calls[0]?.[1];
    expect(request.expectedDataEncryptionKey).toBe(ownerEnvelope);
    expect(request.recipientKeyEnvelopes).toHaveLength(1);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(request.recipientKeyEnvelopes[0].encryptedDataKey), recipientSecretKeyOrSeed: recipientSecret })).toEqual(new Uint8Array(dataKey));

    // A key-holder opening history must deliver the same key to a late member,
    // even when it does not open the current Artifact through read().
    const readCurrent = mockGet.getMockImplementation();
    if (!readCurrent) throw new Error('missing HTTP fixture');
    mockGet.mockImplementation(async (url: string) => url.endsWith('/revisions') ? { status: 200, data: {
      revisions: [{ bodyVersion: 1, body: encodeBase64(encryptWithDataKey({ body: 'prior role' }, dataKey)), createdAt: 1, sizeBytes: 20 }], retentionCount: 10,
    } } : readCurrent(url));
    mockPost.mockClear();
    await expect(store.revisions.list({ artifactId: 'shared-1' })).resolves.toMatchObject({ revisions: [{ body: 'prior role' }] });
    const revisionRecipient = mockPost.mock.calls[0]?.[1]?.recipientKeyEnvelopes?.[0];
    expect(revisionRecipient).toMatchObject({ recipientAccountId: 'late-member' });
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(revisionRecipient.encryptedDataKey), recipientSecretKeyOrSeed: recipientSecret }))
      .toEqual(new Uint8Array(dataKey));
  });
});
