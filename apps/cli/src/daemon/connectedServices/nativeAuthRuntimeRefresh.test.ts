import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createBuiltInQualifiedNativeRefreshHarness } from './refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { ConnectedServiceRuntimeRegistry } from './runtimeRegistry/registry';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from './sessionRuntimeAuthRefresh';

afterEach(() => vi.unstubAllGlobals());

function oauthResponse(accessToken: string) {
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-private',
        id_token: 'id-new', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('registered Session native auth refresh through the canonical coordinator', () => {
    it('settles two refreshes and retained replay after replacing the exact native home, without disclosing rotation material', async () => {
        const registry = new ConnectedServiceRuntimeRegistry();
        const h = await createBuiltInQualifiedNativeRefreshHarness({ controller: pluginReloadController, runtimeRegistry: registry });
        const serviceId = 'happier.agent.codex/openai-codex';
        const bindings = ConnectedServiceBindingsV2IngressSchema.parse({ v: 2, bindingsByServiceId: {
            [serviceId]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        const selection = { kind: 'profile', serviceId, profileId: 'work' } as const;
        const authority = {};
        const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings,
            contributions: h.registry.contributes });
        if (!snapshot) throw new Error('Current declared purpose unavailable');
        const lease = h.purposeRuntime.activateSessionPurposeBindings({ sessionId: 'session', purposes: snapshot.purposes, bindings: snapshot.bindings });
        let materialized: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> | null = null;
        try {
            materialized = await resolveConnectedServiceAuthForSpawn({ agentId: 'codex', materializationKey: 'session',
                connectedServicesBindingsRaw: bindings,
                resolveQualifiedPurposeBindingSnapshot: currentBindings => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                    agentId: 'codex', bindings: currentBindings, contributions: h.registry.contributes,
                }),
                credentials: h.credentials, api: h.api,
                baseDir: join(h.happyHomeDir, 'materialized'), activeServerDir: join(h.happyHomeDir, 'active'),
                qualifiedConnectedAccountApi: h.qualifiedApi, credentialRefreshService: h.coordinator,
                activateQualifiedPurposeBindings: (purposeSnapshot) => h.purposeRuntime.activatePurposeBindings({
                    subject: { kind: 'operation', operationId: 'session-launch', consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                        isCurrent: () => h.controller.isRuntimeRegistryCurrent(h.registry) },
                    purposes: purposeSnapshot.purposes, bindings: purposeSnapshot.bindings,
                }), nowMs: () => h.now, processEnv: {} });
            if (!materialized) throw new Error('Session native launch materialization unavailable');
            await materialized.materializationPurposeLease?.dispose();
            registry.registerTarget({ sessionId: 'session', pid: 4242, agentId: 'codex', materializationKey: 'session',
                connectedServicesBindingsRaw: bindings, connectedServiceSelectionsEnv: materialized.env,
                exactPurposeBindingSubjectId: lease.subjectId });
            const refresh = createSessionConnectedServiceRuntimeAuthRefreshHandler({ registry,
                captureSessionAuthority: () => ({ identity: authority, isCurrent: lease.isCurrent }),
                resolveDaemonAuthBridge: async (requestedService) => ({ serviceId: requestedService,
                    async refresh(request, context) {
                        if (!context || !request.refreshAttemptId || !request.expectedCredentialRevision) {
                            return { status: 'unavailable', reason: 'missing_authority' };
                        }
                        return await h.coordinator.refreshConnectedServiceCredentialForRuntimeAuthBridge({
                            target: context.target, authority: context.authority, isCurrent: context.isCurrent,
                            acceptSettledCredentialRevision: context.acceptSettledCredentialRevision,
                            serviceId: requestedService, profileId: 'work',
                            expectedCredentialRevision: request.expectedCredentialRevision, refreshAttemptId: request.refreshAttemptId,
                        });
                    },
                }) });
            const request = { sessionId: 'session', selection, refreshAttemptId: 'attempt-1', expectedCredentialRevision: h.firstRevision };
            vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(oauthResponse('access-new')).mockResolvedValueOnce(oauthResponse('access-next')));
            await expect(refresh(request)).resolves.toEqual({ ok: true, result: { status: 'refreshed', result: { credentialRevision: h.secondRevision } } });
            await expect(refresh(request)).resolves.toEqual({ ok: true, result: { status: 'refreshed', result: { credentialRevision: h.secondRevision } } });
            const root = materialized.env.CODEX_HOME;
            if (!root) throw new Error('Native home unavailable');
            expect(JSON.parse(await readFile(join(root, 'auth.json'), 'utf8'))).toMatchObject({ tokens: { access_token: 'access-new', refresh_token: '' } });
            // Session callbacks may retain the launch revision (Claude SDK does); the registered
            // Session owner forwards its adopted current revision for the next distinct attempt.
            await expect(refresh({ ...request, refreshAttemptId: 'attempt-2' }))
                .resolves.toEqual({ ok: true, result: { status: 'refreshed', result: { credentialRevision: h.thirdRevision } } });
            const auth = await readFile(join(root, 'auth.json'), 'utf8');
            expect(JSON.parse(auth)).toMatchObject({ tokens: { access_token: 'access-next', refresh_token: '' } });
            expect(auth).not.toContain('refresh-private');
        } finally {
            lease.dispose();
            await materialized?.cleanupOnExit?.();
            await h.dispose();
        }
    });
});
