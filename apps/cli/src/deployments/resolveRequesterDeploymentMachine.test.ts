import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveRequesterDeploymentMachine } from './resolveRequesterDeploymentMachine';

const origin = 'https://fresh-runner.example.test';
const homeId = 'srv_fresh_runner_home';
const restores: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore();
});

// The Home is the boundary. A fresh runner has only its URL, its token and the step's serverId; no saved profile.
function home(
  reply: (
    query: Record<string, unknown>,
  ) => Readonly<{ status: number; body: unknown }>,
) {
  const app = fastify();
  const seen: string[] = [];
  app.get(
    '/v1/deployments/environments/:environmentId',
    async (request, response) => {
      seen.push(`${request.method} ${request.url}`);
      const result = reply(request.query as Record<string, unknown>);
      return response.code(result.status).send(result.body);
    },
  );
  const restore = installAxiosFastifyAdapter({ app, origin });
  restores.push(async () => {
    restore();
    await app.close();
  });
  return seen;
}

describe('requester deployment Machine placement', () => {
  const environment = createDeploymentEnvironmentDetailV1();
  const credentials = {
    token: 'header.payload.signature',
    encryption: null,
    credentialProvenance: 'stored_session' as const,
  };
  const resolve = () =>
    resolveRequesterDeploymentMachine({
      actionId: 'deployments.deploy',
      input: { serverId: homeId, environmentId: environment.environment.id },
      credentials,
      serverApiUrl: origin,
      // The caller's own profile spelling (configuration.activeServerId), which no saved profile maps to the step's Home.
      serverId: 'env_url_profile',
      context: { surface: 'cli' },
    });

  it('reads the controller once from the Home a fresh runner names, without a saved profile', async () => {
    const seen = home(() => ({
      status: 200,
      body: {
        ok: true,
        environment: {
          ...environment.environment,
          serverId: homeId,
          controllerMachineId: 'controller-1',
        },
        targetLinks: [],
      },
    }));
    await expect(resolve()).resolves.toEqual({
      ok: true,
      machineId: 'controller-1',
    });
    expect(seen).toHaveLength(1);
  });

  it("returns the Home's own typed refusal when the step names another Home", async () => {
    home(() => ({
      status: 404,
      body: { ok: false, error: 'deployment_unavailable' },
    }));
    await expect(resolve()).resolves.toMatchObject({
      ok: false,
      errorCode: 'deployment_unavailable',
    });
  });
});
