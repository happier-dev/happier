import axios from 'axios';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import type { StoredCredentials } from '@/persistence';
import { retainWorkflowRequesterCredentials, acquireWorkflowRequesterCredentials, retireWorkflowRequesterCredentials } from './requesterCustody';
import * as requesterCustody from './requesterCustody';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

const wire = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: wire.io }));

it('reconciles only addressed guest custody on typed changes and catches up missed work on reconnect', async () => {
  const app = fastify();
  const origin = 'http://addressed-workflow-requester.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-addressed-requester-'));
  const installation = { serverId: 'home', machineId: 'machine', installationId: 'installation', happyHomeDir: directory,
    serverHttpBaseUrl: origin };
  const sockets = new Map<string, ReturnType<typeof createApiSessionSocketStub>>();
  wire.io.mockImplementation((_url: string, options: { auth: { token: string } }) => {
    const socket = createApiSessionSocketStub();
    sockets.set(options.auth.token, socket);
    return socket;
  });
  const scopes = [
    { scopeId: 'direct-a', accountId: 'guest-a' },
    { scopeId: 'direct-b', accountId: 'guest-a' },
    { scopeId: 'trigger-a', automationId: 'automation-a', accountId: 'guest-a' },
    { scopeId: 'trigger-b', automationId: 'automation-b', accountId: 'guest-a' },
    { scopeId: 'direct-other', accountId: 'guest-b' },
  ];
  const kit = createWorkflowRunStorageTestkit({ runId: 'admitted', machineId: installation.machineId,
    state: 'cancelled', origin: { kind: 'direct' } });
  const reads: string[] = [];
  const pending = new Set(scopes.map(scope => scope.scopeId));
  const errors: unknown[] = [];
  app.get('/v1/account/profile', async request => ({ id: request.headers.authorization === 'Bearer guest-a' ? 'guest-a' : 'guest-b' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.get('/v3/automations/:id', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.post<{ Body: { request: { runId?: string; triggerId?: string } } }>('/v3/automations/runs/workflow-storage', async request => {
    const id = request.body.request.runId ?? request.body.request.triggerId;
    if (!id) throw new Error('Expected exact custody selector');
    reads.push(id);
    return { runs: pending.has(id) ? [{ ...kit.run(), id, workflowCustodyState: 'pending' }] : [] };
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  let observation: ReturnType<typeof requesterCustody.observeWorkflowRequesterCredentialCustody> | undefined;
  try {
    for (const scope of scopes) await retainWorkflowRequesterCredentials({ ...installation, ...scope,
      attribution: { serverId: installation.serverId, machineId: installation.machineId,
        installationId: installation.installationId, accountId: scope.accountId },
      credentials: { token: scope.accountId, encryption: null } });
    observation = requesterCustody.observeWorkflowRequesterCredentialCustody({ ...installation,
      hostAccountId: 'custodian', onError: error => errors.push(error) });
    await vi.waitFor(() => expect(new Set(reads)).toEqual(new Set(scopes.map(scope => scope.scopeId))));
    await vi.waitFor(() => expect(sockets.size).toBe(2));
    const guest = sockets.get('guest-a')!;
    let seq = 0;
    const push = (body: unknown) => guest.trigger('update', { id: `change-${++seq}`, seq, createdAt: seq,
      body: UpdateBodySchema.parse(body) });
    reads.length = 0;
    push({ t: 'account-change', changeKinds: ['session'], entityIds: ['unrelated-session'] });
    push({ t: 'account-change', changeKinds: ['account'], entityIds: ['self'] });
    push({ t: 'delete-artifact', artifactId: 'unrelated-artifact' });
    push({ t: 'account-change', changeKinds: ['account'], entityIds: ['workflow-run:direct-a'] });
    await vi.waitFor(() => expect(reads).toEqual(['direct-a']));
    reads.length = 0;
    // Removing a deleted Automation's last admitted child retires only its
    // own trigger. A sibling trigger and the other guest stay undisturbed.
    pending.delete('trigger-a');
    push({ t: 'account-change', changeKinds: ['automation'], entityIds: ['automation-a'] });
    await vi.waitFor(async () => {
      const inventory = await requesterCustody.listWorkflowRequesterCredentialScopes(installation);
      expect(inventory.status).toBe('ready');
      if (inventory.status === 'ready') expect(inventory.bindings.map(scope => scope.sessionId).sort())
        .toEqual(['direct-a', 'direct-b', 'direct-other', 'trigger-b']);
    });
    expect(reads).toEqual(['trigger-a']);
    reads.length = 0;
    // A missed offline update is intentionally coarse: reconnect re-reads
    // every remaining scope for this guest, never the other guest's scope.
    guest.trigger('connect');
    await vi.waitFor(() => expect(reads.slice().sort()).toEqual(['direct-a', 'direct-b', 'trigger-b']));
    expect(errors).toEqual([]);
  } finally { observation?.dispose(); restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it('keeps direct Run custody across offline terminal cleanup until the exact Run settles', async () => {
  const app = fastify();
  const origin = 'http://direct-workflow-requester.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-direct-requester-'));
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  const binding = { ...attribution, happyHomeDir: directory, scopeId: 'direct-run', serverHttpBaseUrl: origin };
  const kit = createWorkflowRunStorageTestkit({ runId: binding.scopeId, machineId: attribution.machineId,
    state: 'cancelled', origin: { kind: 'direct' } });
  let custody: 'pending' | 'settled' = 'pending';
  const selectors: unknown[] = [];
  app.get('/v1/account/profile', async () => ({ id: attribution.accountId }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.post<{ Body: { request: { runId?: string; triggerId?: string } } }>('/v3/automations/runs/workflow-storage', async request => {
    expect(request.headers.authorization).toBe('Bearer guest-token');
    selectors.push(request.body.request);
    // The real storage selectors distinguish direct Run ids from trigger ids.
    return { runs: request.body.request.runId === binding.scopeId
      ? [{ ...kit.run(), workflowCustodyState: custody }] : [] };
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  try {
    const retained = await retainWorkflowRequesterCredentials({ ...binding, attribution,
      credentials: { token: 'guest-token', encryption: null } });
    await retireWorkflowRequesterCredentials(binding);
    await expect(access(retained.path)).resolves.toBeUndefined();
    // All in-process execution holds are gone. Reconnect must still recover
    // the admitted requester while its terminal Run has unfinished child custody.
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    const recovered = await acquireWorkflowRequesterCredentials(binding);
    expect(recovered?.credentials.token).toBe('guest-token');
    await recovered?.release();
    await expect(access(retained.path)).resolves.toBeUndefined();
    custody = 'settled';
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    expect(await acquireWorkflowRequesterCredentials(binding)).toBeNull();
    await expect(access(retained.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors.every(selector => JSON.stringify(selector) === JSON.stringify({ runId: binding.scopeId,
      machineId: attribution.machineId }))).toBe(true);
  } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it('keeps custody for an admitted queued Run when its trigger is disabled, then retires after drain', async () => {
  const app = fastify();
  const origin = 'http://queued-workflow-requester.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-queued-requester-'));
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  const kit = createWorkflowRunStorageTestkit({ runId: 'queued', machineId: 'machine', state: 'queued', origin: { kind: 'direct' } });
  let pending = true;
  app.get('/v1/account/profile', async () => ({ id: 'guest' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
  // The saved schedule was deleted while this daemon was offline. Reconnect
  // consumes the same guest-owned durable definition and admitted Run inventory.
  app.get('/v3/automations/saved-automation', async (request, reply) => {
    expect(request.headers.authorization).toBe('Bearer guest-token');
    return reply.code(404).send({ error: 'not_found' });
  });
  app.post<{ Body: { operation: string; request: { runId?: string; triggerId?: string; cursor?: string } } }>('/v3/automations/runs/workflow-storage', async request => {
    expect(request.headers.authorization).toBe('Bearer guest-token');
    if (request.body.request.runId) return { runs: request.body.request.runId === 'finished-direct'
      ? [{ ...kit.run(), id: 'finished-direct', state: 'succeeded', workflowCustodyState: 'settled' }] : [] };
    if (request.body.request.triggerId === 'finished-direct') return { runs: [] };
    expect(request.body).toMatchObject({ operation: 'list', request: { triggerId: 'trigger', machineId: 'machine' } });
    return pending ? request.body.request.cursor === 'admitted-page'
      ? { runs: [kit.run()] } : { runs: [], nextCursor: 'admitted-page' } : { runs: [] };
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  const binding = { ...attribution, happyHomeDir: directory, scopeId: 'trigger', serverHttpBaseUrl: origin };
  try {
    await retainWorkflowRequesterCredentials({ ...binding, automationId: 'saved-automation', credentials: { token: 'guest-token', encryption: null }, attribution });
    await retireWorkflowRequesterCredentials(binding);
    const admitted = await acquireWorkflowRequesterCredentials(binding);
    expect(admitted?.credentials.token).toBe('guest-token');
    await admitted?.release();
    pending = false;
    await retainWorkflowRequesterCredentials({ ...binding, automationId: 'saved-automation', credentials: { token: 'guest-token', encryption: null }, attribution });
    await requesterCustody.settleWorkflowRequesterCredentialRetirement(binding);
    const reenabled = await acquireWorkflowRequesterCredentials(binding);
    expect(reenabled?.credentials.token).toBe('guest-token');
    await reenabled?.release();
    await retireWorkflowRequesterCredentials(binding);
    expect(await acquireWorkflowRequesterCredentials(binding)).toBeNull();
    // A reconnect has no scope-kind wire fact. Only a positive exact terminal
    // Run proves this is completed direct-start custody; an empty read retains it.
    const finished = { ...binding, scopeId: 'finished-direct' };
    await retainWorkflowRequesterCredentials({ ...finished, credentials: { token: 'guest-token', encryption: null }, attribution });
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(finished);
    expect(await acquireWorkflowRequesterCredentials(finished)).toBeNull();
    await retainWorkflowRequesterCredentials({ ...binding, credentials: { token: 'guest-token', encryption: null }, attribution });
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    const unknown = await acquireWorkflowRequesterCredentials(binding);
    expect(unknown?.credentials.token).toBe('guest-token');
    await unknown?.release();
    pending = true;
    await retainWorkflowRequesterCredentials({ ...binding, automationId: 'saved-automation',
      credentials: { token: 'guest-token', encryption: null }, attribution });
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    const queuedAfterOfflineDelete = await acquireWorkflowRequesterCredentials(binding);
    expect(queuedAfterOfflineDelete?.credentials.token).toBe('guest-token');
    await queuedAfterOfflineDelete?.release();
    pending = false;
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    expect(await acquireWorkflowRequesterCredentials(binding)).toBeNull();
  } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it('retains enabled local initial Session triggers before birth and cleans only newly introduced custody on refusal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-initial-requester-'));
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  try {
    await retainWorkflowRequesterCredentials({ happyHomeDir: directory, attribution, scopeId: 'already-retained',
      credentials: { token: 'guest-token', encryption: null }, homeServerIdentityId: 'home-identity' });
    const retained = await requesterCustody.retainWorkflowInitialTriggerCredentials({ happyHomeDir: directory, attribution,
      credentials: { token: 'guest-token', encryption: null }, homeServerIdentityId: 'home-identity',
      initialTriggers: [
        { automationId: 'initial', enabled: true, assignments: [{ machineId: 'machine' }], triggers: [
          { triggerId: AutomationTriggerIdSchema.parse('already-retained'), trigger: { enabled: true } }, { triggerId: AutomationTriggerIdSchema.parse('enabled'), trigger: { enabled: true } },
          { triggerId: AutomationTriggerIdSchema.parse('disabled-trigger'), trigger: { enabled: false } }] },
        { automationId: 'disabled', enabled: false, assignments: [{ machineId: 'machine' }], triggers: [{ triggerId: AutomationTriggerIdSchema.parse('disabled-definition'), trigger: { enabled: true } }] },
        { automationId: 'other', enabled: true, assignments: [{ machineId: 'other' }], triggers: [{ triggerId: AutomationTriggerIdSchema.parse('other-machine'), trigger: { enabled: true } }] },
      ] });
    const scopes = await requesterCustody.listWorkflowRequesterCredentialScopes({ happyHomeDir: directory, ...attribution });
    expect(scopes.status).toBe('ready');
    if (scopes.status === 'ready') expect(scopes.bindings.map(row => row.sessionId).sort()).toEqual(['already-retained', 'enabled']);
    await retained.cleanupOnFailure();
    const afterRefusal = await requesterCustody.listWorkflowRequesterCredentialScopes({ happyHomeDir: directory, ...attribution });
    if (afterRefusal.status !== 'ready') throw new Error('Private custody inventory unavailable');
    expect(afterRefusal.bindings.map(row => row.sessionId)).toEqual(['already-retained']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['plain', 'e2ee'] as const)('recovers %s requester custody before claim and retires only after admitted work settles', async mode => {
  const app = fastify();
  const origin = 'http://workflow-requester.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-requester-'));
  let refused = false;
  app.get('/v1/account/profile', async (_request, reply) => refused ? reply.code(401).send({ error: 'unauthorized' }) : { id: 'guest' });
  app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.post('/v3/automations/runs/workflow-storage', async () => ({ runs: [] }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  const credentials: StoredCredentials = { token: 'guest-token', encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(19) } };
  const binding = { happyHomeDir: directory, serverId: 'home', machineId: 'machine', installationId: 'installation', scopeId: 'trigger', serverHttpBaseUrl: origin };
  try {
    await retainWorkflowRequesterCredentials({ happyHomeDir: directory, scopeId: 'trigger', attribution, credentials });
    const active = await acquireWorkflowRequesterCredentials({ ...binding, serverHttpBaseUrl: origin });
    expect(active?.credentials.token).toBe('guest-token');
    expect(active?.attribution.accountId).toBe('guest');
    expect(await acquireWorkflowRequesterCredentials({ ...binding, installationId: 'replacement', serverHttpBaseUrl: origin })).toBeNull();
    await retireWorkflowRequesterCredentials(binding);
    expect(active?.credentials.encryption === null).toBe(mode === 'plain');
    await active?.release();
    expect(await acquireWorkflowRequesterCredentials({ ...binding, serverHttpBaseUrl: origin })).toBeNull();
    await retainWorkflowRequesterCredentials({ happyHomeDir: directory, scopeId: 'trigger', attribution, credentials });
    refused = true;
    expect(await acquireWorkflowRequesterCredentials({ ...binding, serverHttpBaseUrl: origin })).toBeNull();
    refused = false;
    expect(await acquireWorkflowRequesterCredentials({ ...binding, serverHttpBaseUrl: origin })).toBeNull();
  } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});


it.each(['unavailable', 'invalid-profile'] as const)(
  'retains exact private Workflow custody across %s and reuses it after recovery', async failure => {
    const app = fastify();
    const origin = 'http://workflow-recovery-currentness.test';
    const directory = await mkdtemp(join(tmpdir(), 'workflow-recovery-currentness-'));
    let unavailable = false;
    let machineReads = 0;
    app.get('/v1/account/profile', async (_request, reply) => !unavailable ? { id: 'guest' }
      : failure === 'unavailable' ? reply.code(503).send({ error: 'unavailable' }) : { id: 7 });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
    app.get('/v1/machines/:id', async (_request, reply) => { machineReads++; return reply.code(403).send({ error: 'forbidden' }); });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
    const binding = { ...attribution, happyHomeDir: directory, scopeId: 'trigger', serverHttpBaseUrl: origin };
    try {
      const retained = await retainWorkflowRequesterCredentials({ ...binding, attribution,
        credentials: { token: 'guest-token', encryption: null } });
      unavailable = true;
      await expect(acquireWorkflowRequesterCredentials(binding))
        .rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
      await expect(access(retained.path)).resolves.toBeUndefined();
      unavailable = false;
      const admitted = await acquireWorkflowRequesterCredentials(binding);
      expect(admitted?.credentials.token).toBe('guest-token');
      expect(admitted?.attribution).toEqual(attribution);
      await admitted?.release();
      expect(machineReads).toBe(0);
    } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
  });

it.each([401, 403])('retires only the exact private Workflow custody on canonical HTTP %s refusal', async status => {
  const app = fastify();
  const origin = 'http://workflow-refused-currentness.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-refused-currentness-'));
  app.get('/v1/account/profile', async (_request, reply) => reply.code(status).send({ error: 'unauthorized' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
    updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  const binding = { ...attribution, happyHomeDir: directory, scopeId: 'trigger', serverHttpBaseUrl: origin };
  try {
    const retained = await retainWorkflowRequesterCredentials({ ...binding, attribution,
      credentials: { token: 'guest-token', encryption: null } });
    const unrelated = await retainWorkflowRequesterCredentials({ ...binding, scopeId: 'other-trigger', attribution,
      credentials: { token: 'guest-token', encryption: null } });
    await expect(acquireWorkflowRequesterCredentials(binding)).resolves.toBeNull();
    await expect(access(retained.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(unrelated.path)).resolves.toBeUndefined();
  } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});


it.each(['retirement', 'observer'] as const)('cancels a pending custody storage read when its %s lifetime ends', async mode => {
  const app = fastify();
  const origin = 'http://cancel-workflow-requester.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-requester-cancel-'));
  const attribution = { serverId: 'home', machineId: 'machine', installationId: 'installation', accountId: 'guest' };
  const binding = { ...attribution, scopeId: 'direct-cancel', happyHomeDir: directory, serverHttpBaseUrl: origin };
  const socket = createApiSessionSocketStub();
  wire.io.mockReturnValue(socket);
  app.get('/v1/account/profile', async () => ({ id: 'guest' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  let entered!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  let receivedSignal: AbortSignal | undefined;
  const transport = vi.spyOn(axios, 'post').mockImplementation(async (_url, _body, options) => await new Promise((_resolve, reject) => {
    receivedSignal = options?.signal as AbortSignal | undefined;
    release = () => reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' }));
    receivedSignal?.addEventListener('abort', release, { once: true });
    entered();
  }));
  const controller = new AbortController();
  const errors: unknown[] = [];
  let observation: ReturnType<typeof requesterCustody.observeWorkflowRequesterCredentialCustody> | undefined;
  let retiring: Promise<void> | undefined;
  try {
    await retainWorkflowRequesterCredentials({ ...binding, attribution, credentials: { token: 'guest', encryption: null } });
    if (mode === 'retirement') {
      const custody = requesterCustody.createWorkflowRequesterCustody({ credentials: { token: 'guest', encryption: null },
        attribution, happyHomeDir: directory, serverHttpBaseUrl: origin });
      retiring = custody.retire({ scopeId: binding.scopeId, machineId: attribution.machineId }, { signal: controller.signal });
      retiring.catch(error => errors.push(error));
    } else {
      observation = requesterCustody.observeWorkflowRequesterCredentialCustody({ ...binding, hostAccountId: 'host',
        onError: error => errors.push(error) });
      await vi.waitFor(() => expect(wire.io).toHaveBeenCalled());
      socket.trigger('connect');
    }
    await sending;
    expect.soft(receivedSignal).toBeInstanceOf(AbortSignal);
    if (mode === 'retirement') controller.abort();
    else observation!.dispose();
    expect.soft(receivedSignal?.aborted).toBe(true);
  } finally {
    release?.();
    await retiring?.catch(() => {});
    observation?.dispose(); transport.mockRestore(); restore();
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
});
