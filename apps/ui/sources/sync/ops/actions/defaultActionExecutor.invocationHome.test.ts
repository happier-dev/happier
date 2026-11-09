import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import nacl from 'tweetnacl';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionFixture, createExistingSessionDirectoryPreflightResult } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildManualSessionCreationKey, executeSessionSpawnNewAction } from './sessionSpawnNewAction';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { resumeSession } from '../sessions';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { voiceSettingsParse, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// The daemon RPC is the genuine process boundary; Account capture, grant read,
// policy, credential preparation and public Action parsing remain real.
const machineRpcBoundary = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcBoundary,
}));
import { createDefaultActionExecutor, resolveDefaultActionInvocationServerId } from './defaultActionExecutor';

installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn(async () => ({ v: 1, ok: true, admittedSessionIds: [] }));
});
beforeAll(loadSyncSingletonForTests);
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); machineRpcBoundary.mockReset(); });

describe('default Action original Home selection', () => {
    it('refuses Voice readiness when the captured Home cannot admit its connected-purpose catalog', async () => {
        const localStorage = installLocalStorageMock();
        const homes = createHomeGovernanceHarness();
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        try {
            const profile = await upsertServerProfile({ serverUrl: 'https://voice-readiness-captured-home.test' });
            const homeId = 'srv_voice_readiness_captured_home';
            await setServerProfileIdentityForUrl(profile.serverUrl, homeId);
            const token = 'e30.eyJzdWIiOiJib2IiLCJwcm92ZW5hbmNlIjp7InYiOjEsImtpbmQiOiJhY2NvdW50IiwiYXV0aG9yaXR5IjoicHJlc2VudF91c2VyIn19.signature';
            expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: homeId }, { token })).toBe(true);
            const machineId = 'voice-readiness-machine';
            const cloudProviderId = 'happier.voice.openai-compat/stt';
            const readinessSettings = (provider: string) => normalizeVoiceSettingsLocalDelta({
                // This fixture exercises readiness, not the approval Artifact
                // lifecycle. Use the real persisted Actions policy waiver;
                // no caller bypass or internal approval owner is replaced.
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } },
                voice: writeVoiceProviderSettingsConfig(voiceSettingsParse({ providerId: 'local_conversation',
                    executionMachine: { mode: 'fixed', machineId },
                    dictation: { sttBinding: 'explicit', stt: { provider } },
                }), cloudProviderId, {
                    baseUrl: 'https://speech.example.test/v1', model: 'whisper-1', language: '',
                    insecureLocalOriginConsent: '', insecureLocalConsentMachineId: '',
                }),
            }, settingsDefaults);
            let accountSettings = readinessSettings('device');
            let settingsVersion = 1;
            installHomeGovernanceBoundaries(homes);
            const savedHomeId = await homes.addHome({ name: 'Voice readiness Home', serverUrl: profile.serverUrl,
                serverIdentityId: homeId, accountId: 'bob', credentials: { token }, currentAccount: true });
            homes.answer(savedHomeId, '/v2/account/settings', { select: () => ({
                body: { content: { t: 'plain', v: accountSettings }, version: settingsVersion },
            }) });
            homes.answer(savedHomeId, '/v1/features', { body: createRootLayoutFeaturesResponse({
                features: { voice: { enabled: true, happierVoice: { enabled: true } } },
            }) });
            homes.answer(savedHomeId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: machineId, accountId: 'bob' })] });
            const purposesPath = '/v1/account/entity-rows/connected-accounts/purposes';
            homes.answer(savedHomeId, purposesPath, { status: 503, body: {} });
            connection = await restoreServerAccountForTest({ serverUrl: profile.serverUrl,
                serverIdentityId: homeId, accountId: 'bob', credentials: { token }, request: homes.request });
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            await sync.refreshProfile();
            await sync.refreshAccountSettingsFromServer(settingsVersion, storage.getState().settingsScope);
            await sync.refreshMachines();
            const { resolveVoiceExecutionMachineSelectionFromState } = await import('@/voice/settings/executionMachine');
            expect(resolveVoiceExecutionMachineSelectionFromState(storage.getState())).toEqual({ kind: 'resolved', machineId });
            const nativeOutcome = await createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceDictation.readiness',
            }, { surface: 'ui', serverId: homeId, authority: 'present_user' });
            expect(nativeOutcome).toMatchObject({ ok: true, result: {
                anchor: 'voiceDictation.readiness', status: 'completed',
            } });
            accountSettings = readinessSettings(cloudProviderId);
            settingsVersion += 1;
            await sync.refreshAccountSettingsFromServer(settingsVersion, storage.getState().settingsScope);
            const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
            const { projectVoiceProviderSettings } = await import('@/voice/registry/providerRegistry');
            const registry = createDefaultVoiceProviderRegistry();
            const entry = registry.get(cloudProviderId);
            if (!entry) throw new Error('Expected bundled OpenAI-compatible speech provider');
            expect(projectVoiceProviderSettings(entry, storage.getState().settings.voice.providers[cloudProviderId] ?? null))
                .toMatchObject({ status: 'ready' });
            expect(resolveVoiceExecutionMachineSelectionFromState(storage.getState())).toEqual({ kind: 'resolved', machineId });
            const { projectVoiceSpeechCredentialReadiness } = await import('@/voice/registry/speechCredentialReadiness');
            expect(projectVoiceSpeechCredentialReadiness({ registry, role: 'dictation_stt', providerId: cloudProviderId,
                settings: storage.getState().settings, connectedPurposes: null, executionMachineId: machineId,
                providerEnvelope: storage.getState().settings.voice.providers[cloudProviderId] ?? null,
            })).toBe('unknown');
            homes.requests.length = 0;
            const outcome = await createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceDictation.readiness',
            }, { surface: 'ui', serverId: homeId, authority: 'present_user' });
            expect(homes.requestsFor(purposesPath).length).toBeGreaterThan(0);
            expect(homes.requestsFor(purposesPath).every(request => request.serverUrl === profile.serverUrl)).toBe(true);
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: {
                anchor: 'voiceDictation.readiness', status: 'unavailable', reason: 'connected_purpose_catalog_unavailable',
            } });
            expect(machineRpcBoundary).not.toHaveBeenCalled();
        } finally {
            await connection?.dispose();
            await homes.reset();
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

    it('captures the declared terminal Home for a Voice caller without a caller Home', () => {
        const input = { serverId: 'terminal-home', machineId: 'terminal-machine' };
        expect(resolveDefaultActionInvocationServerId('machines.terminal.list', input, { surface: 'voice' }))
            .toBe('terminal-home');
        expect(resolveDefaultActionInvocationServerId('machines.terminal.list', input, { surface: 'ui', serverId: 'captured-home' }))
            .toBe('captured-home');
    });

    it.each([
        { actionId: 'projects.prepare', input: { workspace: { serverId: 'operand-home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/repo' }, phase: 'setup' } },
        { actionId: 'memory.read', input: { ref: { kind: 'doc', artifactId: 'memory', serverId: 'operand-home' } } },
        { actionId: 'memory.remember', input: { sessionRef: { serverId: 'operand-home', sessionId: 'session' }, expectedMetadataRevision: 1, text: 'Remember this' } },
        { actionId: 'memory.remember', input: { scope: 'project', projectRef: { serverId: 'operand-home', projectKey: 'project' }, text: 'Remember this' } },
        { actionId: 'memory.list', input: { serverId: 'operand-home' } },
        { actionId: 'projects.context.update', input: { target: { serverId: 'operand-home', projectKey: 'project' }, expectedRevision: 'absent',
            intent: { kind: 'attach', entry: { id: 'instructions', ref: { kind: 'doc', artifactId: 'doc' }, placement: 'system_append' } } } },
    ] as const)('preserves the domain Home operand for $actionId', ({ actionId, input }) => {
        expect(resolveDefaultActionInvocationServerId(actionId, input, { surface: 'voice' })).toBe('operand-home');
    });

    it('does not treat reviewed source evidence or malformed input as an invocation Home', () => {
        expect(resolveDefaultActionInvocationServerId('memory.remember', { scope: 'account', text: 'Remember this',
            reviewedTarget: { ref: { kind: 'doc', artifactId: 'memory', serverId: 'evidence-home' },
                expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
        }, { surface: 'voice' })).toBeUndefined();
        expect(resolveDefaultActionInvocationServerId('memory.list', { serverId: 'malformed-home', unexpected: true },
            { surface: 'voice' })).toBeUndefined();
    });

    it.each(['session.spawn_new', 'session.open', 'rich-resume', 'spawn acknowledgement loss', 'spawn canonical uncertainty'] as const)('uses the authenticated Action relay for shared %s with the original Home intact', async (operation) => {
        const actionId = operation === 'rich-resume' ? 'session.open'
            : operation === 'spawn acknowledgement loss' || operation === 'spawn canonical uncertainty' ? 'session.spawn_new' : operation;
        const localStorage = installLocalStorageMock();
        try {
            const profile = await upsertServerProfile({ serverUrl: 'https://requester-spawn-original-home.test' });
            const homeId = 'srv_requester_spawn_original_home';
            await setServerProfileIdentityForUrl(profile.serverUrl, homeId);
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: homeId }, { token })).toBe(true);
            const custodian = { accountId: 'alice', displayName: 'Alice' };
            const installation = nacl.sign.keyPair();
            const session = createSessionFixture({ id: 'bob-session', serverId: homeId, active: false,
                metadata: { path: '/workspace/project', host: 'alice-host', machineId: 'alice-machine', flavor: 'codex', codexSessionId: 'native-session' } });
            const sessionWire = SessionCurrentProjectionRecordV1Schema.parse({ ...session,
                metadata: JSON.stringify(session.metadata), metadataLayoutVersion: 0,
                effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
                responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
                agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0 });
            const httpPaths: string[] = [];
            let relayedInput: unknown;
            const machine = { ...createPlainMachineRowFixture({ id: 'alice-machine', accountId: 'alice' }),
                installationId: 'alice-installation', installationPublicKey: encodeBase64(installation.publicKey),
                access: { custodian, role: 'use' as const, resourceMode: 'plain' as const, accessState: 'ready' as const } };
            setRuntimeFetch(createSessionReadBatchFetchBoundary(async (rawUrl, init) => {
                const url = new URL(String(rawUrl));
                expect(url.origin).toBe(profile.serverUrl);
                httpPaths.push(url.pathname);
                if (url.pathname === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }));
                if (url.pathname === '/health') return Response.json({ status: 'ok' });
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
                // The canonical reachability owner probes before scoped HTTP dispatch.
                if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (url.pathname === '/v2/sessions/bob-session') return Response.json({ session: sessionWire });
                if (url.pathname === '/v1/sessions/bob-session/turns') return Response.json({ error: 'not_found' }, { status: 404 });
                if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (url.pathname === '/v1/machines') return Response.json([machine]);
                if (url.pathname === '/v1/machines/managed/actions/list') {
                    expect(JSON.parse(String(init?.body))).toEqual({ homeId, enrolledMachineId: 'alice-machine' });
                    return Response.json({ machines: [] });
                }
                if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
                    return createMachineReadBatchResponseFixture(init.body, id => id === machine.id ? machine : null);
                }
                if (url.pathname === '/v1/machines/alice-machine/access') return Response.json({
                    machineId: 'alice-machine', custodian,
                    access: { custodian, role: 'use', resourceMode: 'plain', accessState: 'ready' },
                    canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [],
                });
                if (url.pathname === `/v1/actions/${actionId}/execution-authorization`) {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                    return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
                        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 0 }, custodianAccountId: 'alice',
                        serverIdentityId: homeId, machineId: 'alice-machine', installationId: 'alice-installation', accountEncryptionMode: 'plain',
                        actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                    } }));
                }
                if (url.pathname === `/v1/actions/${actionId}`) {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                    expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                        purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
                        serverIdentityId: homeId, installationPrivateKey: installation.secretKey })).toEqual({ token });
                    expect(JSON.stringify(request)).not.toContain(token);
                    if (request.envelope.v !== 1) throw new Error('Expected Plain Account Action');
                    relayedInput = request.envelope.input;
                    if (operation === 'spawn acknowledgement loss') return new Response(null, { status: 502 });
                    return Response.json({ v: 1, actionId, requestId: request.envelope.requestId,
                        execution: operation === 'spawn canonical uncertainty'
                            ? { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }
                            : { ok: true, result: operation === 'rich-resume' ? { type: 'success', sessionId: 'bob-session' } : actionId === 'session.spawn_new'
                            ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                            : { ok: true, status: 'opened', sessionId: 'bob-session', serverId: homeId } } });
                }
                throw new Error(`Unexpected requester preparation HTTP effect: ${url.pathname}`);
            }));
            machineRpcBoundary.mockImplementation(async request => {
                if (request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
                    return createExistingSessionDirectoryPreflightResult(request.payload);
                }
                throw new Error('Raw shared-Machine spawn is forbidden');
            });
            const input = {
                executionTarget: { serverId: homeId, machineId: 'alice-machine' },
                directory: { kind: 'path' as const, path: '/workspace/project' },
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                creationKey: buildManualSessionCreationKey('original-home-attempt'),
            };
            const resumeInput = { serverId: homeId, sessionId: 'bob-session', intent: 'resume' as const };
            const context = { surface: 'ui' as const, authority: 'present_user' as const, actionRequestId: 'original-home-attempt', serverId: homeId };
            const executor = createDefaultActionExecutor();
            const account = operation === 'rich-resume' ? await captureLazyActionAccountContext(homeId) : null;
            const richOptions = { sessionId: 'bob-session', machineId: 'alice-machine', directory: '/workspace/project',
                backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
                resume: 'native-session', serverId: homeId, permissionMode: 'read-only' as const,
                permissionModeUpdatedAt: 9, initialTranscriptAfterSeq: 17, spawnNonce: 'rich-resume-attempt',
                initialGoal: { objective: 'Finish the task', tokenBudget: 100 }, environmentVariables: { WORKSPACE: 'project' } };
            const outcome = operation === 'rich-resume'
                ? await resumeSession({ ...richOptions, accountLifetime: account!.accountLifetime })
                : actionId === 'session.spawn_new'
                ? await executeSessionSpawnNewAction(input, context, executor)
                : await executor.execute(actionId, resumeInput, context);
            account?.dispose();
            expect(outcome).toEqual(operation === 'rich-resume' ? { type: 'success', sessionId: 'bob-session' } : { ok: true, result: actionId === 'session.spawn_new'
                ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                : { ok: true, status: 'opened', sessionId: 'bob-session', serverId: homeId } });
            if (operation === 'rich-resume') expect(relayedInput).toMatchObject({ ...resumeInput, resumeRequest: {
                type: 'resume-session', sessionId: richOptions.sessionId, directory: richOptions.directory,
                backendTarget: richOptions.backendTarget, resume: richOptions.resume, permissionMode: richOptions.permissionMode,
                permissionModeUpdatedAt: 9, initialTranscriptAfterSeq: 17, spawnNonce: richOptions.spawnNonce,
                initialGoal: richOptions.initialGoal, environmentVariables: richOptions.environmentVariables,
            } });
            else expect(relayedInput).toEqual(actionId === 'session.spawn_new' ? input : resumeInput);
            expect(machineRpcBoundary.mock.calls.map(([request]) => request.method)).toEqual(
                actionId === 'session.spawn_new' ? [RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT] : [],
            );
            expect(JSON.stringify(input).includes(token)).toBe(false);
            expect(JSON.stringify(outcome).includes(token)).toBe(false);
            if (actionId === 'session.spawn_new') expect(httpPaths.includes('/v1/machines/alice-machine/access')).toBe(true);
        } finally {
            localStorage.restore();
        }
    });
});
