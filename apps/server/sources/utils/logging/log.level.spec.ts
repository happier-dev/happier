import { afterEach, describe, expect, it, vi } from 'vitest';
import { symbols, type DestinationStream } from 'pino';
import Fastify from 'fastify';

import { log, logger } from './log';

describe('log', () => {
  const originalLevel = logger.level;

  afterEach(() => {
    vi.restoreAllMocks();
    logger.level = originalLevel;
  });

  function captureOutput() {
    const records: Array<{ msg?: string; reqId?: string; res?: Record<string, unknown> }> = [];
    // Replace only the output destination; pino's real level filtering and serialization run.
    const stream = (logger as unknown as { [symbols.streamSym]: DestinationStream })[symbols.streamSym];
    vi.spyOn(stream, 'write').mockImplementation((message) => {
      records.push(JSON.parse(message));
    });
    return records;
  }

  it('emits errors and warnings only when their thresholds admit them', () => {
    logger.level = 'error';
    const records = captureOutput();

    log(
      { module: 'fastify-error', level: 'error', statusCode: 500 },
      'Unhandled error',
    );
    log({ module: 'socket', level: 'warn' }, 'Filtered warning');
    logger.level = 'warn';
    log({ module: 'socket', level: 'warn' }, 'Slow handler');
    log({ module: 'api' }, 'Filtered info');

    expect(records).toMatchObject([
      { module: 'fastify-error', statusCode: 500, msg: 'Unhandled error' },
      { module: 'socket', msg: 'Slow handler' },
    ]);
  });

  it('keeps info for entries without a recognised level', () => {
    logger.level = 'info';
    const records = captureOutput();

    log({ module: 'api' }, 'Request served');
    log({ module: 'api', level: 'loud' }, 'Unknown level');
    log('plain message');

    expect(records).toMatchObject([
      { module: 'api', msg: 'Request served' },
      { module: 'api', msg: 'Unknown level' },
      { msg: 'plain message' },
    ]);
  });

  it('attributes the existing completion line from late authenticated context without extra log lines or content', async () => {
    logger.level = 'info';
    const records = captureOutput();
    const app = Fastify({ loggerInstance: logger });
    let accountId = 'completion-account-private';
    // Authentication is outside this log-shape test; supply its server-stamped
    // request facts after ingress. The real Fastify/Pino lifecycle stays intact.
    app.addHook('preHandler', async request => {
      request.userId = accountId;
      request.authTokenKind = 'terminal';
      request.authAuthority = 'account_automation';
    });
    app.post('/completion', async (_request, reply) => reply.code(202).send({ secret: 'response-content-private' }));
    const purposes = [
      'session-detail:socket-connect-catchup',
      'session-detail:socket-reconnect-catchup',
      'session-detail:metadata-wait-catchup',
      'session-detail:primary-turn-runtime-state',
      'session-detail:degraded-socket-repair',
      'session-detail:explicit-drain',
      'session-detail:startup-drain',
      'session-detail:manual-recovery',
      'session-detail:legacy-compat-proof',
      'session-detail:follow-occurrence',
      'session-detail:follow-source-hydration',
      'session-follow:receiver-recovery',
      'session-follow:manager-turn-admission',
      'session-detail:requester-binding',
      'session-detail:memory-change',
      'session-detail:close-end-proof',
      'session-detail:session-query',
      'session-detail:session-control',
      'session-detail:session-replay',
      'session-detail:session-action',
      'session-detail:session-notification',
      'session-detail:session-content',
      'session-detail:usage-query',
    ];
    const subjects = ['completion-account-private', 'completion-account-private', 'other-account-private'];
    const accountAliases = ['acct_fed8a6ba5a23', 'acct_fed8a6ba5a23', 'acct_f9c3d142ac7c'];
    try {
      for (const [index, purpose] of purposes.entries()) {
        accountId = subjects[index % subjects.length];
        expect((await app.inject({ method: 'POST', url: '/completion',
          headers: { authorization: 'Bearer bearer-private', cookie: 'cookie-private',
            'x-happier-request-purpose': purpose },
          payload: { secret: 'request-content-private' },
        })).statusCode).toBe(202);
      }
      expect(records.map(record => record.msg)).toEqual(purposes.flatMap(() => ['incoming request', 'request completed']));
      const completed = records.filter(record => record.msg === 'request completed');
      expect(completed.map(record => record.res)).toEqual(purposes.map((requestPurpose, index) => ({
        statusCode: 202,
        accountAlias: accountAliases[index % accountAliases.length],
        clientKind: 'unknown',
        authTokenKind: 'terminal',
        authAuthority: 'account_automation',
        requestPurpose,
      })));
      const rendered = JSON.stringify(records);
      for (const secret of ['completion-account-private', 'other-account-private', 'bearer-private', 'cookie-private',
        'request-content-private', 'response-content-private']) expect(rendered).not.toContain(secret);
    } finally {
      await app.close();
    }
  });

  it('retains only the admitted Follow route result and source ids on the existing completion record', async () => {
    logger.level = 'info';
    const records = captureOutput();
    const app = Fastify({ loggerInstance: logger });
    app.post('/follow-result', async (request, reply) => {
      request.followSourceRoute = { sourceKind: 'execution_run', sourceSessionId: 'source-session',
        sourceRunId: 'source-run', sourceTargetMachineId: 'target-machine', sourceRpcCode: 'RPC_METHOD_NOT_AVAILABLE',
        resultCode: 'source_unavailable', sourceReadCode: 'rpc_unavailable' };
      return reply.code(409).send({ error: 'source_unavailable', private: 'response-content-private' });
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/follow-result',
        headers: { authorization: 'Bearer bearer-private', 'x-happier-follow-source': 'caller-content-private' },
        payload: { sourceSessionId: 'caller-content-private' } });
      expect(response.statusCode).toBe(409);
      expect(records.map(record => record.msg)).toEqual(['incoming request', 'request completed']);
      expect(records[1]?.res).toEqual({ statusCode: 409, accountAlias: 'unknown', clientKind: 'unknown',
        authTokenKind: 'unknown', authAuthority: 'unknown', requestPurpose: 'unknown',
        followSourceRoute: { sourceKind: 'execution_run', sourceSessionId: 'source-session', sourceRunId: 'source-run',
          sourceTargetMachineId: 'target-machine', sourceRpcCode: 'RPC_METHOD_NOT_AVAILABLE',
          resultCode: 'source_unavailable', sourceReadCode: 'rpc_unavailable' } });
      for (const privateValue of ['bearer-private', 'caller-content-private', 'response-content-private'])
        expect(JSON.stringify(records)).not.toContain(privateValue);
      expect(records[1]?.reqId).toBeTruthy();
    } finally { await app.close(); }
  });

  it('keeps unauthenticated, missing, and caller-controlled attribution explicit and content-free', async () => {
    logger.level = 'info';
    const records = captureOutput();
    const app = Fastify({ loggerInstance: logger });
    app.post('/public', async (_request, reply) => reply.code(401).send({ error: 'unauthorized' }));
    try {
      for (const purpose of [undefined, 'Bearer purpose-secret', 'session-detail:private-user-text',
        'session-detail:socket-connect-catchup,session-detail:legacy-compat-proof']) {
        await app.inject({ method: 'POST', url: '/public', headers: {
          ...(purpose ? { 'x-happier-request-purpose': purpose } : {}),
          'x-happier-account-id': 'spoofed-account', 'x-happier-client-kind': 'daemon',
        } });
      }
      expect(records.filter(record => record.msg === 'request completed').map(record => record.res)).toEqual(
        [undefined, 'unrecognized', 'unrecognized', 'unrecognized'].map(requestPurpose => ({
          statusCode: 401, accountAlias: 'unknown', clientKind: 'unknown',
          authTokenKind: 'unknown', authAuthority: 'unknown',
          requestPurpose: requestPurpose ?? 'unknown',
        })),
      );
      expect(JSON.stringify(records)).not.toContain('purpose-secret');
      expect(JSON.stringify(records)).not.toContain('private-user-text');
      expect(JSON.stringify(records)).not.toContain('spoofed-account');
    } finally {
      await app.close();
    }
  });
});
