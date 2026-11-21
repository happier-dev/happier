import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { observePagesDeployment } from './pages.js';

const scope = { providerIdentity: { providerAccountId: 'account', providerResourceId: 'project-id', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'native' as const, selection: { kind: 'production' as const } }, preparedNative: { projectName: 'existing-pages' }, providerDeploymentId: 'retained-deployment' };
// Constructed current official Pages GET response vectors; only HTTP is replaced.
function fixture(result: unknown, status = 200) {
  const controller = new AbortController();
  const request = vi.fn(async (_input: HttpRequest) => ({ status, headers: {},
    body: new TextEncoder().encode(JSON.stringify({ success: true, result })) }));
  return { controller, request, context: { http: createPluginHttpFixture({ request }), signal: controller.signal, now: () => 123 } };
}
const deployment = { id: scope.providerDeploymentId, project_id: 'project-id', project_name: 'existing-pages', environment: 'production',
  latest_stage: { name: 'deploy', status: 'success' }, url: 'https://retained.example.pages.dev', env_vars: { SECRET: { value: 'private' } } };

it('observes the retained Pages deployment by exact native path without rebuilding, listing or returning configuration', async () => {
  const h = fixture(deployment);
  expect(await observePagesDeployment(scope, h.context)).toEqual({ v: 1, state: 'succeeded', providerDeploymentId: scope.providerDeploymentId,
    observedAtMs: 123, urls: [deployment.url] });
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['GET', 'https://api.cloudflare.com/client/v4/accounts/account/pages/projects/existing-pages/deployments/retained-deployment'],
  ]);
  expect(h.request.mock.calls[0][0]).toMatchObject({ redirect: 'error', credentialBinding: {
    kind: 'connectedAccountPurpose', purpose: 'deploy.manage', method: 'GET', origin: 'https://api.cloudflare.com' } });
});

it('distinguishes successful build from successful deployment and retains truthful terminal outcomes', async () => {
  for (const [stage, status, state] of [['build', 'success', 'running'], ['queued', 'active', 'queued'],
    ['deploy', 'active', 'running'], ['deploy', 'failure', 'failed'], ['build', 'canceled', 'cancelled'],
    ['deploy', 'skipped', 'outcome_unknown']] as const) {
    const h = fixture({ ...deployment, latest_stage: { name: stage, status } });
    expect(await observePagesDeployment(scope, h.context)).toMatchObject({ state, providerDeploymentId: scope.providerDeploymentId });
    expect(h.request).toHaveBeenCalledTimes(1);
  }
});

it('does not certify a skipped deployment from a retained successful stage', async () => {
  const h = fixture({ ...deployment, is_skipped: true });
  expect(await observePagesDeployment(scope, h.context)).toMatchObject({ state: 'outcome_unknown', providerDeploymentId: scope.providerDeploymentId });
  expect(h.request).toHaveBeenCalledTimes(1);
});

it('does not accept a production observation for a Pages preview link', async () => {
  const h = fixture(deployment);
  expect(await observePagesDeployment({ ...scope, providerEnvironment: { kind: 'native', selection: { kind: 'preview' } } }, h.context))
    .toMatchObject({ code: 'provider_response_invalid', phase: 'observe' });
  expect(h.request).toHaveBeenCalledTimes(1);
});

it('keeps lost native identity unknown with no replacement write, and does not disclose invalid provider URLs', async () => {
  const h = fixture({ ...deployment, url: 'https://user:private@example.test' });
  const result = await observePagesDeployment(scope, h.context);
  expect(result).toMatchObject({ code: 'provider_response_invalid', phase: 'observe' });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(await observePagesDeployment({ ...scope, providerDeploymentId: undefined }, h.context))
    .toMatchObject({ code: 'outcome_unknown', phase: 'observe' });
  expect(h.request).toHaveBeenCalledTimes(1);
});

it('preserves provider denial and canonical credential errors without exposing payloads', async () => {
  const h = fixture({ message: 'private-provider-detail' }, 403);
  await expect(observePagesDeployment(scope, h.context)).rejects.toMatchObject({ code: 'deployment_access_denied',
    data: { failureCause: { phase: 'deployment.provider.observe', httpStatus: 403 } } });
  const error = new PluginError({ code: 'credential_unavailable' });
  h.request.mockRejectedValueOnce(error);
  await expect(observePagesDeployment(scope, h.context)).rejects.toBe(error);
});
