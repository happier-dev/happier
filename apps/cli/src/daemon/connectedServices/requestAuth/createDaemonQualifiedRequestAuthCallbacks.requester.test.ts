import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createMcpSignInConnectedAccountRegistration } from '@/mcp/oauth/mcpSignInRuntime';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { accountSettingsParse } from '@happier-dev/protocol';
import { issueMcpRequestAuthCapability } from '@/mcp/runtime/issueMcpRequestAuthCapability';
import { createConnectedAccountRequestAuthSubjectRegistry } from './ConnectedAccountRequestAuthSubjectRegistry';
import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { readFile, stat } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { SessionExecutionRunBrokerAuthorityRequestV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import { listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '../qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '../purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { scopeConnectedAccountPurposeBindingLease } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthService } from './ConnectedAccountRequestAuthService';
import { createDaemonQualifiedRequestAuthCallbacks } from './createDaemonQualifiedRequestAuthCallbacks';
import { logger } from '@/ui/logger';

describe('daemon requester request-auth Account callbacks', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([false, true])('materializes the trusted requester bearer and stops disclosure after its admission is lost (host=%s)', async (host) => {
        const home = await mkdtemp(join(tmpdir(), 'happier-requester-purpose-'));
        const pluginReloadController = createPluginReloadController({ happyHomeDir: home });
        const service = host ? HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 : { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const purpose = host ? MCP_REQUEST_AUTH_PURPOSE : { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
        const binding = { purpose, target: { kind: 'account' as const, account: { service, accountId: 'work' } } };
        const materialization = { kind: 'httpHeaders' as const, origin: host ? 'https://mcp.example.test' : 'https://chatgpt.com', headerNames: ['authorization'] };
        const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const establishedOwners = new Map<string, ReturnType<typeof createQualifiedConnectedAccountEstablishedRuntimeOwner>>();
        const accounts = new Map(['alice', 'bob'].map(accountId => {
            const credentials = { token: `${accountId}-token`, encryption: null };
            const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials,
                getAccountEncryptionMode: async () => 'plain',
                secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) }) });
            const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials,
                reloadController: pluginReloadController, getAccountEncryptionMode: async () => 'plain', configuration: persistence.configuration });
            establishedOwners.set(accountId, established);
            const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
                reloadController: pluginReloadController, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                allowNativeAccountCredentials: false,
                store: { read: async () => ({ v: 1, bindings: host ? [binding] : [] }), update: async mutate => mutate({ v: 1, bindings: host ? [binding] : [] }),
                    subscribe: () => ({ dispose() {} }) },
                qualifiedApi: { listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal }),
                    listGroups: async () => ({ groups: [] }), readGroup: async () => null } });
            return [accountId, purposes] as const;
        }));
        const bundled = loadCurrentBundledPluginLocatorResult();
        const contributes = host ? createResolvedContributionRegistry({}) : createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: { loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.manifest.id === 'happier.agent.codex'), diagnosticsByPluginId: {} }, provenance: 'first_party' }));
        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { contributes, pluginIds: host ? [] : ['happier.agent.codex'], connectedAccounts: accounts.get('alice')!.owner } });
        try {
            if (host && !runtime.registry.connectedAccountContributions?.describe(service)) {
                runtime.registry.connectedAccountContributions?.registerHostConnectedAccountRuntime(createMcpSignInConnectedAccountRegistration());
            }
            let current = true;
            let credentialFailure: 'missing' | 'schema' | 'unexpected' | null = null;
            let grantResource = 'https://mcp.example.test/path';
            const credentialAccounts: string[] = [];
            // Account HTTP transport is the only substituted boundary; actual catalog,
            // purpose authority, service cache and vendor materialization remain real.
            vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
                const accountId = config?.headers?.Authorization === 'Bearer bob-token' ? 'bob' : 'alice';
                const path = new URL(String(url)).pathname;
                if (path === '/v4/connect/qualified/accounts') return { status: 200,
                    data: QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{ ref: { service, accountId: 'work' },
                        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: revision,
                        configurationReady: true, configurationRevision: host ? 'configuration-host-1' : null, scopes: [] }] }) };
                if (path === '/v4/connect/qualified/credential') {
                    if (credentialFailure === 'missing') return { status: 404, data: null };
                    if (credentialFailure === 'schema') return { status: 200, data: { private: 'secret-payload' } };
                    if (credentialFailure === 'unexpected') throw Object.assign(new TypeError('secret-message'), { code: 'secret-code' });
                    credentialAccounts.push(accountId);
                    return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: { service, accountId: 'work' },
                        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: revision,
                        configurationRevision: host ? 'configuration-host-1' : null, metadata: { scopes: [] }, content: { t: 'plain', v: { v: 1, values: {
                            accessToken: `${accountId}-subscription`, refreshToken: `${accountId}-refresh`, idToken: `${accountId}-id`,
                            providerAccountId: `${accountId}-billing` } } } }) };
                }
                if (path === '/v4/connect/qualified/configuration') return host ? { status: 200, data: QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
                    target: { kind: 'account', ref: { service, accountId: 'work' } }, authenticationModeId: 'oauth',
                    revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: 'configuration-host-1',
                    configurationContent: { t: 'plain', v: { values: { serverId: 'work', resource: grantResource }, secretRefs: {} } },
                }) } : { status: 404, data: null };
                throw new Error(`Unexpected Account transport path: ${path}`);
            });
            const bob = accounts.get('bob')!;
            if (host) {
                await expect(bob.owner.materialize({ purpose, serviceRefs: [service], request: materialization,
                    signal: new AbortController().signal })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
                let genericLease: ReturnType<typeof bob.activatePurposeBindings> | undefined;
                try {
                    expect(() => { genericLease = bob.activatePurposeBindings({ subject: { kind: 'operation', operationId: 'generic-host-bypass',
                        consumer: purpose.consumer, isCurrent: () => true }, purposes: [purpose], bindings: [binding] }); }).toThrow(expect.objectContaining({ code: 'plugin_connected_account_binding_out_of_scope' }));
                } finally { genericLease?.dispose(); }
            }
            const lease = bob.activatePurposeBindings({ subject: host ? { kind: 'mcp_request_auth', operationId: 'bob-host', serverId: 'work', resource: grantResource, isCurrent: () => true }
                : { kind: 'execution_run', runId: 'bob-run', runnerPid: process.pid, agentId: 'codex', isCurrent: () => true }, purposes: [purpose], bindings: [binding] });
            const aliceLease = accounts.get('alice')!.activatePurposeBindings({ subject: host ? { kind: 'mcp_request_auth', operationId: 'alice-host', serverId: 'work', resource: grantResource, isCurrent: () => true }
                : { kind: 'execution_run', runId: 'alice-run', runnerPid: process.pid, agentId: 'codex', isCurrent: () => true }, purposes: [purpose], bindings: [binding] });
            try {
                const context = {
                    bootstrap: { serverHttpBaseUrl: 'http://localhost:3005' },
                    isCurrent: async () => current,
                    resolveCurrentRequestAuthBinding: bob.resolveCurrentRequestAuthBinding,
                    materializeRequestAuthBearer: bob.materializeRequestAuthBearer,
                };
                const callbacks = createDaemonQualifiedRequestAuthCallbacks({
                    withSessionAccountContext: async (sessionId, operation) => await operation(sessionId === 'bob-session' && current ? context : null),
                    assertSessionAccountCurrent: async () => { if (!current) throw new Error('requester_session_not_current'); },
                });
                const subject = scopeConnectedAccountPurposeBindingLease({ lease, subjectId: lease.subjectId,
                    parentSessionId: 'bob-session', uses: [{ purpose, materialization }], registerRedaction: () => undefined });
                // Positive fixture proof uses the SAME actual Bob lease and established owner.
                const resolved = await bob.resolveCurrentRequestAuthBinding({ subjectId: lease.subjectId, binding,
                    signal: new AbortController().signal });
                if (!resolved) throw new Error('The genuine requester purpose binding was unavailable');
                await expect(bob.materializeRequestAuthBearer({ subjectId: lease.subjectId, binding, resolved, materialization,
                    signal: new AbortController().signal })).resolves.toMatchObject({ accessToken: 'bob-subscription' });
                const owner = createConnectedAccountRequestAuthService({ ...callbacks,
                    refreshAfterAuthFailure: async () => ({ status: 'current_unchanged' }),
                    reportQuotaFailure: async () => ({ status: 'current_unchanged' }) });
                const aliceSubject = scopeConnectedAccountPurposeBindingLease({ lease: aliceLease, subjectId: aliceLease.subjectId,
                    parentSessionId: 'alice-session', uses: [{ purpose, materialization }], registerRedaction: () => undefined });
                await expect(owner.lookupRequestAuth({ subject: aliceSubject, purpose })).resolves.toMatchObject({ accessToken: 'alice-subscription' });
                credentialAccounts.length = 0;
                await expect(owner.lookupRequestAuth({ subject, purpose })).resolves.toMatchObject({ accessToken: 'bob-subscription' });
                expect(credentialAccounts).toContain('bob');
                expect(credentialAccounts).not.toContain('alice');
                const diagnostics = vi.spyOn(logger, 'debug').mockImplementation(() => {});
                for (const [failure, causeCode] of [
                    ['missing', 'credential_snapshot_unavailable'],
                    ['schema', 'connected_account_v4_contract_violation'],
                    ['unexpected', 'binding_resolution_failed'],
                ] as const) {
                    credentialFailure = failure;
                    diagnostics.mockClear();
                    await expect(owner.lookupRequestAuth({ subject, purpose })).rejects.toMatchObject({
                        code: 'request_auth_binding_unavailable', diagnostic: { causeCode },
                    });
                    const records = diagnostics.mock.calls.filter(([marker]) => marker === '[CONNECTED ACCOUNT] Request-auth lookup refused');
                    expect(records).toHaveLength(1);
                    if (failure === 'unexpected') expect(records[0]?.[1]).toMatchObject({ errorClass: 'TypeError', exceptionCode: null });
                    expect(JSON.stringify(records)).not.toContain('secret-');
                }
                credentialFailure = 'unexpected';
                await expect(callbacks.materializeBearer({ subject, binding, resolved: resolved!, materialization,
                    signal: new AbortController().signal })).rejects.toMatchObject({
                    code: 'request_auth_credential_unavailable', diagnostic: { causeCode: 'materialization_failed',
                        errorClass: 'TypeError', exceptionCode: null },
                });
                credentialFailure = null;
                diagnostics.mockRestore();
                if (host) {
                    const registry = createConnectedAccountRequestAuthSubjectRegistry();
                    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'requester-machine',
                        stopSession: async () => ({ status: 'not_found' }),
                        spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'unused' }),
                        requestShutdown: () => undefined, onHappySessionWebhook: () => undefined, controlToken: 'control-fixture',
                        connectedAccountRequestAuth: { authenticate: registry.authenticate, ...owner } });
                    await app.listen({ host: '127.0.0.1', port: 0 });
                    const address = app.server.address();
                    if (!address || typeof address === 'string') throw new Error('Request-auth listener unavailable');
                    try {
                    const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
                        loadedAtMs: 1, settingsSecretsReadKeys: [], mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const,
                            revision: 1, diagnostics: [], catalog: { v: 1 as const,
                                servers: [{ id: 'work', name: 'work', transport: 'http' as const, remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' as const } }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } } };
                    const issuanceContext = { parentSessionId: 'bob-session', materializationBaseDir: join(home, 'materialized'),
                        readAccountSettingsSnapshot: () => snapshot, establishedOwner: establishedOwners.get('bob')!, activatePurposeBindings: bob.activatePurposeBindings,
                        registry, httpPort: address.port, isCurrent: () => current,
                        assertCurrent: async () => { if (!current) throw new Error('requester_session_not_current'); } };
                    const signal = new AbortController().signal;
                    const issued = await issueMcpRequestAuthCapability({ serverId: 'work', resource: 'https://mcp.example.test/path', materializationId: 'issued-bob' }, issuanceContext, signal);
                    const capability = JSON.parse(await readFile(issued.capabilityFile, 'utf8')).capability;
                    const principal = registry.authenticate(capability);
                    if (!principal) throw new Error('Issued MCP capability was unavailable');
                    const client = await createConnectedAccountRequestAuthClient({ capabilityFile: issued.capabilityFile });
                    await expect(client.lookupConnectedAccountRequestAuth({ purpose })).resolves.toMatchObject({ accessToken: 'bob-subscription' });
                    grantResource = 'https://mcp.example.test/other';
                    await expect(client.lookupConnectedAccountRequestAuth({ purpose })).rejects.toThrow('request_auth_not_active');
                    await expect(issueMcpRequestAuthCapability({ serverId: 'work', resource: 'https://mcp.example.test/path', materializationId: 'mismatched-bob' }, issuanceContext, signal)).rejects.toThrow('mcp_resource_mismatch');
                    grantResource = 'https://mcp.example.test/path';
                    // The Session RPC response is the external Home boundary; the issuer's
                    // exact Run/occurrence/parent checks and both account owners stay real.
                    let runParent = 'bob-session';
                    let runOccurrence = 'occurrence-one';
                    const observedProofs: unknown[] = [];
                    const broker = createServer(async (request, response) => {
                        const chunks: Buffer[] = [];
                        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        observedProofs.push(SessionExecutionRunBrokerAuthorityRequestV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
                        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'current',
                            executionRunId: 'run-one', occurrenceId: runOccurrence, parentSessionId: runParent,
                            intent: 'delegate', runtimeState: 'idle', teamCredentialProviderModel: null }));
                    });
                    await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve));
                    const brokerAddress = broker.address();
                    if (!brokerAddress || typeof brokerAddress === 'string') throw new Error('Broker RPC fixture unavailable');
                    const runContext = { ...issuanceContext, readExecutionRunAuthority: async (request: ReturnType<typeof SessionExecutionRunBrokerAuthorityRequestV1Schema.parse>, signal: AbortSignal) => {
                        const response = await fetch(`http://127.0.0.1:${brokerAddress.port}`, { method: 'POST', body: JSON.stringify(request), signal });
                        return await response.json();
                    } };
                    try {
                        const runInput = { serverId: 'work', resource: 'https://mcp.example.test/path', materializationId: 'issued-run', executionRun: { runId: 'run-one', occurrenceId: 'occurrence-one' } };
                        const runIssued = await issueMcpRequestAuthCapability(runInput, runContext, signal);
                        const runCapability = JSON.parse(await readFile(runIssued.capabilityFile, 'utf8')).capability;
                        const runPrincipal = registry.authenticate(runCapability);
                        if (!runPrincipal) throw new Error('Run capability unavailable');
                        await expect(owner.lookupRequestAuth({ subject: runPrincipal, purpose })).resolves.toMatchObject({ accessToken: 'bob-subscription' });
                        expect(observedProofs[0]).toEqual({ v: 1, executionRunId: 'run-one', expectedOccurrenceId: 'occurrence-one' });
                        runParent = 'other-session';
                        await expect(owner.lookupRequestAuth({ subject: runPrincipal, purpose })).rejects.toThrow('request_auth_not_active');
                        await expect(issueMcpRequestAuthCapability({ ...runInput, materializationId: 'foreign-run' }, runContext, signal)).rejects.toThrow('mcp_request_auth_not_active');
                        runParent = 'bob-session';
                        runOccurrence = 'replacement-occurrence';
                        await expect(owner.lookupRequestAuth({ subject: runPrincipal, purpose })).rejects.toThrow('request_auth_not_active');
                        await registry.retireSessionCapabilities({ parentSessionId: 'bob-session', materializationId: 'issued-run' });
                    } finally { await new Promise<void>((resolve, reject) => broker.close(error => error ? reject(error) : resolve())); }
                    await registry.retireSessionCapabilities({ parentSessionId: 'alice-session', materializationId: 'issued-bob' });
                    expect(registry.authenticate(capability)).not.toBeNull();
                    await registry.retireSessionCapabilities({ parentSessionId: 'bob-session', materializationId: 'issued-bob' });
                    expect(registry.authenticate(capability)).toBeNull();
                    await expect(stat(issued.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
                    } finally { await app.close(); }
                }
                current = false;
                await expect(owner.lookupRequestAuth({ subject, purpose })).rejects.toThrow();
            } finally { await lease.dispose(); await aliceLease.dispose(); }
        } finally { await runtime.dispose(); await rm(home, { recursive: true, force: true }); }
    });
});
