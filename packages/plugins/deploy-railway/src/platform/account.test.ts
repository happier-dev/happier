import { expect, it } from 'vitest';
import { createRailwayGraphqlClient, RailwayNativeError } from '@happier-dev/railway-api';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { projectRailwayFailure } from './account.js';

const signal = new AbortController().signal;
const context: PluginAccountActionContext = {
  plugin: { id: 'happier.deploy.railway', version: '0.0.0' },
  contribution: { id: 'deploy', qualifiedId: 'happier.deploy.railway/deploy' },
  surface: 'cli', invokedAtMs: 1, signal,
  get services(): never { throw new Error('Unexpected service access'); },
};

it.each([
  [400, 'provider_request_failed', 'provider_request_failed'],
  [401, 'deployment_access_denied', 'deployment_access_denied'],
  [403, 'deployment_access_denied', 'deployment_access_denied'],
  [404, 'deployment_unavailable', 'deployment_unavailable'],
  [408, 'provider_unavailable', 'outcome_unknown'],
  [429, 'provider_request_failed', 'provider_request_failed'],
  [502, 'provider_unavailable', 'outcome_unknown'],
])('classifies Railway HTTP %i for reads and writes', async (status, readCode, writeCode) => {
  const graphql = createRailwayGraphqlClient(async () => new Response(null, { status }), signal);
  for (const [effectAttempted, code] of [[false, readCode], [true, writeCode]] as const) {
    await expect(graphql('query { viewer { id } }', {}).catch(error =>
      projectRailwayFailure(error, context, 'test', effectAttempted)))
      .rejects.toMatchObject({ code, data: { failureCause: { httpStatus: status } } });
  }
});

it.each([
  ['FORBIDDEN', 'deployment_access_denied'],
  ['UNAUTHENTICATED', 'deployment_access_denied'],
  ['CONFLICT', 'deployment_conflict'],
  ['PROJECT_LIMIT_REACHED', 'provider_request_failed'],
  ['INTERNAL_SERVER_ERROR', 'outcome_unknown'],
])('preserves the Railway GraphQL %s classification on writes', async (nativeCode, code) => {
  await expect(Promise.resolve().then(() => projectRailwayFailure(new RailwayNativeError('railway_graphql_unavailable', 200, nativeCode),
    context, 'test', true)))
    .rejects.toMatchObject({ code, data: { failureCause: { httpStatus: 200, nativeErrorCode: nativeCode } } });
});
