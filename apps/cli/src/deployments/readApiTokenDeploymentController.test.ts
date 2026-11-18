import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { readApiTokenDeploymentController } from './readApiTokenDeploymentController';

const homeId = 'srv_ci_home';
const environmentId = 'environment-1';
const bearer = `hap_v1_11111111-1111-4111-8111-111111111111_${'A'.repeat(43)}`;
const restores: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore();
});

// The Home is the boundary: a fresh CI runner knows only its URL, its token and the step's serverId.
function home(
  reply: (
    query: Record<string, unknown>,
  ) => Readonly<{ status: number; body: unknown }>,
) {
  const app = fastify();
  const seen: Array<Readonly<{ url: string; authorization: unknown }>> = [];
  app.get(
    '/v1/deployments/environments/:environmentId/controller',
    async (request, response) => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      const result = reply(request.query as Record<string, unknown>);
      return response.code(result.status).send(result.body);
    },
  );
  const restore = installAxiosFastifyAdapter({
    app,
    origin: 'https://ci.example.test',
  });
  restores.push(async () => {
    restore();
    await app.close();
  });
  return seen;
}

describe('scoped CI controller placement', () => {
  it('names the current controller once the authenticated Home confirms the step serverId', async () => {
    const seen = home((query) => ({
      status: 200,
      body: {
        ok: true,
        serverId: query.serverId,
        environmentId,
        controllerMachineId: 'controller-1',
      },
    }));
    expect(
      await readApiTokenDeploymentController(
        { serverApiUrl: 'https://ci.example.test', bearer },
        { serverId: homeId, environmentId },
      ),
    ).toEqual({ ok: true, machineId: 'controller-1' });
    expect(seen).toEqual([
      {
        url: `/v1/deployments/environments/${environmentId}/controller?serverId=${homeId}`,
        authorization: `Bearer ${bearer}`,
      },
    ]);
  });

  it.each([
    [
      'the grant excludes it',
      403,
      { ok: false, error: 'deployment_access_denied' },
      'deployment_access_denied',
    ],
    [
      'the Home is elsewhere',
      404,
      { ok: false, error: 'deployment_unavailable' },
      'deployment_unavailable',
    ],
    [
      'the Home predates the read',
      404,
      { error: 'Not Found' },
      'unsupported_action',
    ],
  ] as const)(
    'refuses placement when %s',
    async (_case, status, body, errorCode) => {
      home(() => ({ status, body }));
      expect(
        await readApiTokenDeploymentController(
          { serverApiUrl: 'https://ci.example.test', bearer },
          { serverId: homeId, environmentId },
        ),
      ).toMatchObject({ ok: false, errorCode });
    },
  );
});
