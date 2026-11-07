import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { createTaskResourceClientV1, executeInternalTaskAction, executeInternalTaskReorder, type TaskResourceClientOptionsV1 } from './todoActionOperationsV1.js';
import { TaskResourceV1Schema, TaskAccessGrantSetRequestV1Schema, TaskAccessRecipientCensusResponseV1Schema, type TaskResourceV1 } from './taskResourceV1.js';
import { signAccountContentKeyBindingV1 } from '../crypto/accountContentKeyBindingV1.js';
import { openEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { packSessionDataKeyBundleV0, readSessionDataKeyBundleV0 } from '../crypto/sessionDataKeyBundleV0.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { createTodoItemV1, updateTodoItemV1, transitionTodoItemV1 } from './todoSessionLinkV1.js';
import { InternalTaskListOutputSchema, InternalTaskReadOutputSchema } from '../actions/internalTaskActions.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { ResourceAccessGrantRowV1Schema } from '../teams/resourceGrantAccessV1.js';
import { TODO_LABEL_CATALOG_KEY_V1 } from './todoLabelColoursV1.js';

function recipient(accountId: string) {
  const signingSecret = randomBytes(32), signingPublic = ed25519.getPublicKey(signingSecret);
  const secret = randomBytes(32), publicKey = x25519.getPublicKey(secret);
  return { secret, row: { recipientAccountId: accountId,
    contentKey: { status: 'available' as const, accountSigningPublicKey: bytesToHex(signingPublic), contentPublicKey: encodeBase64(publicKey),
      contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: publicKey })) },
    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey), encryptedDataKey: null, recipientContentPublicKeyFingerprint: null } };
}
async function seal(value: unknown, key: Uint8Array): Promise<string> {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  return encodeBase64(packSessionDataKeyBundleV0({ nonce, ciphertext: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]), authTag: cipher.getAuthTag() }));
}
async function open(ciphertext: string, key: Uint8Array): Promise<unknown> {
  const parsed = readSessionDataKeyBundleV0(decodeBase64(ciphertext));
  if (parsed.status !== 'ready') throw new Error('Invalid AES bundle');
  const cipher = createDecipheriv('aes-256-gcm', key, parsed.nonce); cipher.setAuthTag(parsed.authTag);
  return JSON.parse(Buffer.concat([cipher.update(parsed.ciphertext), cipher.final()]).toString());
}
function fixture(mode: 'plain' | 'e2ee') {
  const owner = recipient('owner'), peer = recipient('peer'), accountKey = randomBytes(32);
  const todo = createTodoItemV1({ id: 'task', title: 'Original', notes: 'Private notes', links: [{ url: 'https://example.com' }] }, 1);
  const writes: { method: string; body: unknown }[] = [];
  const envelopes = new Map<string, string>();
  let row: TaskResourceV1, revoked = false;
  const initialized = (async () => { row = TaskResourceV1Schema.parse({ ownerAccountId: 'owner', taskId: 'task', version: 1,
    content: mode === 'plain' ? { t: 'plain', v: todo } : { t: 'encrypted', c: await seal(todo, accountKey) },
    access: 'owner', encryptionMode: mode, encryptedDataKey: null }); })();
  const options = (accountId: 'owner' | 'peer'): TaskResourceClientOptionsV1 => ({ accountId, requireCurrent: () => {},
    crypto: { randomBytes, seal, open, openAccount: async ciphertext => ({ value: await open(ciphertext, accountKey), needsReseal: false }), sealAccount: value => seal(value, accountKey),
      openKey: async envelope => openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope), recipientSecretKeyOrSeed: accountId === 'owner' ? owner.secret : peer.secret }) },
    request: async request => {
      await initialized;
      if (accountId === 'peer' && revoked) return { status: 404, body: { error: 'task_not_found' } };
      if (request.path.endsWith('/recipients/census')) return { status: 200, body: TaskAccessRecipientCensusResponseV1Schema.parse({
        ownerAccountId: 'owner', taskId: 'task', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: envelopes.get('owner') ?? null, callerDataEncryptionKey: envelopes.get(accountId) ?? null,
        recipients: [owner.row, peer.row].map(item => ({ ...item, encryptedDataKey: envelopes.get(item.recipientAccountId) ?? null,
          recipientContentPublicKeyFingerprint: envelopes.has(item.recipientAccountId) ? item.contentPublicKeyFingerprint : null })),
      }) };
      if (request.method === 'PUT' && request.path.endsWith('/grants')) {
        writes.push({ method: request.method, body: request.body });
        const body = TaskAccessGrantSetRequestV1Schema.parse(request.body);
        if (body.promotion) {
          row = { ...row, content: body.promotion.content, version: row.version + 1 };
          for (const envelope of [body.promotion.ownerKeyEnvelope, ...body.promotion.recipientKeyEnvelopes]) envelopes.set(envelope.recipientAccountId, envelope.encryptedDataKey);
        }
        return { status: 200, body: { changed: true } };
      }
      if (request.method === 'DELETE') { revoked = true; return { status: 200, body: { changed: true } }; }
      if (request.method === 'PUT') {
        writes.push({ method: request.method, body: request.body });
        const body = request.body as { expectedVersion: number; content: TaskResourceV1['content'] };
        if (body.expectedVersion !== row.version) return { status: 409, body: { error: 'task_version_conflict' } };
        row = TaskResourceV1Schema.parse({ ...row, version: row.version + 1, content: body.content });
      }
      if (request.path === '/v1/tasks') return { status: 200, body: { tasks: [TaskResourceV1Schema.parse({ ...row,
        access: accountId === 'owner' ? 'owner' : 'edit', encryptedDataKey: envelopes.get(accountId) ?? null })] } };
      return { status: 200, body: TaskResourceV1Schema.parse({ ...row, access: accountId === 'owner' ? 'owner' : 'edit', encryptedDataKey: envelopes.get(accountId) ?? null }) };
    },
  });
  return { options, writes, todo, getRow: async () => { await initialized; return row; } };
}

describe('resource-aware task operations', () => {
  it.each([false, true])('preserves Task grant readiness and owner display through one HTTP read and the real Action (metadata=%s)', async metadata => {
    const state = fixture('plain'), requests: { method: string; path: string }[] = [];
    const readiness = { readyCount: 2, pendingCount: 1,
      unavailableCounts: { plain_account: 1, encryption_setup_required: 1, encryption_inconsistent: 1 } };
    const grant = { principal: { kind: 'team', teamId: 'team' }, accessLevel: 'edit',
      createdByAccountId: 'owner', createdAt: 1, display: { name: 'Current team' }, ...(metadata ? { readiness } : {}) };
    const roster = { ownerAccountId: 'owner', taskId: 'task', access: 'admin', grants: [grant],
      ...(metadata ? { ownerDisplayName: 'Current owner' } : {}) };
    if (metadata) expect(ResourceAccessGrantRowV1Schema.safeParse(grant).success).toBe(false);
    const deps = { internalTaskAction: async ({ actionId, input }) => executeInternalTaskAction({
      actionId, input, scope: { serverId: 'home', accountId: 'peer' }, requireCurrent: () => {}, createId: () => 'unused',
      resources: { ...state.options('peer'), request: async request => {
        requests.push({ method: request.method, path: request.path });
        return { status: 200, body: roster };
      } }, port: {
        read: async () => { throw new Error('Grant roster cannot open Task content'); },
        list: async () => { throw new Error('Grant roster cannot open an inventory'); },
        mutate: async () => { throw new Error('Grant roster cannot mutate'); },
      },
    }) } satisfies Partial<ActionExecutorDeps>;
    const result = await createActionExecutor(deps as ActionExecutorDeps).execute('tasks.internal.grants',
      { ownerAccountId: 'owner', taskId: 'task' }, { surface: 'agent', authority: 'account_automation', serverId: 'home' });
    expect(result).toEqual({ ok: true, result: { status: 'access', ...roster } });
    expect(requests).toEqual([{ method: 'GET', path: '/v1/tasks/owner/task/grants' }]);
  });
  it.each([undefined, null, 'Current owner'])('projects only observed Task owner display without storing it (display=%s)', async ownerDisplayName => {
    const state = fixture('plain'), row = await state.getRow();
    const requests: string[] = [];
    const result = await executeInternalTaskAction({ actionId: 'tasks.internal.read', input: { ownerAccountId: 'owner', taskId: 'task' },
      scope: { serverId: 'home', accountId: 'peer' }, requireCurrent: () => {}, createId: () => 'unused',
      resources: { ...state.options('peer'), request: async request => {
        requests.push(request.path);
        return { status: 200, body: { ...row, access: 'view',
          content: { t: 'plain', v: { ...state.todo, ownerDisplayName: 'Forged content owner' } },
          ...(ownerDisplayName === undefined ? {} : { ownerDisplayName }) } };
      } }, port: {
        read: async key => {
          if (key === TODO_LABEL_CATALOG_KEY_V1) return { value: null, version: -1 };
          throw new Error('Shared read cannot open private task rows');
        }, list: async () => [],
        mutate: async () => { throw new Error('Read cannot write'); },
      } });
    expect(InternalTaskReadOutputSchema.parse(result)).toEqual({ status: 'applied', scope: { serverId: 'home', accountId: 'peer' }, todo: {
      ...state.todo, state: 'unstarted', ownerAccountId: 'owner', access: 'view', labelColors: [],
      ...(ownerDisplayName === undefined ? {} : { ownerDisplayName }),
    } });
    expect(requests).toEqual(['/v1/tasks/owner/task']);
    expect(state.todo).not.toHaveProperty('ownerDisplayName');
  });
  it('uses authenticated write scope and normalizes owner-relative relations without opening an inventory', async () => {
    const state = fixture('plain'), scope = { serverId: 'home', accountId: 'peer' };
    const source = { pluginId: 'happier.triage', localId: 'internal' };
    const ref = (collisionScope: string, entryId: string) => ({ source, kindId: 'task', collisionScope, entryId });
    const run = (input: unknown) => executeInternalTaskAction({ actionId: 'tasks.internal.edit', input, scope,
      resources: state.options('peer'), requireCurrent: () => {}, createId: () => 'new', port: {
        read: async () => { throw new Error('A shared edit cannot open private Account rows'); },
        list: async () => { throw new Error('An addressed write cannot open an inventory'); },
        mutate: async () => { throw new Error('A shared edit cannot write the viewer Account'); },
      } });
    expect(await run({ ownerAccountId: 'owner', taskId: 'task', fields: { title: 'Shared edit',
      parentId: ref('account:owner', 'parent'), blockedBy: [ref('personal', 'mine'), ref('account:owner', 'peer')] } }))
      .toMatchObject({ status: 'applied', scope, todo: { ownerAccountId: 'owner', title: 'Shared edit', parentId: 'parent',
        blockedBy: [ref('account:peer', 'mine'), 'peer'] } });
    expect(await run({ ownerAccountId: 'owner', taskId: 'task', fields: { parentId: ref('personal', 'mine') } }))
      .toEqual({ status: 'refused', reason: 'unsupportedField' });
    expect(await run({ scope: { ...scope, accountId: 'other' }, ownerAccountId: 'owner', taskId: 'task', fields: { title: 'Wrong Account' } }))
      .toEqual({ status: 'refused', reason: 'task_scope_mismatch' });
    expect(state.writes).toHaveLength(1);
  });
  it('isolates unreadable shared E2EE content without swallowing Account withdrawal', async () => {
    const state = fixture('e2ee'), options = state.options('owner');
    const owner = createTaskResourceClientV1(options);
    await owner.share({ ownerAccountId: 'owner', taskId: 'task' }, { kind: 'account', accountId: 'peer' }, 'edit');
    const good = await owner.read({ ownerAccountId: 'owner', taskId: 'task' });
    const bad = TaskResourceV1Schema.parse({ ...good.resource, ownerAccountId: 'foreign', taskId: 'bad', access: 'view',
      content: { t: 'encrypted', k: 'task', c: 'unreadable-ciphertext' } });
    let current = true, withdrawOnOpen = false;
    const client = createTaskResourceClientV1({ ...options,
      requireCurrent: () => { if (!current) throw new Error('account_currentness_unavailable'); },
      request: async () => ({ status: 200, body: { tasks: [good.resource, bad], unavailableTasks: [
        { ownerAccountId: 'team-owner', taskId: 'pending', error: 'task_content_unavailable', reason: 'recipient_key_pending' },
      ] } }),
      crypto: { ...options.crypto, open: async (ciphertext, key) => {
        try { return await options.crypto.open(ciphertext, key); }
        finally { if (withdrawOnOpen) current = false; }
      } },
    });
    expect(await client.list()).toEqual({ tasks: [good], unavailableTasks: [
      { ownerAccountId: 'team-owner', taskId: 'pending', error: 'task_content_unavailable', reason: 'recipient_key_pending' },
      { ownerAccountId: 'foreign', taskId: 'bad', error: 'task_content_unavailable', reason: 'task_content_invalid' },
    ] });
    withdrawOnOpen = true;
    await expect(client.list()).rejects.toThrow('account_currentness_unavailable');
  });

  it('does not replay a write whose server response cannot establish acceptance', async () => {
    const state = fixture('plain'), options = state.options('peer');
    const result = await executeInternalTaskAction({ actionId: 'tasks.internal.edit',
      input: { scope: { serverId: 'home', accountId: 'peer' }, ownerAccountId: 'owner', taskId: 'task', fields: { title: 'Accepted before failure' } },
      scope: { serverId: 'home', accountId: 'peer' }, requireCurrent: () => {}, createId: () => 'new',
      resources: { ...options, request: async request => {
        const response = await options.request(request);
        return request.method === 'PUT' ? { status: 500, body: { error: 'internal_error' } } : response;
      } },
      port: { read: async () => { throw new Error('No Account fallback'); }, list: async () => [], mutate: async () => { throw new Error('No Account fallback'); } },
    });
    expect(result).toEqual({ status: 'uncertain', reason: 'task_storage_unavailable' });
    expect(state.writes).toHaveLength(1);
    expect((await createTaskResourceClientV1(state.options('owner')).read({ ownerAccountId: 'owner', taskId: 'task' })).todo.title).toBe('Accepted before failure');
  });
  it('projects an own resource completion through the private order without moving another owner index', async () => {
    const state = fixture('plain'), client = createTaskResourceClientV1(state.options('owner'));
    const task = await client.read({ ownerAccountId: 'owner', taskId: 'task' });
    await client.save(task, transitionTodoItemV1(task.todo, 'completed', 10));
    const result = await executeInternalTaskAction({ actionId: 'tasks.internal.list', input: {}, scope: { serverId: 'home', accountId: 'owner' },
      requireCurrent: () => {}, createId: () => 'new', resources: state.options('owner'), port: {
        read: async key => key === TODO_LABEL_CATALOG_KEY_V1 ? { value: null, version: -1 }
          : { value: { undoneOrder: ['task'], completedOrder: [] }, version: 1 },
        list: async () => { throw new Error('raw list not used'); }, mutate: async () => { throw new Error('read only'); },
      } });
    expect(result).toMatchObject({ status: 'ok', undoneOrder: [], completedOrder: ['task'], todos: [{ done: true, completedAt: 10 }] });
  });

  it('reorders own resource tasks through the same personal index owner without raw reads of managed rows', async () => {
    const state = fixture('plain'), writes: unknown[] = [];
    const args = { input: { scope: { serverId: 'home', accountId: 'owner' }, sourceId: 'task', position: { anchorId: null, placement: 'before' } },
      scope: { serverId: 'home', accountId: 'owner' }, requireCurrent: () => {}, resources: state.options('owner'), port: {
        read: async (key: string) => { if (key !== 'todo.index') throw new Error('Managed task raw read refused'); return { value: { undoneOrder: ['other', 'task'], completedOrder: [] }, version: 1 }; },
        list: async () => [], mutate: async (mutations: readonly unknown[]) => { writes.push(...mutations); return { success: true as const, results: [{ key: 'todo.index', version: 2 }] }; },
      } };
    expect(await executeInternalTaskReorder(args)).toEqual({ status: 'applied' });
    expect(writes).toEqual([{ key: 'todo.index', version: 1, value: { undoneOrder: ['task', 'other'], completedOrder: [] } }]);
  });

  it.each(['unknown-route', 'denied', 'malformed-404'] as const)('uses personal compatibility fallback only for exact %s', async kind => {
    const state = fixture('plain'); let rawReads = 0;
    const resourceOptions = state.options('owner');
    const result = await executeInternalTaskAction({ actionId: 'tasks.internal.list', input: {}, scope: { serverId: 'home', accountId: 'owner' },
      requireCurrent: () => {}, createId: () => 'new', resources: { ...resourceOptions, request: async () => ({ status: 404,
        body: kind === 'unknown-route' ? { statusCode: 404, error: 'Not Found', message: 'Route GET:/v1/tasks not found' }
          : kind === 'denied' ? { error: 'task_not_found' } : { error: 'not_found' } }) }, port: {
        read: async key => {
          if (key === TODO_LABEL_CATALOG_KEY_V1) return { value: null, version: -1 };
          throw new Error('fallback list owns index');
        },
        list: async () => { rawReads += 1; return [{ key: 'todo.task', value: state.todo, version: 1 }]; },
        mutate: async () => { throw new Error('read only'); },
      } });
    expect(result.status).toBe(kind === 'unknown-route' ? 'ok' : kind === 'denied' ? 'refused' : 'failed');
    expect(rawReads).toBe(kind === 'unknown-route' ? 1 : 0);
  });
  it('shares Plain content by grants only and never asks for encryption material', async () => {
    const state = fixture('plain'), options = state.options('owner');
    const crypto: TaskResourceClientOptionsV1['crypto'] = { ...options.crypto,
      openAccount: async () => { throw new Error('Plain cannot open Account content'); },
      openKey: async () => { throw new Error('Plain cannot open keys'); },
      seal: async () => { throw new Error('Plain cannot seal content'); } };
    const client = createTaskResourceClientV1({ ...options, crypto });
    const result = await client.share({ ownerAccountId: 'owner', taskId: 'task' }, { kind: 'account', accountId: 'peer' }, 'edit');
    expect(result.todo).toEqual(state.todo);
    expect(state.writes).toEqual([{ method: 'PUT', body: { principal: { kind: 'account', accountId: 'peer' }, accessLevel: 'edit' } }]);
    expect((await state.getRow()).version).toBe(1);
  });

  it('promotes one E2EE row with verified recipient envelopes then both clients edit that same row', async () => {
    const state = fixture('e2ee');
    const owner = createTaskResourceClientV1(state.options('owner')), peer = createTaskResourceClientV1(state.options('peer'));
    const address = { ownerAccountId: 'owner', taskId: 'task' };
    await owner.share(address, { kind: 'account', accountId: 'peer' }, 'edit');
    const shared = await peer.read(address);
    expect(shared.todo).toEqual(state.todo);
    await peer.save(shared, updateTodoItemV1(shared.todo, { title: 'Peer edit' }, 2));
    expect((await owner.read(address)).todo.title).toBe('Peer edit');
    await owner.share(address, { kind: 'account', accountId: 'peer' }, 'view');
    expect(state.writes.filter(write => TaskAccessGrantSetRequestV1Schema.safeParse(write.body).success && 'promotion' in (write.body as object))).toHaveLength(1);
    expect((await state.getRow()).content).toMatchObject({ t: 'encrypted', k: 'task' });
  });

  it('never treats absent E2EE recipient material as Plain content', async () => {
    const state = fixture('e2ee'), owner = createTaskResourceClientV1(state.options('owner'));
    const address = { ownerAccountId: 'owner', taskId: 'task' };
    await owner.share(address, { kind: 'account', accountId: 'peer' }, 'edit');
    const options = state.options('peer');
    const peer = createTaskResourceClientV1({ ...options, crypto: { ...options.crypto, openKey: async () => null } });
    await expect(peer.read(address)).rejects.toMatchObject({ code: 'resource_encryption_material_unavailable' });
    expect((await state.getRow()).content.t).toBe('encrypted');
    expect(state.writes).toHaveLength(1);
  });

  it('surfaces a revoked next read/write as denial without falling back to Account KV', async () => {
    const state = fixture('plain'), owner = createTaskResourceClientV1(state.options('owner')), peer = createTaskResourceClientV1(state.options('peer'));
    const address = { ownerAccountId: 'owner', taskId: 'task' }, retained = await peer.read(address);
    // The next HTTP boundary is denied even when a previously opened value remains in memory.
    await state.options('owner').request({ method: 'DELETE', path: '/v1/tasks/owner/task/grants', body: { principal: { kind: 'account', accountId: 'peer' } } });
    await expect(peer.read(address)).rejects.toMatchObject({ code: 'task_not_found' });
    await expect(peer.save(retained, updateTodoItemV1(retained.todo, { title: 'Rejected edit' }, 2))).rejects.toMatchObject({ code: 'task_not_found' });
    expect((await owner.read(address)).todo.title).toBe('Original');
    expect(state.writes).toHaveLength(0);
  });
  it('lists good owner-qualified tasks and reports a malformed shared row without failing the list', async () => {
    const calls: string[] = [];
    const own = { id: 'same', title: 'Mine', done: false, createdAt: 1, updatedAt: 1 };
    const shared = { ...own, title: 'Shared' };
    const args = {
      actionId: 'tasks.internal.list' as const, input: {}, scope: { serverId: 'home', accountId: 'viewer' },
      requireCurrent: () => {}, createId: () => 'new',
      port: {
        read: async (key: string) => {
          calls.push(key);
          return key === TODO_LABEL_CATALOG_KEY_V1 ? { value: null, version: -1 }
            : { value: { undoneOrder: ['same'], completedOrder: [] }, version: 2 };
        },
        list: async () => { throw Object.assign(new Error('raw collection refuses managed content'), { code: 'raw_kv_refused' }); },
        mutate: async () => { throw new Error('read only'); },
      },
      resources: {
        accountId: 'viewer', requireCurrent: () => {},
        request: async (request: { path: string }) => {
          calls.push(request.path);
          return { status: 200, body: { tasks: [
            { ownerAccountId: 'viewer', taskId: 'same', version: 1, content: { t: 'plain', v: own }, access: 'owner', encryptionMode: 'plain', encryptedDataKey: null },
            { ownerAccountId: 'owner', taskId: 'same', version: 1, content: { t: 'plain', v: shared }, access: 'edit', encryptionMode: 'plain', encryptedDataKey: null },
            { ownerAccountId: 'bad-owner', taskId: 'same', version: 1, content: { t: 'plain', v: { invalid: true } }, access: 'view', encryptionMode: 'plain', encryptedDataKey: null },
          ] } };
        },
        crypto: {
          randomBytes: (length: number) => new Uint8Array(length),
          openAccount: async () => { throw new Error('Plain does not use Account keys'); },
          sealAccount: async () => { throw new Error('read only'); },
          openKey: async () => null,
          open: async () => { throw new Error('Plain does not decrypt'); },
          seal: async () => { throw new Error('read only'); },
        },
      },
    };
    const result = await executeInternalTaskAction(args);
    expect(result).toMatchObject({ status: 'ok', todos: [
      { ...own, ownerAccountId: 'viewer', access: 'owner' }, { ...shared, ownerAccountId: 'owner', access: 'edit' },
    ], unavailableTasks: [{ ownerAccountId: 'bad-owner', taskId: 'same', error: 'task_content_unavailable', reason: 'task_content_invalid' }] });
    expect(InternalTaskListOutputSchema.parse(result)).toEqual(result);
    expect(calls).toEqual([TODO_LABEL_CATALOG_KEY_V1, '/v1/tasks', 'todo.index']);
  });
});
