import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import type { ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedDiscussionHttpFixture } from './discussionExecutionAuthorization.testkit';
import { createExternalActionAuthorizedRequestHeaders, resolveExternalActionServerRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import axios from '../../../../../../cli/src/api/client/credentialAxios';

describe('approved Copy Machine read through Home authentication', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-copy-machine-read-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['restricted-token', 'full-token', 'account', 'signed-account'] as const)('reads the execution Machine for an admitted %s Copy child', async kind => {
        const f = await createSignedDiscussionHttpFixture(kind === 'restricted-token' ? 'template.instantiate' : undefined,
            [], false, undefined, { machineReads: true });
        try {
            const authorization = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } }, kind === 'account' || kind === 'signed-account');
            const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', runtimeAccountId: f.account.id,
                externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target };
            const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
            const path = `/v1/machines/${encodeURIComponent(f.machine.id)}`;
            const response = await invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: {} }, context,
                child: { action: 'session.spawn_new', role: 'create_bot', input: {} },
                admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'cli' },
                execute: async (_input, childContext) => {
                    // Native Account requester HTTP retains the signed template root instead of the installed Account bearer.
                    const resolved = kind === 'signed-account' ? { ok: true as const,
                        headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: authorization.binding.actionId,
                            target: authorization.binding.target, method: 'GET', path,
                            installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey }) }
                        : resolveExternalActionServerRequestHeaders({ context: childContext, effectActionId: 'session.spawn_new',
                        method: 'GET', path, daemonToken: f.presentUserToken, serverIdentityId: authorization.binding.serverIdentityId,
                        installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey });
                    if (!resolved.ok) throw new Error('Expected admitted child request headers');
                    const result = await axios.get(`${origin}${path}`, { headers: {
                        ...resolved.headers, 'x-happier-account-stored-content-protocol': '2',
                    }, validateStatus: () => true });
                    if (kind === 'signed-account') {
                        expect(result.status).toBe(200);
                        const reviewedChild: ReviewedActionChildHttpProofV1 = {
                            actionId: 'session.spawn_new', role: 'create_bot',
                            inputDigest: computeActionInputApprovalDigestV1('session.spawn_new', {}),
                        };
                        const refusedRequests = [
                            { name: 'unrelated Machine', path: `/v1/machines/${randomUUID()}`,
                                effectActionId: authorization.binding.actionId, refusal: 'verification_purpose' },
                            { name: 'different Action', path, effectActionId: 'session.spawn_new', refusal: 'effect_family' },
                            { name: 'attached reviewed child', path, effectActionId: authorization.binding.actionId,
                                reviewedChild, refusal: 'reviewed_child' },
                        ];
                        for (const request of refusedRequests) {
                            const response = await axios.get(`${origin}${request.path}`, { headers: {
                                ...createExternalActionAuthorizedRequestHeaders({ authorization,
                                    effectActionId: request.effectActionId, target: authorization.binding.target,
                                    method: 'GET', path: request.path, reviewedChild: request.reviewedChild,
                                    installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey }),
                                'x-happier-account-stored-content-protocol': '2',
                            }, validateStatus: () => true });
                            expect({ status: response.status, refusal: response.data.authorizationRefusal }, request.name)
                                .toEqual({ status: 401, refusal: request.refusal });
                        }
                    }
                    return { status: result.status, refusal: result.status === 200 ? null : result.data.authorizationRefusal,
                        error: result.status === 200 ? null : result.data.error };
                } });
            expect(response).toEqual({ status: 200, refusal: null, error: null });
        } finally { await f.app.close(); }
    });

    it('reads the execution Machine for the Account Copy child’s nested Agent inventory', async () => {
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, undefined, { machineReads: true });
        try {
            const authorization = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } }, true);
            const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', runtimeAccountId: f.account.id,
                externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target };
            const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
            const path = `/v1/machines/${encodeURIComponent(f.machine.id)}`;
            const response = await invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: {} }, context,
                child: { action: 'session.spawn_new', role: 'create_bot', input: {} },
                admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'cli' },
                execute: async (_input, spawnContext) => invokeHostReviewedChildV1({
                    parent: { actionId: 'session.spawn_new', input: {} }, context: spawnContext,
                    child: { ...SESSION_AGENT_READINESS_CHILDREN_V1.inventory, input: {} },
                    execute: async (_inventoryInput, inventoryContext) => {
                        const resolved = resolveExternalActionServerRequestHeaders({ context: inventoryContext,
                            effectActionId: SESSION_AGENT_READINESS_CHILDREN_V1.inventory.action,
                            method: 'GET', path, daemonToken: f.presentUserToken,
                            serverIdentityId: authorization.binding.serverIdentityId,
                            installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey });
                        if (!resolved.ok) throw new Error('Expected admitted nested child request headers');
                        const result = await axios.get(`${origin}${path}`, { headers: {
                            ...resolved.headers, 'x-happier-account-stored-content-protocol': '2',
                        }, validateStatus: () => true });
                        return { status: result.status, refusal: result.status === 200 ? null : result.data.authorizationRefusal,
                            error: result.status === 200 ? null : result.data.error };
                    },
                }),
            });
            expect(response).toEqual({ status: 200, refusal: null, error: null });
        } finally { await f.app.close(); }
    });
});
