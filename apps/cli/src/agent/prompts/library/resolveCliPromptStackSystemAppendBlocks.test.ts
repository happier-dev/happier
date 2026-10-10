import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';

// Load/transform the substantial real Action owner before timed hooks, under
// an isolated OS Home. Each test still resets modules and admits its own Home.
const actionOwnerLoadHome = await createTempDir('happier-prompt-owner-load-');
vi.stubEnv('HAPPIER_HOME_DIR', actionOwnerLoadHome);
for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_ID', 'HAPPIER_WEBAPP_URL']) vi.stubEnv(key, '');
try {
  await import('@/session/actions/createCliActionDeps');
} finally {
  vi.resetModules();
  vi.unstubAllEnvs();
  await removeTempDir(actionOwnerLoadHome);
}

// Real Axios, credentials, Home selection and codecs run above HTTP/FS peers.
let taskHome: string;
const peers: Server[] = [];
beforeEach(async () => {
  vi.resetModules();
  taskHome = await createTempDir('happier-qualified-prompts-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  for (const key of [
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_SERVER_ID',
    'HAPPIER_WEBAPP_URL',
  ])
    vi.stubEnv(key, '');
});
afterEach(async () => {
  for (const peer of peers.splice(0)) {
    peer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  vi.unstubAllEnvs();
  await removeTempDir(taskHome);
});
function entry(id: string, serverId?: string): PromptStackEntryV1 {
  return {
    id,
    ref: { kind: 'doc', artifactId: id, ...(serverId ? { serverId } : {}) },
    enabled: true,
    required: true,
    placement: 'system_append',
  };
}
async function home(id: string, token: string, accountMarkdownByToken?: Readonly<Record<string, string>>) {
  function row(artifactId: string, markdown: string, kind = 'prompt_doc.v2') {
    return {
      id: artifactId,
      ownerAccountId: id,
      access: 'owner',
      encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({
        v: 1,
        kind,
        title: artifactId,
      }),
      body: encodePlainArtifactStoredContent({
        body: JSON.stringify({
          v: 1,
          markdown,
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    };
  }
  const rows = new Map<string, ReturnType<typeof row>>();
  const requests: string[] = [];
  let responseBytes = 0;
  let status = 200;
  const peer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    let data: unknown;
    let code = 200;
    const requestToken = request.headers.authorization?.slice('Bearer '.length);
    const accountMarkdown = requestToken ? accountMarkdownByToken?.[requestToken] : undefined;
    if (request.headers.authorization !== `Bearer ${token}` && accountMarkdown === undefined) {
      code = 401;
      data = { error: 'wrong_account' };
    } else if (url.pathname === '/v1/account/profile') data = { id };
    else if (url.pathname === '/v1/account/encryption/currentness') data = {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    };
    else if (url.pathname === '/v2/account/settings') data = { content: { t: 'plain', v: {} }, version: 1 };
    else if (url.pathname === '/v2/sessions/lookup-by-tags') data = { sessions: [] };
    else if (url.pathname === '/v1/account/encryption')
      data = { mode: 'plain', updatedAt: 0 };
    else if (url.pathname === '/v1/artifacts') {
      const sorted = [...rows.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
      );
      const cursor = url.searchParams.get('cursor');
      const last: unknown = cursor
        ? JSON.parse(Buffer.from(cursor, 'base64url').toString())
        : null;
      const after =
        last && typeof last === 'object'
          ? sorted.findIndex((item) => item.id === Reflect.get(last, 'id')) + 1
          : 0;
      data = sorted
        .slice(after, after + Number(url.searchParams.get('limit') ?? 500))
        .map(({ body: _body, bodyVersion: _version, ...header }) => header);
    } else {
      code = status;
      const found = rows.get(
        decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length)),
      );
      if (code === 200 && !found) code = 404;
      data = code === 200 ? found && accountMarkdown !== undefined ? row(found.id, accountMarkdown) : found : { error: 'unavailable' };
    }
    response.writeHead(code, { 'Content-Type': 'application/json' });
    const encoded = JSON.stringify(data);
    responseBytes += Buffer.byteLength(encoded);
    response.end(encoded);
  });
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
  peers.push(peer);
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('missing_http_address');
  const url = `http://127.0.0.1:${address.port}`;
  await mkdir(join(taskHome, 'servers', id), { recursive: true });
  await writeFile(
    join(taskHome, 'servers', id, 'access.key'),
    JSON.stringify({ token }),
  );
  return {
    id,
    url,
    requests,
    get responseBytes() { return responseBytes; },
    rows,
    set: (artifactId: string, markdown: string, kind?: string) => {
      const previous = rows.get(artifactId);
      return rows.set(artifactId, { ...row(artifactId, markdown, kind),
        bodyVersion: (previous?.bodyVersion ?? 0) + 1, seq: (previous?.seq ?? 0) + 1,
        updatedAt: (previous?.updatedAt ?? 0) + 1 });
    },
    fail: (code: number) => {
      status = code;
    },
  };
}
async function profiles(homes: readonly Awaited<ReturnType<typeof home>>[]) {
  await writeFile(
    join(taskHome, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      activeServerId: homes[0]!.id,
      servers: Object.fromEntries(
        homes.map((item) => [
          item.id,
          {
            id: item.id,
            name: item.id,
            serverUrl: item.url,
            webappUrl: item.url,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        ]),
      ),
    }),
  );
}
describe('CLI qualified current Artifact prompt preparation', () => {
  describe('ordinary Instructions birth admission', () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alpha' })).toString('base64url')}.signature`;
    let a: Awaited<ReturnType<typeof home>>;
    let protocol: typeof import('@happier-dev/protocol');
    let createCliActionDeps: typeof import('@/session/actions/createCliActionDeps')['createCliActionDeps'];
    let createActionSettingsProvider: typeof import('@/settings/actionsSettingsProvider')['createActionSettingsProvider'];
    beforeEach(async () => {
      a = await home('alpha', token);
      await profiles([a]);
      // Configuration consumes the saved Home. Compile/load the real owner as
      // fixture setup, outside the timed network-admission assertion.
      protocol = await import('@happier-dev/protocol');
      ({ createCliActionDeps } = await import('@/session/actions/createCliActionDeps'));
      ({ createActionSettingsProvider } = await import('@/settings/actionsSettingsProvider'));
    });
    it.each(['missing', 'unavailable'] as const)('refuses ordinary selected Instructions %s before a provider spawn', async state => {
    if (state === 'unavailable') { a.set('instructions', 'Required remit'); a.fail(503); }
    const { createActionExecutor, SessionSpawnNewInputV2Schema, accountSettingsParse } = protocol;
    const spawn = vi.fn(async () => ({ success: false, error: 'Unexpected spawn' }));
    const executor = createActionExecutor(createCliActionDeps({
      token, credentials: { token, encryption: null }, sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: a.id, serverHttpBaseUrl: a.url,
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
      sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce: vi.fn(async () => ({ status: 'not_found' as const })) },
      },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: `instructions-${state}`,
      executionTarget: { serverId: a.id, machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, promptStack: [entry('instructions', a.id)],
    });
    const result = await executor.execute('session.spawn_new', input, { surface: 'cli', authority: 'present_user', serverId: a.id,
      presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: `instructions-${state}` });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false,
      errorCode: state === 'unavailable' ? 'preparation_pending' : 'attachment_unavailable' });
    expect(spawn).not.toHaveBeenCalled();
    // Birth resolves the selected qualified document, not the optional catalog listing.
    expect(a.requests, JSON.stringify(a.requests)).toContain('/v1/artifacts/instructions');
    });
  });

  describe('private requester Home admission', () => {
    let bob: Awaited<ReturnType<typeof home>>;
    let alice: Awaited<ReturnType<typeof home>>;
    let withReader: typeof import('./resolveCliPromptStackSystemAppendBlocks').withCliPromptLibraryArtifactReader;
    beforeEach(async () => {
      bob = await home('bob-home', 'bob-token');
      alice = await home('alice-home', 'alice-token');
      await profiles([bob, alice]);
      bob.set('bob-doc', 'Bob current prompt');
      alice.set('alice-doc', 'Alice private prompt');
      // Load Configuration after the saved Homes exist, before the HTTP-only test phase.
      ({ withCliPromptLibraryArtifactReader: withReader } = await import('./resolveCliPromptStackSystemAppendBlocks'));
    });
    it('never borrows a custodian saved Home for a private requester prompt reference', async () => {
      const credentials = { token: 'bob-token', encryption: null,
        requesterSessionCredentialScope: { serverId: bob.id, serverHttpBaseUrl: bob.url } } as const;
      await withReader(async reader => {
        expect(await reader.readArtifact({ kind: 'doc', artifactId: 'bob-doc', serverId: bob.id }))
          .toMatchObject({ body: expect.stringContaining('Bob current prompt') });
        await expect(reader.readArtifact({ kind: 'doc', artifactId: 'alice-doc', serverId: alice.id }))
          .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
      }, { credentials, serverId: bob.id });
      expect(alice.requests).toEqual([]);
    });
  });
  describe('admitted inventory', () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alpha' })).toString('base64url')}.signature`;
    let a: Awaited<ReturnType<typeof home>>;
    let resolve: typeof import('./resolveCliPromptStackSystemAppendBlocks').resolveCliPromptStackSystemAppendBlocks;
    beforeEach(async () => {
      a = await home('alpha', token);
      await profiles([a]);
      a.set('doc', 'first');
      a.set('empty', '');
      // Load Configuration after the real saved Home exists, outside the
      // measured test phase, which contains only actual preparation.
      ({ resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks'));
    });
    it('publishes qualified admission facts with current revisions and valid-empty documents on each preparation', async () => {
      const settings = {
        promptStacksV1: {
          v: 1,
          surfaces: { coding: [entry('doc'), entry('empty')], voice: [], profilesById: {} },
        },
      };
      const args = { surface: 'coding' as const, credentials: { token, encryption: null }, settings };
      const admitted = (id: string, bodyVersion: number, outcome: 'ready' | 'valid-empty') => ({
        entryId: id, layer: 'account', scope: { serverId: a.id, accountId: a.id },
        ref: { kind: 'doc', artifactId: id, serverId: a.id }, revision: { headerVersion: 1, bodyVersion }, outcome,
      });
      expect(await resolve(args)).toEqual({ blocks: ['first'], admittedEntries: [admitted('doc', 1, 'ready'), admitted('empty', 1, 'valid-empty')] });
      a.set('doc', 'second');
      expect(await resolve(args)).toEqual({ blocks: ['second'], admittedEntries: [admitted('doc', 2, 'ready'), admitted('empty', 1, 'valid-empty')] });
      expect(await resolve(args)).toEqual({ blocks: ['second'], admittedEntries: [admitted('doc', 2, 'ready'), admitted('empty', 1, 'valid-empty')] });
      expect(a.requests.filter(path => path === '/v1/artifacts/doc')).toHaveLength(3);
    });
  });
  it('reads current edited content on every preparation and shares repeated references only within that preparation', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'first');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    const args = { surface: 'coding' as const, accountEntries: [entry('doc'), { ...entry('doc'), id: 'duplicate-ref' }] };
    const started = performance.now();
    expect((await resolve(args)).blocks).toEqual(['first', 'first']);
    const firstPrepared = performance.now();
    a.set('doc', 'second');
    expect((await resolve(args)).blocks).toEqual(['second', 'second']);
    const editedPrepared = performance.now();
    expect((await resolve(args)).blocks).toEqual(['second', 'second']);
    const unchangedPrepared = performance.now();
    expect(a.requests.filter(path => path === '/v1/artifacts/doc')).toHaveLength(3);
    console.info('D11 loopback plaintext preparation', {
      firstMs: firstPrepared - started,
      editedMs: editedPrepared - firstPrepared,
      unchangedMs: unchangedPrepared - editedPrepared,
      detailReads: a.requests.filter(path => path.startsWith('/v1/artifacts/')).length,
      responseBytes: a.responseBytes,
    });
  });
  it('prepares the current unsaved environment Home without admitting an unknown foreign Home', async () => {
    const current = await home('unsaved', 'bound-token');
    // No settings.json is written: a current environment Home need not be a
    // saved profile, and its explicit Account credentials own this preparation.
    vi.stubEnv('HAPPIER_SERVER_URL', current.url);
    current.set('doc', 'unsaved current Home');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    const credentials = { token: 'bound-token', encryption: null };
    expect(await resolve({ surface: 'coding', credentials,
      accountEntries: [entry('doc')],
    })).toMatchObject({ blocks: ['unsaved current Home'] });
    const previousRequests = [...current.requests];
    await expect(resolve({ surface: 'coding', credentials,
      accountEntries: [entry('doc', 'unknown-foreign-home')],
    })).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
    expect(current.requests).toEqual(previousRequests);
  });
  it('qualifies identical ids to distinct Homes without forwarding active credentials', async () => {
    const a = await home('alpha', 'active-token');
    const b = await home('bravo', 'other-token');
    await profiles([a, b]);
    a.set('same', 'alpha');
    b.set('same', 'bravo');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(
      await resolve({
        surface: 'coding',
        credentials: { token: 'active-token', encryption: null },
        accountEntries: [entry('same', 'alpha'), entry('same', 'bravo')],
      }),
    ).toMatchObject({ blocks: ['alpha', 'bravo'] });
  });
  it('keeps explicit credentials for a bound non-active Home and saved credentials for another Home', async () => {
    const a = await home('alpha', 'active-token');
    const b = await home('bravo', 'saved-token', { 'bound-token': 'bound Account X', 'saved-token': 'saved Account Y' });
    await profiles([a, b]);
    a.set('same', 'alpha saved Account');
    b.set('same', 'saved Account Y');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(await resolve({ surface: 'coding', serverId: 'bravo',
      credentials: { token: 'bound-token', encryption: null }, accountEntries: [entry('same', 'bravo')],
    })).toMatchObject({ blocks: ['bound Account X'] });
    expect(await resolve({ surface: 'coding', serverId: 'bravo',
      credentials: { token: 'bound-token', encryption: null },
      accountEntries: [entry('same', 'bravo'), entry('same', 'alpha')],
    })).toMatchObject({ blocks: ['bound Account X', 'alpha saved Account'] });
  });
  it('distinguishes retryable unavailability from confirmed absence and recovers', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'first');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    const args = { surface: 'coding' as const, accountEntries: [entry('doc')] };
    a.fail(503);
    await expect(resolve(args)).rejects.toMatchObject({
      status: 'preparation_pending',
      reason: 'unavailable',
    });
    a.fail(404);
    await expect(resolve(args)).rejects.toMatchObject({
      status: 'attachment_unavailable',
      reason: 'not_found',
    });
    a.fail(200);
    expect((await resolve(args)).blocks).toEqual(['first']);
  });
  it('suppresses required memory by header only beyond the first page', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('memory', 'must not load', 'memory_doc.v1');
    for (let index = 0; index < 500; index++)
      a.set(`z-other-${index}`, 'never load');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(
      await resolve({
        surface: 'coding',
        accountEntries: [entry('memory')],
        memoryEnabled: false,
      }),
    ).toEqual({ blocks: [], admittedEntries: [] });
    expect(
      a.requests.filter((path) => path === '/v1/artifacts/memory'),
    ).toEqual([]);
  });
  it('skips disabled inherited selections before Account HTTP', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(
      await resolve({
        surface: 'coding',
        accountEntries: [entry('missing')],
        disabledInheritedEntryIds: ['missing'],
      }),
    ).toEqual({ blocks: [], admittedEntries: [] });
    expect(a.requests).toEqual([]);
  });
  it('does not load a body when the current header is unreadable', async () => {
    const a = await home('alpha', 'active-token'); await profiles([a]); a.set('doc', 'must not load');
    const row = a.rows.get('doc')!; a.rows.set('doc', { ...row, header: encodePlainArtifactStoredContent({}) });
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    await expect(resolve({ surface: 'coding', accountEntries: [entry('doc')], memoryEnabled: false }))
      .rejects.toMatchObject({ status: 'attachment_unavailable', reason: 'locked' });
    expect(a.requests.filter(path => path === '/v1/artifacts/doc')).toEqual([]);
  });
});
