import { mutateQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PLUGIN_MANIFEST as MUSE_MANIFEST } from '@happier-dev/plugins-muse/manifest';
import { PLUGIN_MANIFEST as GEMINI_MANIFEST } from '@happier-dev/plugins-gemini/manifest';
import * as undici from 'undici';
import { expect, it, vi } from 'vitest';
import { ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
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
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';

// Genuine vendor HTTP boundary. Keep native dispatcher and TLS owners real.
vi.mock('undici', async importOriginal => {
    const runtime = await importOriginal<typeof undici>();
    return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

it('agrees with begin admission when the catalog lists daemon-only Slack authentication without a Machine', async () => {
    const origin = 'http://slack-authentication-availability.test';
    const service = { pluginId: 'happier.channel.slack', localId: 'slack-bot' };
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, {
        includeBundledPluginIds: [service.pluginId],
    });
    const machineId = 'slack-authentication-machine';
    const native = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        return { status: 'awaitingManual', attemptId: 'native-slack-attempt' };
    });
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            await ensureCliActionPolicySettings(fixture.credentials, origin);
            const executor = createCliActionExecutorFromCredentials({ credentials: fixture.credentials,
                pluginActionExecutionOwner: 'current_process' });
            const context = { surface: 'cli' as const, actionRequestId: randomUUID() };
            expect(await executor.execute('connectedServices.authentication.beginConnect', { service, modeId: 'bot-tokens' }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'connected_account_authentication_mode_unavailable' } });
            const catalog = await executor.execute('connectedServices.catalog.list', {}, context);
            if (!catalog.ok) throw new Error(catalog.errorCode);
            const services = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.catalog.list'].parse(catalog.result).services;
            expect(services.find(entry => entry.service.pluginId === service.pluginId && entry.service.localId === service.localId))
                .toMatchObject({ service, canAdd: false, reason: 'connected_account_authentication_mode_unavailable',
                    descriptor: { authentication: { modes: expect.arrayContaining([expect.objectContaining({ id: 'bot-tokens' })]) } } });
            expect(services.find(entry => entry.service.pluginId === 'happier.voice.openai' && entry.service.localId === 'openai'))
                .toMatchObject({ canAdd: true });
            expect(fixture.machineRequests).toBe(0);
            expect(fixture.promotedResourceCount).toBe(0);
            expect(await executor.execute('connectedServices.authentication.beginConnect', { service, modeId: 'bot-tokens', machineId }, context))
                .toMatchObject({ ok: true, result: { status: 'awaitingManual', attemptId: 'native-slack-attempt' } });
            expect(native).toHaveBeenCalledOnce();
        });
    } finally { native.mockRestore(); await fixture.close(); }
});

it('routes configuration for a daemon-only service to its selected Machine', async () => {
    const origin = 'http://slack-configuration-placement.test';
    const service = { pluginId: 'happier.channel.slack', localId: 'slack-bot' };
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, {
        includeBundledPluginIds: [service.pluginId],
    });
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: {
                credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true,
            } });
            const host = registry.connectedAccountAuthenticationHost;
            if (!host) throw new Error('Missing Account host');
            const command = { operation: 'readConfiguration' as const,
                target: { kind: 'service' as const, service, modeId: 'bot-tokens' } };
            const response = await host.controlCommand('slack-configuration-machine', command, {
                // Genuine Machine RPC boundary; the remote host's response must survive routing.
                native: async (machineId, forwarded) => {
                    expect(machineId).toBe('slack-configuration-machine');
                    expect(forwarded).toEqual(command);
                    return { status: 'unavailable', code: 'remote_configuration_result' };
                },
            });
            expect(response).toEqual({ status: 'unavailable', code: 'remote_configuration_result' });
        });
    } finally { await registry?.dispose(); await fixture.close(); }
});

it.each(['native-import', 'device'] as const)('tests a saved Muse subscription without repeating its %s sign-in placement', async authenticationModeId => {
    const origin = 'http://muse-saved-subscription-test.test';
    const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    const projectRoot = resolve(import.meta.dirname, '../../../../../../packages/plugins/muse');
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { additional: [{
        manifest: MUSE_MANIFEST, projectRoot, artifactId: 'connected-account-authentication',
        entryPath: resolve(projectRoot, 'src/connectedAccounts/account.ts'), activateExport: 'activate', manifestExport: null,
    }] });
    const vendor = vi.mocked(undici.fetch).mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            const account = { service, accountId: 'saved-subscription' };
            await mutateQualifiedConnectedAccountCredentialV4({ token: fixture.credentials.token, mutation: {
                ref: account, authenticationModeId, expectedCredentialRevision: null,
                content: { t: 'plain', v: { v: 1, values: { credentialMode: 'native', inferenceKey: 'synthetic-muse-key', accountToken: 'synthetic-account-token', nativeMechanism: '"oauth"', expiresAtMs: String(Date.now() + 60_000), nativeApiBaseUrl: 'https://api.meta.ai/v1' } } },
                metadata: { kind: 'oauth', scopes: [] },
            } });
            await ensureCliActionPolicySettings(fixture.credentials, origin);
            const executor = createCliActionExecutorFromCredentials({ credentials: fixture.credentials, serverHttpBaseUrl: origin, pluginActionExecutionOwner: 'current_process' });
            const tested = await executor.execute('connectedServices.accounts.testConnection', { account }, { surface: 'cli', actionRequestId: randomUUID() });
            if (!tested.ok) throw new Error(`Connection test refused: ${tested.errorCode}`);
            expect(tested).toMatchObject({ ok: true, result: { status: 'ok' } });
            expect(fixture.machineRequests).toBe(0);
            expect(fixture.directCredentialWrites).toBe(1);
            const configuration = await executor.execute('connectedServices.configuration.get', { target: { kind: 'account', account } },
                { surface: 'cli', actionRequestId: randomUUID() });
            expect(configuration).toMatchObject({ ok: true, result: { configuration: {
                status: 'ready', revision: null, missingFieldIds: [], values: {},
            } } });
        });
    } finally { vendor.mockRestore(); await fixture.close(); }
});

it('continues a refused manual Account attempt in a fresh host', async () => {
    const origin = 'http://manual-account-host-handoff.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin);
    const registries: ResolvedExecutablePluginRuntimeRegistry[] = [];
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
            const first = await createHost();
            const begun = await first.authenticationCommand(undefined,
                { operation: 'beginConnect', service: fixture.service, modeId: 'manual' }, { native });
            expect(begun).toMatchObject({ status: 'awaitingManual', attemptId: expect.any(String) });
            if (begun.status !== 'awaitingManual') throw new Error('Expected manual attempt');
            expect(await first.authenticationCommand(undefined,
                { operation: 'submitManual', attemptId: begun.attemptId, fields: { apiKey: 'wrong-field-candidate' } }, { native }))
                .toMatchObject({ status: 'rejected', code: 'connected_account_manual_fields_invalid' });
            await registries[0]!.dispose();
            const resumed = await createHost();
            expect(await resumed.authenticationCommand(undefined, { operation: 'read', attemptId: begun.attemptId }, { native }))
                .toEqual(begun);
            const completed = await resumed.authenticationCommand(undefined,
                { operation: 'submitManual', attemptId: begun.attemptId, fields: { token: 'synthetic-handoff-token' } }, { native });
            expect(completed, JSON.stringify(completed))
                .toMatchObject({ status: 'connected', attemptId: begun.attemptId, account: { service: fixture.service } });
            expect(fixture.promotedResourceCount).toBe(1);
            if (completed.status !== 'connected') throw new Error('Expected connected fixture account');
            for (const machineId of [undefined, 'selected-machine']) {
                expect(await resumed.controlCommand(machineId, { operation: 'testConnection', account: completed.account }, { native }))
                    .toMatchObject({ status: 'connectionTested', result: { status: 'unsupported',
                        code: 'connected_account_connection_test_unsupported', reason: expect.any(String) } });
            }
            expect(fixture.machineRequests).toBe(0);
        });
    } finally {
        for (const registry of registries) await registry.dispose();
        await fixture.close();
    }
});

it('lets the selected Machine admit a mode unavailable in the Account runtime', async () => {
    const origin = 'http://machine-authentication-mode.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin);
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: {
                credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true,
            } });
            const host = registry.connectedAccountAuthenticationHost;
            if (!host) throw new Error('Missing Account host');
            const command = { operation: 'beginConnect' as const, service: fixture.service, modeId: 'machine-mode' };
            const native = vi.fn(async () => ({ status: 'awaitingManual' as const, attemptId: 'machine-attempt' }));
            expect(await host.authenticationCommand('selected-machine', command, { native }))
                .toEqual({ status: 'awaitingManual', attemptId: 'machine-attempt' });
            expect(native).toHaveBeenCalledWith('selected-machine', command);
        });
    } finally { await registry?.dispose(); await fixture.close(); }
});

it('retains a Linear provider-refused attempt through the CLI host for corrected submission', async () => {
    const origin = 'http://linear-provider-refusal.test';
    const service = { pluginId: 'happier.linear', localId: 'linear-account' };
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { includeBundledPluginIds: [service.pluginId] });
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    // Substitute only the vendor HTTP boundary. The actual plugin, host,
    // transaction storage and credential settlement remain in the path.
    let accepted = false;
    const fetch = vi.mocked(undici.fetch).mockImplementation(async target => {
        expect(String(target)).toBe('https://api.linear.app/graphql');
        const response = new undici.Response(JSON.stringify(accepted ? { data: { viewer: { id: 'fixture-viewer', name: 'Fixture' } } } : {}),
            { status: accepted ? 200 : 401, headers: { 'content-type': 'application/json' } });
        Object.defineProperty(response, 'url', { value: String(target) });
        return response;
    });
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: {
                credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true,
            } });
            const host = registry.connectedAccountAuthenticationHost;
            if (!host) throw new Error('Missing Account host');
            const native = async (): Promise<never> => { throw new Error('Linear must execute in the Account host'); };
            const begun = await host.authenticationCommand(undefined, { operation: 'beginConnect', service, modeId: 'personal-api-key' }, { native });
            if (begun.status !== 'awaitingManual') throw new Error(JSON.stringify(begun));
            const command = { operation: 'submitManual' as const, attemptId: begun.attemptId, fields: { 'personal-api-key': 'synthetic-key' } };
            expect(await host.authenticationCommand(undefined, command, { native }))
                .toMatchObject({ status: 'rejected', code: 'linear/credentialRejected' });
            accepted = true;
            expect(await host.authenticationCommand(undefined, command, { native }))
                .toMatchObject({ status: 'connected', account: { service } });
        });
    } finally { fetch.mockRestore(); await registry?.dispose(); await fixture.close(); }
});

it('retains a Gemini provider-refused attempt through the CLI host for corrected submission', async () => {
    const origin = 'http://gemini-provider-refusal.test';
    const service = { pluginId: 'happier.agent.gemini', localId: 'gemini-account' };
    const projectRoot = resolve(import.meta.dirname, '../../../../../../packages/plugins/gemini');
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { additional: [{
        manifest: GEMINI_MANIFEST, projectRoot, artifactId: 'connected-account-authentication',
        entryPath: resolve(projectRoot, 'src/connectedAccounts/portableAuthentication.ts'),
        activateExport: 'activate', manifestExport: null,
    }] });
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: {
                credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true,
            } });
            let host = registry.connectedAccountAuthenticationHost;
            if (!host) throw new Error('Missing Account host');
            const native = async (): Promise<never> => { throw new Error('Gemini must execute in the Account host'); };
            const begun = await host.authenticationCommand(undefined, { operation: 'beginConnect', service, modeId: 'service-account' }, { native });
            if (begun.status !== 'awaitingManual') throw new Error(JSON.stringify(begun));
            for (const credentialsJson of ['{}', '{"type":"service_account"}']) {
                expect(await host.authenticationCommand(undefined, { operation: 'submitManual', attemptId: begun.attemptId,
                    fields: { credentialsJson } }, { native })).toMatchObject({ status: 'rejected', code: 'gemini_service_account_invalid' });
                await registry.dispose();
                registry = await resolveExecutablePluginRuntimeRegistry({ accountExecution: {
                    credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true,
                } });
                host = registry.connectedAccountAuthenticationHost;
                if (!host) throw new Error('Missing resumed Account host');
            }
            expect(await host.authenticationCommand(undefined, { operation: 'read', attemptId: begun.attemptId }, { native })).toEqual(begun);
            expect(await host.authenticationCommand(undefined, { operation: 'submitManual', attemptId: begun.attemptId,
                fields: { credentialsJson: JSON.stringify({ type: 'service_account', client_id: '123',
                    client_email: 'fixture@example.test', project_id: 'fixture', private_key: 'synthetic-private-key' }) } }, { native }))
                .toMatchObject({ status: 'connected', account: { service } });
        });
    } finally { await registry?.dispose(); await fixture.close(); }
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
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
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
            expect.objectContaining({ code: 'plugin_account_execution_artifact_unavailable', message: 'plugin_account_execution_artifact_unavailable' }),
        ]));
        // The activation owner's cause reaches the caller instead of a bare code.
        const unavailable = { status: 'unavailable', code: 'connected_account_service_unavailable',
            diagnostic: expect.objectContaining({ code: 'connected_account_service_unavailable', severity: 'error',
                message: expect.stringContaining('plugin_account_execution_artifact_unavailable') }) };
        expect(outcomes).toEqual([unavailable, unavailable]);
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
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
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


it('routes real bundled native-import declarations before acquiring Account artifacts', async () => {
    for (const pluginId of ['happier.agent.muse', 'happier.agent.kimi', 'happier.agent.grok', 'happier.agent.cursor', 'happier.agent.codex']) {
        const origin = 'http://native-import-placement.test';
        const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { includeBundledPluginIds: [pluginId] });
        const native = vi.spyOn(machineRpc, 'callExactMachineRpc').mockResolvedValue({ status: 'awaitingManual', attemptId: 'native-import-attempt' });
        try {
            await runWithServerHttpBaseUrl(origin, async () => {
                await ensureCliActionPolicySettings(fixture.credentials, origin);
                const loaded = loadCurrentBundledPluginLocatorResult({ pluginIds: [pluginId] });
                const manifest = loaded.loadedPlugins.find(value => value.manifest.id === pluginId)?.manifest;
                const descriptor = manifest?.contributes.connectedAccountDescriptors?.find(value => value.authentication.modes.some(mode => mode.kind === 'manual' && mode.credentialOrigin === 'native_import'));
                if (!descriptor) throw new Error('Missing native import declaration: ' + pluginId);
                const service = { pluginId, localId: descriptor.id };
                const modeId = descriptor.authentication.modes.find(mode => mode.kind === 'manual' && mode.credentialOrigin === 'native_import')!.id;
                const executor = createCliActionExecutorFromCredentials({ credentials: fixture.credentials, pluginActionExecutionOwner: 'current_process' });
                expect(await executor.execute('connectedServices.authentication.beginConnect', { service, modeId, machineId: 'import-machine' }, { surface: 'cli', actionRequestId: randomUUID() }))
                    .toMatchObject({ ok: true, result: { status: 'awaitingManual', attemptId: 'native-import-attempt' } });
            });
        } finally { native.mockRestore(); await fixture.close(); }
    }
});
