import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { ActionId } from '@happier-dev/protocol';
import { createPortableConnectedAccountAuthenticationHttpFixture } from '@/testkit/connectedAccountAuthentication';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import * as persistence from '@/persistence';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createConnectedAccountAttemptTransactionApi } from '@/api/client/connectedAccountAttemptTransactionApi';
import { resolveExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';

it('continues a manual Account attempt in a fresh host after beginConnect has returned', async () => {
    const origin = 'http://manual-account-host-handoff.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin);
    const registries: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>[] = [];
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            await ensureCliActionPolicySettings(fixture.credentials, origin);
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Expected fixture Account settings');
            const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({
                credentials: fixture.credentials, snapshot, serverHttpBaseUrl: origin, isCurrent: async () => true,
            });
            const createHost = async () => {
                const registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: {
                    credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true,
                    savedSecretOperationContext,
                } });
                registries.push(registry);
                if (!registry.connectedAccountAuthenticationHost) throw new Error('Missing Account host');
                return registry.connectedAccountAuthenticationHost;
            };
            const native = async (): Promise<never> => { throw new Error('Account attempt must remain portable'); };
            const begun = await (await createHost()).authenticationCommand(undefined,
                { operation: 'beginConnect', service: fixture.service, modeId: 'manual' }, { native });
            expect(begun).toMatchObject({ status: 'awaitingManual', attemptId: expect.any(String) });
            if (begun.status !== 'awaitingManual') throw new Error('Expected manual attempt');
            await registries[0]!.dispose();
            const resumed = await createHost();
            expect(await resumed.authenticationCommand(undefined, { operation: 'read', attemptId: begun.attemptId }, { native }))
                .toEqual(begun);
            const completed = await resumed.authenticationCommand(undefined,
                { operation: 'submitManual', attemptId: begun.attemptId, fields: { token: 'synthetic-handoff-token' } }, { native });
            expect(completed, JSON.stringify(completed))
                .toMatchObject({ status: 'connected', attemptId: begun.attemptId, account: { service: fixture.service } });
            expect(fixture.promotedResourceCount).toBe(1);
            expect(fixture.machineRequests).toBe(0);
        });
    } finally {
        for (const registry of registries) await registry.dispose();
        await fixture.close();
    }
});

it('reports missing Account artifact availability on first and repeated lookup instead of requiring a restart', async () => {
    const origin = 'http://missing-account-authentication-artifact.test';
    const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, {
        accountId: 'missing-account-authentication-artifact', includeBundledPluginIds: [service.pluginId],
    });
    const declaration = loadCurrentBundledPluginLocatorResult({ pluginIds: [service.pluginId] }).loadedPlugins[0];
    if (!declaration) throw new Error('Expected the bundled Claude declaration');
    // The filesystem projection has no generated graph when its compiled artifact is absent.
    const { generatedUiArtifactsManifest: _generated, ...unpreparedDeclaration } = declaration;
    let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    try {
        registry = await resolveExecutablePluginRuntimeRegistry({
            contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
                loadResult: { loadedPlugins: [unpreparedDeclaration], diagnosticsByPluginId: {} } })),
            accountExecution: { credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true },
        });
        const host = registry.connectedAccountAuthenticationHost;
        if (!host) throw new Error('Expected the Account authentication host');
        const outcomes = [];
        for (const _lookup of ['first', 'repeated']) outcomes.push(await host.authenticationCommand(undefined,
            { operation: 'beginConnect', service, modeId: 'setup-token' },
            { native: async () => { throw new Error('Account artifact failure must not replay on a Machine'); } }));
        expect(registry.pluginDiagnosticsByPluginId[service.pluginId]).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_daemon_module_load_failed', message: 'plugin_account_execution_artifact_unavailable' }),
        ]));
        expect(outcomes).toEqual([
            { status: 'unavailable', code: 'connected_account_service_unavailable' },
            { status: 'unavailable', code: 'connected_account_service_unavailable' },
        ]);
        expect(fixture.machineRequests).toBe(0);
        expect(fixture.promotedResourceCount).toBe(0);
    } finally {
        await registry?.dispose();
        await fixture.close();
    }
});

it('routes required attempt configuration through the selected physical host and ordinary Action admission', async () => {
    const origin = 'http://physical-authentication-config.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { requireAccountConfiguration: true });
    const credentialFiles = vi.spyOn(persistence, 'readCredentials').mockRejectedValue(new Error('Credential files are unavailable in this fixture'));
    const lifetime = new AbortController();
    let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            await ensureCliActionPolicySettings(fixture.credentials, origin);
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Expected fixture Account settings');
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: fixture.credentials,
                snapshot, serverHttpBaseUrl: origin, isCurrent: async () => !lifetime.signal.aborted });
            registry = await resolveExecutablePluginRuntimeRegistry({ signal: lifetime.signal, accountExecution: {
                credentials: fixture.credentials, serverUrl: origin, isCurrent: () => !lifetime.signal.aborted,
                savedSecretOperationContext: operationContext,
            } });
            const host = registry.connectedAccountAuthenticationHost;
            if (!host) throw new Error('Expected the physical Account authentication producer');
            const execute = async (actionId: ActionId, operands: unknown) => {
                const selected = await host.executeAction(actionId, operands, { surface: 'cli', actionRequestId: randomUUID() },
                    (id, input, context, boundHost) => createCliActionExecutorFromCredentials({ credentials: fixture.credentials,
                        connectedAccountAuthenticationHost: boundHost, savedSecretOperationContext: operationContext }).execute(id, input, context));
                expect(selected.matched, actionId).toBe(true);
                if (!selected.matched) throw new Error('Account Action did not match its selected producer');
                if (!selected.result.ok) throw new Error(selected.result.errorCode);
                expect(selected.result.ok, actionId).toBe(true);
                return selected.result.result;
            };
            const begun = ConnectedAccountAttemptResponseSchema.parse(await execute('connectedServices.authentication.beginConnect',
                { service: fixture.service, modeId: 'manual' }));
            if (begun.status !== 'configurationRequired' || !begun.attemptId) throw new Error('Missing prepared Account attempt');
            const target = { kind: 'attempt', attemptId: begun.attemptId };
            const readsBeforeConfiguration = fixture.addressedAttemptReads;
            expect(await execute('connectedServices.configuration.get', { target }))
                .toMatchObject({ configuration: { missingFieldIds: ['region'] } });
            // The shared configuration owner reads the stored values and their
            // revision. The physical adapter adds one addressed routing read.
            expect(fixture.addressedAttemptReads - readsBeforeConfiguration,
                'one routing read plus the existing two configuration storage reads').toBe(3);
            const replacement = await execute('connectedServices.configuration.replace', { target, expectedRevision: null,
                values: { region: 'fixture-region' }, secretValues: {} });
            expect(replacement).toMatchObject({ applied: true, revision: expect.any(String) });
            if (!replacement || typeof replacement !== 'object' || !('revision' in replacement)
                || typeof replacement.revision !== 'string') throw new Error('Missing configuration receipt');
            const configured = ConnectedAccountAttemptResponseSchema.parse(await execute('connectedServices.authentication.continueConnect', {
                attemptId: begun.attemptId,
                expectedConfigurationRevision: replacement.revision,
            }));
            expect(configured.status).toBe('awaitingManual');
            const connected = ConnectedAccountAttemptResponseSchema.parse(await execute('connectedServices.authentication.submitManual', {
                attemptId: begun.attemptId, fields: { token: 'synthetic-retained-token' },
            }));
            if (connected.status !== 'connected') throw new Error('Expected configured Account');
            const accountTarget = { kind: 'account' as const, account: connected.account };
            expect(await execute('connectedServices.configuration.replace', { target: accountTarget,
                expectedRevision: 'csr_1123456789ABCDEFGHJKMNPQRS', values: { region: 'edited-region' }, secretValues: {} }))
                .toMatchObject({ applied: true, revision: 'cscr_replaced_configuration' });
            expect(await execute('connectedServices.configuration.get', { target: accountTarget }))
                .toMatchObject({ configuration: { values: { region: 'edited-region' } } });
            const stored = await fixture.readCredential(connected.account);
            if (!stored) throw new Error('Credential disappeared after configuration edit');
            expect((await fixture.reopenCredential(stored)).values.token).toBe('synthetic-retained-token');
            expect(await host.executeAction('account.security.get', {}, { surface: 'cli' },
                async () => { throw new Error('Unrelated Account Actions stay with their existing router'); })).toEqual({ matched: false });
            expect(credentialFiles).not.toHaveBeenCalled();
            expect(fixture.machineRequests).toBe(0);
            expect(fixture.promotedResourceCount).toBe(1);
        });
    } finally {
        lifetime.abort();
        await registry?.dispose();
        credentialFiles.mockRestore();
        await fixture.close();
    }
});


it.each(['read', 'submitManual', 'cancel'] as const)('routes native %s by the addressed attempt through the credentialed Action executor without a supplied authentication host', async operation => {
    const origin = 'http://native-continuation-action.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { includeBundledPluginIds: ['happier.agent.codex'] });
    const attemptId = `caa_${randomUUID()}`;
    const machineId = 'native-attempt-machine';
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const response = operation === 'submitManual' ? { status: 'connected', attemptId, account: { service, accountId: 'native-account' } }
        : { status: operation === 'cancel' ? 'cancelled' : 'awaitingManual', attemptId };
    // Only the receiving Machine transport is substituted. Account routing,
    // persisted attempt addressing, Action admission and wire parsing stay real.
    const native = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        expect(request.request).toEqual({ v: 1, machineId, command: { operation, attemptId,
            ...(operation === 'submitManual' ? { fields: { source: 'native' } } : {}) } });
        return response;
    });
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            await ensureCliActionPolicySettings(fixture.credentials, origin);
            // This is the Home HTTP/database boundary populated by the native
            // beginConnect producer, not a Machine operand on the continuation.
            await createConnectedAccountAttemptTransactionApi({ token: fixture.credentials.token }).create({
                attemptId, kind: 'manual', content: { t: 'plain', v: {} },
                scope: { machineId, service, modeId: 'native-import', intent: 'connect', phase: 'awaitingManual', createdAtMs: Date.now() },
            });
            // The daemon builds this same credentialed executor without a host.
            const executor = createCliActionExecutorFromCredentials({ credentials: fixture.credentials,
                pluginActionExecutionOwner: 'current_process' });
            const input = { attemptId, ...(operation === 'submitManual' ? { fields: { source: 'native' } } : {}) };
            expect(input).not.toHaveProperty('machineId');
            const result = await executor.execute(`connectedServices.authentication.${operation}`, input,
                { surface: 'cli', actionRequestId: randomUUID() });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: response });
            expect(native).toHaveBeenCalledTimes(1);
            expect(fixture.addressedAttemptReads).toBe(1);
        });
    } finally {
        native.mockRestore();
        await fixture.close();
    }
});
