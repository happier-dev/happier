import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { readCurrentAccountPluginExecutionSelection, resolveAccountPluginActivationSources } from './accountPluginActivationSource';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { createCommittedContributedActionInvoker, createCommittedContributedActionDefinitionLister,
    createCommittedContributedActionSchemaReader } from './invocation/actions/createCommittedContributedActionDeps';
import { createActionExecutor, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import { createBundledActivationSourceResolver } from './bundledActivationSource';
import * as daemonControlClient from '@/daemon/controlClient';
import { executeAccountPluginAction } from '@/session/actions/executeAccountPluginAction';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { ActionDiscoveryDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { PLUGIN_ACTION_EXECUTE_PATH } from '@/plugins/daemon/controlRoutes';
import * as persistence from '@/persistence';
import { manifest as authoredAccountManifest } from '../../../../../packages/plugin-sdk/fixtures/account-actions/src/index';

describe('Account activation source assembly', () => {
    it('resolves an authored authentication-only Account artifact without a Machine or native runtime', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-portable-authentication-'));
        const app = fastify();
        const manifest = normalizePluginManifestV2({ ...authoredAccountManifest, id: 'acme.portable-auth',
            hostAccess: { required: [], optional: [] }, secrets: [],
            contributes: { ...authoredAccountManifest.contributes, actions: [], resources: [],
                connectedAccountDescriptors: [{ id: 'example', title: 'Example', authentication: {
                    account: { artifactId: 'account-runtime', exportName: 'activate' }, defaultModeId: 'manual', modes: [{
                        id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
                    }],
                } }],
            },
        });
        const projectRoot = join(import.meta.dirname, '../../../../../packages/plugin-sdk/examples/public-authoring');
        const fixture = await registerAuthoredAccountActionRelease(app, 'owner', { primary: {
            manifest, projectRoot, entryPath: join(projectRoot, 'portableAuthentication.ts'),
            activateExport: 'activate', manifestExport: null,
        } });
        let machineRequests = 0;
        app.addHook('onRequest', async request => {
            if (/^\/v1\/machines(?:\/|$)/.test(request.url)) machineRequests += 1;
        });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-portable-authentication.test' });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
                accountExecution: { credentials: { token: 'fixture', encryption: null },
                    serverUrl: 'http://account-portable-authentication.test', isCurrent: () => true } });
            const service = { pluginId: fixture.pluginId, localId: 'example' };
            const selected = await runtime.resolveAccountConnectedAccountRuntime?.(service).catch(error => {
                expect(runtime?.pluginDiagnosticsByPluginId[fixture.pluginId] ?? []).toEqual([]);
                throw error;
            });
            expect(selected).toMatchObject({ ref: service, runtime: { authentication: { modes: { manual: { kind: 'manual' } } } } });
            if (!selected) throw new Error('Expected the actual Account authentication registration');
            expect('status' in selected.runtime).toBe(false);
            expect(selected.isCurrent()).toBe(true);
            expect(await runtime.resolveConnectedAccountRuntime?.(service)).toMatchObject({ ref: service, realm: 'account' });
            const account = { service, accountId: 'selected-account' };
            const invocation = {
                target: { account, expectedCredentialRevision: 'credential-1', expectedRuntimeConfigurationRevision: 'configuration-1' },
                context: { account,
                    configuration: { target: { kind: 'service' as const, service, modeId: 'manual' },
                        revision: 'configuration-1', values: {}, getSecret: async () => null },
                    credentials: { get: async (key: string) => key === 'token' ? 'selected-account-token' : null } },
                isConfigurationCurrent: () => true,
                isCredentialRevisionCurrent: () => true,
            };
            await expect(runtime.connectedAccountRuntimeInvoker?.invokeEstablished({ ...invocation,
                operation: { kind: 'materialize', request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] } } }))
                .resolves.toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer selected-account-token' } });
            await expect(runtime.connectedAccountRuntimeInvoker?.invokeEstablished({ ...invocation,
                operation: { kind: 'status' } })).rejects.toMatchObject({ code: 'unsupported' });
            expect(machineRequests).toBe(0);
            await runtime.dispose();
            expect(selected.isCurrent()).toBe(false);
        } finally { await runtime?.dispose(); restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });

    it('keeps Machine Agents and daemon-only Resources out of Account execution while retaining their package custody', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-resource-realm-'));
        const app = fastify();
        const { pluginId } = await registerAuthoredAccountActionRelease(app, 'owner');
        const declarations = await Promise.all(['happier.channels', 'happier.agent.qwen'].map(async peerId => {
            const bundled = getResolvedContributionRegistry().pluginDeclarations?.find(entry => entry.pluginId === peerId);
            if (!bundled) throw new Error(`Expected canonical declaration: ${peerId}`);
            const packageName = bundled.sourceSpec.locator;
            const pluginRootPath = join(home, peerId);
            await mkdir(pluginRootPath);
            await writeFile(join(pluginRootPath, 'package.json'), JSON.stringify({ name: packageName }));
            return { ...bundled, pluginRootPath,
                sourceSpec: { ...bundled.sourceSpec, kind: 'bundled' as const, locator: packageName,
                    resolvedVersion: bundled.manifest.version, trustPolicy: 'prompt' as const, installPolicy: 'copy' as const } };
        }));
        app.addHook('onSend', async (request, _reply, payload) => {
            if (request.url !== PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']
                || typeof payload !== 'string') return payload;
            const page = JSON.parse(payload);
            for (const { pluginId: peerId } of declarations) {
                page.pluginIds.push(peerId);
                page.intentReads.push({ pluginId: peerId, response: { availabilityCursor: 1,
                    hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [] } });
            }
            page.pluginIds.sort();
            return JSON.stringify(page);
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-resource-realm.test' });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
                contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
                    loadResult: { loadedPlugins: declarations, diagnosticsByPluginId: {} } })),
                accountExecution: { credentials: { token: 'fixture', encryption: null },
                    serverUrl: 'http://account-resource-realm.test', isCurrent: () => true } });
            const lease = { registry: runtime, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
            const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), listContributedActionDefinitions: list });
            expect(await executor.execute('action.spec.search', { query: 'Echo personal' }, { surface: 'agent' }))
                .toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([
                    expect.objectContaining({ id: `${pluginId}/actions/echo`, executionPlacement: 'account' }),
                ]) } });
            for (const { pluginId: peerId } of declarations) {
                expect(runtime.readAccountExecutionSelection?.(peerId))
                    .toMatchObject({ kind: 'available', sourceCustody: { kind: 'bundled_first_party',
                        packagedRuntime: { kind: 'source_declaration' } } });
            }
            expect(runtime.readAccountExecutionSelection?.('happier.agent.qwen'))
                .toMatchObject({ kind: 'available', manifest: { contributes: { agents: [expect.objectContaining({ id: 'qwen' })] } } });
            expect(runtime.contributes.resources).toEqual([]);
            expect(runtime.agentRuntimesByAgentId.size).toBe(0);
        } finally { await runtime?.dispose(); restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });

    it.each(['Artifact', 'Account source census'] as const)('keeps a selected Account release refused after %s HTTP 404 instead of replaying its Action on a Machine', async phase => {
        const home = await mkdtemp(join(tmpdir(), 'account-missing-artifact-'));
        const app = fastify();
        const daemon = fastify();
        const { pluginId } = await registerAuthoredAccountActionRelease(app, 'owner');
        const qualifiedId = formatQualifiedPluginActionId({ pluginId, localId: 'echo' });
        const credentials = { token: 'fixture', encryption: null } as const;
        const serverUrl = 'http://account-missing-artifact.test';
        const failedSourcePath = phase === 'Artifact' ? PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read']
            : PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'];
        let missingSourceReads = 0;
        app.addHook('onRequest', async (request, reply) => {
            if (request.url === failedSourcePath) {
                missingSourceReads += 1;
                return reply.code(404).send({ error: 'not_found' });
            }
        });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        const machineDescriptor = ActionDiscoveryDefinitionV1Schema.parse({ id: qualifiedId, kindVersion: 1,
            title: 'Incumbent Machine echo', description: null, safety: 'safe', placements: [], slash: null,
            bindings: null, examples: null, inputHints: null, inputSchema: {}, executionPlacement: 'machine',
            surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: false, plugin: false } });
        let machineDescriptorReads = 0;
        let machineEffects = 0;
        daemon.post<{ Body: Parameters<typeof daemonControlClient.requestDaemonPluginActionExecution>[0] }>(PLUGIN_ACTION_EXECUTE_PATH,
            async request => {
                if (request.body.actionId === 'action.spec.get') {
                    expect(request.body.input).toEqual({ id: qualifiedId });
                    machineDescriptorReads += 1;
                    return { matched: true, result: { ok: true, result: { actionSpec: machineDescriptor } } };
                }
                expect(request.body).toMatchObject({ actionId: 'action.invoke',
                    input: { action: { pluginId, localId: 'echo' }, input: { key: 'cold' } } });
                machineEffects += 1;
                return { matched: true, result: { ok: true, result: { replayedOnMachine: true } } };
            });
        const daemonUrl = await daemon.listen({ host: '127.0.0.1', port: 0 });
        // The local state-file reader is the filesystem boundary. Dispatch,
        // daemon HTTP, selection, compilation and activation remain real.
        const readDaemonState = vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid,
            httpPort: Number(new URL(daemonUrl).port), startedAt: Date.now(), startedWithCliVersion: 'test' });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
        try {
            expect(await readCurrentAccountPluginExecutionSelection({ pluginId, credentials, serverUrl }))
                .toMatchObject({ kind: 'available', sourceCustody: { kind: 'account_release' },
                    manifest: { contributes: { actions: expect.arrayContaining([expect.objectContaining({ id: 'echo',
                        execution: expect.objectContaining({ target: 'account' }) })]) } } });
            // Prove the incumbent transport admits this exact Machine descriptor
            // before using its effect counter as the no-fallback oracle.
            expect(await daemonControlClient.requestDaemonPluginActionExecution({ actionId: 'action.spec.get',
                input: { id: qualifiedId }, surface: 'cli' })).toMatchObject({ matched: true,
                result: { ok: true, result: { actionSpec: { id: qualifiedId, executionPlacement: 'machine' } } } });
            machineDescriptorReads = 0;
            const cli = createCliActionExecutor({ token: 'fixture', credentials: { ...credentials, credentialProvenance: 'stored_session' },
                happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverId: 'account-missing-artifact', serverHttpBaseUrl: serverUrl });
            const result = await cli.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'cold' } }, { surface: 'cli' });
            expect(missingSourceReads).toBeGreaterThan(0);
            expect({ result, machineDescriptorReads, machineEffects }).toMatchObject({
                result: { ok: false, errorCode: expect.any(String) }, machineDescriptorReads: 0, machineEffects: 0,
            });
        } finally { readDaemonState.mockRestore(); restore(); await Promise.all([app.close(), daemon.close()]);
            await rm(home, { recursive: true, force: true }); }
    });
    it('reports one missing bundled root without losing another Account source', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-source-isolation-'));
        const app = fastify();
        const declarations = ['missing', 'ready'].map(name => ({
            pluginId: `happier.${name}`, pluginRootPath: join(home, name), manifestPath: `bundled:${name}`,
            daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'bundled' as const, locator: `@happier-dev/plugins-${name}`,
                trustPolicy: 'prompt' as const, installPolicy: 'copy' as const },
            manifest: normalizePluginManifestV2({ ...authoredAccountManifest, id: `happier.${name}` }),
        }));
        const ready = declarations[1]!;
        await mkdir(ready.pluginRootPath);
        await writeFile(join(ready.pluginRootPath, 'package.json'), JSON.stringify({ name: ready.sourceSpec.locator }));
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => ({
            availabilityCursor: 1, pluginIds: declarations.map(declaration => declaration.pluginId), failedPluginIds: [],
            intentReads: declarations.map(declaration => ({ pluginId: declaration.pluginId,
                response: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null,
                    release: null, uiArtifacts: [], packageAssets: [] } })),
        }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-source-isolation.test' });
        try {
            const sources = await resolveAccountPluginActivationSources({
                contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
                    loadResult: { loadedPlugins: declarations, diagnosticsByPluginId: {} } })),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'fixture', encryption: null },
                serverUrl: 'http://account-source-isolation.test', isCurrent: () => true,
                resolveBundledActivationSource: createBundledActivationSourceResolver({
                    bundledPackageNames: declarations.map(declaration => declaration.sourceSpec.locator), bundledDeclarations: declarations }),
            });
            expect(sources.readSelection('happier.missing')).toEqual({ kind: 'unavailable', code: 'plugin_account_execution_unavailable' });
            expect(sources.sourcesByPluginId.has('happier.missing')).toBe(false);
            expect(sources.readSelection(ready.pluginId)).toMatchObject({ kind: 'available' });
            expect(sources.isCurrent(ready.pluginId)).toBe(true);
            expect(sources.sourcesByPluginId.has(ready.pluginId)).toBe(true);
        } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });
    it('checks fresh Account placement for repeated Machine Actions without rebuilding the full Account census', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-machine-placement-'));
        const app = fastify();
        const action = getResolvedContributionRegistry().actions.find(action => {
            const execution = action.definition.execution;
            return action.pluginId && typeof execution === 'object' && execution !== null
                && 'target' in execution && execution.target === 'daemon';
        });
        if (!action?.pluginId) throw new Error('Missing bundled Machine Action fixture');
        let enabled = true;
        let censusReads = 0;
        let exactReads = 0;
        const response = () => ({ availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: enabled ? null : { pluginId: action.pluginId, desiredVersion: '1.0.0', enabled: false, offlineUiHosting: 'disabled',
                revision: '1', writableCollections: [] }, release: null, uiArtifacts: [], packageAssets: [] });
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request => {
            expect(PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body).pluginId).toBe(action.pluginId);
            exactReads++;
            return response();
        });
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => {
            censusReads++;
            return { availabilityCursor: 1, pluginIds: [action.pluginId],
                intentReads: [{ pluginId: action.pluginId, response: response() }], failedPluginIds: [] };
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-machine-placement.test' });
        const invoke = () => executeAccountPluginAction({ host: { token: 'fixture',
            credentials: { token: 'fixture', encryption: null }, happyHomeDir: home, sessionId: 'cli-global',
            mode: 'plain', ctx: null, serverId: 'machine-placement', serverHttpBaseUrl: 'http://account-machine-placement.test' },
            deps: createUnavailableActionTransportDeps(), actionId: 'action.invoke',
            input: { action: { pluginId: action.pluginId, localId: action.definition.id }, input: {} }, context: { surface: 'cli' } });
        try {
            for (let i = 0; i < 3; i++) expect(await invoke()).toEqual({ matched: false, accountSelectionUnavailable: true });
            enabled = false;
            expect(await invoke()).toMatchObject({ matched: true, result: { ok: false, errorCode: 'plugin_disabled' } });
            expect(censusReads).toBe(0);
            expect(exactReads).toBe(4);
        } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });
    it('refuses cold corrupt Account bytes through the CLI ingress without replaying on a Machine', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-corrupt-source-'));
        const app = fastify();
        const { pluginId, artifactId, artifacts, providerPluginId } = await registerAuthoredAccountActionRelease(app, 'owner', { includeAccountProvider: true });
        const artifact = artifacts.read(artifactId);
        if (!artifact) throw new Error('authored fixture artifact missing');
        artifacts.seed(artifactId, artifact.header, encodePlainArtifactStoredContent({ body: 'not an artifact archive' }));
        let artifactReads = 0;
        app.addHook('onRequest', async request => {
            if (request.url === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read']) artifactReads += 1;
        });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-corrupt-source.test' });
        // The daemon request is the genuine cross-process boundary. A replay
        // would succeed visibly, so the Account refusal cannot hide one.
        const daemon = vi.spyOn(daemonControlClient, 'requestDaemonPluginActionExecution').mockResolvedValue({ matched: true,
            result: { ok: true, result: { replayedOnMachine: true } } });
        try {
            const cli = createCliActionExecutor({ token: 'fixture',
                credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
                happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverId: 'account-corrupt-source', serverHttpBaseUrl: 'http://account-corrupt-source.test' });
            expect(await cli.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'cold' } }, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'plugin_action_handler_missing' });
            expect(artifactReads).toBeGreaterThan(0);
            expect(daemon).not.toHaveBeenCalled();
            const runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
                contributes: createResolvedContributionRegistry({}), accountExecution: {
                    credentials: { token: 'fixture', encryption: null },
                    serverUrl: 'http://account-corrupt-source.test', isCurrent: () => true,
                } });
            try {
                await runtime.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'echo' }]);
                expect(runtime.pluginDiagnosticsByPluginId[pluginId]).toEqual(expect.arrayContaining([
                    expect.objectContaining({ code: 'plugin_daemon_module_load_failed', message: 'plugin_account_execution_artifact_invalid' }),
                ]));
                const lease = { registry: runtime, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
                const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
                const definitions = list();
                expect(definitions.some(action => action.id === `${pluginId}/actions/echo`)).toBe(false);
                expect(definitions.some(action => action.id === `${providerPluginId}/actions/record`)).toBe(true);
            } finally { await runtime.dispose(); }
        } finally { daemon.mockRestore(); restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });
    it('refuses a qualified hosted response for another Artifact identity even when its archive bytes are valid', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-hosted-identity-'));
        const app = fastify();
        const { pluginId } = await registerAuthoredAccountActionRelease(app, 'owner');
        app.addHook('onSend', async (request, _reply, payload) => {
            if (request.url !== PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read']
                || typeof payload !== 'string') return payload;
            const response = JSON.parse(payload);
            return JSON.stringify({ ...response, link: { ...response.link,
                accountArtifactId: 'c7e5d73f-88a7-44bc-98ed-23edbffb6214' } });
        });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-hosted-identity.test' });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
                contributes: createResolvedContributionRegistry({}), accountExecution: {
                    credentials: { token: 'fixture', encryption: null },
                    serverUrl: 'http://account-hosted-identity.test', isCurrent: () => true } });
            await runtime.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'echo' }]);
            expect(runtime.pluginDiagnosticsByPluginId[pluginId]).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_daemon_module_load_failed', message: 'plugin_account_execution_identity_mismatch' }),
            ]));
            const lease = { registry: runtime, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
            const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
            expect(list().some(action => action.id === `${pluginId}/actions/echo`)).toBe(false);
        } finally { await runtime?.dispose(); restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });
    it.each(['Account disable', 'same-version source retirement'] as const)('loads a current host-bundled declaration and refuses it after %s', async retirement => {
        const home = await mkdtemp(join(tmpdir(), 'account-bundled-source-'));
        const app = fastify();
        const { pluginId, manifest, generated, files, setBundledFallback, setEnabled } = await registerAuthoredAccountActionRelease(app, 'owner');
        const packageName = '@happier-dev/plugins-account-host-fixture';
        const pluginRootPath = join(home, 'host-bundle');
        await mkdir(pluginRootPath, { recursive: true });
        await writeFile(join(pluginRootPath, 'package.json'), JSON.stringify({ name: packageName }));
        for (const file of files) {
            const path = join(pluginRootPath, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH, file.relativePath);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, file.bytes);
        }
        const declaration = { pluginId, manifest, pluginRootPath, manifestPath: 'bundled:account-host-fixture',
            daemonEntryPath: null, devDaemonEntryPath: null, generatedUiArtifactsManifest: generated,
            sourceSpec: { kind: 'bundled', locator: packageName, trustPolicy: 'prompt', installPolicy: 'copy' } as const };
        setBundledFallback();
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-bundled-source.test' });
        let current = true;
        try {
            const source = await resolveAccountPluginActivationSources({
                contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
                    loadResult: { loadedPlugins: [declaration], diagnosticsByPluginId: {} } })),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'fixture', encryption: null },
                serverUrl: 'http://account-bundled-source.test', isCurrent: () => current,
                resolveBundledActivationSource: createBundledActivationSourceResolver({ bundledPackageNames: [packageName],
                    bundledDeclarations: [declaration] }),
            });
            expect(source.readSelection(pluginId)).toMatchObject({ kind: 'available',
                sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName } } });
            expect(source.contributes.activationTargets).toMatchObject([{ daemonEntryPath: null,
                account: { artifactId: 'account-runtime', exportName: 'activate' } }]);
            expect(typeof (await source.sourcesByPluginId.get(pluginId)?.resolveRelativeModule?.('account-runtime'))?.module.activate).toBe('function');
            if (retirement === 'Account disable') {
                setBundledFallback(false);
                setEnabled(false);
            } else {
                current = false;
            }
            expect(await source.revalidate(pluginId)).toBe(false);
            await expect(source.sourcesByPluginId.get(pluginId)?.resolveRelativeModule?.('account-runtime')).rejects.toThrow('plugin_account_execution_retired');
        } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });
    it('loads an Account release through qualified hosted Artifact bytes unavailable to ordinary reads, without a Machine, and retires on disable', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-source-'));
        const app = fastify();
        const { pluginId, manifest, artifactId, setEnabled } = await registerAuthoredAccountActionRelease(app, 'owner');
        // Hosted plugin Artifacts are intentionally isolated from ordinary Artifact reads.
        app.addHook('onRequest', async (request, reply) => {
            if (request.url === `/v1/artifacts/${artifactId}`) return reply.code(404).send({ error: 'not_found' });
        });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-source.test' });
        try {
            const result = await resolveAccountPluginActivationSources({ contributes: createResolvedContributionRegistry({}),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'fixture', encryption: null },
                serverUrl: 'http://account-source.test', isCurrent: () => true, resolveBundledActivationSource: () => null });
            const censusSelection = result.readSelection(pluginId);
            const exactSelection = await readCurrentAccountPluginExecutionSelection({ pluginId,
                credentials: { token: 'fixture', encryption: null }, serverUrl: 'http://account-source.test' });
            for (const selection of [censusSelection, exactSelection]) {
                expect(selection?.kind).toBe('available');
                if (selection?.kind !== 'available' || !selection.release) throw new Error('Expected acquired Account release');
                expect(Object.isFrozen(selection.release)).toBe(true);
                expect(Object.isFrozen(selection.manifest.contributes.actions)).toBe(true);
                expect(Object.isFrozen(selection.release.uiSlots)).toBe(true);
            }
            expect(result.contributes.actions.map(action => action.definition.id).sort()).toEqual(manifest.contributes.actions.map(action => action.id).sort());
            expect(result.contributes.activationTargets).toMatchObject([{ account: { artifactId: 'account-runtime', exportName: 'activate' } }]);
            const module = await result.sourcesByPluginId.get(pluginId)?.resolveRelativeModule?.('account-runtime');
            expect(typeof module?.module.activate).toBe('function');
            expect(result.isCurrent(pluginId)).toBe(true);
            const cli = createCliActionExecutor({ token: 'fixture',
                credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
                happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverId: 'account-source', serverHttpBaseUrl: 'http://account-source.test' });
            for (const surface of ['cli', 'agent', 'mcp'] as const) {
                expect(await cli.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: surface } }, { surface }))
                    .toMatchObject({ ok: true, result: { key: surface, surface } });
            }
            expect(await cli.execute('action.spec.get', { id: formatQualifiedPluginActionId({ pluginId, localId: 'echo' }) }, { surface: 'cli' }))
                .toMatchObject({ ok: true, result: { actionSpec: { executionPlacement: 'account' } } });
            expect(await cli.execute('action.invoke', { action: { pluginId, localId: 'source' }, input: { key: 'provider' } }, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'plugin_action_machine_required' });
            const registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: home, contributes: createResolvedContributionRegistry({}),
                accountExecution: { credentials: { token: 'fixture', encryption: null },
                    serverUrl: 'http://account-source.test', isCurrent: () => true },
            });
            try {
                const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
                const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                    listContributedActionDefinitions: list,
                    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
                    invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => lease }),
                });
                expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'retained' } }, { surface: 'cli' }))
                    .toMatchObject({ ok: true, result: { key: 'retained', surface: 'cli' } });
                setEnabled(false);
                expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'retained' } }, { surface: 'cli' }))
                    .toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
            } finally { await registry.dispose(); }
            setEnabled(false);
            expect(await cli.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'disabled' } }, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'plugin_disabled' });
            expect(await result.revalidate(pluginId)).toBe(false);
            expect(result.isCurrent(pluginId)).toBe(false);
            await expect(result.sourcesByPluginId.get(pluginId)?.resolveRelativeModule?.('account-runtime')).rejects.toThrow();
        } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });
});
