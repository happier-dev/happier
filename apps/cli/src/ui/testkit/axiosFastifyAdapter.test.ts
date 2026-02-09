import axios from 'axios';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { installAxiosFastifyAdapter } from './axiosFastifyAdapter.testkit';

describe('installAxiosFastifyAdapter', () => {
  let app: FastifyInstance | null = null;
  let restoreAdapter: (() => void) | null = null;

  afterEach(async () => {
    restoreAdapter?.();
    restoreAdapter = null;
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it('throws axios-shaped errors for validateStatus failures', async () => {
    app = fastify({ logger: false });
    app.get('/boom', async (_req, reply) => {
      return reply.code(418).send({ error: 'teapot' });
    });
    await app.ready();

    restoreAdapter = installAxiosFastifyAdapter({
      app,
      origin: 'http://adapter.test',
    });

    await expect(axios.get('http://adapter.test/boom')).rejects.toMatchObject({
      name: 'AxiosError',
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      response: expect.objectContaining({ status: 418 }),
    });
  });

  it('uses ERR_BAD_RESPONSE for 5xx responses', async () => {
    app = fastify({ logger: false });
    app.get('/boom-500', async (_req, reply) => {
      return reply.code(500).send({ error: 'server exploded' });
    });
    await app.ready();

    restoreAdapter = installAxiosFastifyAdapter({
      app,
      origin: 'http://adapter.test',
    });

    await expect(axios.get('http://adapter.test/boom-500')).rejects.toMatchObject({
      name: 'AxiosError',
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      response: expect.objectContaining({ status: 500 }),
    });
  });

  it('resolves relative urls against baseURL', async () => {
    app = fastify({ logger: false });
    app.get('/relative', async () => ({ ok: true }));
    await app.ready();

    restoreAdapter = installAxiosFastifyAdapter({
      app,
      origin: 'http://adapter.test',
    });

    const client = axios.create({ baseURL: 'http://adapter.test' });
    const response = await client.get('/relative');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
  });
});
