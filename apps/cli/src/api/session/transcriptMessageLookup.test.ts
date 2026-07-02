import axios from 'axios';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

function createState(overrides: Partial<ManagedConnectionState> = {}): ManagedConnectionState {
  return {
    phase: 'online',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: 1,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function createSupervisor(state: ManagedConnectionState = createState()): ManagedConnectionSupervisor {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn(() => state),
    reportProbeResult: vi.fn(),
  };
}

describe('waitForTranscriptEncryptedMessageByLocalId', () => {
  let app: FastifyInstance | null = null;
  let restoreAdapter: (() => void) | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    restoreAdapter?.();
    restoreAdapter = null;
    vi.resetModules();
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it('backs off between consecutive request errors to avoid tight polling loops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    let requestCount = 0;
    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      requestCount += 1;
      return reply.code(503).send({ error: 'nope' });
    });
    app.get('/v1/sessions/:sid/messages', async (_req, reply) => {
      return reply.code(500).send({ error: 'should not use v1 transcript scan when v2 is available' });
    });
    await app.ready();

    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    const p = waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'lid',
      maxWaitMs: 1000,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 100,
      errorBackoffMaxMs: 400,
      onError: () => {},
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await p;

    expect(result).toBeNull();
    expect(requestCount).toBe(4);

    // sanity: the adapter should have been exercised via axios
    expect(typeof axios.get).toBe('function');
  });

  it('caps per-request timeout to the remaining maxWaitMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    process.env.HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS = '0';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    const observedTimeouts: number[] = [];
    const getSpy = vi.spyOn(axios, 'get').mockImplementation((async (_url: string, config?: any) => {
      observedTimeouts.push(config?.timeout);
      await new Promise((_resolve, reject) => setTimeout(() => reject(new Error('boom')), config?.timeout ?? 0));
      throw new Error('unreachable');
    }) as any);

    const p = waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'lid',
      maxWaitMs: 500,
      requestTimeoutMs: 10_000,
      pollIntervalMs: 1,
      errorBackoffBaseMs: 1,
      errorBackoffMaxMs: 1,
      onError: () => {},
    });

    try {
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await p;

      expect(result).toBeNull();
      expect(observedTimeouts[0]).toBe(500);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('does not poll by-local-id recovery while the supplied supervisor is offline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');
    const getSpy = vi.spyOn(axios, 'get');

    const p = waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'lid',
      supervisor: createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' })),
      maxWaitMs: 50,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 10,
      onError: () => {},
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('does not fall back to v1 transcript scanning when the v2 localId route is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    const calls: string[] = [];
    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (req: any, reply) => {
      calls.push(`v2:${req.params.sid}:${req.params.localId}`);
      // Simulate an older server that does not implement this route.
      return reply.code(404).send({ error: 'Not found', path: `/v2/sessions/${req.params.sid}/messages/by-local-id/${req.params.localId}` });
    });
    app.get('/v1/sessions/:sid/messages', async (req: any, reply) => {
      calls.push(`v1:${req.params.sid}`);
      return reply.code(500).send({ error: 'v1 should not be used for localId lookup' });
    });
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    const p = waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'lid',
      maxWaitMs: 100,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 10,
      onError: () => {},
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await p;

    expect(result).toBeNull();
    expect(calls.some((v) => v.startsWith('v1:'))).toBe(false);
    expect(calls.filter((v) => v.startsWith('v2:')).length).toBeGreaterThan(0);
  });

  it('treats legacy route-missing responses as supervisor-backed misses and reports unsupported lookup capability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    process.env.HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS = '0';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (req: any, reply) => {
      return reply.code(404).send({ error: 'Not found', path: `/v2/sessions/${req.params.sid}/messages/by-local-id/${req.params.localId}` });
    });
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    const onError = vi.fn();
    const onUnsupported = vi.fn();
    const supervisor = createSupervisor();
    const p = waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'lid',
      supervisor,
      maxWaitMs: 25,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 10,
      onError,
      onUnsupported,
    });

    await vi.advanceTimersByTimeAsync(50);
    const result = await p;

    expect(result).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onUnsupported).toHaveBeenCalledOnce();
    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
  });

  it('does not hide session-not-found 404s as legacy route-missing misses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    process.env.HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS = '0';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      return reply.code(404).send({ error: 'Session not found' });
    });
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    const onError = vi.fn();
    const supervisor = createSupervisor();
    const p = waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'lid',
      supervisor,
      maxWaitMs: 25,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 10,
      onError,
    });

    await vi.advanceTimersByTimeAsync(50);
    const result = await p;

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
  });

  it('returns parsed message details (sidechainId + timestamps) when the v2 localId route succeeds', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      return reply.code(200).send({
        message: {
          id: 'm1',
          seq: 1,
          localId: 'l1',
          sidechainId: 'sc-1',
          createdAt: 111,
          updatedAt: 222,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
        },
      });
    });
    await app.ready();

    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    const result = await waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'l1',
      maxWaitMs: 200,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 10,
      onError: () => {},
    });

    expect(result).toMatchObject({
      id: 'm1',
      seq: 1,
      localId: 'l1',
      sidechainId: 'sc-1',
      createdAt: 111,
      updatedAt: 222,
      content: { t: 'plain' },
    });
  });

  it('exposes structured v2 lookup outcomes for found and not-found responses', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { findTranscriptEncryptedMessageByLocalIdV2 } = await import('./transcriptMessageLookup');

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/found-local', async (_req, reply) => {
      return reply.code(200).send({
        message: {
          id: 'm1',
          seq: 1,
          localId: 'found-local',
          sidechainId: null,
          createdAt: 111,
          updatedAt: 222,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
        },
      });
    });
    app.get('/v2/sessions/:sid/messages/by-local-id/missing-local', async (_req, reply) => {
      return reply.code(404).send({ error: 'Message not found' });
    });
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    await expect(findTranscriptEncryptedMessageByLocalIdV2({
      token: 'token',
      serverUrl: 'http://adapter.test',
      sessionId: 'sid',
      localId: 'found-local',
    })).resolves.toMatchObject({
      type: 'found',
      message: { id: 'm1', localId: 'found-local', createdAt: 111, updatedAt: 222 },
    });

    await expect(findTranscriptEncryptedMessageByLocalIdV2({
      token: 'token',
      serverUrl: 'http://adapter.test',
      sessionId: 'sid',
      localId: 'missing-local',
    })).resolves.toEqual({ type: 'not_found' });
  });

  it('classifies v2 lookup server and malformed-response failures instead of collapsing them to null', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { findTranscriptEncryptedMessageByLocalIdV2 } = await import('./transcriptMessageLookup');

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/server-error', async (_req, reply) => {
      return reply.code(503).send({ error: 'busy' });
    });
    app.get('/v2/sessions/:sid/messages/by-local-id/malformed', async (_req, reply) => {
      return reply.code(200).send({ message: { id: 'm1', seq: 1 } });
    });
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    await expect(findTranscriptEncryptedMessageByLocalIdV2({
      token: 'token',
      serverUrl: 'http://adapter.test',
      sessionId: 'sid',
      localId: 'server-error',
    })).resolves.toMatchObject({
      type: 'unhealthy',
      reason: 'server_5xx',
    });

    await expect(findTranscriptEncryptedMessageByLocalIdV2({
      token: 'token',
      serverUrl: 'http://adapter.test',
      sessionId: 'sid',
      localId: 'malformed',
    })).resolves.toMatchObject({
      type: 'protocol_error',
    });
  });

  it('returns null when the v2 localId route omits timestamps instead of inventing local clock values', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      return reply.code(200).send({
        message: {
          id: 'm1',
          seq: 1,
          localId: 'l1',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
        },
      });
    });
    await app.ready();

    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    const result = await waitForTranscriptEncryptedMessageByLocalId({
      token: 'token',
      sessionId: 'sid',
      localId: 'l1',
      maxWaitMs: 200,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 10,
      onError: () => {},
    });

    expect(result).toBeNull();
  });

  it('rethrows terminal auth failures instead of polling them as missing messages', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    const getSpy = vi.spyOn(axios, 'get').mockRejectedValueOnce(new HttpStatusError(401, 'Authentication failed'));

    try {
      await expect(
        waitForTranscriptEncryptedMessageByLocalId({
          token: 'token',
          sessionId: 'sid',
          localId: 'l1',
          maxWaitMs: 200,
          pollIntervalMs: 10,
          errorBackoffBaseMs: 10,
          errorBackoffMaxMs: 10,
          onError: () => {},
        }),
      ).rejects.toMatchObject({
        name: 'HttpStatusError',
        response: { status: 401 },
      });
      expect(getSpy).toHaveBeenCalledTimes(1);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('stops transcript polling when stale auth appears after an earlier not-found response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
    reloadConfiguration();

    const { waitForTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');

    let requestCount = 0;
    const getSpy = vi.spyOn(axios, 'get').mockImplementation(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        const error = new Error('Message not found') as Error & {
          response?: { status: number; data: { error: string } };
        };
        error.response = { status: 404, data: { error: 'Message not found' } };
        throw error;
      }
      throw new HttpStatusError(403, 'Authentication failed');
    });

    try {
      const promise = waitForTranscriptEncryptedMessageByLocalId({
        token: 'token',
        sessionId: 'sid',
        localId: 'l1',
        maxWaitMs: 500,
        pollIntervalMs: 10,
        errorBackoffBaseMs: 10,
        errorBackoffMaxMs: 10,
        onError: () => {},
      });
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'HttpStatusError',
        response: { status: 403 },
      });

      await vi.advanceTimersByTimeAsync(100);

      await assertion;
      expect(requestCount).toBe(2);
    } finally {
      getSpy.mockRestore();
    }
  });
});
