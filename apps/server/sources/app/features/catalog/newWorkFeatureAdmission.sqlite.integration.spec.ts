import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
    ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationBindingV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import type { Fastify } from '@/app/api/types';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-new-work-feature-',
        initAuth: false, initEncrypt: true, initFiles: false,
        env: { HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '0', HAPPIER_FEATURE_BOTS__ENABLED: '0' } });
}, 180_000);
afterAll(async () => { await harness?.close(); });

describe('feature opt-outs refuse admission and preserve recovery', () => {
    it.each([
        '/v1/deployments/environments/:environmentId/controller',
        '/v1/deployments/environments/:environmentId/bindings',
        '/v1/deployments/environments/:environmentId/template',
        '/v1/deployments/environments/:environmentId/backup',
        '/v1/deployments/environments',
        '/v1/deployments/environments/:environmentId/targets',
        '/v1/deployments/environments/:environmentId/deploy',
        '/v1/deployments/environments/:environmentId/rollback',
        '/v1/deployments/environments/:environmentId/promote',
        '/v1/deployments/environments/:environmentId/domains',
    ])('refuses new work at %s before any mutation', async path => {
        const route = createRouteTestBuilder({ method: 'POST', path,
            registerRoutes: app => registerDeploymentRoutes(app as unknown as Fastify) });
        const { reply } = await route.invoke({ userId: 'owner', validationError: new Error('invalid fixture'), body: {} });
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ ok: false, error: 'deployment_unavailable' });
    });

    it.each([
        '/v1/deployments/environments/:environmentId/delete',
        '/v1/deployments/environments/:environmentId/targets/:targetLinkId/unlink',
        '/v1/deployments/environments/:environmentId/teardown',
        '/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions',
        '/v1/deployments/environments/:environmentId/domains/:domainId/remove',
        '/v1/deployments/environments/:environmentId/domains/:domainId/transitions',
    ])('keeps cleanup and admitted-work routes reachable at %s', async path => {
        const route = createRouteTestBuilder({ method: 'POST', path,
            registerRoutes: app => registerDeploymentRoutes(app as unknown as Fastify) });
        const { reply } = await route.invoke({ userId: 'owner', validationError: new Error('invalid fixture'), body: {} });
        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({ ok: false, error: 'deployment_invalid' });
    });

    it('allows the authenticated effect of an admitted deployment after the feature is disabled', async () => {
        const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ accountId: 'owner',
            authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'home', machineId: 'machine',
            installationId: 'installation', custodianAccountId: 'owner', actionId: 'deployments.deploy',
            requestId: randomUUID(), requestEnvelopeDigest: 'd'.repeat(43), target: { kind: 'machine', machineId: 'machine' } });
        const route = createRouteTestBuilder({ method: 'POST', path: '/v1/deployments/environments/:environmentId/deploy',
            registerRoutes: app => registerDeploymentRoutes(app as unknown as Fastify) });
        // Authentication is the upstream trust boundary; these are its verified signed-root facts.
        const { reply } = await route.invoke({ userId: 'owner', validationError: new Error('invalid fixture'), body: {},
            externalActionExecutionAuthorized: true, externalActionExecutionAuthorizationBinding: binding,
            externalActionRootActionId: binding.actionId, externalActionEffectActionId: binding.actionId,
            externalActionExecutionMachineId: binding.machineId });
        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({ ok: false, error: 'deployment_invalid' });
    });

    it.each(['template.draft', 'template.release', 'template.instantiate', 'deployments.prepare'])(
        'refuses new %s Action authorization with a typed transport result', async actionId => {
            const machineId = randomUUID();
            const route = createRouteTestBuilder({ method: 'POST', path: EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1,
                registerRoutes: app => registerExternalActionRoutes(app as unknown as Fastify) });
            const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId,
                envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId }, input: {} } });
            const { reply } = await route.invoke({ userId: randomUUID(), authTokenKind: 'account', authAuthority: 'present_user',
                authTokenLegacy: false, authTokenEpoch: 0, params: { actionId },
                body });
            expect(reply.code).toHaveBeenCalledWith(409);
            expect(reply.send).toHaveBeenCalledWith(expect.stringContaining('target_unavailable'));
        });

    it.each(['template.draft', 'deployments.prepare'])(
        'refuses fresh %s dispatch through the same feature owner', async actionId => {
            const machineId = randomUUID();
            const route = createRouteTestBuilder({ method: 'POST', path: `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}:actionId`,
                registerRoutes: app => registerExternalActionRoutes(app as unknown as Fastify) });
            const request = route.createAuthenticatedRequest({ userId: randomUUID(), raw: new EventEmitter(), authTokenKind: 'account', authAuthority: 'present_user',
                authTokenLegacy: false, authTokenEpoch: 0, params: { actionId },
                body: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId }, input: {} } });
            const reply = Object.assign(route.createReply(), { raw: new EventEmitter() });
            await route.handler(request, reply);
            expect(reply.code).toHaveBeenCalledWith(409);
            expect(reply.send).toHaveBeenCalledWith(expect.stringContaining('target_unavailable'));
        });
});
