import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '../qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '../purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { scopeConnectedAccountPurposeBindingLease } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthService } from './ConnectedAccountRequestAuthService';
import { createDaemonQualifiedRequestAuthCallbacks } from './createDaemonQualifiedRequestAuthCallbacks';

describe('daemon requester request-auth Account callbacks', () => {
    afterEach(() => vi.restoreAllMocks());

    it('materializes the trusted requester vendor bearer and stops disclosure after its admission is lost', async () => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const purpose = { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
        const binding = { purpose, target: { kind: 'account' as const, account: { service, accountId: 'work' } } };
        const materialization = { kind: 'httpHeaders' as const, origin: 'https://chatgpt.com', headerNames: ['authorization'] };
        const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const accounts = new Map(['alice', 'bob'].map(accountId => {
            const credentials = { token: `${accountId}-token`, encryption: null };
            const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials,
                getAccountEncryptionMode: async () => 'plain', readAccountSettings: () => ({}),
                secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) }) });
            const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials,
                reloadController: pluginReloadController, getAccountEncryptionMode: async () => 'plain', configuration: persistence.configuration });
            const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
                reloadController: pluginReloadController, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                allowNativeAccountCredentials: false,
                store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }),
                    subscribe: () => ({ dispose() {} }) },
                qualifiedApi: { listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal }),
                    listGroups: async () => ({ groups: [] }), readGroup: async () => null } });
            return [accountId, purposes] as const;
        }));
        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.codex'], connectedAccounts: accounts.get('alice')!.owner } });
        try {
            let current = true;
            const credentialAccounts: string[] = [];
            // Account HTTP transport is the only substituted boundary; actual catalog,
            // purpose authority, service cache and vendor materialization remain real.
            vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
                const accountId = config?.headers?.Authorization === 'Bearer bob-token' ? 'bob' : 'alice';
                const path = new URL(String(url)).pathname;
                if (path === '/v4/connect/qualified/accounts') return { status: 200,
                    data: QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{ ref: { service, accountId: 'work' },
                        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: revision,
                        configurationReady: true, configurationRevision: null, scopes: [] }] }) };
                if (path === '/v4/connect/qualified/credential') {
                    credentialAccounts.push(accountId);
                    return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: { service, accountId: 'work' },
                        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: revision,
                        configurationRevision: null, metadata: { scopes: [] }, content: { t: 'plain', v: { v: 1, values: {
                            accessToken: `${accountId}-subscription`, refreshToken: `${accountId}-refresh`, idToken: `${accountId}-id`,
                            providerAccountId: `${accountId}-billing` } } } }) };
                }
                if (path === '/v4/connect/qualified/configuration') return { status: 404, data: null };
                throw new Error(`Unexpected Account transport path: ${path}`);
            });
            const bob = accounts.get('bob')!;
            const lease = bob.activatePurposeBindings({ subject: { kind: 'execution_run', runId: 'bob-run', runnerPid: process.pid,
                agentId: 'codex', isCurrent: () => true }, purposes: [purpose], bindings: [binding] });
            const aliceLease = accounts.get('alice')!.activatePurposeBindings({ subject: { kind: 'execution_run', runId: 'alice-run', runnerPid: process.pid,
                agentId: 'codex', isCurrent: () => true }, purposes: [purpose], bindings: [binding] });
            try {
                const context = {
                    bootstrap: { serverHttpBaseUrl: 'http://localhost:3005' },
                    isCurrent: async () => current,
                    resolveCurrentRequestAuthBinding: bob.resolveCurrentRequestAuthBinding,
                    materializeRequestAuthBearer: bob.materializeRequestAuthBearer,
                };
                const callbacks = createDaemonQualifiedRequestAuthCallbacks({
                    resolveCurrentRequestAuthBinding: accounts.get('alice')!.resolveCurrentRequestAuthBinding,
                    materializeRequestAuthBearer: accounts.get('alice')!.materializeRequestAuthBearer,
                    resolveSessionAccountContext: async sessionId => sessionId === 'bob-session' && current ? context : null,
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
                current = false;
                await expect(owner.lookupRequestAuth({ subject, purpose })).rejects.toThrow();
            } finally { await lease.dispose(); await aliceLease.dispose(); }
        } finally { await runtime.dispose(); }
    });
});
