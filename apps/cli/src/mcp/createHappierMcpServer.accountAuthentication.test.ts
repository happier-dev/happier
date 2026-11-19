import { expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import axios from '@/api/client/credentialAxios';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createPortableConnectedAccountAuthenticationHttpFixture } from '@/testkit/connectedAccountAuthentication';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createHappierMcpServer } from './createHappierMcpServer';
import type { HappyMcpSessionClient } from './startHappyServer';

it('retains explicit Account authentication review and original cancellation before a portable provider effect', async () => {
    const origin = 'http://mcp-portable-review.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin);
    const lifetime = new AbortController();
    const policy = normalizeActionsSettingsV1({ v: 1, actions: {
        'connectedServices.authentication.submitManual': { approvalRequiredSurfaces: ['agent'] },
    } });
    const accountSettings = { ...fixture.settings, actionsSettingsV1: policy };
    // The live MCP client owns the permission witness; ApiSessionClient does not.
    const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'portable-review-session', metadata: createTestMetadata(), overrides: {
        getServerBinding: () => ({ serverId: 'portable-review-home', serverUrl: origin }),
        getServerFeaturesSnapshot: () => ({ status: 'ready', features: fixture.features }),
        getWorkDepth: () => 0,
        getHostTurnWorkDepth: () => 0,
    } }), {
        getActiveTurnAdmissionWitness: () => ({ turnId: 'portable-review-turn', inputId: 'portable-review-input',
            userMessageSeq: 1, userMessageSeqs: [1], callerPermissionMode: 'default',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            agentStartCaller: { kind: 'session', sessionId: 'portable-review-session', starterDepth: 0, turnDepth: 0 },
        }),
        getActiveTurnPermissionWitness: () => ({ turnId: 'portable-review-turn',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
        }),
    } satisfies Pick<HappyMcpSessionClient, 'getActiveTurnAdmissionWitness' | 'getActiveTurnPermissionWitness'>);
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    let runtime: ReturnType<typeof createHappierMcpServer> | undefined;
    let interceptor: number | undefined;
    try {
        registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: {
            credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true,
            savedSecretOperationContext: createInvocationSavedSecretOperationContextV1({ credentials: fixture.credentials,
                serverHttpBaseUrl: origin, isCurrent: async () => !lifetime.signal.aborted,
                snapshot: { settings: accountSettings, source: 'network', settingsVersion: 1, loadedAtMs: Date.now(),
                    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(fixture.credentials) },
            }),
        } });
        const authentication = registry.connectedAccountAuthenticationHost;
        if (!authentication) throw new Error('Expected the actual portable Account authentication host');
        // Starting a manual attempt has durable inputs; submitting its secret fields retains live custody.
        const begun = await authentication.authenticationCommand(undefined,
            { operation: 'beginConnect', service: fixture.service, modeId: 'manual' }, {
                native: async () => { throw new Error('Account attempt must remain portable'); },
            });
        expect(begun).toMatchObject({ status: 'awaitingManual', attemptId: expect.any(String) });
        if (begun.status !== 'awaitingManual') throw new Error('Expected manual attempt');
        const retainedRegistry = registry;
        runtime = createHappierMcpServer(session, { credentials: fixture.credentials,
            actionsSettingsProvider: { getActionsSettings: () => policy, getAccountSettings: () => accountSettings },
            pluginRuntimeRegistryLease: { registry, source: 'ephemeral', durableRevision: -1,
                release: () => retainedRegistry.dispose() },
            toolExecutionSignal: lifetime.signal,
        });
        let reviewed!: () => void;
        const review = new Promise<'review'>(resolve => { reviewed = () => resolve('review'); });
        let approvalWrites = 0;
        // Observe the real Home HTTP acknowledgement, without replacing admission or its store.
        interceptor = axios.interceptors.response.use(response => {
            if (response.config.method?.toLowerCase() === 'post'
                && new URL(response.config.url ?? '', origin).pathname === '/v1/artifacts') {
                approvalWrites += 1;
                reviewed();
            }
            return response;
        });
        const execution = runtime.executeTool({ toolName: 'action_execute', toolCallId: 'portable-review-tool', args: {
            actionId: 'connectedServices.authentication.submitManual',
            input: { attemptId: begun.attemptId, fields: { token: 'portable-review-token' } },
        } });
        // A router refusal or a direct unreviewed provider call settles first and fails this assertion.
        expect(await Promise.race([review.then(() => ({ phase: 'review' })), execution.then(result => ({
            phase: 'settled', errorCode: result.ok ? null : result.errorCode,
        }))])).toEqual({ phase: 'review' });
        lifetime.abort();
        expect(await execution).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(approvalWrites).toBe(1);
        expect(fixture.promotedResourceCount).toBe(0);
        expect(fixture.directCredentialWrites).toBe(0);
        expect(fixture.machineRequests).toBe(0);
        const selected = await registry.resolveAccountConnectedAccountRuntime?.(fixture.service);
        if (!selected) throw new Error('Expected the actual portable Account registration');
        await runtime.mcp.close();
        expect(selected.isCurrent()).toBe(true);
    } finally {
        lifetime.abort();
        if (interceptor !== undefined) axios.interceptors.response.eject(interceptor);
        await runtime?.mcp.close();
        await registry?.dispose();
        await session.close();
        await fixture.close();
    }
});
