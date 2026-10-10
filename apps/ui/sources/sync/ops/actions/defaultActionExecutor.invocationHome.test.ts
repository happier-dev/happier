import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionRequesterBootstrapRpcRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildManualSessionCreationKey, executeSessionSpawnNewAction } from './sessionSpawnNewAction';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

// The daemon RPC is the genuine process boundary; Account capture, grant read,
// policy, credential preparation and public Action parsing remain real.
const machineRpcBoundary = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcBoundary,
}));
import { createDefaultActionExecutor, resolveDefaultActionInvocationServerId } from './defaultActionExecutor';

installApprovalCommonModuleMocks();
beforeAll(loadSyncSingletonForTests);
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); machineRpcBoundary.mockReset(); });

describe('default Action original Home selection', () => {
    it('refuses Voice readiness when the captured Home cannot admit its connected-purpose catalog', async () => {
        const localStorage = installLocalStorageMock();
        try {
            const profile = await upsertServerProfile({ serverUrl: 'https://voice-readiness-captured-home.test' });
            const homeId = 'srv_voice_readiness_captured_home';
            await setServerProfileIdentityForUrl(profile.serverUrl, homeId);
            const token = 'e30.eyJzdWIiOiJib2IiLCJwcm92ZW5hbmNlIjp7InYiOjEsImtpbmQiOiJhY2NvdW50IiwiYXV0aG9yaXR5IjoicHJlc2VudF91c2VyIn19.signature';
            expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: homeId }, { token })).toBe(true);
            const accountSettings = {
                // This fixture exercises readiness, not the approval Artifact
                // lifecycle. Use the real persisted Actions policy waiver;
                // no caller bypass or internal approval owner is replaced.
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } },
                voice: { providerId: 'local_conversation', dictation: {
                    sttBinding: 'explicit', stt: { provider: 'device' },
                } },
            };
            setRuntimeFetch(async (rawUrl, init) => {
                const url = new URL(String(rawUrl));
                expect(url.origin).toBe(profile.serverUrl);
                if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                    features: { voice: { enabled: true, happierVoice: { enabled: true } } },
                }));
                if (url.pathname === '/health') return Response.json({ status: 'ok' });
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
                if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: accountSettings }, version: 1 });
                if (url.pathname === '/v1/account/entity-rows/connected-accounts/purposes') return Response.json({}, { status: 503 });
                throw new Error(`Unexpected Voice readiness HTTP effect: ${url.pathname}`);
            });
            const nativeOutcome = await createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceDictation.readiness',
            }, { surface: 'ui', serverId: homeId, authority: 'present_user' });
            expect(nativeOutcome).toMatchObject({ ok: true, result: {
                anchor: 'voiceDictation.readiness', status: 'completed',
            } });
            accountSettings.voice.dictation.stt.provider = 'happier.voice.openai-compat/stt';
            const outcome = await createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceDictation.readiness',
            }, { surface: 'ui', serverId: homeId, authority: 'present_user' });
            expect(outcome).toMatchObject({ ok: true, result: {
                anchor: 'voiceDictation.readiness', status: 'unavailable', reason: 'connected_purpose_catalog_unavailable',
            } });
            expect(machineRpcBoundary).not.toHaveBeenCalled();
        } finally {
            localStorage.restore();
        }
    });

    it('captures the explicit spawn Home even without a focused UI or caller Home', () => {
        const input = {
            executionTarget: { serverId: 'original-bob-home', machineId: 'alice-machine' },
            directory: { kind: 'path', path: '/workspace/project' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        } as const;
        expect(resolveDefaultActionInvocationServerId('session.spawn_new', input, { surface: 'voice' }))
            .toBe('original-bob-home');
        expect(resolveDefaultActionInvocationServerId('session.spawn_new', input, { surface: 'ui', serverId: 'captured-home' }))
            .toBe('captured-home');
    });

    it('reaches the existing private requester carrier through the ordinary UI Action with the original Home and creation key intact', async () => {
        const localStorage = installLocalStorageMock();
        try {
            const profile = await upsertServerProfile({ serverUrl: 'https://requester-spawn-original-home.test' });
            const homeId = 'srv_requester_spawn_original_home';
            await setServerProfileIdentityForUrl(profile.serverUrl, homeId);
            const token = 'e30.eyJzdWIiOiJib2IiLCJwcm92ZW5hbmNlIjp7InYiOjEsImtpbmQiOiJhY2NvdW50IiwiYXV0aG9yaXR5IjoicHJlc2VudF91c2VyIn19.signature';
            expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: homeId }, { token })).toBe(true);
            const custodian = { accountId: 'alice', displayName: 'Alice' };
            const httpPaths: string[] = [];
            setRuntimeFetch(async (rawUrl, init) => {
                const url = new URL(String(rawUrl));
                expect(url.origin).toBe(profile.serverUrl);
                httpPaths.push(url.pathname);
                if (url.pathname === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }));
                if (url.pathname === '/health') return Response.json({ status: 'ok' });
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
                // The canonical reachability owner probes before scoped HTTP dispatch.
                if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (url.pathname === '/v1/machines/alice-machine/access') return Response.json({
                    machineId: 'alice-machine', custodian,
                    access: { custodian, role: 'use', resourceMode: 'plain', accessState: 'ready' },
                    canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [],
                });
                throw new Error(`Unexpected requester preparation HTTP effect: ${url.pathname}`);
            });
            let privateRequest: unknown;
            machineRpcBoundary.mockImplementation(async (request: Readonly<{ method: string; payload: unknown; serverId: string; machineId: string }>) => {
                expect(request.method).toBe(RPC_METHODS.SESSION_SPAWN_NEW);
                expect(request.serverId).toBe(homeId);
                expect(request.machineId).toBe('alice-machine');
                privateRequest = request.payload;
                return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
            });
            const input = {
                executionTarget: { serverId: homeId, machineId: 'alice-machine' },
                directory: { kind: 'path' as const, path: '/workspace/project' },
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                creationKey: buildManualSessionCreationKey('original-home-attempt'),
            };
            const outcome = await executeSessionSpawnNewAction(input, {
                surface: 'ui', authority: 'present_user', actionRequestId: 'original-home-attempt',
            }, createDefaultActionExecutor());
            expect(outcome).toEqual({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' } });
            const prepared = SessionRequesterBootstrapRpcRequestV1Schema.parse(privateRequest);
            expect(prepared.input).toEqual(input);
            expect(prepared.requesterBootstrap).toEqual({ v: 1, disposition: 'ordinary_requester', credentials: { token } });
            expect(JSON.stringify(input).includes(token)).toBe(false);
            expect(JSON.stringify(outcome).includes(token)).toBe(false);
            expect(httpPaths.includes('/v1/machines/alice-machine/access')).toBe(true);
        } finally {
            localStorage.restore();
        }
    });
});
