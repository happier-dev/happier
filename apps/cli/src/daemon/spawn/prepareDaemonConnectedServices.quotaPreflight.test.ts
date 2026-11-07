import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProviderAccountUsageRecordId, QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../connectedServices/runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import { resolveConnectedServiceAuthForLaunch, type ConnectedServiceLaunchAuthGroupCoordinatorFactory } from '../connectedServices/resolveConnectedServiceAuthForLaunch';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { buildConnectedServiceQuotaPreflightIncompleteSpawnErrorResult, prepareDaemonConnectedServices } from './prepareDaemonConnectedServices';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { withRealForegroundAdmissionFixture } from '../agentRuntime/foregroundAdmission.testkit';
import { createForegroundPurposeOwnerFixture } from '../agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAgentIsolationMemberPreparationBoundary } from '../agentIsolation/agentIsolationEffects.testkit';

const nativeHomes = vi.hoisted(() => new Map<string, Readonly<{ backingDirectory: string; uid: number; gid: number }>>());
// Only native filesystem ownership is substituted; member setup/admission and launch selection remain real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual,
        lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
            const home = nativeHomes.get(String(path));
            return home ? Object.assign(await actual.lstat(home.backingDirectory), { uid: home.uid, gid: home.gid, mode: 0o40700 }) : actual.lstat(path);
        },
        realpath: async (path: Parameters<typeof actual.realpath>[0]) => nativeHomes.has(String(path)) ? String(path) : actual.realpath(path),
    };
});
afterEach(() => nativeHomes.clear());

describe('connected-service quota spawn preflight', () => {
    it.each([false, true])('applies the foreground requested-model entitlement before materialization (member %s)', async memberLaunch => {
        await withRealForegroundAdmissionFixture({}, async fixture => {
            const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
            const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'pool' },
                incarnation: 'pool-row', displayName: 'Pool', policy: { autoSwitch: true },
                activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
                members: [{ v: 1, connectedAccountId: 'primary', priority: 1, enabled: true,
                    state: { modelUnavailableUntilMsByModelId: { 'requested-model': Date.now() + 60_000 } }, createdAt: 1, updatedAt: 1 }] });
            const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
                ref: { service, accountId: 'primary' }, status: 'connected', authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                configurationReady: true, configurationRevision: null, scopes: [],
            }] });
            const readCredential = vi.fn(async (): Promise<never> => { throw new Error('unexpected-credential-http'); });
            const api = { getAccountEncryptionMode: async () => 'plain', getConnectedServiceCredentialPlain: readCredential } as unknown as ApiClient;
            const { owner } = createForegroundPurposeOwnerFixture({ service, consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                materializeAccount: readCredential });
            const member = memberLaunch ? createAgentIsolationMemberPreparationBoundary({
                activeServerDir: fixture.home, requesterIdentity: { kind: 'isolated', separationRequired: true,
                    homeServerIdentityId: 'canonical-home', requester: { serverId: 'home', accountId: 'member',
                        machineId: 'machine-1', installationId: 'installation' } },
                custodianAccountId: 'owner', encryptionMode: 'plain', uid: 2401,
            }) : null;
            if (member) {
                nativeHomes.set(member.filesystemHome.path, member.filesystemHome);
                expect(await member.prepare()).toMatchObject({ kind: 'ready' });
            }
            let refusalCode: unknown;
            let connectedOwnerReached = false;
            const prepared = await fixture.prepare({ ...(member ? { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: {} } } : {}),
                selection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'requested-model' }, updatedAt: Date.now() },
                connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
                    source: 'connected', selection: 'group', groupId: 'pool' } } } }, {
                activateSessionPurposeBindings: owner.activateSessionPurposeBindings,
                ...(member ? { connectedServicesMaterializationBaseDir: join(fixture.directory, 'materialized'),
                    prepareAgentIsolationMember: async () => {
                        const preparation = await member.prepare();
                        if (preparation.kind !== 'ready') throw new Error('Canonical member preparation refused');
                        return preparation.identity;
                    } } : {}),
                resolveConnectedServiceAuthForSpawn: async input => {
                    connectedOwnerReached = true;
                    try { return await resolveConnectedServiceAuthForLaunch({ ...input, credentials: { token: 'synthetic-foreground', encryption: null },
                        api, qualifiedConnectedAccountApi: { readGroup: async () => group, listAccounts: async () => accounts },
                        activeServerDir: fixture.home, baseDir: join(fixture.directory, 'materialized') }, async () => null);
                    } catch (error) { refusalCode = error && typeof error === 'object' && 'code' in error ? error.code : null; throw error; }
                },
                resolveDaemonSpawnHooks: async agentId => await (await fixture.runtime.registry.acquireAgentCatalogEntry?.(agentId))?.getDaemonSpawnHooks?.() ?? null,
            });
            expect(prepared.ok).toBe(false);
            expect(connectedOwnerReached, prepared.ok ? 'admitted without group owner' : prepared.error.code).toBe(true);
            expect(refusalCode).toBe('connected_service_run_model_unavailable');
            expect(readCredential).not.toHaveBeenCalled();
            // A native model is a valid foreground selection, not a Provider refusal.
            const native = await fixture.prepare({ sessionId: 'native-model-session', attemptId: 'native-model-attempt',
                selection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null, modelId: 'requested-model' }, updatedAt: Date.now() } });
            expect(native.ok).toBe(true);
        });
    });
    it.each([
        { meterModel: null, blockedModel: null, code: 'no_eligible_member', factoryAvailable: true },
        { meterModel: 'requested-model', blockedModel: null, code: 'no_eligible_member', factoryAvailable: true },
        { meterModel: 'other-model', blockedModel: 'requested-model', code: 'connected_service_run_model_unavailable', factoryAvailable: true },
        { meterModel: null, blockedModel: null, code: 'resolution_unavailable', factoryAvailable: false },
    ])('uses launch selection for a committed untracked Session ($meterModel, entitlement $blockedModel, factory $factoryAvailable)', async ({ meterModel, blockedModel, code, factoryAvailable }) => {
        const directory = await mkdtemp(join(tmpdir(), 'daemon-launch-quota-'));
        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
        const credentials = { token: 'synthetic-launch-account', encryption: null };
        const control = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory,
            activeServerDir: directory, serverId: 'home', serverHttpBaseUrl: 'http://127.0.0.1:1',
            machineId: 'machine', custodianAccountId: 'owner', credentials,
            connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
            registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised' });
        try {
            const now = Date.now();
            const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
            const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'pool' },
                incarnation: 'pool-row', displayName: 'Pool', policy: { autoSwitch: true, preTurnProbeMode: 'never' },
                activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
                members: [{ v: 1, connectedAccountId: 'primary', priority: 1, enabled: true,
                    state: blockedModel ? { modelUnavailableUntilMsByModelId: { [blockedModel]: now + 60_000 } } : {},
                    createdAt: 1, updatedAt: 1 }] });
            const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
                ref: { service, accountId: 'primary' }, status: 'connected', authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                configurationReady: true, configurationRevision: null, scopes: [],
            }] });
            const store = createProviderAccountUsageStore();
            const recordKey = { providerId: 'openai', accountSubjectId: 'primary', subjectKind: 'account' as const, quotaScope: 'account' as const };
            store.recordSnapshot({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
                providerId: 'openai', accountSubject: { kind: 'providerSubject', id: 'primary' },
                observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
                meters: [{ meterId: 'allowance', label: 'Allowance', used: 100, limit: 100, unit: 'unknown', remainingPct: 0,
                    utilizationPct: 100, resetsAt: now + 60_000, status: 'ok', modelId: meterModel,
                    limitScope: meterModel ? 'model' : 'account', details: {} }] },
            { sources: [{ serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary', bindingKind: 'group_member', groupId: 'pool', groupGeneration: 7 }] });
            // Only Home HTTP is substituted. An admitted launch must refuse before secret acquisition or pool writes.
            const readCredential = vi.fn(async () => { throw new Error('unexpected-credential-http'); });
            const api = { getAccountEncryptionMode: async () => 'plain', getConnectedServiceCredentialPlain: readCredential } as unknown as ApiClient;
            const forbiddenMutation = vi.fn(async (): Promise<never> => { throw new Error('unexpected-pool-http-write'); });
            const qualifiedApi = { readGroup: async () => group, listAccounts: async () => accounts,
                setActiveAccount: forbiddenMutation, updateRuntimeState: forbiddenMutation };
            const createCoordinator: ConnectedServiceLaunchAuthGroupCoordinatorFactory = async selection =>
                createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({ token: credentials.token,
                    api: qualifiedApi, nowMs: () => now, accountUsageStore: store, applyGeneration: selection.applyGeneration });
            expect(await control.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator.switchBeforeTurn({
                sessionId: 'committed-untracked-session', serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'pool', reason: 'usage_limit',
            })).toEqual({ status: 'session_not_found' });
            const connectedServices = { v: 2 as const, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'pool' },
            } };
            await expect(resolveConnectedServiceAuthForLaunch({ agentId: 'codex', connectedServicesBindingsRaw: connectedServices,
                materializationKey: 'detached', activeServerDir: directory, baseDir: join(directory, 'materialized'),
                credentials, api, qualifiedConnectedAccountApi: qualifiedApi, accountUsageStore: store, nowMs: () => now,
                modelId: 'requested-model', resolveQualifiedPurposeBindingSnapshot: bindings =>
                    resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings, contributions: runtime.registry.contributes }),
            }, createCoordinator)).rejects.toMatchObject({ code: factoryAvailable ? code : 'no_eligible_member' });
            const request = { options: { directory, connectedServices,
                connectedServiceMaterializationIdentityV1: { v: 1 as const, id: 'committed-session-material', createdAt: now },
                modelSelection: { v: 1 as const, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'requested-model', providerConnectionId: null }, updatedAt: now } },
                normalizedExistingSessionId: 'committed-untracked-session', requestedSessionId: 'committed-untracked-session', effectiveResume: '',
                catalogAgentId: 'codex' as const, credentials, api, activeServerDir: directory,
                connectedServicesMaterializationBaseDir: join(directory, 'materialized'), connectedServiceRefreshCoordinator: null,
                processEnv: {}, pluginRuntimeRegistry: runtime.registry, qualifiedConnectedAccountApi: qualifiedApi,
                providerAccountUsageStore: store,
                createConnectedServiceLaunchAuthGroupCoordinator: factoryAvailable ? createCoordinator : undefined };
            const prepared = await prepareDaemonConnectedServices(request);
            expect(prepared).toMatchObject({ ok: false, result: { errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: expect.stringContaining(code) } });
            if (code === 'no_eligible_member' && factoryAvailable) {
                if (prepared.ok) throw new Error('Expected pool refusal');
                const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(prepared.result));
                const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
                    errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
                }));
                expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: true,
                    launchError: { code: 'no_eligible_member', connectedAccountPool: {
                        serviceId: 'happier.agent.codex/openai-codex',
                        excluded: [{ profileId: 'primary', reason: 'quota_exhausted' }],
                    } } });
            }
            expect(readCredential).not.toHaveBeenCalled();
            expect(forbiddenMutation).not.toHaveBeenCalled();
        } finally { await control.dispose(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
    it('returns a stable spawn validation failure for incomplete hard quota evidence', () => {
        expect(buildConnectedServiceQuotaPreflightIncompleteSpawnErrorResult()).toEqual({
            type: 'error',
            errorCode: 'SPAWN_VALIDATION_FAILED',
            errorMessage: 'connected_service_quota_preflight_incomplete',
        });
    });
});
