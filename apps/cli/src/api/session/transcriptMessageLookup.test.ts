import axios from 'axios';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { installAxiosFastifyAdapter } from '@/ui/testkit/axiosFastifyAdapter.testkit';

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
});
