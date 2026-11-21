import { describe, expect, it } from 'vitest';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import { buildLogsAction, runtimeLogsAction } from './logs.js';

const deployedService = {
  v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1,
  deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation',
  providerDeploymentId: 'retained-railway-deployment',
  providerIdentity: { providerAccountId: 'railway-project', providerResourceId: 'railway-service', providerEnvironment: 'railway-environment' },
  providerEnvironment: { kind: 'native', selection: {
    projectId: 'railway-project', environmentId: 'railway-environment', serviceId: 'railway-service',
  } },
};

function railwayBoundary(payload: unknown, status = 200) {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({
    async request(request) {
      requests.push(request);
      return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(payload)) };
    },
  });
  const unavailable = (): never => { throw new Error('Unexpected non-HTTP host service'); };
  const context = {
    plugin: { id: 'happier.deploy.railway', version: '0.0.0' },
    contribution: { id: 'logs.read', qualifiedId: 'happier.deploy.railway/logs.read' },
    surface: 'cli', invokedAtMs: 1, signal: new AbortController().signal,
    services: {
      http, get storage() { return unavailable(); }, get settings() { return unavailable(); },
      get actions() { return unavailable(); }, get targetedContributions() { return unavailable(); },
      get machineProvisioners() { return unavailable(); }, get secrets() { return unavailable(); },
      get connectedAccounts() { return unavailable(); },
    },
  } satisfies PluginAccountActionContext;
  return { context, requests };
}

describe('Railway deployment log roles', () => {
  it.each([
    ['buildLogs', buildLogsAction],
    ['deploymentLogs', runtimeLogsAction],
  ] as const)('reads only the retained service deployment with %s', async (field, action) => {
    const rows = [{ message: 'first', timestamp: '2026-11-20T10:00:00Z' },
      { message: 'second line\n', timestamp: '2026-11-20T10:00:00Z' }];
    const { requests, context } = railwayBoundary({ data: { [field]: rows } });
    expect(await action.run(deployedService, context)).toEqual({ kind: 'page', page: {
      sourceRevision: deployedService.providerDeploymentId, text: 'first\nsecond line\n', nextCursor: null, truncated: false,
    } });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ url: 'https://backboard.railway.com/graphql/v2', method: 'POST', redirect: 'error',
      credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'cloud-api', headerNames: ['authorization'] } });
    expect(new Headers(request?.headers).has('authorization')).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(request?.body))).toEqual({
      query: expect.stringContaining(`${field}(deploymentId: $deploymentId, limit: $limit)`),
      variables: { deploymentId: deployedService.providerDeploymentId, limit: 500 },
    });
  });

  it('reports a saturated window as partial and retains the last requested lines when Railway returns an extra line', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ message: `line ${index}` }));
    const { requests, context } = railwayBoundary({ data: { deploymentLogs: rows } });
    expect(await runtimeLogsAction.run(deployedService, context)).toEqual({ kind: 'page', page: {
      sourceRevision: deployedService.providerDeploymentId, text: rows.slice(1).map(row => `${row.message}\n`).join(''),
      nextCursor: null, truncated: true,
    } });
    expect(requests).toHaveLength(1);
  });

  it('settles stale cursors and unsupported history and stage selectors without contacting Railway', async () => {
    const { requests, context } = railwayBoundary({ data: { buildLogs: [] } });
    const cursor = { sourceRevision: deployedService.providerDeploymentId, token: 'opaque' };
    expect(await buildLogsAction.run({ ...deployedService, cursor: { ...cursor, sourceRevision: 'other-deployment' } }, context))
      .toEqual({ kind: 'source-changed', sourceRevision: deployedService.providerDeploymentId });
    expect(await buildLogsAction.run({ ...deployedService, cursor }, context)).toEqual({ kind: 'unavailable', reason: 'unsupported' });
    expect(await buildLogsAction.run({ ...deployedService, ref: 'controller-stage' }, context))
      .toEqual({ kind: 'unavailable', reason: 'unsupported' });
    expect(requests).toHaveLength(0);
  });

  it('preserves the typed access refusal from Railway without disclosing its response body', async () => {
    const { context } = railwayBoundary({ errors: [{ message: 'vendor-private-detail' }] }, 403);
    await expect(runtimeLogsAction.run(deployedService, context)).rejects.toMatchObject({
      code: 'deployment_access_denied', message: 'deployment_access_denied',
    });
  });
});
