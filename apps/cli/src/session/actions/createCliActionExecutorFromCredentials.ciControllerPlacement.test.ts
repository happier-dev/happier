import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    default: {
      ...actual.default,
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Deploy from CI placement with an API token', () => {
  it('submits to the controller Home names through the scoped read, with no saved Home profile', async () => {
    await withConfiguredDaemonTestHome(
      { prefix: 'happier-ci-controller-' },
      async () => {
        const reads: string[] = [];
        const submitted: unknown[] = [];
        // Home HTTP is the boundary; placement, the SDK envelope and the Action owner stay real.
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
          const parsed = new URL(String(url));
          reads.push(
            `${parsed.pathname}?serverId=${String((config?.params as { serverId?: string })?.serverId)}`,
          );
          return parsed.pathname ===
            '/v1/deployments/environments/env/controller'
            ? {
                status: 200,
                data: {
                  ok: true,
                  serverId: 'srv_home',
                  environmentId: 'env',
                  controllerMachineId: 'controller-1',
                },
              }
            : { status: 403, data: { error: 'present_user_required' } };
        });
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url), 'https://home.test').pathname;
            if (path === '/v1/actions/deployments.deploy')
              submitted.push(JSON.parse(String(init?.body)));
            return Response.json(
              { error: 'credential_scope_denied' },
              { status: 403 },
            );
          }),
        );
        const executor = createCliActionExecutorFromCredentials({
          credentials: {
            token:
              'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
            encryption: null,
            credentialProvenance: 'api_token',
          },
          serverId: configuration.activeServerId,
          serverApiUrl: 'https://home.test',
        });
        await executor.execute(
          'deployments.deploy',
          {
            serverId: 'srv_home',
            environmentId: 'env',
            sha: 'a'.repeat(40),
            requestKey: 'ci-1',
          },
          { surface: 'cli' },
        ).catch(() => undefined); // The Home boundary refuses the submission; only placement is under test.
        expect(reads).toEqual([
          '/v1/deployments/environments/env/controller?serverId=srv_home',
        ]);
        expect(submitted).toEqual([
          expect.objectContaining({
            target: { kind: 'machine', machineId: 'controller-1' },
          }),
        ]);
      },
    );
  });
});
