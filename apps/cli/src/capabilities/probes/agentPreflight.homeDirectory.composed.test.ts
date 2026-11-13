import { createCliActionInventoryDeps } from '@/session/actions/cliActionDeps/createCliActionInventoryDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { invokeCliPreflightMethod } from './agentPreflight';
import { preflightCatalogEntryFixture } from './preflightSessionControlsProbeAdapter.testkit';
import { createExternalConnectedAccountForegroundFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { reloadConfiguration } from '@/configuration';
import type { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { AgentInventoryProbeInputSchema } from '@happier-dev/protocol/actions/actionSpecs';

afterAll(async () => { await pluginReloadController.shutdown(); });

describe('native Agent preflight home directory intent', () => {
    it('expands the default home in the executing process and preserves an explicit directory', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-preflight-home-')));
        const nativeHome = join(root, 'native-home');
        const explicitDirectory = join(root, 'explicit-project');
        await mkdir(nativeHome);
        await mkdir(explicitDirectory);
        const script = join(root, 'probe.cjs');
        await writeFile(script, 'process.stdout.write(process.cwd());');
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const executable = writeExecutableShimSync({
            dir: root,
            fileName: process.platform === 'win32' ? 'native.cmd' : 'native',
            contents: process.platform === 'win32'
                ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
                : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
        });
        // HOME is the OS boundary already selected by the native worker. The
        // real preflight dispatcher, catalog, Exec owner and process stay live.
        vi.stubEnv('HOME', nativeHome);
        vi.stubEnv('USERPROFILE', nativeHome);
        try {
            const projected = projectAgentPreflightSessionControlsCatalogEntry({
                agentId: 'opencode',
                systemTools: [{ id: 'native-cwd', title: 'Native cwd', executableNames: [executable] }],
                preflightSessionControls: {
                    models: {
                        command: { toolId: 'native-cwd', args: [] },
                        parseOutput: (result) => [{ id: 'observed-cwd', name: result.stdout.trim() }],
                    },
                },
                retirementSignal: new AbortController().signal,
                isCurrent: () => true,
            });
            const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
            if (!adapter) throw new Error('Missing real native preflight adapter');
            const catalogEntry = preflightCatalogEntryFixture('opencode', adapter);
            const probe = async (cwd: string) => await invokeCliPreflightMethod(
                'opencode', 'probeModels', { cwd, bypassCache: true },
                { agentCatalogEntry: catalogEntry, accountContext: { credentials: null, accountSettings: null } }, {},
            );
            // Discriminates home expansion from blindly replacing every cwd.
            expect(await probe(explicitDirectory)).toMatchObject({ ok: true, result: {
                source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'observed-cwd', name: explicitDirectory }]),
            } });
            expect(await probe('~')).toMatchObject({ ok: true, result: {
                source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'observed-cwd', name: nativeHome }]),
            } });
        } finally {
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    }, 60_000);
    it.each(['files_ambient', 'files_explicit', 'environment', 'native', 'prepared'] as const)(
        'uses the selected materialization environment in a real catalog process (%s)', async (mode) => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-preflight-account-env-')));
        const observed = join(root, 'observed.json');
        const nativeHome = join(root, 'native-home');
        await mkdir(nativeHome);
        vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'home'));
        vi.stubEnv('HAPPIER_SERVER_URL', 'https://preflight-account.example.test');
        vi.stubEnv('ACME_NATIVE_HOME', nativeHome);
        vi.stubEnv('ACME_TOKEN', 'fake-ambient-token');
        reloadConfiguration();
        const accountHttp = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (new URL(url).pathname.endsWith('/qualified/accounts')) return { status: 200, data: {
                service: { pluginId: 'acme.preflight-account', localId: 'credential' },
                accounts: [{ ref: { service: { pluginId: 'acme.preflight-account', localId: 'credential' }, accountId: 'selected-account' },
                    status: 'connected', authenticationModeId: 'fixture', revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_abcdefghijklmnopqrstuv', configurationRevision: null, configurationReady: true,
                    displayName: 'Selected Account', scopes: [] }],
            } };
            throw new Error(`Unexpected preflight HTTP GET ${new URL(url).pathname}`);
        });
        let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        const auth = new Uint8Array([0, 255, 17, 99]);
        try {
            const account = createExternalConnectedAccountForegroundFixture({
                service: { pluginId: 'acme.preflight-account', localId: 'credential' },
                materializationKinds: mode === 'prepared' ? ['httpHeaders'] : ['files', 'environment'],
                launch: mode === 'prepared' ? undefined : {
                    stateSharingDescriptor: { providerSupportStatus: 'supported',
                        config: { supported: false, modes: [], entries: [] },
                        state: { supported: false, modes: [], entries: [], symlinkUnavailableDegradePolicy: 'degrade_to_isolated' },
                        authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
                        nativeHome: { environmentKey: 'ACME_NATIVE_HOME', defaultRelativePath: '.acme-native-home', fallbackEnvironmentKeys: ['ACME_TOKEN'] } },
                    environmentUses: [{ purpose: 'primary', environmentKey: 'ACME_TOKEN' }],
                    environmentUnsetUses: [{ purpose: 'primary', environmentKey: 'ACME_TOKEN' }],
                },
                materializeAccount: async ({ request }) => request.kind === 'httpHeaders'
                    ? { kind: 'httpHeaders', headers: { authorization: 'Bearer fake-selected-token' } }
                    : request.kind === 'environment'
                    ? { kind: 'environment', env: mode === 'environment' ? { ACME_TOKEN: 'fake-selected-token' } : {} }
                    : { kind: 'files', files: mode.startsWith('files_') ? { 'auth.json': auth } : {} },
            });
            const plugins = account.plugins.map(plugin => mode !== 'prepared' ? plugin : {
                ...plugin, files: { ...plugin.files,
                'daemon.mjs': String(plugin.files['daemon.mjs']).replace('sessionRunnerFactory:', `preflightSessionControls: {
                    prepareLaunchEnvironment: async ({ environment, connectedAccounts, signal, modelId }) => {
                        if (modelId === undefined) throw Object.assign(new Error('credential-bearing native preparation error'), {
                            code: 'agent_startup_model_reconciliation_failed',
                            details: { failureCause: { phase: 'client_start', failureReason: 'model_selection_required', retryable: false } },
                        });
                        const binding = await connectedAccounts.getBinding('primary', { signal });
                        const materialized = await connectedAccounts.materialize('primary', {
                            kind: 'httpHeaders', origin: 'https://preflight-account.example.test', headerNames: ['authorization'],
                        }, { signal, expectedAccount: binding.account });
                        return { environment: { ...environment, ACME_TOKEN: materialized.headers.authorization.slice(7) }, commandArgsSuffix: ['--selected-upstream', 'https://native.example.test/v1', '--model', String(modelId)], catalogConfidence: 'account_unverified', dispose() {} };
                    },
                }, sessionRunnerFactory:`) },
            });
            runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins,
                happyHomeDir: join(root, 'home'), controller: pluginReloadController, runtimeOptions: { connectedAccounts: account.owner },
                resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir })),
            });
            const { agentId } = account.requestFor(runtime.registry);
            const entry = runtime.registry.contributes.agentDefinitionsById.get(agentId)?.catalogEntry;
            if (!entry) throw new Error('Missing admitted preflight Agent');
            if (mode === 'prepared') expect(entry.preparePreflightLaunchEnvironment).toBeTypeOf('function');
            const script = join(root, 'probe.cjs');
            await writeFile(script, `const fs = require('node:fs'); const home = process.env.ACME_NATIVE_HOME; const auth = home && require('node:path').join(home, 'auth.json'); fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ key: process.env.ACME_TOKEN ?? null, home: home ?? null, cwd: process.cwd(), args: process.argv.slice(2), auth: auth && fs.existsSync(auth) ? [...fs.readFileSync(auth)] : null }));`);
            const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
            const executable = writeExecutableShimSync({ dir: root,
                fileName: process.platform === 'win32' ? 'catalog.cmd' : 'catalog',
                contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
                    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
            });
            const projected = projectAgentPreflightSessionControlsCatalogEntry({ agentId,
                systemTools: [{ id: 'native-env', title: 'Native environment', executableNames: [executable] }],
                preflightSessionControls: { catalogs: { command: { toolId: 'native-env', args: [] },
                    parseOutput: () => ({ commands: [], skills: [] }) } },
                retirementSignal: new AbortController().signal, isCurrent: () => true,
            });
            if (mode === 'prepared') expect.soft(AgentInventoryProbeInputSchema.safeParse({ modelId: 'chosen-native-model' }).success).toBe(true);
            const response = await runWithServerHttpBaseUrl('https://preflight-account.example.test', () => invokeCliPreflightMethod(agentId, 'probeCatalogs', {
                cwd: root, bypassCache: true,
                ...(mode === 'prepared' ? { modelId: 'chosen-native-model' } : {}),
                ...(mode === 'files_ambient' ? {} : { environmentVariables: { ACME_TOKEN: 'fake-explicit-token' } }),
                ...(mode === 'native' ? {} : { connectedServices: { v: 2, bindingsByServiceId: {
                    'acme.preflight-account/credential': { source: 'connected', selection: 'profile', profileId: 'selected-account' },
                } } }),
            }, {
                agentCatalogEntry: { ...entry, ...projected }, agentRegistrySnapshot: runtime.registry.contributes,
                accountContext: { credentials: { token: 'fake-account-token', encryption: null }, accountSettings: null },
                // The API is an external transport; the real purpose owner supplies the selected Account.
                createApiClient: async () => ({} as ApiClient), connectedAccountsOwner: account.owner,
                activatePurposeBindings: account.owner.activatePurposeBindings, isAgentRegistryCurrent: () => true,
                createAgentInvocationServices: runtime.registry.createAgentInvocationServices,
                agentRuntimeCacheKey: runtime.registry.readPluginOccurrenceId?.('acme.foreground') ?? undefined,
            }, {}));
            expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
            const environment = JSON.parse(await readFile(observed, 'utf8')) as { key: string | null; home: string | null; cwd: string; args: string[]; auth: number[] | null };
            expect(environment.cwd).toBe(root);
            expect.soft(environment.args).toEqual(mode === 'prepared' ? ['--selected-upstream', 'https://native.example.test/v1', '--model', 'chosen-native-model'] : []);
            if (mode.startsWith('files_')) {
                expect(environment.key).toBeNull();
                expect(environment.home).not.toBe(nativeHome);
                expect(environment.auth).toEqual([...auth]);
            } else {
                expect(environment.key).toBe(mode === 'environment' || mode === 'prepared' ? 'fake-selected-token' : 'fake-explicit-token');
                expect(environment.home).toBe(mode === 'prepared' ? null : nativeHome);
            }
            if (mode === 'prepared') {
                const modelProjection = projectAgentPreflightSessionControlsCatalogEntry({ agentId,
                    systemTools: [{ id: 'native-models', title: 'Native models', executableNames: [executable] }],
                    preflightSessionControls: { models: { command: { toolId: 'native-models', args: [] },
                        parseOutput: () => [{ id: 'ambient-native-model', name: 'Ambient native model' }] } },
                    retirementSignal: new AbortController().signal, isCurrent: () => true,
                });
                for (const modelId of [undefined, 'chosen-native-model']) {
                    const models = await runWithServerHttpBaseUrl('https://preflight-account.example.test', () => invokeCliPreflightMethod(agentId, 'probeModels', {
                        ...(modelId === undefined ? {} : { modelId }),
                        cwd: root, bypassCache: true, connectedServices: { v: 2, bindingsByServiceId: {
                            'acme.preflight-account/credential': { source: 'connected', selection: 'profile', profileId: 'selected-account' },
                        } },
                    }, {
                        agentCatalogEntry: { ...entry, ...modelProjection }, agentRegistrySnapshot: runtime.registry.contributes,
                        accountContext: { credentials: { token: 'fake-account-token', encryption: null }, accountSettings: null },
                        createApiClient: async () => ({} as ApiClient), connectedAccountsOwner: account.owner,
                        activatePurposeBindings: account.owner.activatePurposeBindings, isAgentRegistryCurrent: () => true,
                        createAgentInvocationServices: runtime.registry.createAgentInvocationServices,
                        agentRuntimeCacheKey: runtime.registry.readPluginOccurrenceId?.('acme.foreground') ?? undefined,
                    }, {}));
                    if (modelId === undefined) {
                        // The Machine transport carries the real preparation result;
                        // no internal catalog or Action logic is replaced.
                        const inventory = createCliActionInventoryDeps({ token: 'fake-account-token', sessionId: '', mode: 'plain', ctx: null,
                            callMachineAction: async input => input.method === RPC_METHODS.CAPABILITIES_INVOKE ? models
                                : { status: 'error', error: { code: 'provider_catalog_unavailable', retryable: false } },
                        });
                        const actions = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
                        expect(await actions.execute('agents.models.list', { machineId: 'fixture-machine', agentId,
                            probe: { connectedServices: { v: 2, bindingsByServiceId: {
                                'acme.preflight-account/credential': { source: 'connected', profileId: 'selected-account' },
                            } } } }, { surface: 'cli', authority: 'present_user' })).toMatchObject({
                            ok: false, errorCode: 'model_selection_required', details: { retryable: false },
                        });
                    } else {
                        expect(models).toMatchObject({ ok: true, result: { availableModels: [], source: 'unavailable',
                            refreshError: true, cacheable: false, refreshErrorMessage: expect.stringContaining('account_unverified'),
                        } });
                    }
                    expect(JSON.stringify(models)).not.toContain('credential-bearing');
                }
            }
        } finally {
            await runtime?.dispose();
            accountHttp.mockRestore();
            vi.unstubAllEnvs();
            reloadConfiguration();
            await rm(root, { recursive: true, force: true });
        }
    }, 60_000);


});
