import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { REVIEW_COMMENT_PRINCIPAL_HEADER_V1, ReviewCommentPrincipalHeaderV1Schema, ReviewCommentActionInputSchemasV1, ReviewCommentClaimPublicationDispatchResponseV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { ReviewCommentPublicationTransportRequestV1Schema } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { CliApprovalRequestedHandler } from '@/session/actions/approvals/deferredResult';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import * as persistence from '@/persistence';

import { createPluginInvocationActionsService } from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetInMemoryAccountSettingsContextForTests();
});

describe('plugin Review publication claim approval', () => {
    it.each(['approve', 'reject', 'cancel'] as const)('settles the awaiting claim on its exact host invocation (%s)', decision =>
        withConfiguredDaemonTestHome({ prefix: 'review-claim-approval-', env: {
            HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined,
        } }, async () => {
            const app = Fastify();
            const socket = await createRequesterCurrentnessSocketHarness();
            const controller = new AbortController();
            const accountId = `review-claim-${decision}`;
            const base = 'https://review-claim.example.invalid';
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
                encryption: null, credentialProvenance: 'stored_session' as const };
            // The daemon's persisted Machine identity is a filesystem boundary.
            vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, machineId: 'machine-1' });
            const settings = accountSettingsParse({});
            const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_review-claim', settings });
            registerPlainArtifactRoutes(app, accountId);
            app.get(ACCOUNT_SECURITY_PATH_V1, async () => AccountSecurityGetResponseV1Schema.parse({ v: 1,
                encryptionMode: 'plain', nativeEmail: null, password: { status: 'not_enrolled', revision: null } }));
            const claims: unknown[] = [];
            app.post('/v1/reviews/comments/publication/claim', async request => {
                const principalHeader = request.headers[REVIEW_COMMENT_PRINCIPAL_HEADER_V1];
                if (typeof principalHeader !== 'string') throw new Error('Missing authenticated plugin principal');
                const principal = ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(Buffer.from(principalHeader, 'base64url').toString()));
                expect(principal.actor).toEqual({ kind: 'plugin', pluginId: 'acme.forge' });
                expect(principal.proof).toMatchObject({ machineId: 'machine-1' });
                const claim = ReviewCommentPublicationTransportRequestV1Schema.parse(request.body);
                claims.push(claim);
                return { disposition: 'dispatch', dispatchToken: 'dispatch-token', publicationPlanId: claim.publicationPlanId,
                    entries: claim.entries.map(({ happierCommentId, publicationCorrelationId }) => ({ happierCommentId, publicationCorrelationId })),
                    verdict: claim.verdict, instructions: { entries: claim.entries.map(() => 'dispatch'),
                        verdict: claim.verdict === null ? null : 'dispatch' }, priorResult: null };
            });
            const restoreHttp = installAxiosFastifyAdapter({ app, origin: base });
            vi.stubGlobal('fetch', async (url: string | URL | Request) => {
                const path = new URL(String(url)).pathname;
                if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error(`Unexpected fetch ${path}`);
                return Response.json(features);
            });
            let prompt: Readonly<{ artifactId: string; decide: Parameters<CliApprovalRequestedHandler>[2] }> | undefined;
            let notifyWaiting: (() => void) | undefined;
            const waiting = new Promise<void>(resolve => { notifyWaiting = resolve; });
            const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                serverId: 'review-claim-profile', serverIdentityId: 'srv_review-claim', serverApiUrl: base,
                pluginActionExecutionOwner: 'current_process',
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => settings, allowEnvironmentOverride: false }),
                onApprovalRequested: (artifactId, signal, decide) => new Promise<void | Awaited<ReturnType<typeof decide>>>(resolve => {
                    // Returning void hands the Ask to the app and retires this local decision callback.
                    prompt = { artifactId, decide: async choice => {
                        const answer = await decide(choice);
                        resolve(answer);
                        return answer;
                    } };
                    signal.addEventListener('abort', () => resolve(), { once: true });
                    notifyWaiting?.();
                }),
            });
            const materialization = createPluginActionCallerMaterializationFixture('acme.forge');
            const service = createPluginInvocationActionsService({
                seed: { plugin: { id: 'acme.forge', version: '1.0.0' }, occurrenceId: 'review-publisher', surface: 'plugin',
                    contribution: { id: 'publish-review' },
                    sourceCustody: createManagedPluginSourceCustody('review-publisher-generation'),
                    signal: controller.signal, isOccurrenceCurrent: () => true,
                    resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                    correlationId: `claim-${decision}`, approvalContext: {
                        surface: 'plugin', authority: 'account_automation', runtimeAccountId: accountId,
                        serverId: 'review-claim-profile', serverIdentityId: 'srv_review-claim',
                        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
                    } },
                actionExecutor: executor, invokeContributedAction: async () => { throw new Error('Unexpected contributed Action'); },
            });
            const plan = ReviewCommentActionInputSchemasV1['reviews.comments.claimPublicationDispatch'].parse({
                target: { providerId: 'external-forge', nativeService: { pluginId: 'acme.forge', localId: 'account' },
                    entryRef: { sourceId: 'acme.forge/source', kindId: 'pull-request', collisionScope: 'repo:1', entryId: '1' }, subtarget: null },
                baseRevision: 'base', headRevision: 'head', entries: [], verdict: { kind: 'comment', body: 'Review verdict' },
            });
            const pending = service.execute('reviews.comments.claimPublicationDispatch', plan).then(
                result => ({ kind: 'completed' as const, result }), error => ({ kind: 'refused' as const, error }));
            try {
                expect(await Promise.race([pending, waiting.then(() => ({ kind: 'waiting' as const }))])).toEqual({ kind: 'waiting' });
                expect(claims).toEqual([]);
                expect(prompt).toBeDefined();
                if (decision === 'cancel') controller.abort();
                else {
                    const answer = await prompt!.decide(decision);
                    expect(answer.ok, JSON.stringify(answer)).toBe(true);
                }
                const outcome = await pending;
                if (decision === 'approve') {
                    expect(outcome.kind).toBe('completed');
                    if (outcome.kind !== 'completed') throw outcome.error;
                    expect(ReviewCommentClaimPublicationDispatchResponseV1Schema.parse(outcome.result)).toMatchObject({
                        disposition: 'dispatch', dispatchToken: 'dispatch-token', verdict: { publicationCorrelationId: expect.any(String) },
                    });
                    expect(claims).toHaveLength(1);
                } else {
                    expect(outcome.kind).toBe('refused');
                    expect(claims).toEqual([]);
                }
            } finally {
                controller.abort();
                await pending;
                restoreHttp();
                await socket.close();
                await app.close();
            }
        }));
});
