import axios from 'axios';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRunEvent, AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PluginConnectedAccountAuthenticationV2Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { createPurposeTargetResolver } from '@happier-dev/cli-common/connectedAccounts';
import { emptyConnectedAccountCatalogRecordV1, sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { RunnerDaemonPluginServiceOperationV1Schema, decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { refreshActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { logger } from '@/ui/logger';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore, createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createRunnerDaemonPluginServicesHost } from './runnerDaemonPluginServicesHost';
import { activate, PLUGIN_MANIFEST } from '../../../../../packages/plugins/review-deepsec/src/index';
import { DEEPSEC_CLAUDE_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/review-deepsec/src/agent/connectedAccount';

const purposes = ['model-one', 'model-two', 'model-three', 'model-four'];
const consumer = { pluginId: 'acme.external-agent', localId: 'agent' };
const service = { pluginId: 'acme.accounts', localId: 'api' };

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function fixture(authorizedPurposes: readonly string[] = purposes, selection?: 'unselected' | 'selected' | 'unavailable',
    identity = { consumer, service }) {
    const boundConsumer = identity.consumer;
    const boundService = identity.service;
    const credentials = { token: 'binding-fixture', encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
        settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    const unreachable = async (): Promise<never> => { throw new Error('Unbound purposes must not select or materialize a target'); };
    // Home HTTP and account metadata transport are fixture boundaries. Catalog,
    // target resolution, binding ownership, SDK scope, proxy and wire codec remain real.
    const owner = createConnectedAccountPurposeBindingOwner({
        store: createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }),
        selectTarget: unreachable, resolveTarget: selection === undefined ? unreachable : createPurposeTargetResolver({
            available: true,
            resolveService: async () => ({ service: boundService, authentication: PluginConnectedAccountAuthenticationV2Schema.parse({
                defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }] }],
            }) }),
            listAccounts: async () => selection === 'unavailable' ? [] : [QualifiedConnectedAccountProfileV4Schema.parse({
                ref: { service: boundService, accountId: 'selected' }, authenticationModeId: 'token', status: 'connected',
                revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                configurationReady: true, configurationRevision: null, scopes: [], displayName: 'Selected account',
            })],
        }), materializeAccount: unreachable,
        projectTargetAccounts: unreachable, assertTargetAccountMaterializable: unreachable,
    });
    const purpose = { consumer: boundConsumer, purpose: authorizedPurposes[0] };
    const lease = selection === undefined ? undefined : owner.activatePurposeBindings({
        subject: { kind: 'execution_run', runId: 'runner-selection', runnerPid: 123, agentId: boundConsumer.localId, isCurrent: () => true },
        purposes: [purpose], bindings: selection === 'unselected' ? [] : [
            { purpose, target: { kind: 'account', account: { service: boundService, accountId: 'selected' } } },
        ],
    });
    const controller = new AbortController();
    const connectedHost = createStablePluginConnectedAccountsHost(owner);
    const connectedAccounts = connectedHost.bind({
        plugin: { id: boundConsumer.pluginId, version: '1.0.0' },
        contribution: { id: boundConsumer.localId, qualifiedId: `${boundConsumer.pluginId}/agents/${boundConsumer.localId}` },
        occurrenceId: 'binding-occurrence', correlationId: 'binding-callback', surface: 'cli',
        session: { id: 'binding-session' }, signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
    }, authorizedPurposes.map(purpose => ({ purpose, serviceRefs: [boundService], operations: ['use'], materializationKinds: [] })),
    lease ? { exactPurposeBindingSubjectId: lease.subjectId } : undefined);
    const unavailable = createUnavailablePluginServices();
    const services = { ...unavailable, connectedAccounts, availability: (id: Parameters<typeof unavailable.availability>[0]) =>
        id === 'connectedAccounts' ? { status: 'available' as const } : unavailable.availability(id) };
    const host = createRunnerDaemonPluginServicesHost({ createInvocation: async () => ({
        services, resourceDescriptors: {},
        subscriptionCapabilities: { settingsWatch: false, eventSubscriptions: [], resourceWatches: [], notificationPreferencesWatch: false },
        dispose() { connectedHost.retire(); }, authorizeOperation: () => true,
        executeCurrentGlobalAction: services.actions.execute, currentGlobalMcp: services.mcp, currentGlobalExternalSessions: services.sessions.external,
    }) });
    const binding = createAgentSessionRunnerFactoryBinding({
        v: 1, pluginId: boundConsumer.pluginId, pluginVersion: '1.0.0', agentId: `${boundConsumer.pluginId}/${boundConsumer.localId}`, localAgentId: boundConsumer.localId,
        sourceCustody: { kind: 'managed', immutableGenerationId: 'binding-generation', installSource: 'localPath' },
        locator: { module: './agent.js', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/plugins/acme/agent.js', loadMode: 'immutable-js',
    });
    const requests: Array<{ kind: string; requestId: string; purpose?: string }> = [];
    const runnerServices = await prepareRunnerDaemonPluginServices({
        invocationId: 'binding-invocation', signal: controller.signal,
        dispatch: async (input, options) => {
            const operation = RunnerDaemonPluginServiceOperationV1Schema.parse(input);
            requests.push({ kind: operation.kind, requestId: operation.requestId, ...('purpose' in operation ? { purpose: operation.purpose } : {}) });
            const result = await host.dispatch({ sessionId: 'binding-session',
                runner: { pid: 123, processStartTimeMs: 1, processCommandHash: '4'.repeat(64), snapshotIdentity: 'binding-snapshot' },
                retainedAgent: binding, operation, signal: options?.signal });
            return decodeRunnerDaemonPluginServiceWireValueV1(result.value);
        },
        local: { availability: unavailable.availability, logger: unavailable.logger, sessions: unavailable.sessions,
            managedServices: unavailable.managedServices, machineProvisioners: unavailable.machineProvisioners,
            exec: unavailable.exec, interactions: unavailable.interactions, targetedContributions: unavailable.targetedContributions,
            composerContent: unavailable.composerContent, backgroundServices: unavailable.backgroundServices, deploymentSource: unavailable.deploymentSource },
    });
    return { accounts: runnerServices.connectedAccounts, directAccounts: connectedAccounts, requests, signal: controller.signal,
        refreshPurposeCatalog: () => refreshActiveConnectedAccountCatalog({ credentials, key: 'purposes', readMode: 'admitted' }, true),
        async dispose() { controller.abort(); lease?.dispose(); await host.dispose(); } };
}

function home(readCurrentness: () => Promise<void> = async () => {}) {
    const record = emptyConnectedAccountCatalogRecordV1('purposes');
    const content = sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null, record });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/currentness')) {
            await readCurrentness();
            return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        }
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 4, content } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
        return { status: 404, data: { error: 'unsupported' } };
    });
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('Binding reads cannot write Home'));
}

describe('runner qualified-purpose cold preparation through the real binding owner', () => {
    afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

    it.each(['unselected', 'unavailable'] as const)('uses the real runner selection in DeepSec execution (%s)', async selection => {
        const f = await fixture([DEEPSEC_CLAUDE_ACCOUNT_PURPOSE], selection, {
            consumer: { pluginId: PLUGIN_MANIFEST.id, localId: 'deepsec' },
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
        });
        const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        const factory = plugin.registration('agents', 'deepsec')?.factory;
        if (!factory) throw new Error('DeepSec Agent registration missing');
        const unavailable = createUnavailablePluginServices();
        const launched: PluginExecSpawnRequest[] = [];
        const services: PluginServices = { ...unavailable, connectedAccounts: f.accounts,
            availability: id => id === 'exec' ? { status: 'available' } : unavailable.availability(id),
            exec: { ...unavailable.exec,
                agentCli: { checkReadiness: async () => ({ launchable: [{ agentId: 'claude' }] }) },
                systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'deepsec-cli' }, executablePath: '/native/deepsec' }) },
                async run(request) {
                    launched.push(request);
                    if (request.args?.[0] === 'export') {
                        const output = request.args[request.args.indexOf('--out') + 1];
                        if (!output) throw new Error('Native export output path missing');
                        await writeFile(output, '[]', 'utf8');
                    }
                    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                        stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
                },
            },
        };
        const unused = async (): Promise<never> => { throw new Error('Unexpected UI or protocol access'); };
        const context: AgentRuntimeContext = {
            plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            contribution: { id: 'deepsec', qualifiedId: `${PLUGIN_MANIFEST.id}/agents/deepsec` },
            surface: 'agent', signal: f.signal, services, agent: { id: 'deepsec' },
            protocols: { acp: { open: unused } },
            ui: { askQuestions: unused, confirm: unused, notify: unused, status: { set: unused }, widget: { set: unused },
                title: { set: unused }, composer: { replace: unused } },
        };
        const runtime = await factory({ plugin: context.plugin, agent: context.agent, signal: f.signal });
        const opened = await runtime.executionRuns?.open({ kind: 'create', runId: 'runner-deepsec', cwd: '/repo',
            profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'repository-security-audit' },
            input: { text: 'Review repository security.', structuredInput: { instructions: 'Review repository security.',
                reviewers: [{ kind: 'engine', engineId: 'deepsec' }], engines: { deepsec: {
                    mode: 'repository_security_audit', confirmedCostWarning: true,
                } } } },
        }, context);
        if (!opened) throw new Error('DeepSec execution runtime missing');
        try {
            const events: AgentExecutionRunEvent[] = [];
            opened.watch(event => events.push(event));
            await vi.waitFor(() => expect(['run-complete', 'run-failed']).toContain(events.at(-1)?.kind));
            if (selection === 'unavailable') {
                expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'plugin_connected_account_binding_unavailable' } });
                expect(launched).toEqual([]);
            } else {
                expect(events.at(-1)).toMatchObject({ kind: 'run-complete' });
                expect(launched.find(request => request.args?.[0] === 'process')).toMatchObject({
                    args: expect.arrayContaining(['--agent', 'claude', '--ai-provider', 'anthropic', '--ai-api-key-env', 'ANTHROPIC_API_KEY']),
                    env: expect.objectContaining({ ANTHROPIC_API_KEY: '', AI_GATEWAY_API_KEY: '' }),
                });
            }
        } finally { await opened.dispose(); await plugin.dispose(); await f.dispose(); }
    });

    it.each(['unselected', 'selected', 'unavailable'] as const)('round-trips admitted native selection (%s) through the runner', async selection => {
        const f = await fixture(purposes, selection);
        try {
            if (selection === 'unavailable') {
                await expect(f.accounts.resolveSelection!(purposes[0])).rejects.toMatchObject({
                    code: 'plugin_connected_account_binding_unavailable', details: { reasonCode: 'target_unavailable' },
                });
            } else {
                const direct = await f.directAccounts.resolveSelection!(purposes[0]);
                expect(direct).toMatchObject(selection === 'unselected' ? { credentialSource: 'machineLogin' } : {
                    credentialSource: 'connectedAccount', binding: { account: { service, accountId: 'selected' } },
                });
                await expect(f.accounts.resolveSelection!(purposes[0])).resolves.toEqual(direct);
            }
        } finally { await f.dispose(); }
    });

    it.each(['sdk', 'runner'] as const)('omits undeclared purpose content from %s diagnostics without changing the refusal', async surface => {
        home();
        const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const f = await fixture();
        // Public SDK arguments are not wire-bounded. Neither surface may log an
        // undeclared value before the existing purpose authorization owner checks it.
        const privatePurpose = `synthetic-private-purpose-${'x'.repeat(surface === 'sdk' ? 2_048 : 128)}`;
        try {
            const accounts = surface === 'sdk' ? f.directAccounts : f.accounts;
            await expect(accounts.getBinding(privatePurpose)).rejects.toMatchObject({ code: 'plugin_connected_account_purpose_undeclared' });
            expect(axios.get).not.toHaveBeenCalled();
            expect(JSON.stringify(log.mock.calls)).not.toContain(privatePurpose);
        } finally { await f.dispose(); }
    });

    it.each(['slow', 'failed'] as const)('settles four watches and concurrent reads after a %s Home currentness read', async variant => {
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const entered = deferred();
        const release = deferred();
        let failing = variant === 'failed';
        home(async () => {
            entered.resolve();
            await release.promise;
            if (failing) throw Object.assign(new Error('private Home body must not be logged'), { code: 'ECONNRESET' });
        });
        const f = await fixture();
        const initial = purposes.map(() => deferred());
        const subscriptions = purposes.map((purpose, index) => f.accounts.watch(purpose, () => initial[index].resolve()));
        try {
            await entered.promise;
            // Initial delivery is not held behind the owner's pending Home read.
            await Promise.all(initial.map(item => item.promise));
            const pending = Promise.allSettled(purposes.map(purpose => f.accounts.getBinding(purpose)));
            await vi.waitFor(() => {
                const requests = f.requests.filter(request => request.kind === 'plugin_connected_accounts.get_binding_v1');
                expect(requests).toHaveLength(4);
                for (const request of requests) expect(debug.mock.calls).toContainEqual(['[connected-account-binding-stage]',
                    expect.objectContaining({ agentSessionId: 'binding-session', requestId: request.requestId, purpose: request.purpose,
                        stage: 'binding_read', event: 'begin' })]);
            });
            release.resolve();
            const results = await pending;
            if (variant === 'slow') expect(results).toEqual(purposes.map(() => ({ status: 'fulfilled', value: null })));
            else {
                expect(results.every(result => result.status === 'rejected')).toBe(true);
                for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'plugin_connected_account_settings_unavailable' });
            }
            // A published refusal remains authoritative until the catalog owner republishes.
            failing = false;
            if (variant === 'failed') {
                await expect(f.accounts.getBinding(purposes[0])).rejects.toMatchObject({ code: 'plugin_connected_account_settings_unavailable' });
                expect(await f.refreshPurposeCatalog()).toMatchObject({ status: 'ready' });
            }
            expect(await Promise.all(purposes.map(purpose => f.accounts.getBinding(purpose)))).toEqual([null, null, null, null]);
            for (const request of f.requests.filter(request => request.kind === 'plugin_connected_accounts.get_binding_v1').slice(-4)) {
                expect(debug.mock.calls).toContainEqual(['[connected-account-binding-stage]', expect.objectContaining({
                    requestId: request.requestId, operation: 'get_binding', stage: 'dispatch', event: 'end', durationMs: expect.any(Number),
                })]);
            }
        } finally { release.resolve(); subscriptions.forEach(subscription => subscription.dispose()); await f.dispose(); }
    });

    it('correlates pending and failed owner stages to the runner request without private error content', async () => {
        const entered = deferred();
        const release = deferred();
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        home(async () => { entered.resolve(); await release.promise;
            throw Object.assign(new Error('private Home body'), { code: 'ECONNRESET', credentials: 'private-credential' }); });
        const f = await fixture();
        const pending = f.accounts.getBinding(purposes[0]).then(value => value, (error: unknown) => error);
        try {
            await entered.promise;
            const request = f.requests.find(request => request.kind === 'plugin_connected_accounts.get_binding_v1')!;
            const identity = { agentSessionId: 'binding-session', invocationId: 'binding-invocation', requestId: request.requestId };
            expect(debug.mock.calls).toContainEqual(['[connected-account-binding-stage]', expect.objectContaining({ ...identity, purpose: purposes[0], stage: 'account_currentness', event: 'begin' })]);
            release.resolve();
            expect(await pending).toMatchObject({ code: 'plugin_connected_account_settings_unavailable' });
            for (const stage of ['authorization', 'binding_read', 'retained_binding', 'account_purpose_read']) {
                expect(debug.mock.calls).toContainEqual(['[connected-account-binding-stage]', expect.objectContaining({ ...identity,
                    ...(stage === 'authorization' ? {} : { purpose: purposes[0] }), stage, event: 'begin' })]);
            }
            expect(log.mock.calls).toContainEqual(['[connected-account-binding-stage]', expect.objectContaining({ ...identity, purpose: purposes[0], stage: 'account_currentness', event: 'failure', errorCode: 'account_encryption_currentness_unavailable', durationMs: expect.any(Number) })]);
            expect(JSON.stringify([...debug.mock.calls, ...log.mock.calls])).not.toMatch(/private Home body|private-credential|binding-fixture/);
        } finally { release.resolve(); await pending; await f.dispose(); }
    });

    it('round-trips declared purposes and refuses a missing external-plugin registration before reading Home', async () => {
        home();
        const complete = await fixture();
        try {
            expect(await Promise.all(purposes.map(purpose => complete.accounts.getBinding(purpose)))).toEqual([null, null, null, null]);
        } finally { await complete.dispose(); }
        vi.mocked(axios.get).mockClear();
        const f = await fixture(purposes.slice(0, 3));
        try {
            await expect(f.accounts.getBinding(purposes[3])).rejects.toMatchObject({ code: 'plugin_connected_account_purpose_undeclared' });
            expect(axios.get).not.toHaveBeenCalled();
        } finally { await f.dispose(); }
    });
});
