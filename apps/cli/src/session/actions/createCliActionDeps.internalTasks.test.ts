import axios from 'axios';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { createActionExecutor } from '@happier-dev/protocol';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp } from './widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encrypt, decryptResult, encodeBase64, decodeBase64 } from '@/api/encryption';
import { TaskResourceV1Schema, TaskResourceMutateRequestV1Schema, TaskAccessGrantSetRequestV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';
import { TODO_LABEL_CATALOG_KEY_V1 } from '@happier-dev/protocol/todos/todoSessionLinkV1';

const scope = { serverId: 'task-home', accountId: 'task-account' };
const token = `header.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`;
const encode = (value: unknown) => Buffer.from(JSON.stringify({ t: 'plain', v: value })).toString('base64');
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString()).v;
function unsupportedTaskResourceApi() {
  vi.spyOn(axios, 'request').mockImplementation(async configuration => ({ status: 404,
    data: { statusCode: 404, error: 'Not Found', message: `Route ${configuration.method}:${configuration.url} not found` } }));
}
afterEach(() => vi.restoreAllMocks());

it('runs share, collaborator read/edit/transition/link and next-request revoke through the public executor and real HTTP adapter', async () => {
  const app = fastify(), endpoint = 'http://shared-task.test';
  const features = registerAccountHomeHttp(app, { accountId: scope.accountId, serverId: scope.serverId });
  const peerToken = `header.${Buffer.from(JSON.stringify({ sub: 'peer' })).toString('base64url')}.signature`;
  let granted = false, resource = TaskResourceV1Schema.parse({ ownerAccountId: scope.accountId, taskId: 'shared', version: 1,
    content: { t: 'plain', v: { id: 'shared', title: 'Shared task', notes: 'Retain', done: false, createdAt: 1, updatedAt: 1 } },
    access: 'owner', encryptionMode: 'plain', encryptedDataKey: null });
  const path = `/v1/tasks/${scope.accountId}/shared`;
  const isPeer = (authorization: string | undefined) => authorization === `Bearer ${peerToken}`;
  app.get(path, async (request, reply) => isPeer(request.headers.authorization) && !granted
    ? reply.code(404).send({ error: 'task_not_found' }) : { ...resource, access: isPeer(request.headers.authorization) ? 'edit' : 'owner' });
  app.put(path, async (request, reply) => {
    if (isPeer(request.headers.authorization) && !granted) return reply.code(404).send({ error: 'task_not_found' });
    const mutation = TaskResourceMutateRequestV1Schema.parse(request.body);
    if (mutation.expectedVersion !== resource.version) return reply.code(409).send({ error: 'task_version_conflict' });
    resource = TaskResourceV1Schema.parse({ ...resource, content: mutation.content, version: resource.version + 1 });
    return { ...resource, access: isPeer(request.headers.authorization) ? 'edit' : 'owner' };
  });
  app.put(`${path}/grants`, async request => {
    const grant = TaskAccessGrantSetRequestV1Schema.parse(request.body);
    expect(grant).toEqual({ principal: { kind: 'account', accountId: 'peer' }, accessLevel: 'edit' });
    granted = true; return { changed: true };
  });
  app.delete(`${path}/grants`, async () => { granted = false; return { changed: true }; });
  app.get(`${path}/grants`, async () => ({ ownerAccountId: scope.accountId, taskId: 'shared', access: 'owner', grants: [] }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
  const executor = (bearer: string) => createActionExecutor(createCliActionDeps({ token: bearer, credentials: { token: bearer, encryption: null },
    sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: scope.serverId, serverHttpBaseUrl: endpoint }));
  const owner = executor(token), peer = executor(peerToken), context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true } as const;
  const address = { taskId: 'shared', ownerAccountId: scope.accountId }, viewerScope = { serverId: scope.serverId, accountId: 'peer' };
  try {
    expect(await owner.execute('tasks.internal.share', { scope, ...address, principal: { kind: 'account', accountId: 'peer' }, accessLevel: 'edit' }, context))
      .toMatchObject({ ok: true, result: { status: 'applied', todo: { ownerAccountId: scope.accountId } } });
    expect(await peer.execute('tasks.internal.read', address, context)).toMatchObject({ ok: true, result: { status: 'applied', scope: viewerScope, todo: { title: 'Shared task', access: 'edit' } } });
    expect(await peer.execute('tasks.internal.edit', { scope: viewerScope, ...address, fields: { title: 'Peer edit' } }, context)).toMatchObject({ ok: true, result: { status: 'applied' } });
    expect(await peer.execute('tasks.internal.transition', { scope: viewerScope, ...address, state: 'completed' }, context)).toMatchObject({ ok: true, result: { status: 'applied', todo: { done: true } } });
    expect(await peer.execute('tasks.internal.session.link', { scope: viewerScope, ...address, session: { ...viewerScope, sessionId: 'session' } }, context))
      .toMatchObject({ ok: true, result: { status: 'linked' } });
    expect(await owner.execute('tasks.internal.read', address, context)).toMatchObject({ ok: true, result: { status: 'applied', todo: { title: 'Peer edit', notes: 'Retain', done: true, linkedSessions: expect.any(Object) } } });
    expect(await owner.execute('tasks.internal.unshare', { scope, ...address, principal: { kind: 'account', accountId: 'peer' } }, context)).toMatchObject({ ok: true, result: { status: 'access', grants: [] } });
    expect(await peer.execute('tasks.internal.read', address, context)).toMatchObject({ ok: true, result: { status: 'refused', reason: 'task_not_found' } });
    expect(await peer.execute('tasks.internal.edit', { scope: viewerScope, ...address, fields: { title: 'Denied' } }, context)).toMatchObject({ ok: true, result: { status: 'refused', reason: 'task_not_found' } });
    expect(resource.content).toMatchObject({ t: 'plain', v: { title: 'Peer edit' } });
  } finally { restore(); await app.close(); }
});

it.each(['cli', 'agent'] as const)('persists personal reorder through the public %s executor without a Machine', async surface => {
  const app = fastify();
  const endpoint = 'http://task-reorder.test';
  const features = registerAccountHomeHttp(app, { accountId: scope.accountId, serverId: scope.serverId });
  const rows = new Map<string, { value: string; version: number }>([
    ['todo.index', { value: encode({ undoneOrder: ['first', 'second'], completedOrder: [] }), version: 1 }],
    ...['first', 'second'].map(id => [`todo.${id}`, { value: encode({ id, title: id, done: false, createdAt: 1, updatedAt: 1 }), version: 1 }] as const),
  ]);
  app.get('/v1/kv', async () => ({ items: [...rows].map(([key, row]) => ({ key, ...row })) }));
  app.get('/v1/kv/:key', async (request, reply) => {
    const { key } = z.strictObject({ key: z.string() }).parse(request.params);
    return rows.has(key) ? { key, ...rows.get(key)! } : reply.code(404).send({ error: 'not_found' });
  });
  app.post('/v1/kv', async (request, reply) => {
    const { mutations } = z.strictObject({ mutations: z.array(z.strictObject({ key: z.string(), value: z.string(), version: z.number() })) }).parse(request.body);
    const errors = mutations.filter(row => row.version !== (rows.get(row.key)?.version ?? -1)).map(row => ({
      key: row.key, error: 'version-mismatch', value: rows.get(row.key)?.value ?? null, version: rows.get(row.key)?.version ?? -1,
    }));
    if (errors.length) return reply.code(409).send({ success: false, errors });
    const results = mutations.map(row => { const version = row.version + 1; rows.set(row.key, { value: row.value, version }); return { key: row.key, version }; });
    return { success: true, results };
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
  const create = () => createCliActionExecutorFromCredentials({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
    serverId: scope.serverId, serverIdentityId: scope.serverId, serverApiUrl: endpoint });
  // Approval policy is tested separately with real Artifacts; this host-private
  // waived context isolates the Account placement and raw KV/CAS contract.
  const context = { surface, authority: 'account_automation', bypassApprovals: true, runtimeAccountId: scope.accountId,
    serverId: scope.serverId, serverIdentityId: scope.serverId } as const;
  try {
    expect(await create().execute('tasks.internal.reorder', { scope, sourceId: 'second', position: { anchorId: 'first', placement: 'before' } }, context))
      .toMatchObject({ ok: true, result: { status: 'applied' } });
    expect(decode(rows.get('todo.index')!.value)).toMatchObject({ undoneOrder: ['second', 'first'] });
    expect(await create().execute('tasks.internal.list', {}, context))
      .toMatchObject({ ok: true, result: { status: 'ok', undoneOrder: ['second', 'first'] } });
  } finally { restore(); await app.close(); }
});

it('executes public task Actions against released Account rows, rebasing atomic index changes and refusing ambiguous create replay', async () => {
  unsupportedTaskResourceApi();
  const rows = new Map<string, { value: string; version: number }>([
    ['todo.index', { value: encode({ undoneOrder: ['old'], completedOrder: [] }), version: 1 }],
    ['todo.old', { value: encode({ id: 'old', title: 'Predecessor task', done: false, createdAt: 1, updatedAt: 1 }), version: 1 }],
  ]);
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (parsed.pathname === '/v1/kv') return { status: 200, data: { items: [...rows].map(([key, row]) => ({ key, ...row })) } };
    const key = decodeURIComponent(parsed.pathname.slice('/v1/kv/'.length));
    return rows.has(key) ? { status: 200, data: { key, ...rows.get(key)! } } : { status: 404 };
  });
  let loseCreateResponse = false;
  let concurrentIndexChange = true;
  const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
    const { mutations } = body as { mutations: { key: string; value: string; version: number }[] };
    if (concurrentIndexChange && mutations.some(mutation => mutation.key === 'todo.index')) {
      concurrentIndexChange = false;
      rows.set('todo.index', { value: encode({ undoneOrder: ['concurrent', 'old'], completedOrder: [] }), version: 2 });
      rows.set('todo.concurrent', { value: encode({ id: 'concurrent', title: 'Concurrent task', done: false, createdAt: 2, updatedAt: 2 }), version: 1 });
    }
    const errors = mutations.filter(mutation => mutation.version !== (rows.get(mutation.key)?.version ?? -1))
      .map(mutation => ({ key: mutation.key, error: 'version-mismatch', value: rows.get(mutation.key)?.value ?? null, version: rows.get(mutation.key)?.version ?? -1 }));
    if (errors.length) return { status: 409, data: { success: false, errors } };
    const results = mutations.map(mutation => {
      const version = mutation.version + 1;
      rows.set(mutation.key, { value: mutation.value, version });
      return { key: mutation.key, version };
    });
    if (loseCreateResponse) throw new Error('response lost after acceptance');
    return { status: 200, data: { success: true, results } };
  });
  const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
    sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: scope.serverId, serverHttpBaseUrl: 'https://task-home.test' }));
  const context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true } as const;
  expect(await executor.execute('tasks.internal.list', {}, context)).toMatchObject({ ok: true, result: { status: 'ok', scope,
    todos: [{ id: 'old', state: 'unstarted' }], undoneOrder: ['old'] } });
  expect(await executor.execute('tasks.internal.create', { fields: { title: 'New task', notes: 'Notes' } }, context))
    .toMatchObject({ ok: true, result: { status: 'refused', reason: 'task_conflict' } });
  // A known atomic refusal applied nothing. A fresh explicit invocation can now use the current index.
  const created = await executor.execute('tasks.internal.create', { fields: { title: 'New task', notes: 'Notes' } }, context);
  expect(created).toMatchObject({ ok: true, result: { status: 'applied', todo: { title: 'New task', notes: 'Notes', state: 'unstarted' } } });
  const index = decode(rows.get('todo.index')!.value);
  expect(index.undoneOrder.slice(0, 2)).toEqual(['concurrent', 'old']);
  expect(index.undoneOrder).toHaveLength(3);
  expect(await executor.execute('tasks.internal.transition', { scope, taskId: 'old', state: 'completed' }, context))
    .toMatchObject({ ok: true, result: { status: 'applied', todo: { done: true, state: 'completed' } } });
  expect(decode(rows.get('todo.index')!.value)).toMatchObject({ completedOrder: ['old'] });
  expect(await executor.execute('tasks.internal.edit', { scope, taskId: 'old', fields: { notes: 'Retained', title: 'Renamed' } }, context))
    .toMatchObject({ ok: true, result: { status: 'applied', todo: { done: true, state: 'completed', notes: 'Retained' } } });
  loseCreateResponse = true;
  const callsBefore = post.mock.calls.length;
  expect(await executor.execute('tasks.internal.create', { fields: { title: 'Unknown acceptance' } }, context))
    .toMatchObject({ ok: true, result: { status: 'uncertain' } });
  expect(post.mock.calls.length - callsBefore).toBe(1);
});

it('fails explicit on mode disagreement and refuses cross-Account mutations before HTTP writes', async () => {
  unsupportedTaskResourceApi();
  vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/currentness')
    ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
    : { status: 200, data: { items: [{ key: 'todo.old', value: 'encrypted-predecessor-bytes', version: 1 }] } });
  const post = vi.spyOn(axios, 'post');
  const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
    sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: scope.serverId, serverHttpBaseUrl: 'https://task-home.test' }));
  const context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true } as const;
  expect(await executor.execute('tasks.internal.list', {}, context)).toMatchObject({ ok: true, result: { status: 'failed' } });
  expect(await executor.execute('tasks.internal.edit', { scope: { ...scope, accountId: 'other' }, taskId: 'old', fields: { title: 'No' } }, context))
    .toMatchObject({ ok: true, result: { status: 'refused', reason: 'task_scope_mismatch' } });
  expect(post).not.toHaveBeenCalled();
});

it('opens predecessor E2EE records and retains their encryption and bare Session links through a public edit', async () => {
  unsupportedTaskResourceApi();
  const secret = new Uint8Array(32).fill(7);
  const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
  let version = 1;
  const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
  let encoded = encodeBase64(encrypt(secret, 'legacy', { id: 'old', title: 'Encrypted predecessor', done: false,
    createdAt: 1, updatedAt: 1, linkedSessions: { 'bare-session': { title: 'Old Session', linkedAt: 1 } } }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current', contentKeyFingerprint: fingerprint, updatedAt: 1 } };
    if (path === `/v1/kv/${TODO_LABEL_CATALOG_KEY_V1}`) return { status: 404 };
    const row = { key: 'todo.old', value: encoded, version };
    if (path === '/v1/kv') return { status: 200, data: { items: [row] } };
    if (path === '/v1/kv/todo.old') return { status: 200, data: row };
    throw new Error('An edit must not depend on the unrelated ordering record');
  });
  vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
    const mutations = (body as { mutations: { key: string; value: string; version: number }[] }).mutations;
    expect(mutations.map(row => row.key)).toEqual(['todo.old']);
    expect(mutations[0]!.version).toBe(version);
    encoded = mutations[0]!.value;
    expect(decryptResult(machineKey, 'dataKey', decodeBase64(encoded))).toMatchObject({ status: 'authenticated', value: {
      title: 'Encrypted predecessor', linkedSessions: { 'bare-session': { title: 'Old Session', linkedAt: 1 } },
    } });
    version += 1;
    return { status: 200, data: { success: true, results: [{ key: 'todo.old', version }] } };
  });
  const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: { type: 'legacy', secret } },
    sessionId: 'cli-global', mode: 'e2ee', ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, serverId: scope.serverId, serverHttpBaseUrl: 'https://task-home.test' }));
  const context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true } as const;
  expect(await executor.execute('tasks.internal.list', {}, context)).toMatchObject({ ok: true, result: { status: 'ok', scope,
    todos: [{ id: 'old', title: 'Encrypted predecessor', state: 'unstarted' }] } });
  expect(await executor.execute('tasks.internal.edit', { scope, taskId: 'old', fields: { notes: 'Private task note' } }, context))
    .toMatchObject({ ok: true, result: { status: 'applied' } });
  expect(version).toBe(3);
  expect(decryptResult(machineKey, 'dataKey', decodeBase64(encoded))).toMatchObject({ status: 'authenticated', value: {
    notes: 'Private task note', linkedSessions: { 'bare-session': { title: 'Old Session', linkedAt: 1 } },
  } });
});
