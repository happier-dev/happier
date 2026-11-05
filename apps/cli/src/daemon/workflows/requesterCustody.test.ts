import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it } from 'vitest';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import type { StoredCredentials } from '@/persistence';
import { retainWorkflowRequesterCredentials, acquireWorkflowRequesterCredentials, retireWorkflowRequesterCredentials } from './requesterCustody';
import * as requesterCustody from './requesterCustody';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

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
    await retainWorkflowRequesterCredentials({ ...binding, credentials: { token: 'guest-token', encryption: null }, attribution });
    await retireWorkflowRequesterCredentials(binding);
    const admitted = await acquireWorkflowRequesterCredentials(binding);
    expect(admitted?.credentials.token).toBe('guest-token');
    await admitted?.release();
    pending = false;
    await retainWorkflowRequesterCredentials({ ...binding, credentials: { token: 'guest-token', encryption: null }, attribution });
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
