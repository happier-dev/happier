import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

describe('managed inventory CLI Home adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://home.test' });
  });
  afterEach(async () => { restore(); await app.close(); });

  const machine = {
    id: 'managed-1', homeId: 'srv_home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: { cores: 2 } },
    controller: { machineId: 'controller-1', installationId: 'installation-1' },
    allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  } as const satisfies ManagedMachineV1;
  const context = { surface: 'cli', authority: 'account_automation', serverId: 'route-home' } as const;

  function executor(overrides: Partial<Pick<Parameters<typeof createAccountServerActionDeps>[0],
    'serverIdentityId' | 'resolveServerFeaturesSnapshot' | 'isCredentialCurrent'>> = {}) {
    return createCliActionExecutor({
      token: 'bound', sessionId: 'cli-global', serverId: 'route-home', serverHttpBaseUrl: 'http://home.test',
      mode: 'plain', ctx: null,
      accountServerActionDeps: createAccountServerActionDeps({
        token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test', ...overrides,
      }),
    });
  }

  it('lists and gets retained resources through the real CLI executor without a controller or answering app', async () => {
    const seen: Array<{ url: string; body: unknown; authorization?: string }> = [];
    app.post('/v1/machines/managed/actions/list', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return { machines: [machine] };
    });
    app.post('/v1/machines/managed/actions/get', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return machine;
    });
    const cli = executor();
    await expect(cli.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toEqual({ ok: true, result: { machines: [machine] } });
    await expect(cli.execute('machines.managed.get', { homeId: 'srv_home', managedId: machine.id }, context))
      .resolves.toEqual({ ok: true, result: machine });
    expect(seen).toEqual([
      { url: '/v1/machines/managed/actions/list', body: { homeId: 'srv_home' }, authorization: 'Bearer bound' },
      { url: '/v1/machines/managed/actions/get', body: { homeId: 'srv_home', managedId: machine.id }, authorization: 'Bearer bound' },
    ]);
  });

  it('keeps a named managed refusal distinct from an older Home without the endpoint', async () => {
    app.post('/v1/machines/managed/actions/get', async (_request, reply) => reply.code(404).send({ code: 'managed_not_found' }));
    const cli = executor();
    await expect(cli.execute('machines.managed.get', { homeId: 'srv_home', managedId: 'missing' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'managed_not_found' });
    await expect(cli.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('binds reads to the authenticated Home and withholds retired Account output', async () => {
    let current = true;
    const seen: unknown[] = [];
    app.post('/v1/machines/managed/actions/list', async request => {
      seen.push(request.body);
      current = false;
      return { machines: [machine] };
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
    app.get('/v1/features/authenticated', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return features;
    });
    app.get('/v1/features', async () => features);
    // Only Fetch's HTTP boundary is replaced; feature parsing and provenance
    // come from the same observation owner used by credentialed CLI execution.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe('http://home.test');
      const response = await app.inject({ method: 'GET', url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(response.payload, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    };
    const authenticated = executor({ serverIdentityId: undefined,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'http://home.test', token: 'bound', fetchImpl }),
      isCredentialCurrent: () => current });
    await expect(authenticated.execute('machines.managed.list', { homeId: 'route-home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    const advisory = executor({ serverIdentityId: undefined,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'http://home.test', fetchImpl }) });
    await expect(advisory.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(seen).toEqual([]);
    await expect(authenticated.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    await expect(authenticated.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(seen).toEqual([{ homeId: 'srv_home' }]);
  });
});
