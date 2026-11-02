import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';

import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionReadStateActionDeps } from './sessionReadStateActionDeps';

describe('Session read-state HTTP Action adapter', () => {
  let app = fastify();
  let restore = () => {};

  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://read-state.test' });
  });

  afterEach(async () => {
    restore();
    await app.close();
  });

  it('requires the fixed endpoint and Home identity as one binding', () => {
    const partial = { token: 'token', serverHttpBaseUrl: 'http://read-state.test' };
    // @ts-expect-error -- Untyped callers can still attempt the incomplete runtime shape.
    expect(() => createSessionReadStateActionDeps(partial)).toThrow('fixed_action_server_target_incomplete');
  });

  it.each(['home-a', 'srv_home_a'])('binds the captured Home through %s, encodes the Session id, and carries only the route body', async requestedServerId => {
    app.post('/v2/sessions/:sessionId/read-state', async (request) => {
      expect(request.params).toEqual({ sessionId: 'session/one' });
      expect(request.body).toEqual({ state: 'unread' });
      expect(request.headers.authorization).toBe('Bearer token');
      return {
        success: true,
        state: 'unread',
        lastViewedSessionSeq: 6,
        didChange: true,
      };
    });
    const deps = createSessionReadStateActionDeps({
      token: 'token',
      serverId: 'home-a',
      serverIdentityId: 'srv_home_a',
      serverHttpBaseUrl: 'http://read-state.test',
    });
    await expect(deps.sessionReadStateAction!({
      actionId: 'session.read_state.set',
      input: { sessionId: 'session/one', state: 'unread' },
      context: { surface: 'cli', authority: 'present_user' },
      serverId: requestedServerId,
    })).resolves.toEqual({
      success: true,
      state: 'unread',
      lastViewedSessionSeq: 6,
      didChange: true,
    });
  });

  it('refuses a different selected Home before sending the bound credential', async () => {
    let requests = 0;
    app.post('/v2/sessions/:sessionId/read-state', async () => {
      requests += 1;
      return { success: true, state: 'read', lastViewedSessionSeq: 7, didChange: true };
    });
    const deps = createSessionReadStateActionDeps({
      token: 'token',
      serverId: 'home-a',
      serverIdentityId: 'srv_home_a',
      serverHttpBaseUrl: 'http://read-state.test',
    });

    await expect(deps.sessionReadStateAction!({
      context: { surface: 'cli', authority: 'present_user' },
      actionId: 'session.read_state.set',
      serverId: 'home-b',
      input: { sessionId: 'session-1', state: 'read' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'server_target_mismatch',
      error: 'server_target_mismatch',
    });
    expect(requests).toBe(0);
  });

  it('preserves a present-user authority refusal instead of requesting authentication', async () => {
    app.post('/v2/sessions/:sessionId/read-state', async (_request, reply) => {
      return reply.code(403).send({ error: 'present_user_required' });
    });
    const deps = createSessionReadStateActionDeps({
      token: 'token',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://read-state.test',
    });

    await expect(deps.sessionReadStateAction!({
      context: { surface: 'cli', authority: 'account_automation' },
      actionId: 'session.read_state.set',
      serverId: 'home-a',
      input: { sessionId: 'session-1', state: 'read' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
  });

  it.each([
    { error: 'credential_scope_denied', details: { sessionId: 'private' } },
    { error: 'unknown_denial' },
  ])('keeps malformed or unknown 403s closed', async (payload) => {
    app.post('/v2/sessions/:sessionId/read-state', async (_request, reply) => reply.code(403).send(payload));
    const deps = createSessionReadStateActionDeps({ token: 'token', serverId: 'home-a', serverHttpBaseUrl: 'http://read-state.test' });
    await expect(deps.sessionReadStateAction!({ actionId: 'session.read_state.set',
      input: { sessionId: 'session-1', state: 'read' }, context: {}, serverId: 'home-a',
    })).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('preserves a credential scope refusal instead of requesting authentication', async () => {
    app.post('/v2/sessions/:sessionId/read-state', async (_request, reply) => reply.code(403).send({ error: 'credential_scope_denied' }));
    const deps = createSessionReadStateActionDeps({ token: 'token', serverId: 'home-a', serverHttpBaseUrl: 'http://read-state.test' });
    await expect(deps.sessionReadStateAction!({ actionId: 'session.read_state.set',
      input: { sessionId: 'session-1', state: 'read' }, context: {}, serverId: 'home-a',
    })).resolves.toEqual({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  });
});
