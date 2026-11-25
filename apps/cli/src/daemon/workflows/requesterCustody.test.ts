import axios from 'axios';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
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
import { createRequesterSessionCredentialCustody } from '../sessionEncryption/requesterSessionCredentials';
import { retainWorkflowRequesterCredentials, acquireWorkflowRequesterCredentials, retireWorkflowRequesterCredentials } from './requesterCustody';
import * as requesterCustody from './requesterCustody';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

const wire = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: wire.io }));

function publishedProfileAutomation(id: string, machineId: string, triggerIds: readonly string[]) {
  return AutomationDefinitionDetailSchema.parse({
    id, name: 'Approval Profile check', description: null, enabled: true, workflowDefinitionId: null,
    scopeSessionId: null, targetType: null, existingSessionId: null, templateVersion: 1,
    lastRunAt: null, createdAt: 1, updatedAt: 1, templateCiphertext: 'opaque fixture',
    assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }],
    triggers: triggerIds.map(triggerId => ({ id: triggerId, revision: 0, enabled: true, createdAt: 1,
      updatedAt: 1, kind: 'action', phase: 'before', mode: 'wait', onFailure: 'refuse',
      actionIds: ['machines.command.run'], triggerDefinitionEnvelope: 'opaque trigger fixture' })),
  });
}

it.each([
  { existingTriggerIds: undefined, publication: 'a new Profile check' },
  { existingTriggerIds: ['10d027a9-a59f-4802-9373-98ed6564fec9'], publication: 'an appended Profile check' },
])('keeps guest custody when catch-up precedes publication of $publication', async ({ existingTriggerIds }) => {
  const app = fastify();
  const origin = 'http://workflow-requester-publication.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-requester-publication-'));
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  // Native G15 Profile authoring retained the Any check while Home still had
  // only its Exact sibling, or no definition at all on the first Save.
  const automationId = 'cd4638cd-444a-42fd-93a2-0be35bffdb9c';
  const scopeId = 'd64b55a0-33b9-4fdd-b878-c46459a57988';
  const binding = { ...attribution, happyHomeDir: directory, scopeId, serverHttpBaseUrl: origin };
  let publishedTriggerIds: readonly string[] | undefined = existingTriggerIds;
  app.get('/v1/account/profile', async () => ({ id: attribution.accountId }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.get('/v3/automations/' + automationId, async (request, reply) => {
    expect(request.headers.authorization).toBe('Bearer guest-token');
    return publishedTriggerIds ? publishedProfileAutomation(automationId, attribution.machineId, publishedTriggerIds)
      : reply.code(404).send({ error: 'not_found' });
  });
  app.post('/v3/automations/runs/workflow-storage', async () => ({ runs: [] }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  try {
    const retained = await retainWorkflowRequesterCredentials({ ...binding, automationId, attribution,
      credentials: { token: 'guest-token', encryption: null } });
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    await expect(access(retained.path)).resolves.toBeUndefined();

    publishedTriggerIds = [...(existingTriggerIds ?? []), scopeId];
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    const admitted = await acquireWorkflowRequesterCredentials(binding);
    expect(admitted?.attribution).toEqual(attribution);
    expect(admitted?.credentials.token).toBe('guest-token');
    await admitted?.release();

    publishedTriggerIds = existingTriggerIds;
    await requesterCustody.reconcileWorkflowRequesterCredentialScope(binding);
    expect(await acquireWorkflowRequesterCredentials(binding)).toBeNull();
  } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

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
  const definitionReads: string[] = [];
  const published = new Map([['automation-a', 'trigger-a'], ['automation-b', 'trigger-b']]);
  const pending = new Set(scopes.map(scope => scope.scopeId));
  const errors: unknown[] = [];
  app.get('/v1/account/profile', async request => ({ id: request.headers.authorization === 'Bearer guest-a' ? 'guest-a' : 'guest-b' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.get<{ Params: { id: string } }>('/v3/automations/:id', async (request, reply) => {
    const { id } = request.params;
    definitionReads.push(id);
    const triggerId = published.get(id);
    return triggerId ? publishedProfileAutomation(id, installation.machineId, [triggerId])
      : reply.code(404).send({ error: 'not_found' });
  });
  app.post<{ Body: { request: { runId?: string; automationId?: string } } }>('/v3/automations/runs/workflow-storage', async request => {
    const id = request.body.request.runId ?? request.body.request.automationId;
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
    for (const scope of scopes) if (scope.automationId) {
      await requesterCustody.reconcileWorkflowRequesterCredentialScope({ ...installation, ...scope });
    }
    definitionReads.length = 0;
    observation = requesterCustody.observeWorkflowRequesterCredentialCustody({ ...installation,
      hostAccountId: 'custodian', onError: error => errors.push(error) });
    await vi.waitFor(() => expect(reads.slice().sort()).toEqual(['direct-a', 'direct-b', 'direct-other']));
    await vi.waitFor(() => expect(definitionReads.slice().sort()).toEqual(['automation-a', 'automation-b']));
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
    published.delete('automation-a');
    push({ t: 'account-change', changeKinds: ['automation'], entityIds: ['automation-a'] });
    await vi.waitFor(async () => {
      const inventory = await requesterCustody.listWorkflowRequesterCredentialScopes(installation);
      expect(inventory.status).toBe('ready');
      if (inventory.status === 'ready') expect(inventory.bindings.map(scope => scope.sessionId).sort())
        .toEqual(['direct-a', 'direct-b', 'direct-other', 'trigger-b']);
    });
    expect(reads).toEqual(['automation-a']);
    reads.length = 0;
    definitionReads.length = 0;
    // A missed offline update is intentionally coarse: reconnect re-reads
    // every remaining scope for this guest, never the other guest's scope.
    guest.trigger('connect');
    await vi.waitFor(() => expect(reads.slice().sort()).toEqual(['direct-a', 'direct-b']));
    await vi.waitFor(() => expect(definitionReads).toEqual(['automation-b']));
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

it.each(['trigger', 'manual'] as const)('keeps custody for an admitted queued %s Run when its trigger is disabled, then retires after drain', async kind => {
  const app = fastify();
  const origin = 'http://queued-workflow-requester.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-queued-requester-'));
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  const automationId = 'saved-automation';
  const triggerId = AutomationTriggerIdSchema.parse('trigger');
  const kit = createWorkflowRunStorageTestkit({ runId: 'queued', machineId: 'machine', state: 'queued', origin: {
    kind: 'automation', automationId,
    cause: kind === 'manual' ? { kind, invokedAt: 1 } : { kind, triggerId, triggerRevision: 0, triggerKind: 'schedule',
      occurrenceKey: Buffer.alloc(32, 7).toString('base64url'), occurredAt: 1, evidence: { scheduledFor: 1 } },
  } });
  let pending = true;
  app.get('/v1/account/profile', async () => ({ id: 'guest' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
  let published = true;
  app.get('/v3/automations/saved-automation', async (request, reply) => {
    expect(request.headers.authorization).toBe('Bearer guest-token');
    return published ? publishedProfileAutomation('saved-automation', attribution.machineId, ['trigger'])
      : reply.code(404).send({ error: 'not_found' });
  });
  app.post<{ Body: { operation: string; request: { runId?: string; triggerId?: string; automationId?: string; cursor?: string } } }>('/v3/automations/runs/workflow-storage', async request => {
    expect(request.headers.authorization).toBe('Bearer guest-token');
    if (request.body.request.runId) return { runs: request.body.request.runId === 'finished-direct'
      ? [{ ...kit.run(), id: 'finished-direct', state: 'succeeded', workflowCustodyState: 'settled' }] : [] };
    if (request.body.request.triggerId === 'finished-direct') return { runs: [] };
    expect(request.body).toMatchObject({ operation: 'list', request: { machineId: 'machine' } });
    const selector = request.body.request;
    if (selector.triggerId !== undefined && (kind === 'manual' || selector.triggerId !== triggerId)) return { runs: [] };
    if (selector.automationId !== undefined && selector.automationId !== automationId) return { runs: [] };
    return pending ? request.body.request.cursor === 'admitted-page'
      ? { runs: [kit.run()] } : { runs: [], nextCursor: 'admitted-page' } : { runs: [] };
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  const binding = { ...attribution, happyHomeDir: directory, scopeId: 'trigger', serverHttpBaseUrl: origin };
  try {
    await retainWorkflowRequesterCredentials({ ...binding, automationId: 'saved-automation', credentials: { token: 'guest-token', encryption: null }, attribution });
    await retireWorkflowRequesterCredentials(binding);
    const admitted = kind === 'manual'
      ? await requesterCustody.acquireWorkflowAutomationRequesterCredentials({ ...binding, automationId })
      : await acquireWorkflowRequesterCredentials(binding);
    expect(admitted?.credentials.token).toBe('guest-token');
    await admitted?.release();
    if (kind === 'manual') {
      await expect(requesterCustody.acquireWorkflowAutomationRequesterCredentials({
        ...binding, accountId: 'another-guest', automationId,
      })).resolves.toBeNull();
      await expect(requesterCustody.acquireWorkflowAutomationRequesterCredentials({
        ...binding, automationId: 'another-automation',
      })).resolves.toBeNull();
    }
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
    // A predecessor record has no publication marker. It already represents
    // a saved trigger for this installation and still drains on offline removal.
    await createRequesterSessionCredentialCustody({ ...binding, scope: 'workflow_trigger', sessionId: binding.scopeId,
      automationId: 'saved-automation', credentials: { token: 'guest-token', encryption: null }, attribution });
    published = false;
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


it('preserves a claimed Run admission when its trigger is resaved and never upgrades legacy roleless custody', async () => {
  const app = fastify();
  const origin = 'http://workflow-run-admission.test';
  const directory = await mkdtemp(join(tmpdir(), 'workflow-run-admission-'));
  const attribution = { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' };
  const credentials: StoredCredentials = { token: 'guest-token', encryption: null };
  const binding = { ...attribution, happyHomeDir: directory, serverHttpBaseUrl: origin, homeServerIdentityId: 'srv_home' };
  app.get('/v1/account/profile', async () => ({ id: attribution.accountId }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  let machineReads = 0;
  app.get('/v1/machines/:id', async (_request, reply) => { machineReads++; return reply.code(403).send({ error: 'forbidden' }); });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  const userAdmission = { actorAccountId: attribution.accountId, custodianAccountId: 'custodian', role: 'use' as const };
  const managerAdmission = { ...userAdmission, role: 'manage' as const };
  const retain = (scopeId: string, machineAdmission?: typeof userAdmission | typeof managerAdmission, automationId?: string) =>
    retainWorkflowRequesterCredentials({ ...binding, scopeId, attribution, credentials, machineAdmission, automationId });
  try {
    await retain('trigger', userAdmission, 'automation');
    await retain('claimed-run', userAdmission);
    await retain('legacy-run');
    // A new schedule admission affects future occurrences; reclaiming the
    // already accepted Run cannot replace that Run's original Machine role.
    await retain('trigger', managerAdmission, 'automation');
    await retain('claimed-run', managerAdmission);
    await retain('legacy-run', managerAdmission);
    const recovered = await acquireWorkflowRequesterCredentials({ ...binding, scopeId: 'claimed-run' });
    const trigger = await acquireWorkflowRequesterCredentials({ ...binding, scopeId: 'trigger' });
    const legacy = await acquireWorkflowRequesterCredentials({ ...binding, scopeId: 'legacy-run' });
    expect(recovered?.machineAdmission).toEqual(userAdmission);
    expect(trigger?.machineAdmission).toEqual(managerAdmission);
    expect(legacy?.machineAdmission).toBeUndefined();
    expect(await acquireWorkflowRequesterCredentials({ ...binding, scopeId: 'claimed-run', installationId: 'replacement' })).toBeNull();
    expect(await acquireWorkflowRequesterCredentials({ ...binding, scopeId: 'claimed-run', accountId: 'other' })).toBeNull();
    expect(await acquireWorkflowRequesterCredentials({ ...binding, scopeId: 'claimed-run', homeServerIdentityId: 'srv_other' })).toBeNull();
    await recovered?.release(); await trigger?.release(); await legacy?.release();
    expect(machineReads).toBe(0);
  } finally { restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
