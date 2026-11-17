import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { QualifiedConnectedAccountRefreshLeaseV4Schema } from '@happier-dev/protocol';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { PluginError } from '@happier-dev/plugin-sdk';
import { buildConnectedServiceCredentialRefreshSpawnErrorResult } from './diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createBuiltInQualifiedNativeRefreshHarness } from './refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { ConnectedServiceRuntimeRegistry } from './runtimeRegistry/registry';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from './sessionRuntimeAuthRefresh';
import { resolveSharedStateRequiredSwitchContinuity } from './sessionAuthSwitch/sharedStateContinuity';
import { stubUndiciFetch } from '@/testkit/http/stubUndiciFetch';

function oauthResponse(accessToken: string) {
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-private',
        id_token: 'id-new', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('registered Session native auth refresh through the canonical coordinator', () => {
    it.each([
        ['provider', 200, null, 'profile'],
        ['resume', 200, null, 'profile'],
        ['resume', 400, null, 'profile'],
        ['provider', 400, null, 'profile'],
        ['busy', 400, 'connected_account_refresh_lease_not_acquired', 'profile'],
        ['owner', 400, 'connected_account_refresh_lease_owner_mismatch', 'profile'],
        ['revision', 400, 'connected_account_refresh_lease_revision_mismatch', 'profile'],
        ['home', 200, 'project_requester_home_unavailable', 'profile'],
        ['provider', 200, null, 'group'],
    ] as const)('prepares retryable auth through %s / HTTP %i / cause %s / selection %s', async (wiring, providerStatus, reason, selection) => {
        const applicationFailures: string[] = [];
        const h = await createBuiltInQualifiedNativeRefreshHarness({ controller: pluginReloadController, groupBinding: selection === 'group',
            ...(wiring === 'resume' ? { onQualifiedConnectedAccountCredentialUpdated: async () => {
                // Real continuity owner, real absent native state. Bootstrap propagates
                // this existing Session's refusal from its credential-update callback.
                const continuity = await resolveSharedStateRequiredSwitchContinuity({
                    agentId: 'codex', accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
                        v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: {},
                    } },
                    serviceId: 'happier.agent.codex/openai-codex',
                });
                if (continuity.mode === 'unsupported') {
                    applicationFailures.push(continuity.errorCode);
                    throw new Error(continuity.errorCode);
                }
            } } : {}),
        });
        let materialized: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> = null;
        const bindings = ConnectedServiceBindingsV2IngressSchema.parse({ v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': selection === 'group'
                ? { source: 'connected', selection: 'group', groupId: 'pool' }
                : { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        try {
            // Persistent storage is the boundary: seed an expired synthetic grant, retaining
            // the real plugin, refresh coordinator, purpose owner and file materializer.
            await h.mutateCredential({ token: h.credentials.token, mutation: {
                ref: h.account, authenticationModeId: 'oauth', expectedCredentialRevision: h.firstRevision,
                expectedConfigurationRevision: null, metadata: (await h.readCredential()).metadata,
                content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                    payload: { v: 1, values: { accessToken: 'expired-test-access', refreshToken: 'test-refresh',
                        idToken: 'test-id', providerAccountId: 'work', expiresAtMs: String(h.now - 1) } },
                    randomBytes: length => new Uint8Array(length) }),
            } });
            const providerFetch = stubUndiciFetch(async () => providerStatus === 200 ? oauthResponse('access-new')
                : new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
            if (wiring === 'home') {
                // The established runtime reads Account mode through the requester-bound
                // Home API. Its unavailable response must not become a provider failure.
                h.getAccountEncryptionMode.mockRejectedValue(new PluginError({
                    code: 'project_requester_home_unavailable', retryable: true,
                    message: 'Home response token=must-not-leak',
                }));
            } else if (wiring !== 'provider' && wiring !== 'resume') {
                // Lease transport/storage is a genuine boundary. A mis-bound owner or
                // revision must refuse before the real plugin's provider exchange.
                h.acquireRefreshLease.mockImplementation(async ({ lease: raw }) => {
                    const lease = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(raw);
                    return { acquired: wiring !== 'busy', leaseUntil: h.now + 60_000,
                        ownerId: wiring === 'owner' ? 'other-machine:runtime' : lease.ownerId,
                        credentialRevision: wiring === 'revision' ? h.thirdRevision : lease.expectedCredentialRevision };
                });
            }
            let failure: unknown;
            const listAccounts = vi.fn(async () => {
                const current = await h.qualifiedApi.listAccounts();
                return { ...current, accounts: current.accounts.map(profile => ({ ...profile, status: 'refresh_failed_retryable' as const })) };
            });
            try {
                materialized = await resolveConnectedServiceAuthForSpawn({ agentId: 'codex', materializationKey: 'retryable-spawn',
                    connectedServicesBindingsRaw: bindings, credentials: h.credentials, api: h.api,
                    baseDir: join(h.happyHomeDir, 'materialized'), activeServerDir: join(h.happyHomeDir, 'active'),
                    qualifiedConnectedAccountApi: { ...h.qualifiedApi, listAccounts },
                    credentialRefreshService: h.coordinator,
                    resolveQualifiedPurposeBindingSnapshot: currentBindings => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                        agentId: 'codex', bindings: currentBindings, contributions: h.registry.contributes,
                    }),
                    activateQualifiedPurposeBindings: snapshot => h.purposeRuntime.activatePurposeBindings({
                        subject: { kind: 'operation', operationId: 'retryable-spawn', consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                            isCurrent: () => h.controller.isRuntimeRegistryCurrent(h.registry) },
                        purposes: snapshot.purposes, bindings: snapshot.bindings,
                    }), nowMs: () => h.now, processEnv: {},
                });
            } catch (error) { failure = error; }
            if ((wiring === 'provider' || wiring === 'resume') && providerStatus === 200) {
                expect(failure).toBeUndefined();
                expect(materialized?.connectedServicesBindings).toMatchObject(bindings);
                expect(listAccounts).toHaveBeenCalledOnce();
                expect((await h.readCredential()).credentialRevision).toBe(h.thirdRevision);
                if (wiring === 'resume') {
                    expect(applicationFailures).toEqual(['provider_session_state_unavailable_for_resume']);
                    const nativeHome = materialized?.env.CODEX_HOME;
                    if (!nativeHome) throw new Error('Refreshed native home unavailable');
                    expect(JSON.parse(await readFile(join(nativeHome, 'auth.json'), 'utf8')))
                        .toMatchObject({ tokens: { access_token: 'access-new', refresh_token: '' } });
                }
            } else {
                expect(materialized).toBeNull();
                const daemonFailure = buildConnectedServiceCredentialRefreshSpawnErrorResult({ agentId: 'codex', error: failure });
                if (!daemonFailure) throw failure;
                const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(daemonFailure));
                const action = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
                    errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
                }));
                if (wiring === 'resume') expect(applicationFailures).toEqual([]);
                if (wiring === 'home') {
                    expect(action).toMatchObject({ type: 'error', retryable: true, launchError: {
                        code: 'project_requester_home_unavailable',
                    } });
                    expect(daemonFailure.errorDetail).toMatchObject({ kind: 'launch_error',
                        code: 'project_requester_home_unavailable' });
                    expect(JSON.stringify(action)).not.toContain('must-not-leak');
                    expect(JSON.stringify(action)).not.toContain('connected_service_credential_refresh_unavailable');
                    expect(h.acquireRefreshLease).not.toHaveBeenCalled();
                    expect(h.mutateCredentialHealth).not.toHaveBeenCalled();
                    expect(providerFetch).not.toHaveBeenCalled();
                    return;
                }
                expect(action).toMatchObject({ type: 'error', retryable: reason !== null, launchError: {
                    code: reason ? 'connected_service_credential_refresh_unavailable' : 'connected_service_credential_reconnect_required',
                } });
                if (action.type !== 'error') throw new Error('Expected rejected grant');
                if (reason) {
                    expect(daemonFailure.errorDetail).toMatchObject({ uxDiagnostic: { diagnostics: { reason } } });
                    if (!('launchError' in action)) throw new Error('Missing launch diagnostic');
                    expect(action.launchError?.message).toContain(reason);
                    expect(providerFetch).not.toHaveBeenCalled();
                } else {
                    expect(daemonFailure.errorDetail).toMatchObject({ uxDiagnostic: {
                        suggestedActions: expect.arrayContaining(['reconnect_profile']),
                    } });
                }
            }
        } finally {
            await materialized?.materializationPurposeLease?.dispose();
            await materialized?.cleanupOnExit?.();
            await h.dispose();
        }
    });
    it('settles two refreshes and retained replay after replacing the exact native home, without disclosing refresh tokens', async () => {
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
            stubUndiciFetch(vi.fn().mockResolvedValueOnce(oauthResponse('access-new')).mockResolvedValueOnce(oauthResponse('access-next')));
            const firstSettlement = { ok: true, result: { status: 'refreshed', result: {
                credentialRevision: h.secondRevision, accessToken: 'access-new', providerAccountId: 'work',
            } } };
            await expect(refresh(request)).resolves.toEqual(firstSettlement);
            await expect(refresh(request)).resolves.toEqual(firstSettlement);
            const root = materialized.env.CODEX_HOME;
            if (!root) throw new Error('Native home unavailable');
            expect(JSON.parse(await readFile(join(root, 'auth.json'), 'utf8'))).toMatchObject({ tokens: { access_token: 'access-new', refresh_token: '' } });
            // Session callbacks may retain the launch revision (Claude SDK does); the registered
            // Session owner forwards its adopted current revision for the next distinct attempt.
            await expect(refresh({ ...request, refreshAttemptId: 'attempt-2' }))
                .resolves.toEqual({ ok: true, result: { status: 'refreshed', result: {
                    credentialRevision: h.thirdRevision, accessToken: 'access-next', providerAccountId: 'work',
                } } });
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
