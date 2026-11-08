import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchInactiveSessionFollowObservations } from './sessionFollowInactiveObservationsHttp';

describe('inactive Follow observation settlement', () => {
  it.each([
    { status: 503, body: { error: 'database_connection_unavailable', statusCode: 503 }, kind: 'server_error' },
    { status: 200, body: { ok: false, v: 1, error: 'internal' }, kind: 'protocol_error' },
    { status: 200, body: { invalid: true }, kind: 'protocol_error' },
  ])('settles a $status/$kind read without losing its failure cause or retrying', async ({ status, body, kind }) => {
    const app = fastify();
    let requests = 0;
    app.post('/v2/sessions/destination/follows/inactive-observations', async (_request, reply) => {
      requests++;
      return reply.code(status).send(body);
    });
    const serverUrl = 'http://inactive-follow.test';
    const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
    try {
      const result = await runWithServerHttpBaseUrl(serverUrl, () => fetchInactiveSessionFollowObservations({
        token: 'fixture-token', destinationSessionId: 'destination', machineId: 'machine', installationId: 'installation',
        reason: 'receiver-recovery',
      }));
      expect(result).toMatchObject({ ok: false, error: 'observation_unavailable', failure: { kind } });
      if (status === 503) expect(result).toMatchObject({ failure: { statusCode: 503 },
        diagnostic: { responseError: 'database_connection_unavailable' } });
      expect(requests).toBe(1);
    } finally { restore(); await app.close(); }
  });

  it('settles a disconnected transport once and retains the network cause', async () => {
    // Axios is the network boundary; the observation transport stays real.
    const post = vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }));
    try {
      const result = await fetchInactiveSessionFollowObservations({ token: 'fixture-token', destinationSessionId: 'destination',
        machineId: 'machine', installationId: 'installation', reason: 'receiver-recovery' });
      expect(result).toMatchObject({ ok: false, error: 'observation_unavailable',
        failure: { kind: 'network', retryable: true }, diagnostic: { code: 'ECONNRESET' } });
      expect(post).toHaveBeenCalledTimes(1);
    } finally { post.mockRestore(); }
  });
});
