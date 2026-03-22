import axios from 'axios';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

describe('axios fastify adapter helper', () => {
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

  it('adapts fastify responses for axios and preserves error codes', async () => {
    const http = await import('@/testkit/http/axiosAdapter').catch(() => null);

    expect(http).not.toBeNull();
    expect(http?.installAxiosFastifyAdapter).toBeTypeOf('function');

    app = fastify({ logger: false });
    app.get('/boom', async (_req, reply) => reply.code(418).send({ error: 'teapot' }));
    await app.ready();

    restoreAdapter = http!.installAxiosFastifyAdapter({
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
});
