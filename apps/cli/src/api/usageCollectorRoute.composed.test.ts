import { randomBytes } from 'node:crypto';
import fastify, { type FastifyRequest } from 'fastify';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';

import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import {
  bindExternalActionExecutionAuthorizationHttpPathV1,
  EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, decodeExternalActionHttpBodyV1,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectDeploymentTelemetryReadAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { USAGE_PRIVATE_RECAP_ACTION_IDS, USAGE_QUERY_ACTION_ID_V1 } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';

import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';

it.each(['environment', 'account'] as const)('routes a signed %s Usage read from a paired terminal to its admitted collector', async scope => {
  const app = fastify();
  const origin = 'http://usage-collector.test';
  const serverId = 'srv_usage_fixture';
  const accountId = 'account';
  const installationId = 'collector-installation';
  const target = { kind: 'machine', machineId: 'collector' } as const;
  const keys = nacl.sign.keyPair();
  const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, actions: { families: ['usage'], ids: [] },
    targets: scope === 'environment' ? { environments: ['staging'], machines: [target.machineId], sessions: [] } : null });
  const credential = { credentialId: '00000000-0000-4000-8000-000000000001', principalId: 'usage-principal', accountId, grant };
  let parent = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-parent-proof', binding: {
    ...credential, accountEncryptionMode: 'plain', custodianAccountId: accountId, serverIdentityId: serverId, installationId,
    machineId: target.machineId, target, actionId: USAGE_QUERY_ACTION_ID_V1, requestId: 'parent-request', requestEnvelopeDigest: 'A'.repeat(43),
  } });
  const projectParent = async () => {
    const authorization = await projectExternalActionRequesterHttpAuthorization({
      authorization: parent, serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin,
      target, installationId, privateKey: keys.secretKey, rootAdmitted: true,
    });
    if (!authorization) throw new Error('Expected an admitted root HTTP projection');
    return authorization;
  };

  const scopeFailure = { error: 'credential_scope_denied', details: { reason: 'environment_not_granted' } };
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.post('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
  app.post('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  app.post('/v1/account/profile', async () => ({ id: accountId }));
  app.post('/v1/account/usage/prices', async () => bundledUsageModelPriceCatalog);
  app.post('/v1/deployments/environments', async (request, reply) => {
    const environments = new URL(request.url, origin).searchParams.getAll('environmentIds');
    if (scope === 'environment' && environments.some(id => id !== 'staging')) return reply.code(403).send(scopeFailure);
    return { ok: true, nextCursor: null, items: environments.filter(id => id === 'staging' || id === 'production').map(id =>
      createDeploymentEnvironmentHeaderV1({ id, serverId, telemetryMachineId: target.machineId })) };
  });

  // Home transport boundary. The CLI mints and relays with its real signed HTTP and codec paths.
  const collectorBody = (request: FastifyRequest) => {
    const frame = decodeExternalActionHttpBodyV1(request.body);
    const signature = frame?.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
    if (!frame || !signature || !verifyExternalActionMachineRequestV1({
      authorizationToken: parent.token, effectActionId: ACTION_INVOKE_ACTION_ID_V1,
      target, installationId, requestId: parent.binding.requestId, method: 'POST', path: request.url,
      body: frame.body, signature, publicKey: keys.publicKey,
    })) throw new Error('Expected the signed Usage parent on the collector request');
    return ExternalActionExecutionAuthorizationRequestV1Schema.parse(frame.body);
  };
  const mints: string[] = [];
  const relays: string[] = [];
  app.post(bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_INVOKE_ACTION_ID_V1), async (request, reply) => {
    const body = collectorBody(request);
    const envelope = body.envelope;
    if (envelope.v !== 2 || !envelope.telemetryCollectorCodec) return reply.code(400).send({ error: 'invalid_envelope' });
    const read = envelope.deploymentReadAdmission;
    if (!read || !('telemetryCollector' in read)) return reply.code(400).send({ error: 'invalid_envelope' });
    const environmentIds = read.telemetryCollector.environmentIds;
    mints.push(...environmentIds);
    return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-child-proof',
      telemetryReadInstallationPublicKey: Buffer.from(keys.publicKey).toString('base64url'), binding: {
        ...parent.binding, actionId: ACTION_INVOKE_ACTION_ID_V1, requestId: envelope.requestId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        telemetryCollectorCodec: true, deploymentReadAdmission: read,
        deploymentTelemetryRead: environmentIds.map(environmentId => ({ environmentId, revision: 1, capabilities: { appLlmCost: true } })),
        usageCollectorParent: { requestId: parent.binding.requestId, requestEnvelopeDigest: parent.binding.requestEnvelopeDigest },
      } });
  });
  app.post(`${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${ACTION_INVOKE_ACTION_ID_V1}`, async (request, reply) => {
    const { envelope, executionAuthorization: child } = collectorBody(request);
    if (envelope.v !== 2 || !child) return reply.code(400).send({ error: 'invalid_envelope' });
    const material = openManagedControllerActionCodecV1({ authorization: child, installationPrivateKey: keys.secretKey,
      machineId: target.machineId, installationId, serverIdentityId: serverId });
    if (!material) return reply.code(400).send({ error: 'invalid_envelope' });
    if ('authentication' in child.binding) return reply.code(400).send({ error: 'invalid_envelope' });
    const binding = { serverIdentityId: serverId, accountId, credentialId: child.binding.credentialId,
      actionId: ACTION_INVOKE_ACTION_ID_V1, requestId: child.binding.requestId, target };
    const opened = openExternalActionRequestV2({ envelope, binding, material, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
    const read = projectDeploymentTelemetryReadAdmissionV1(ACTION_INVOKE_ACTION_ID_V1, opened?.input);
    const source = read?.telemetryCollector;
    if (!source || source.environmentIds.length !== 1) return reply.code(400).send({ error: 'invalid_envelope' });
    const [environmentId] = source.environmentIds;
    relays.push(environmentId!);
    const callCount = environmentId === 'staging' ? 4 : 8;
    const tokens = { input: callCount * 10, output: callCount * 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: callCount * 12 };
    return prepareExternalActionResponseV2({ request: envelope, binding, material, executedMachineId: target.machineId, randomBytes,
      execution: { ok: true, result: { ok: true, source: { kind: 'environment', serverId, environmentId }, since: 100, until: 200,
        items: [{ bucketStartMs: 0, provider: null, modelId: null, requestedModel: null, operation: null, callCount,
          tokens, tokenCategories: tokens, reportedCost: { amount: 3, currency: 'USD' }, firstSeenMs: 150, lastSeenMs: 150 }],
        coverage: { callCount, tokenCategoryCallCount: callCount, reportedCostCallCount: callCount, lostObservations: 0, reason: null },
      } } }).response;
  });
  const dispose = installAxiosFastifyAdapter({ app, origin });
  try {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ sub: accountId, tokenEpoch: 7,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })}.fixture`;
    const executor = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null },
      machineId: target.machineId, serverId, serverApiUrl: origin, serverIdentityId: serverId,
      externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: keys.secretKey,
      resolveServerFeaturesSnapshot: async () => undefined });
    const context = { surface: 'api' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
      serverId, serverIdentityId: serverId, externalActionTarget: target, actionRequestId: parent.binding.requestId,
      externalActionCredential: credential, externalActionExecutionAuthorization: await projectParent() };
    const ids = scope === 'environment' ? ['staging'] : ['staging', 'production'];
    const query = (ids: string[]) => ({
      sources: ids.map(id => `app_calls:${id}`), period: { startMs: 100, endMs: 200 }, includeComparison: false,
      includeQuota: false, includeSessionEvidence: false, includeWorkEvidence: false, includeActivity: false,
    });
    const execute = (ids: string[]) => executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [query(ids)] }, context);
    const result = await execute(ids);
    if (!result.ok) throw new Error(`Usage refused: ${result.errorCode}`);
    const { results: [slice] } = UsageQueryBatchResultSchema.parse(result.result);
    expect(slice?.sources.filter(row => row.source === 'accounting')
      .map(row => ({ status: row.status, code: row.errorCode, phase: row.failureCause?.phase })),
      `Collector HTTP requests: ${mints.length} mint, ${relays.length} relay`)
      .toEqual([{ status: 'available', code: undefined, phase: undefined }]);
    expect(slice?.accounting?.totals).toMatchObject({
      eventCount: scope === 'environment' ? 4 : 12, tokens: { total: scope === 'environment' ? 48 : 144 },
    });
    expect(mints.sort()).toEqual([...ids].sort());
    expect(relays.sort()).toEqual([...ids].sort());
    if (scope === 'environment') {
      const refused = await execute(['production']);
      expect(refused).toMatchObject({ ok: false, errorCode: 'credential_scope_denied', details: scopeFailure.details });
      expect(mints).toEqual(ids);
      expect(relays).toEqual(ids);

      const recapAction = USAGE_PRIVATE_RECAP_ACTION_IDS.compose;
      parent = ExternalActionExecutionAuthorizationV1Schema.parse({
        ...parent, token: 'fixture-recap-proof',
        binding: { ...parent.binding, actionId: recapAction, requestId: 'recap-request' },
      });
      const recapContext = { ...context, actionRequestId: parent.binding.requestId,
        externalActionExecutionAuthorization: await projectParent() };
      const recap = (ids: string[]) => executor.execute(recapAction,
        { query: normalizeUsageQuery(query(ids)), selectedFields: ['tokens'] }, recapContext);
      await expect(recap(ids)).resolves.toMatchObject({ ok: true, result: { kind: 'composed', facts: { tokens: { total: 48 } } } });
      await expect(recap(['production'])).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied', details: scopeFailure.details });
      expect(mints).toEqual(['staging', 'staging']);
      expect(relays).toEqual(['staging', 'staging']);
    }
  } finally {
    dispose();
    await app.close();
  }
});
