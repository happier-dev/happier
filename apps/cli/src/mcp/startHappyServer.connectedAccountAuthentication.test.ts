import { expect, it, vi } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { startHappyServer } from './startHappyServer';
import type { HappyMcpSessionClient } from './startHappyServer';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createPortableConnectedAccountAuthenticationHttpFixture } from '@/testkit/connectedAccountAuthentication';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as daemonControl from '@/daemon/controlClient';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import * as persistence from '@/persistence';
import { sessionMcpAuthorizationHeaders, sessionMcpTestTransport } from '@/mcp/runtime/sessionMcpClient.testkit';

it.each([false, true])('retains authored Account manual authentication across MCP requests (required configuration: %s)', async requireAccountConfiguration => {
    const origin = `http://mcp-portable-authentication-${requireAccountConfiguration ? 'configured' : 'manual'}.test`;
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { requireAccountConfiguration });
    const { credentials, settings, features, service } = fixture;
    const daemon = vi.spyOn(daemonControl, 'readDaemonPluginCatalog').mockRejectedValue(new Error('No daemon in portable Account fixture'));
    const nativeRpc = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new Error('No Machine in portable Account fixture'));
    const credentialFiles = vi.spyOn(persistence, 'readCredentials').mockRejectedValue(new Error('Credential files are unavailable in this fixture'));
    // The live MCP client owns the permission witness; ApiSessionClient does not.
    const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'mcp-portable-authentication', overrides: {
        getServerBinding: () => ({ serverId: 'mcp-portable', serverUrl: origin }),
        getServerFeaturesSnapshot: () => ({ status: 'ready', features }),
        getWorkDepth: () => 0,
        getHostTurnWorkDepth: () => 0,
    } }), {
        getActiveTurnAdmissionWitness: () => ({ turnId: 'portable-authentication-turn', inputId: 'portable-authentication-input',
            userMessageSeq: 1, userMessageSeqs: [1], callerPermissionMode: 'default',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            agentStartCaller: { kind: 'session', sessionId: 'mcp-portable-authentication', starterDepth: 0, turnDepth: 0 },
        }),
        getActiveTurnPermissionWitness: () => ({ turnId: 'portable-authentication-turn',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
        }),
    } satisfies Pick<HappyMcpSessionClient, 'getActiveTurnAdmissionWitness' | 'getActiveTurnPermissionWitness'>);
    const client = new Client({ name: 'portable-account-authentication', version: '1' });
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    let server: Awaited<ReturnType<typeof startHappyServer>> | undefined;
    try {
        registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: { credentials, serverUrl: origin, isCurrent: () => true,
            savedSecretOperationContext: createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: origin,
                isCurrent: async () => true,
                snapshot: { settings, source: 'network', settingsVersion: 1, loadedAtMs: Date.now(),
                    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
            }),
        } });
        const parentRegistry = registry;
        const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: () => parentRegistry.dispose() };
        server = await startHappyServer(session, { credentials, accountSettings: settings, pluginRuntimeRegistryLease: lease });
        await client.connect(sessionMcpTestTransport(server));
        const execute = async (actionId: string, input: unknown) => {
            const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
            if (response.isError) {
                const text = response.content.find(item => item.type === 'text');
                const failure: unknown = text?.type === 'text' ? JSON.parse(text.text) : null;
                const rawCode = failure && typeof failure === 'object' && 'errorCode' in failure ? failure.errorCode : null;
                const retired = failure && typeof failure === 'object' && 'error' in failure
                    && failure.error === 'Captured Connected Account retired';
                const code = retired ? 'scope-retired' : rawCode === 'target_unavailable' || rawCode === 'scope-retired'
                    || rawCode === 'action_failed' || rawCode === 'connected_account_configuration_target_unavailable'
                    || rawCode === 'connected_account_configuration_unavailable' ? rawCode : 'unclassified_failure';
                throw new Error(`Account authentication Action ${actionId} refused: ${code}`);
            }
            expect(response).toMatchObject({ isError: false });
            const text = response.content.find(item => item.type === 'text');
            if (text?.type !== 'text') throw new Error('Missing Account authentication Action response');
            const result: unknown = JSON.parse(text.text);
            return result;
        };
        let begun = ConnectedAccountAttemptResponseSchema.parse(await execute('connectedServices.authentication.beginConnect', { service, modeId: 'manual' }));
        if (requireAccountConfiguration) {
            expect(begun).toMatchObject({ status: 'configurationRequired', missingFieldIds: ['region'] });
            if (begun.status !== 'configurationRequired' || !begun.attemptId) throw new Error('Missing configuration attempt');
            const target = { kind: 'attempt', attemptId: begun.attemptId };
            expect(await execute('connectedServices.configuration.get', { target })).toMatchObject({
                configuration: { status: 'configurationRequired', revision: null, missingFieldIds: ['region'] },
            });
            const replaced = await execute('connectedServices.configuration.replace', { target,
                expectedRevision: null, values: { region: 'fixture-region' }, secretValues: {} });
            expect(replaced).toMatchObject({ applied: true, revision: expect.any(String) });
            if (!replaced || typeof replaced !== 'object' || !('revision' in replaced) || typeof replaced.revision !== 'string') {
                throw new Error('Missing staged configuration acknowledgement');
            }
            begun = ConnectedAccountAttemptResponseSchema.parse(await execute('connectedServices.authentication.continueConnect', {
                attemptId: begun.attemptId, expectedConfigurationRevision: replaced.revision,
            }));
        }
        expect(begun).toMatchObject({ status: 'awaitingManual' });
        if (begun.status !== 'awaitingManual') throw new Error('Manual authentication did not request fields');
        // A second HTTP request creates a fresh MCP executor. Attempt custody
        // belongs to the containing Account host, not that request's executor.
        expect(await execute('connectedServices.authentication.submitManual', { attemptId: begun.attemptId, fields: { token: 'portable-manual-fixture-token' } }))
            .toMatchObject({ status: 'connected', account: { service, accountId: 'example-account' } });
        const stored = await fixture.readCredential({ service, accountId: 'example-account' });
        expect(stored).not.toBeNull();
        if (!stored) throw new Error('Missing settled credential');
        expect(stored.metadata).not.toHaveProperty('authenticationProvenance');
        expect(JSON.stringify(stored)).not.toContain('portable-manual-fixture-token');
        const reopened = await fixture.reopenCredential(stored);
        expect(reopened.values).toEqual({ token: 'portable-manual-fixture-token' });
        expect(fixture.promotedResourceCount).toBe(1);
        expect(fixture.initialConfiguration === undefined).toBe(!requireAccountConfiguration);
        if (requireAccountConfiguration) expect(fixture.reopenInitialConfiguration()).toMatchObject({ values: { region: 'fixture-region' } });
        expect(fixture.directCredentialWrites).toBe(0);
        expect(fixture.machineRequests).toBe(0);
        expect(nativeRpc).not.toHaveBeenCalled();
        expect(daemon).not.toHaveBeenCalled();
        expect(credentialFiles).not.toHaveBeenCalled();
        const selected = await registry.resolveAccountConnectedAccountRuntime?.(service);
        expect(selected).toBeDefined();
        if (!selected) throw new Error('Missing authored Account authentication registration');
        const authentication = selected.authentication.acquire(() => { throw new Error('The two Actions must already own their runtime'); });
        await server.stop();
        expect(selected.isCurrent()).toBe(true);
        await expect(authentication.attempts.read({ attemptId: begun.attemptId })).resolves.toMatchObject({ status: 'connected' });
        await expect(fetch(server.url, { method: 'POST' })).rejects.toThrow();
        if (!registry.retirePluginConsumers) throw new Error('Missing actual plugin retirement owner');
        await registry.retirePluginConsumers([service.pluginId]);
        expect(selected.isCurrent()).toBe(false);
        await expect(authentication.attempts.read({ attemptId: begun.attemptId })).resolves.toMatchObject({ status: 'unavailable' });
        await lease.release();
        expect(selected.isCurrent()).toBe(false);
        await expect(authentication.attempts.read({ attemptId: begun.attemptId })).resolves.toMatchObject({ status: 'unavailable' });
    } finally {
        await client.close();
        await server?.stop();
        await registry?.dispose();
        await session.close();
        nativeRpc.mockRestore();
        daemon.mockRestore();
        credentialFiles.mockRestore();
        await fixture.close();
    }
});
