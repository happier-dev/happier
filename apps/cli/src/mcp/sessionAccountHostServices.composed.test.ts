import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import * as undici from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { manifest } from '../../../../packages/plugin-sdk/fixtures/account-actions/src/index';
import { createMutableApiSessionClientFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createRetainedAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createEphemeralPluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { registerHappierSessionAgentToolRpc } from './startHappyServer';

// Replace only the provider transport used by the real plugin HTTP adapter.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: vi.fn() }));
afterEach(() => { vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it('uses the containing Session Account runtime for repeated MCP HTTP Actions without re-admitting Account policy', async () => {
    const home = await mkdtemp(join(tmpdir(), 'U5-SESSION-ACCOUNT-'));
    const origin = 'http://session-account-services.test';
    const accountId = 'session-account-owner';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.sig`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const app = fastify();
    let accountRegistryLoads = 0;
    app.addHook('onRequest', async request => {
        if (request.url === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) accountRegistryLoads += 1;
    });
    // Reuse the public-author compiler/release fixture and its HTTP/Secrets leaf.
    const projectRoot = resolve(import.meta.dirname, '../../../../packages/plugin-sdk/fixtures/account-actions');
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        projectRoot, entryPath: join(projectRoot, 'src/index.ts'),
        manifest: { ...manifest, contributes: { ...manifest.contributes, actions: manifest.contributes.actions.map(action =>
            action.id === 'controller-request' ? { ...action, surfaces: [...action.surfaces, 'agent'] } : action) } },
    } });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    let policyAdmissions = 0;
    app.get('/v2/account/settings', async (_request, reply) => {
        policyAdmissions += 1;
        return reply.code(503).send({ error: 'Session already holds its admitted policy' });
    });
    const restore = installAxiosFastifyAdapter({ app, origin });
    let providerRequests = 0;
    vi.mocked(undici.fetch).mockImplementation(async url => {
        expect(String(url)).toBe('https://account-services.test/variables');
        providerRequests += 1;
        return new undici.Response('accepted');
    });
    const policy = normalizeActionsSettingsV1({ v: 1 });
    const settings = { actionsSettingsV1: policy };
    let accountCurrent = true;
    const operationContext = runWithServerHttpBaseUrl(origin, () => createInvocationSavedSecretOperationContextV1({
        credentials, serverHttpBaseUrl: origin, isCurrent: async () => accountCurrent,
        snapshot: { settings, source: 'network', settingsVersion: 1, loadedAtMs: Date.now(),
            settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
    }));
    const native = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
        contributes: createResolvedContributionRegistry({}) });
    const accountRuntime = createRetainedAccountExecutionRuntime(() => ({ happyHomeDir: home,
        resolveServerFeaturesSnapshot: () => undefined, accountExecution: {
        credentials, serverUrl: origin, serverId: 'account-service-home', isCurrent: () => accountCurrent, savedSecretOperationContext: operationContext,
    } }));
    const nativeLease = createEphemeralPluginRuntimeRegistryLease(native);
    const lease = { ...nativeLease, accountRuntime };
    const session = createMutableApiSessionClientFixture({ sessionId: 'account-service-session', metadata: createTestMetadata(), overrides: {
        getServerBinding: () => ({ serverId: 'account-service-home', serverUrl: origin }),
        getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
        getActiveTurnPermissionWitness: () => ({ turnId: 'account-service-turn',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
    } });
    registerHappierSessionAgentToolRpc(session, { credentials, pluginRuntimeRegistryLease: lease,
        actionsSettingsProvider: { getActionsSettings: () => policy, getAccountSettings: () => settings } });
    try {
        for (const key of ['first', 'second']) {
            const result = await session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1, { toolName: 'action_execute', toolCallId: key, args: {
                actionId: 'action.invoke', input: { action: { pluginId: authored.pluginId, localId: 'controller-request' }, input: { key } },
            } });
            const failureCode = typeof result === 'object' && result !== null && 'errorCode' in result ? result.errorCode : undefined;
            expect(result, JSON.stringify({ failureCode, providerRequests, accountRegistryLoads, policyAdmissions })).toMatchObject({ ok: true, result: { status: 200, nativeServices: [] } });
        }
        accountCurrent = false;
        const retired = await session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1, {
            toolName: 'action_execute', args: { actionId: 'action.invoke',
                input: { action: { pluginId: authored.pluginId, localId: 'controller-request' }, input: { key: 'retired' } } },
        });
        expect(retired).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
        expect(providerRequests).toBe(2);
        expect(policyAdmissions).toBe(0);
        expect(accountRegistryLoads).toBe(1);
        expect(native.executionRealm).not.toBe('account');
    } finally {
        await session.close(); await accountRuntime.dispose(); await nativeLease.release();
        restore(); await app.close(); await rm(home, { recursive: true, force: true });
    }
});
