import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import type {
    PluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/runtime';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
    createPluginStateStore,
    writeCommittedLocalPathPluginFixture,
} from '@/plugins/store/state.testkit';
import {
    createMergedContributionRegistry,
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    readPluginRegistryCommitRecord,
    replacePluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';
import {
    ImmutablePluginGenerationRecordSchema,
    prepareImmutablePluginGeneration,
    persistInstallationStateRevision,
    readCurrentCommittedPluginGenerations,
    readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import { createPendingGenerationHealthRecord } from '@/plugins/store/registry/healthPolicy';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import type { ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { adaptTargetActivationFacts } from '@/plugins/projection/introspection/targetActivationFacts';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import { resolveEffectiveCodingPromptPlan } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createNativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createPluginSecretStore } from './context/secrets';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    notificationChannelSettingFieldId,
} from '@/plugins/settings/notificationChannelSettings';

async function createTrustedLocalLinkInstall(params: Readonly<{
    pluginId: string;
    sourceRootPath: string;
    manifestVersion: string;
    manifestDigest: `sha256:${string}` | null;
}>) {
    const distribution = await createLocalPathPluginDistributionIdentity(params.sourceRootPath);
    return {
        mode: 'link' as const,
        manifestVersion: params.manifestVersion,
        manifestDigest: params.manifestDigest,
        installedPath: null,
        trust: createPluginTrustRecord({
            pluginId: params.pluginId,
            distribution,
            approvedAtMs: 1,
        }),
    };
}

describe('resolveExecutablePluginRuntimeRegistry (integration)', () => {
    it('projects Antigravity localharness through the canonical managed-installable adapter', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-antigravity-managed-home-'));
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            pluginIds: ['happier.agent.antigravity'],
        });
        try {
            const contribution = (runtimeRegistry.contributes.managedDependencies ?? []).find((entry) => (
                entry.pluginId === 'happier.agent.antigravity'
                && entry.definition.id === 'localharness'
            ));
            expect(contribution?.definition).toMatchObject({
                id: 'localharness',
                sources: [expect.objectContaining({
                    kind: 'managedPypiWheelAsset',
                    installId: 'dep.antigravity.localharness',
                })],
                executable: 'localharness',
            });

            const status = await runtimeRegistry.managedDependencies
                ?.bind('happier.agent.antigravity')
                .status('localharness');
            expect(status?.state).toEqual(expect.stringMatching(/^(missing|ready|updateAvailable)$/));
        } finally {
            await runtimeRegistry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('keeps uncommitted local-trusted actions from invoking the production system-source owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-managed-dependency-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-managed-dependency-plugin-'));
        const toolRoot = await mkdtemp(join(tmpdir(), 'happier-managed-dependency-tool-'));
        const toolName = process.platform === 'win32' ? 'acme-runtime.exe' : 'acme-runtime';
        const unavailablePlatform = process.platform === 'darwin' ? 'linux' : 'macos';
        const toolPath = join(toolRoot, toolName);
        const originalPath = process.env.PATH;
        await symlink(process.execPath, toolPath);
        process.env.PATH = `${toolRoot}${delimiter}${originalPath ?? ''}`;
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
            schemaVersion: 2,
            id: 'acme.managed.runtime',
            version: '1.0.0',
            displayName: 'Managed runtime fixture',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'managed-runtime-process', capability: 'process', reason: 'Run the declared managed runtime',
                    scope: { executables: [{ kind: 'managedDependency', id: 'runtime' }] },
                }],
                optional: [],
            },
            contributes: {
                managedDependencies: [{
                    id: 'runtime', title: 'Runtime', executable: toolName,
                    sources: [{ kind: 'system', executableNames: [toolName], versionArguments: ['--version'] }],
                }, {
                    id: 'wrong-platform', title: 'Wrong platform', platforms: [unavailablePlatform], executable: toolName,
                    sources: [{ kind: 'system', executableNames: [toolName] }],
                }, {
                    id: 'manual-only', title: 'Manual dependency', executable: 'manual-only',
                    sources: [{ kind: 'manual', instructions: 'Install the dependency manually' }],
                }],
                actions: [{
                    id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe',
                    hostAccess: ['managed-runtime-process'],
                }],
            },
        }), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
            api.actions.register('run', async (_input, context) => {
                const result = await context.services.exec.run({
                    executable: { kind: 'managedDependency', id: 'runtime' },
                    args: ['-e', 'process.stdout.write("production-managed-ok")']
                });
                return { stdout: new TextDecoder().decode(result.stdout) };
            });
        }`, 'utf8');
        const store = createPluginStateStore({ happyHomeDir });
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.managed.runtime': {
                    source: {
                        kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: { mode: 'link', manifestVersion: '1.0.0', manifestDigest: null, installedPath: null },
                    state: { enabled: true },
                },
            },
        });

        try {
            const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            try {
                const dependencies = runtimeRegistry.managedDependencies?.bind('acme.managed.runtime');
                await expect(dependencies?.status('runtime')).resolves.toMatchObject({
                    state: 'ready', sourceId: 'acme.managed.runtime/runtime#0',
                });
                await expect(dependencies?.update('runtime')).rejects.toMatchObject({
                    code: 'plugin_managed_dependency_system_missing',
                });
                await expect(dependencies?.remove('runtime')).rejects.toMatchObject({
                    code: 'plugin_managed_dependency_system_missing',
                });
                await expect(dependencies?.status('wrong-platform')).resolves.toMatchObject({
                    state: 'unsupported', code: 'plugin_managed_dependency_platform_unsupported',
                });
                await expect(dependencies?.status('manual-only')).resolves.toMatchObject({
                    state: 'unsupported', code: 'plugin_managed_dependency_manual_required',
                });
                expect(runtimeRegistry.targetActionInvocations?.evaluateCatalogPolicy(
                    'acme.managed.runtime',
                    'run',
                )).toMatchObject({ outcome: 'unavailable', code: 'plugin_action_handler_missing' });
                await expect(runtimeRegistry.activateContributionsOnDemand([{
                    pluginId: 'acme.managed.runtime', family: 'actions', localId: 'run',
                }])).resolves.toEqual([expect.objectContaining({
                    pluginId: 'acme.managed.runtime',
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: 'plugin_source_missing' }),
                    ]),
                })]);
                const executable = await runtimeRegistry.managedDependencies?.resolveExecutable(
                    { kind: 'managedDependency', id: 'runtime' },
                    'acme.managed.runtime',
                );
                expect(executable).toMatchObject({ command: toolPath });
                executable?.release();
                await runtimeRegistry.dispose();
                await expect(dependencies?.status('runtime')).resolves.toMatchObject({
                    state: 'unsupported', code: 'plugin_managed_dependency_generation_retired',
                });
            } finally {
                await runtimeRegistry.dispose();
            }
        } finally {
            process.env.PATH = originalPath;
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(toolRoot, { recursive: true, force: true });
        }
    });

    it('materializes CodeRabbit and DeepSec bundled prompt assets once through SVC11', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-prompts-home-'));
        for (const artifact of BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS) {
            expect(() => ImmutablePluginGenerationRecordSchema.parse(artifact.record)).not.toThrow();
        }
        const admitted = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir }),
            { bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS },
        );
        expect(admitted?.unavailableBundledPackageNames).toEqual(new Set());
        expect([...admitted?.generations.keys() ?? []].sort()).toEqual([
            'happier.review.coderabbit',
            'happier.review.deepsec',
        ]);
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            pluginIds: ['happier.review.coderabbit', 'happier.review.deepsec'],
        });
        try {
            const deepsecRuntimeLease = runtimeRegistry.agentRuntimesByAgentId.get('deepsec');
            expect(deepsecRuntimeLease).toMatchObject({
                pluginId: 'happier.review.deepsec',
                agentId: 'deepsec',
                generation: String(runtimeRegistry.generation),
            });
            if (!deepsecRuntimeLease?.hasPrimaryRuntime) {
                throw new Error('DeepSec must register a primary Agent runtime');
            }
            const deepsecRuntime = await deepsecRuntimeLease.createRuntime({
                signal: new AbortController().signal,
            });
            expect(deepsecRuntime?.executionRuns?.open).toEqual(expect.any(Function));
            expect(deepsecRuntime?.sessions).toBeUndefined();

            const coderabbit = await runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'coderabbit' });
            const deepsec = await runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'deepsec' });
            const deepsecAudit = await runtimeRegistry.resolvePromptAssetBlocks({
                agentId: 'deepsec',
                selectedAsset: {
                    pluginId: 'happier.review.deepsec',
                    localId: 'repository-security-audit-prompt',
                },
            });
            expect(coderabbit).toEqual([{
                id: 'plugin_prompt_asset.happier.review.coderabbit/review-prompt',
                scope: 'session',
                text: await readFile(join(
                    process.cwd(),
                    '../../packages/plugins/review-coderabbit/resources/review-prompt.md',
                ), 'utf8'),
            }]);
            expect(deepsec.map((block) => block.id)).toEqual([
                'plugin_prompt_asset.happier.review.deepsec/repository-security-audit-prompt',
                'plugin_prompt_asset.happier.review.deepsec/review-prompt',
            ]);
            expect(new Set(deepsec.map((block) => block.id)).size).toBe(deepsec.length);
            expect(deepsecAudit).toEqual([{
                id: 'plugin_prompt_asset.happier.review.deepsec/repository-security-audit-prompt',
                scope: 'session',
                text: await readFile(join(
                    process.cwd(),
                    '../../packages/plugins/review-deepsec/resources/repository-security-audit-prompt.md',
                ), 'utf8'),
            }]);
            const machineKey = new Uint8Array(32).fill(11);
            const promptPlan = await resolveEffectiveCodingPromptPlan({
                credentials: {
                    token: 'token',
                    encryption: {
                        type: 'dataKey',
                        machineKey,
                        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
                    },
                },
                settings: {},
                profileId: null,
                baseOverride: 'Base prompt',
                memoryRecallGuidanceEnabled: false,
                agentId: 'coderabbit',
                promptAssetBlocks: coderabbit,
            });
            expect(promptPlan.plan.blocks.filter((block) => block.id === coderabbit[0]?.id)).toEqual([{
                ...coderabbit[0]!,
                text: coderabbit[0]!.text.trim(),
            }]);
        } finally {
            await runtimeRegistry.dispose();
        }
    });

    it('binds native Agent readiness and declared system-tool resolution through production services', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-agent-services-home-'));
        const toolRoot = await mkdtemp(join(tmpdir(), 'happier-native-agent-services-tool-'));
        const toolName = process.platform === 'win32' ? 'pi.cmd' : 'pi';
        const toolPath = join(toolRoot, toolName);
        const originalPath = process.env.PATH;
        const originalClaudePath = process.env.HAPPIER_CLAUDE_PATH;
        const originalJavaScriptRuntimePath = process.env.HAPPIER_JS_RUNTIME_PATH;
        await writeFile(toolPath, process.platform === 'win32'
            ? `@echo off\r\n"${process.execPath}" -e "process.stdout.write(process.env.PROFILE_CUSTOM || '')"\r\n`
            : '#!/usr/bin/env node\nprocess.stdout.write(process.env.PROFILE_CUSTOM ?? "");\n', 'utf8');
        await chmod(toolPath, 0o755);
        process.env.PATH = `${toolRoot}${delimiter}${originalPath ?? ''}`;
        process.env.HAPPIER_CLAUDE_PATH = process.execPath;
        process.env.HAPPIER_JS_RUNTIME_PATH = process.execPath;

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        try {
            expect(runtimeRegistry.activatedPluginIds.has('happier.agent.pi')).toBe(false);
            await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'happier.agent.pi',
                family: 'agents',
                localId: 'pi',
            }]);
            expect(runtimeRegistry.activatedPluginIds.has('happier.agent.pi')).toBe(true);
            const services = runtimeRegistry.createAgentInvocationServices({
                pluginId: 'happier.agent.pi',
                pluginVersion: '0.0.0',
                agentId: 'pi',
                generation: String(runtimeRegistry.generation),
                correlationId: 'pi-native-services',
                cwd: toolRoot,
                environment: { PROFILE_CUSTOM: 'profile-value' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(services.exec.agentCli.checkReadiness({
                candidates: ['claude'],
                requirement: 'any',
                cwd: toolRoot,
            })).resolves.toEqual({ launchable: [{ agentId: 'claude' }] });
            await expect(services.exec.systemTools.resolve({
                toolId: 'pi-cli',
                purpose: 'Run Pi',
                cwd: toolRoot,
                preferredPath: toolPath,
            })).resolves.toMatchObject({
                executable: { kind: 'systemTool', id: 'pi-cli' },
                executablePath: toolPath,
            });
            const executable = await services.exec.systemTools.resolve({
                toolId: 'pi-cli',
                purpose: 'Run Pi with the host-admitted Profile environment',
                cwd: toolRoot,
                preferredPath: toolPath,
            });
            const result = await services.exec.run({
                executable: executable.executable,
                env: { PROFILE_CUSTOM: 'profile-value' },
            });
            expect(Buffer.from(result.stdout).toString('utf8')).toBe('profile-value');
            await expect(services.exec.run({
                executable: executable.executable,
                env: { UNADMITTED_CUSTOM: 'must-not-reach-agent' },
            })).rejects.toMatchObject({
                code: 'plugin_exec_environment_denied',
            });
        } finally {
            await runtimeRegistry.dispose();
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
            if (originalClaudePath === undefined) delete process.env.HAPPIER_CLAUDE_PATH;
            else process.env.HAPPIER_CLAUDE_PATH = originalClaudePath;
            if (originalJavaScriptRuntimePath === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
            else process.env.HAPPIER_JS_RUNTIME_PATH = originalJavaScriptRuntimePath;
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(toolRoot, { recursive: true, force: true });
        }
    });

    it('routes dynamic and discovered MCP servers through the bound native session owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-mcp-session-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-mcp-session-plugin-'));
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
            schemaVersion: 2,
            id: 'acme.mcp.session',
            version: '1.0.0',
            displayName: 'Session MCP fixture',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'session-tools-access',
                    capability: 'mcp',
                    reason: 'Use the session MCP server',
                    scope: { serverRefs: ['session-tools'], operations: ['listTools', 'callTools'] },
                }],
                optional: [],
            },
            contributes: {
                agents: [{
                    id: 'session-agent', title: 'Session agent', runtime: { kind: 'custom' }, primary: 'sessions',
                    capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                }],
                mcp: {
                    servers: [{ id: 'session-tools', title: 'Session tools', kind: 'dynamic', sessionScope: 'session' }],
                    discoveryProviders: [{ id: 'pi-synthetic', title: 'Pi discovery' }],
                },
            },
        }), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
            api.agents.register('session-agent', () => ({
                async dispose() {},
                sessions: {
                    async open(request) {
                        return {
                            async send() { return { status: 'admitted' }; },
                            watch() { return { dispose() {} }; },
                            async dispose() {},
                            sessionId: request.sessionId
                        };
                    }
                }
            }));
            api.mcp.registerServer('session-tools', {
                async dispose() {},
                async listTools() {
                    return { items: [{ name: 'confirm', inputSchema: { type: 'object' } }] };
                },
                async callTool(_request, context) {
                    const confirmed = await context.ui.confirm('Run the session MCP tool?');
                    return { confirmed };
                }
            });
            api.mcp.registerDiscoveryProvider('pi-synthetic', async () => ({
                items: [{
                    provider: { pluginId: 'acme.mcp.session', localId: 'pi-synthetic' },
                    discoveryId: 'pi.docs',
                    title: 'Discovered docs'
                }],
                servers: [{
                    id: 'pi.docs',
                    name: 'discovered-docs',
                    transport: { kind: 'http', url: 'https://mcp.example.test/discovered' }
                }]
            }));
        }`, 'utf8');
        const paths = resolvePluginStorePaths({ happyHomeDir });
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.mcp.session',
            sourceRootPath: pluginRoot,
            plugin: {
                source: {
                    kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                    resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                },
                compatibility: { status: 'unknown', diagnostics: [] },
                install: await createTrustedLocalLinkInstall({
                    pluginId: 'acme.mcp.session',
                    sourceRootPath: pluginRoot,
                    manifestVersion: '1.0.0',
                    manifestDigest: null,
                }),
                state: { enabled: true },
            },
        });
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const cleanupWarning = vi.spyOn(logger, 'warn');
        let projectedUrlAfterRegistryDispose: string | null = null;

        try {
            const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            try {
                expect(runtimeRegistry.contributes.mcpDiscoveryProviders).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        pluginId: 'acme.mcp.session',
                        definition: expect.objectContaining({ id: 'pi-synthetic' }),
                    }),
                ]));
                const discovery = await runtimeRegistry.discoverMcpServersForDetection?.({
                    pluginId: 'acme.mcp.session',
                    localId: 'pi-synthetic',
                    input: {
                        sessionId: 'mcp-detection',
                        directory: pluginRoot,
                    },
                    signal: new AbortController().signal,
                });
                expect(discovery).toEqual({
                    servers: [{
                        id: 'pi.docs',
                        name: 'discovered-docs',
                        transport: {
                            kind: 'http',
                            url: 'https://mcp.example.test/discovered',
                        },
                    }],
                    warnings: [],
                });
                await runtimeRegistry.activateContributionsOnDemand([{
                    pluginId: 'acme.mcp.session',
                    family: 'agents',
                    localId: 'session-agent',
                }]);
                expect(runtimeRegistry.agentRuntimesByAgentId.get('session-agent')).toMatchObject({
                    pluginId: 'acme.mcp.session',
                    agentId: 'session-agent',
                    generation: String(runtimeRegistry.generation),
                });
                const sessionServices = createNativeAgentSessionServices({
                    permissionHandler: { handleToolCall },
                    pluginId: 'acme.mcp.session',
                    contributionId: 'session-agent',
                    runtimeId: 'session-agent',
                    sessionId: 'session-1',
                    generationId: String(runtimeRegistry.generation),
                    isCurrent: () => true,
                });
                const services = runtimeRegistry.createAgentInvocationServices({
                    pluginId: 'acme.mcp.session',
                    pluginVersion: '1.0.0',
                    agentId: 'session-agent',
                    generation: String(runtimeRegistry.generation),
                    correlationId: 'session-1',
                    cwd: pluginRoot,
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                    session: { id: 'session-1', current: sessionServices.sessions.current },
                });
                const client = await services.mcp.connect(
                    { pluginId: 'acme.mcp.session', localId: 'session-tools' },
                    { sessionId: 'session-1', elicitation: { mode: 'hostMediated', sessionId: 'session-1' } },
                );

                await expect(client.callTool('confirm', {})).resolves.toEqual({ confirmed: true });
                expect(handleToolCall).toHaveBeenCalledWith(
                    expect.any(String),
                    'AgentConfirmation',
                    expect.objectContaining({ message: 'Run the session MCP tool?' }),
                    expect.objectContaining({
                        owner: { kind: 'plugin', pluginId: 'acme.mcp.session', runtimeId: 'session-agent' },
                    }),
                );
                const agentContribution = runtimeRegistry.contributes.agentDefinitionsById.get('session-agent');
                if (!agentContribution) throw new Error('Expected session Agent contribution');
                const backendContribution = {
                    id: 'session-agent',
                    agentId: 'session-agent',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'session-agent',
                        agentId: 'session-agent',
                    },
                    runtimeKind: 'custom',
                    pluginId: 'acme.mcp.session',
                } satisfies ResolvedAgentRuntimeContribution;
                const createHostOwners = (
                    permissionHandlerOverride: Readonly<{
                        handleToolCall: ProviderEnforcedPermissionHandler['handleToolCall'];
                    }>,
                ) => {
                    const session = createMutableApiSessionClientFixture({
                        overrides: { sessionId: 'session-1' },
                    });
                    const permissionHandler = createProviderEnforcedPermissionHandler({
                        session,
                        logPrefix: '[Session MCP integration]',
                    });
                    vi.spyOn(permissionHandler, 'handleToolCall')
                        .mockImplementation(permissionHandlerOverride.handleToolCall);
                    const hostRuntimeParams = {
                        directory: pluginRoot,
                        metadata: createTestMetadata({ path: pluginRoot }),
                        machineId: 'machine-1',
                        session,
                        transcriptSession: session,
                        messageBuffer: new MessageBuffer(),
                        accountSettings: accountSettingsParse({
                            mcpServersSettingsV1: {
                                v: 1,
                                strictMode: false,
                                servers: [{
                                    id: 'pi.docs',
                                    name: 'discovered-docs',
                                    transport: 'http',
                                    remote: { url: 'https://mcp.example.test/discovered', headers: {} },
                                    env: {},
                                    createdAt: 1,
                                    updatedAt: 1,
                                }],
                                bindings: [{
                                    id: 'pi.docs-binding',
                                    serverId: 'pi.docs',
                                    enabled: true,
                                    target: { t: 'allMachines' },
                                    createdAt: 1,
                                    updatedAt: 1,
                                }],
                            },
                        }),
                        permissionHandler,
                        mcpServers: {},
                        getPermissionMode: () => 'default' as const,
                        setThinking: () => undefined,
                        memoryRecallGuidanceEnabled: false,
                    } satisfies HostSessionRuntimeFactoryParams;
                    return createNativeAgentSessionHostServiceOwners({
                        runtimeRegistry,
                        identity: {
                            pluginId: 'acme.mcp.session',
                            pluginVersion: '1.0.0',
                            agentId: 'session-agent',
                            generation: String(runtimeRegistry.generation),
                            isCurrent: () => true,
                        },
                        backend: backendContribution,
                        agent: agentContribution,
                        hostRuntimeParams,
                        sessionId: 'session-1',
                        directory: pluginRoot,
                        signal: new AbortController().signal,
                    });
                };
                const hostOwners = createHostOwners({ handleToolCall });
                const projected = await hostOwners.mcp.resolveForSession({
                    sessionId: 'session-1',
                    directory: pluginRoot,
                });
                expect(projected).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        id: 'acme.mcp.session/session-tools',
                        transport: {
                            kind: 'http',
                            url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
                        },
                        scope: { sessionId: 'session-1', directory: pluginRoot },
                    }),
                    expect.objectContaining({
                        id: 'pi.docs',
                        name: 'discovered-docs',
                        transport: {
                            kind: 'http',
                            url: 'https://mcp.example.test/discovered',
                        },
                        scope: { sessionId: 'session-1', directory: pluginRoot },
                    }),
                ]));
                expect(projected).toHaveLength(2);
                const projectedDynamic = projected?.find((server) => (
                    server.id === 'acme.mcp.session/session-tools'
                ));
                const projectedUrl = projectedDynamic?.transport.kind === 'http'
                    ? projectedDynamic.transport.url
                    : null;
                if (!projectedUrl) throw new Error('Expected hosted MCP session projection');
                projectedUrlAfterRegistryDispose = projectedUrl;
                const projectedClient = new Client(
                    { name: 'happier-mcp-session-integration', version: '1.0.0' },
                    { capabilities: {} },
                );
                await projectedClient.connect(new StreamableHTTPClientTransport(new URL(projectedUrl)));
                const projectedTools = await projectedClient.listTools();
                expect(projectedTools.tools).toEqual([
                    expect.objectContaining({
                        name: expect.stringMatching(/^happier\.proxy_[a-f0-9]{24}$/),
                    }),
                ]);
                await expect(projectedClient.callTool({
                    name: projectedTools.tools[0]!.name,
                    arguments: {},
                })).resolves.toEqual({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ confirmed: true }),
                    }],
                });
                expect(handleToolCall).toHaveBeenCalledTimes(2);
                await projectedClient.close();
                await hostOwners.dispose();
                await expect(fetch(projectedUrl, {
                    signal: AbortSignal.timeout(1_000),
                })).rejects.toBeInstanceOf(Error);

                const reboundHandleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
                const reboundHostOwners = createHostOwners({
                    handleToolCall: reboundHandleToolCall,
                });
                const reboundProjected = await reboundHostOwners.mcp.resolveForSession({
                    sessionId: 'session-1',
                    directory: pluginRoot,
                });
                const reboundDynamic = reboundProjected.find((server) => (
                    server.id === 'acme.mcp.session/session-tools'
                ));
                const reboundProjectedUrl = reboundDynamic?.transport.kind === 'http'
                    ? reboundDynamic.transport.url
                    : null;
                if (!reboundProjectedUrl) throw new Error('Expected rebound hosted MCP session projection');
                expect(reboundProjectedUrl).not.toBe(projectedUrl);
                const reboundProjectedClient = new Client(
                    { name: 'happier-mcp-session-rebound-integration', version: '1.0.0' },
                    { capabilities: {} },
                );
                await reboundProjectedClient.connect(new StreamableHTTPClientTransport(new URL(reboundProjectedUrl)));
                const reboundTools = await reboundProjectedClient.listTools();
                await expect(reboundProjectedClient.callTool({
                    name: reboundTools.tools[0]!.name,
                    arguments: {},
                })).resolves.toEqual({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ confirmed: true }),
                    }],
                });
                expect(reboundHandleToolCall).toHaveBeenCalledOnce();
                expect(handleToolCall).toHaveBeenCalledTimes(2);
                await reboundProjectedClient.close();

                const committedBeforeRevocation = await readPluginRegistryCommitRecord(paths);
                if (!committedBeforeRevocation) throw new Error('Expected current MCP fixture commit before revocation');
                const remainingPluginGenerations = { ...committedBeforeRevocation.pluginGenerations };
                delete remainingPluginGenerations['acme.mcp.session'];
                await replacePluginRegistryCommitRecord({
                    paths,
                    expectedRevision: committedBeforeRevocation.revision,
                    next: {
                        ...committedBeforeRevocation,
                        revision: committedBeforeRevocation.revision + 1,
                        transactionId: 'mcp-session-runtime-revocation',
                        baseRevision: committedBeforeRevocation.revision,
                        pluginGenerations: remainingPluginGenerations,
                        createdAtMs: 2,
                    },
                });

                await expect(client.callTool('confirm', {})).rejects.toMatchObject({
                    code: 'plugin_final_generation_retired',
                });
                expect(handleToolCall).toHaveBeenCalledTimes(2);
                await client.dispose();
                await reboundHostOwners.dispose();
            } finally {
                await runtimeRegistry.dispose();
            }
            if (!projectedUrlAfterRegistryDispose) throw new Error('Expected hosted MCP cleanup endpoint');
            await expect(fetch(projectedUrlAfterRegistryDispose, {
                signal: AbortSignal.timeout(1_000),
            })).rejects.toBeInstanceOf(Error);
            expect(cleanupWarning.mock.calls.some(([message]) => (
                message === '[PLUGIN RUNTIME] Plugin cleanup step failed during disposal'
            ))).toBe(false);
        } finally {
            cleanupWarning.mockRestore();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('binds all five selected resource kinds through real prompt, structured-message, and external-action consumers', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-resource-runtime-home-'));
        const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-resource-runtime-source-'));
        const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
        const manifest = {
            schemaVersion: 2,
            id: 'acme.resource.action',
            version: '1.0.0',
            displayName: 'Resource action',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                actions: [{
                    id: 'read-prompt', title: 'Read prompt', scopes: ['global'], surfaces: ['cli'],
                    placement: 'primary', dangerLevel: 'safe',
                }],
                resources: [
                    { id: 'shared', kind: 'prompt', path: './resources/shared.txt', contentType: 'text/plain' },
                    { id: 'review-skill', kind: 'skill', path: './resources/review-skill.md', contentType: 'text/markdown' },
                    { id: 'report-template', kind: 'template', path: './resources/report-template.md', contentType: 'text/markdown' },
                    { id: 'preview-icon', kind: 'asset', path: './resources/preview-icon.svg', contentType: 'image/svg+xml' },
                    { id: 'defaults', kind: 'config', path: './resources/defaults.json', contentType: 'application/json' },
                ],
                ui: {
                    renderers: [{
                        id: 'resource-card',
                        kind: 'declarative',
                        root: { kind: 'status', label: 'Resource', value: 'Available' },
                    }],
                },
                structuredMessages: [{
                    id: 'resource-result',
                    title: 'Resource result',
                    kind: 'acme.resource-result.v1',
                    payloadSchema: {
                        type: 'object',
                        required: ['status'],
                        properties: { status: { type: 'string' } },
                        additionalProperties: false,
                    },
                    renderer: 'resource-card',
                    actions: ['read-prompt'],
                    fallback: { kind: 'summary', template: 'Resource unavailable' },
                }],
                agents: [{
                    id: 'novel-reviewer', title: 'Novel reviewer', runtime: { kind: 'custom' }, primary: 'sessions',
                    capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                }],
                promptAssets: [{
                    id: 'committed-instructions', kind: 'systemPrompt', resource: 'shared',
                    target: { kind: 'agent', agent: 'novel-reviewer' }, priority: 4,
                }],
            },
        };
        const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        const daemonBytes = Buffer.from(`export function activate(api) {
            api.agents.register('novel-reviewer', () => ({
                sessions: {
                    async open(request) {
                        return {
                            async send() { return { status: 'admitted' }; },
                            watch() { return { dispose() {} }; },
                            async dispose() {},
                            sessionId: request.sessionId
                        };
                    }
                }
            }));
            api.actions.register('read-prompt', async (_input, context) => {
                const ids = ['shared', 'review-skill', 'report-template', 'preview-icon', 'defaults'];
                const resources = await Promise.all(ids.map(async (id) => {
                    const result = await context.services.resources.read(id);
                    return {
                        id,
                        kind: result.kind,
                        text: new TextDecoder().decode(result.bytes),
                        digest: result.digest
                    };
                }));
                return {
                    availability: context.services.availability('resources').status,
                    resources
                };
            });
        }`, 'utf8');
        const promptBytes = Buffer.from('committed prompt bytes', 'utf8');
        const resourceBytesByPath = {
            'resources/defaults.json': Buffer.from('{"tone":"concise"}', 'utf8'),
            'resources/preview-icon.svg': Buffer.from('<svg/>', 'utf8'),
            'resources/report-template.md': Buffer.from('# Report template', 'utf8'),
            'resources/review-skill.md': Buffer.from('# Review skill', 'utf8'),
            'resources/shared.txt': promptBytes,
        } as const;
        await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
        await mkdir(join(sourceRoot, 'resources'), { recursive: true });
        await writeFile(join(sourceRoot, '.happier-plugin', 'plugin.json'), manifestBytes);
        await writeFile(join(sourceRoot, 'daemon.mjs'), daemonBytes);
        await Promise.all(Object.entries(resourceBytesByPath).map(([relativePath, bytes]) => (
            writeFile(join(sourceRoot, relativePath), bytes)
        )));

        const paths = resolvePluginStorePaths({ happyHomeDir });
        const immutableGenerationId = 'acme-resource-generation-1';
        const generationRecord = {
            t: 'happier_plugin_generation_v1' as const, schemaVersion: 1 as const,
            pluginId: 'acme.resource.action', immutableGenerationId,
            fingerprint: digest('fingerprint'), packageDigest: `sha256:${'0'.repeat(64)}`,
            manifestDigest: digest(manifestBytes), runtimeDigest: digest(daemonBytes),
            installedUiArtifactDigest: digest('no-ui'), createdAtMs: 1,
            files: [
                { relativePath: '.happier-plugin/plugin.json', byteLength: manifestBytes.byteLength, digest: digest(manifestBytes) },
                { relativePath: 'daemon.mjs', byteLength: daemonBytes.byteLength, digest: digest(daemonBytes) },
                ...Object.entries(resourceBytesByPath).map(([relativePath, bytes]) => ({
                    relativePath,
                    byteLength: bytes.byteLength,
                    digest: digest(bytes),
                })),
            ],
            installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest(daemonBytes) },
        };
        const store = createPluginStateStore({ happyHomeDir });
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.resource.action': {
                    source: {
                        kind: 'path', locator: sourceRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: sourceRoot,
                        manifestPath: join(sourceRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: await createTrustedLocalLinkInstall({
                        pluginId: 'acme.resource.action',
                        sourceRootPath: sourceRoot,
                        manifestVersion: '1.0.0',
                        manifestDigest: digest(manifestBytes),
                    }),
                    state: { enabled: true },
                },
            },
        });
        // Bootstrap the canonical installation revision before preparing bytes.
        // Otherwise startup cleanup correctly removes an as-yet unreferenced
        // immutable generation while the fixture is still assembling it.
        const prepared = await prepareImmutablePluginGeneration({
            paths,
            sourceRootPath: sourceRoot,
            record: generationRecord,
        });
        const immutableRoot = prepared.rootPath;
        const seededCommit = await readPluginRegistryCommitRecord(paths);
        if (!seededCommit) throw new Error('Expected canonical resource-action fixture commit');
        await replacePluginRegistryCommitRecord({
            paths,
            expectedRevision: seededCommit.revision,
            next: {
                ...seededCommit,
                revision: seededCommit.revision + 1,
                transactionId: 'resource-runtime-commit',
                baseRevision: seededCommit.revision,
                pluginGenerations: { 'acme.resource.action': prepared.reference },
                createdAtMs: 1,
                creator: { pid: 42, instanceId: 'daemon-a' },
            },
        });

        const generationBRoot = await mkdtemp(join(tmpdir(), 'happier-resource-runtime-generation-b-'));
        const generationBManifest = { ...manifest, version: '2.0.0', displayName: 'Resource action B' };
        const generationBManifestBytes = Buffer.from(JSON.stringify(generationBManifest), 'utf8');
        await mkdir(join(generationBRoot, '.happier-plugin'), { recursive: true });
        await mkdir(join(generationBRoot, 'resources'), { recursive: true });
        await writeFile(join(generationBRoot, '.happier-plugin', 'plugin.json'), generationBManifestBytes);
        await writeFile(join(generationBRoot, 'daemon.mjs'), daemonBytes);
        await Promise.all(Object.entries(resourceBytesByPath).map(([relativePath, bytes]) => (
            writeFile(join(generationBRoot, relativePath), relativePath === 'resources/shared.txt' ? 'generation B bytes' : bytes)
        )));
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.resource.action': {
                    source: {
                        kind: 'path', locator: generationBRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: generationBRoot,
                        manifestPath: join(generationBRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: await createTrustedLocalLinkInstall({
                        pluginId: 'acme.resource.action',
                        sourceRootPath: generationBRoot,
                        manifestVersion: '2.0.0',
                        manifestDigest: digest(generationBManifestBytes),
                    }),
                    state: { enabled: true },
                },
            },
        });
        const generationBContributes = await resolveMergedContributionRegistry({ happyHomeDir });
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.resource.action': {
                    source: {
                        kind: 'path', locator: immutableRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: immutableRoot,
                        manifestPath: join(immutableRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: await createTrustedLocalLinkInstall({
                        pluginId: 'acme.resource.action',
                        sourceRootPath: immutableRoot,
                        manifestVersion: '1.0.0',
                        manifestDigest: digest(manifestBytes),
                    }),
                    state: { enabled: true },
                },
            },
        });
        const resourceCommit = await readPluginRegistryCommitRecord(paths);
        if (!resourceCommit) throw new Error('Expected current resource-action fixture commit');
        const resourceInstallationState = await readInstallationStateRevision({
            paths,
            reference: resourceCommit.installationState,
        });
        const installationState = await persistInstallationStateRevision({
            paths,
            state: {
                ...resourceInstallationState,
                revisionId: 'resource-runtime-state',
                createdAtMs: generationRecord.createdAtMs,
                health: {
                    ...resourceInstallationState.health,
                    [immutableGenerationId]: createPendingGenerationHealthRecord({
                        pluginId: 'acme.resource.action',
                        immutableGenerationId,
                        fingerprint: generationRecord.fingerprint,
                    }),
                },
            },
        });
        await replacePluginRegistryCommitRecord({
            paths,
            expectedRevision: resourceCommit.revision,
            next: {
                ...resourceCommit,
                revision: resourceCommit.revision + 1,
                transactionId: 'resource-runtime-health-commit',
                baseRevision: resourceCommit.revision,
                installationState,
                createdAtMs: generationRecord.createdAtMs,
            },
        });
        const canonicalContributes = await resolveMergedContributionRegistry({ happyHomeDir });
        const scopedContributes = {
            ...canonicalContributes,
            resources: canonicalContributes.resources.filter((entry) => entry.pluginId !== 'acme.resource.action'),
            promptAssets: canonicalContributes.promptAssets?.filter((entry) => entry.pluginId !== 'acme.resource.action'),
            activationTargets: canonicalContributes.activationTargets.filter((entry) => entry.pluginId !== 'acme.resource.action'),
        };
        const scopedRuntime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: scopedContributes,
            pluginIds: [],
        });
        await scopedRuntime.dispose();

        let mismatchedRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
        let mismatchError: unknown;
        try {
            mismatchedRuntime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: generationBContributes,
            });
        } catch (error) {
            mismatchError = error;
        } finally {
            await mismatchedRuntime?.dispose();
        }
        expect(mismatchError).toEqual(expect.objectContaining({
            message: expect.stringMatching(/committed.*(activation|runtime).*identity/i),
        }));

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        try {
            expect(runtimeRegistry.pluginFinalPolicyCurrentGenerationsById?.get('acme.resource.action'))
                .toMatchObject({
                    immutableGenerationId: generationRecord.immutableGenerationId,
                    manifestDigest: digest(manifestBytes),
                    packageDigest: generationRecord.packageDigest,
                    applied: false,
                });
            const contributionLifecycle =
                runtimeRegistry.resolveContributionRuntimeLifecycle?.({
                    pluginId: 'acme.resource.action',
                    manifestDigest: digest(manifestBytes),
                });
            expect(contributionLifecycle).toMatchObject({
                generation: immutableGenerationId,
            });
            expect(contributionLifecycle?.isCurrent()).toBe(true);
            expect(contributionLifecycle?.retirementSignal.aborted).toBe(false);
            await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'acme.resource.action',
                family: 'agents',
                localId: 'novel-reviewer',
            }]);
            expect(runtimeRegistry.pluginFinalPolicyCurrentGenerationsById?.get('acme.resource.action'))
                .toMatchObject({
                    immutableGenerationId: generationRecord.immutableGenerationId,
                    manifestDigest: digest(manifestBytes),
                    packageDigest: generationRecord.packageDigest,
                    applied: true,
                });
            expect(runtimeRegistry.agentRuntimesByAgentId.get('novel-reviewer')).toMatchObject({
                generation: String(runtimeRegistry.generation),
                immutableGenerationId,
            });
            const resolveStructuredMessage = runtimeRegistry.resolveStructuredMessage;
            if (!resolveStructuredMessage) throw new Error('Expected structured-message consumer');
            const structured = await resolveStructuredMessage({
                expectedGeneration: String(runtimeRegistry.generation),
                kind: 'acme.resource-result.v1',
                payload: { status: 'ready' },
                resourceRefs: ['shared', 'review-skill', 'report-template', 'preview-icon', 'defaults'],
                facts: { 'plugin.enabled': true, 'session.exists': true },
            });
            expect(structured.model).toMatchObject({
                renderer: { qualifiedId: 'acme.resource.action/resource-card' },
                actions: [{ qualifiedId: 'acme.resource.action/read-prompt', enabled: true }],
                resources: [
                    { qualifiedId: 'acme.resource.action/shared' },
                    { qualifiedId: 'acme.resource.action/review-skill' },
                    { qualifiedId: 'acme.resource.action/report-template' },
                    { qualifiedId: 'acme.resource.action/preview-icon' },
                    { qualifiedId: 'acme.resource.action/defaults' },
                ],
                visible: true,
            });
            expect(structured.resources.map((resource) => ({
                kind: resource.kind,
                text: new TextDecoder().decode(resource.bytes),
            }))).toEqual([
                { kind: 'prompt', text: 'committed prompt bytes' },
                { kind: 'skill', text: '# Review skill' },
                { kind: 'template', text: '# Report template' },
                { kind: 'asset', text: '<svg/>' },
                { kind: 'config', text: '{"tone":"concise"}' },
            ]);
            await expect(resolveStructuredMessage({
                expectedGeneration: String(runtimeRegistry.generation),
                kind: 'acme.resource-result.v1',
                payload: { status: 42 },
                facts: { 'plugin.enabled': true, 'session.exists': true },
            })).rejects.toMatchObject({ code: 'plugin_structured_message_payload_invalid' });
            const promptAssetBlocks = await runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'novel-reviewer' });
            const machineKey = new Uint8Array(32).fill(9);
            const promptPlan = await resolveEffectiveCodingPromptPlan({
                credentials: {
                    token: 'token',
                    encryption: { type: 'dataKey', machineKey, publicKey: deriveBoxPublicKeyFromSeed(machineKey) },
                },
                settings: {}, profileId: null, baseOverride: 'Base prompt', memoryRecallGuidanceEnabled: false,
                agentId: 'novel-reviewer', promptAssetBlocks,
            });
            expect(promptAssetBlocks).toEqual([{
                id: 'plugin_prompt_asset.acme.resource.action/committed-instructions',
                scope: 'session',
                text: 'committed prompt bytes',
            }]);
            expect(promptPlan.plan.blocks.filter((block) => block.id === promptAssetBlocks[0]?.id)).toEqual(promptAssetBlocks);
            await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'acme.resource.action', family: 'actions', localId: 'read-prompt',
            }]);
            expect(runtimeRegistry.targetActionInvocations?.evaluateCatalogPolicy(
                'acme.resource.action',
                'read-prompt',
            )).toMatchObject({ outcome: 'visible', code: 'plugin_action_available' });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.resource.action', localId: 'read-prompt', input: {}, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    availability: 'available',
                    resources: [
                        { id: 'shared', kind: 'prompt', text: 'committed prompt bytes', digest: digest(promptBytes) },
                        { id: 'review-skill', kind: 'skill', text: '# Review skill', digest: digest(resourceBytesByPath['resources/review-skill.md']) },
                        { id: 'report-template', kind: 'template', text: '# Report template', digest: digest(resourceBytesByPath['resources/report-template.md']) },
                        { id: 'preview-icon', kind: 'asset', text: '<svg/>', digest: digest(resourceBytesByPath['resources/preview-icon.svg']) },
                        { id: 'defaults', kind: 'config', text: '{"tone":"concise"}', digest: digest(resourceBytesByPath['resources/defaults.json']) },
                    ],
                },
            });
            await writeFile(
                join(immutableRoot, 'resources', 'shared.txt'),
                Buffer.alloc(promptBytes.byteLength, 'x'),
            );
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.resource.action', localId: 'read-prompt', input: {}, surface: 'cli',
            })).resolves.toMatchObject({
                status: 'failed',
                code: 'plugin_generation_stale',
            });
            await writeFile(join(immutableRoot, 'resources', 'shared.txt'), promptBytes);
            const currentCommit = await readPluginRegistryCommitRecord(paths);
            if (!currentCommit) throw new Error('Expected current resource-action commit');
            await replacePluginRegistryCommitRecord({
                paths,
                expectedRevision: currentCommit.revision,
                next: {
                    ...currentCommit,
                    revision: currentCommit.revision + 1,
                    transactionId: 'resource-runtime-replacement',
                    baseRevision: currentCommit.revision,
                    createdAtMs: 2,
                    creator: { pid: 42, instanceId: 'daemon-a' },
                    pluginGenerations: {},
                },
            });
            await expect(runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'novel-reviewer' }))
                .rejects.toMatchObject({ code: 'plugin_generation_stale' });
            await expect(resolveStructuredMessage({
                expectedGeneration: String(runtimeRegistry.generation),
                kind: 'acme.resource-result.v1',
                payload: { status: 'ready' },
                resourceRefs: ['shared'],
                facts: { 'plugin.enabled': true, 'session.exists': true },
            })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.resource.action', localId: 'read-prompt', input: {}, surface: 'cli',
            })).resolves.toEqual({
                status: 'failed',
                code: 'plugin_generation_stale',
                message: 'Plugin generation is stale',
            });
            runtimeRegistry.retirePluginConsumers?.(['acme.resource.action']);
            expect(contributionLifecycle?.isCurrent()).toBe(false);
            expect(contributionLifecycle?.retirementSignal.aborted).toBe(true);
        } finally {
            await runtimeRegistry.dispose();
        }
    });

    it('demands and re-reads a novel qualified connected-account runtime through the host registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-account-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-connected-account-plugin-'));
        const fetchMock = vi.fn(async (
            _input: string | URL | Request,
        ) => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
            schemaVersion: 2,
            id: 'acme.novel.accounts',
            version: '1.0.0',
            displayName: 'Novel accounts',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'provider-api',
                    capability: 'network',
                    reason: 'Call the configured provider API',
                    scope: {
                        targets: [{
                            kind: 'connectedAccountOrigin',
                            service: 'same-local-id',
                        }],
                        methods: ['POST'],
                    },
                }],
                optional: [],
            },
            contributes: {
                connectedAccountDescriptors: [{
                    id: 'same-local-id',
                    title: 'Novel account',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{
                            id: 'manual',
                            kind: 'manual',
                            outcomeReconciliation: 'none',
                            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                            configuration: {
                                scope: 'service',
                                changeBehavior: 'refresh',
                                fields: [{
                                    id: 'api-origin',
                                    title: 'API origin',
                                    schema: { type: 'string', minLength: 1 },
                                    required: true,
                                    semantic: 'connectedAccountOrigin',
                                }],
                            },
                        }],
                    },
                }],
            },
        }), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
            api.connectedAccounts.register('same-local-id', {
                authentication: { modes: { manual: { kind: 'manual', async complete(_input, context) {
                    const origin = context.configuration.values['api-origin'];
                    const response = await context.services.fetch.request({
                        url: origin + '/session',
                        method: 'POST',
                        redirect: 'error'
                    });
                    if (response.status !== 200) return { status: 'unavailable', diagnostic: { code: 'fixture_http', severity: 'error' } };
                    return { status: 'connected', accountId: 'novel-1', displayName: 'Novel account', scopes: [] };
                } } } },
                async refresh() { return { status: 'unavailable' }; },
                async revoke() { return { status: 'remoteUnsupported' }; },
                async status() { return { status: 'connected', displayName: 'Novel account' }; },
                async materialize() { return { kind: 'environment', env: {} }; }
            });
        }`, 'utf8');
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.novel.accounts',
            sourceRootPath: pluginRoot,
            plugin: {
                source: {
                    kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                    resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                },
                compatibility: { status: 'unknown', diagnostics: [] },
                install: await createTrustedLocalLinkInstall({
                    pluginId: 'acme.novel.accounts',
                    sourceRootPath: pluginRoot,
                    manifestVersion: '1.0.0',
                    manifestDigest: null,
                }),
                state: { enabled: true },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        try {
            expect(runtimeRegistry.activatedPluginIds.has('acme.novel.accounts')).toBe(false);
            const lease = await runtimeRegistry.resolveConnectedAccountRuntime!({
                pluginId: 'acme.novel.accounts', localId: 'same-local-id',
            });
            expect(runtimeRegistry.activatedPluginIds.has('acme.novel.accounts')).toBe(true);
            expect(lease).toMatchObject({
                ref: { pluginId: 'acme.novel.accounts', localId: 'same-local-id' },
                descriptor: {
                    id: 'same-local-id',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{ id: 'manual', kind: 'manual' }],
                    },
                },
            });
            expect(await lease.runtime.status({} as never)).toMatchObject({ displayName: 'Novel account' });
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                target: Object.freeze({
                    kind: 'service',
                    service: lease.ref,
                    modeId: 'manual',
                }),
                revision: 'configuration-1',
                values: Object.freeze({
                    'api-origin': 'https://tenant.example.test',
                }),
                getSecret: async () => null,
            });
            const attemptCredentials = Object.freeze({
                get: async () => null,
                set: async () => undefined,
                delete: async () => undefined,
            });
            const invoke = async (
                isConfigurationCurrent: (
                    snapshot: PluginConnectedAccountRuntimeConfiguration,
                ) => boolean | Promise<boolean>,
            ) => await runtimeRegistry.connectedAccountRuntimeInvoker?.invokeAuthentication({
                admission: Object.freeze({
                    service: lease.ref,
                    descriptor: lease.descriptor.authentication.modes[0]!,
                    modeId: 'manual',
                    generation: lease.generation,
                    immutableGenerationId: lease.immutableGenerationId,
                }),
                operation: Object.freeze({
                    kind: 'submitManual',
                    fields: Object.freeze({ token: 'novel-token' }),
                }),
                context: Object.freeze({
                    service: lease.ref,
                    attempt: Object.freeze({
                        kind: 'connect',
                        attemptId: 'novel-attempt-1',
                    }),
                    configuration,
                    attemptCredentials,
                }),
                isConfigurationCurrent,
                signal: new AbortController().signal,
            });
            await expect(invoke(() => true)).resolves.toMatchObject({
                status: 'connected',
                accountId: 'novel-1',
            });
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(fetchMock.mock.calls[0]?.[0]).toBe(
                'https://tenant.example.test/session',
            );

            let currentnessChecks = 0;
            let releaseFinalCheck!: () => void;
            const finalCheckReleased = new Promise<void>((resolve) => {
                releaseFinalCheck = resolve;
            });
            let notifyFinalCheck!: () => void;
            const finalCheckStarted = new Promise<void>((resolve) => {
                notifyFinalCheck = resolve;
            });
            let configurationCurrent = true;
            const staleInvocation = invoke(async () => {
                currentnessChecks += 1;
                if (currentnessChecks === 2) {
                    notifyFinalCheck();
                    await finalCheckReleased;
                }
                return configurationCurrent;
            });
            await finalCheckStarted;
            configurationCurrent = false;
            releaseFinalCheck();
            await expect(staleInvocation).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            expect(fetchMock).toHaveBeenCalledOnce();
            const introspection = adaptTargetActivationFacts({
                generation: runtimeRegistry.generation!,
                candidates: runtimeRegistry.contributes.introspectionContributions ?? [],
                plugins: runtimeRegistry.contributes.activationTargets.map((target) => ({
                    pluginId: target.pluginId,
                    pluginVersion: target.manifest.version,
                    source: mapPluginSourceToDiagnosticSource(target.sourceSpec),
                })),
                targetActivationFacts: runtimeRegistry.targetActivationFacts ?? [],
                runtimeState: 'current',
            });
            expect(introspection.runtimeFactsByQualifiedId.get(
                'acme.novel.accounts/connectedAccountDescriptors/same-local-id',
            )).toMatchObject({
                registration: { requirement: 'required', state: 'bound' },
                activation: { state: 'active' },
            });
        } finally {
            await runtimeRegistry.dispose();
            vi.unstubAllGlobals();
        }
    });

    it('demands and re-reads an exact current cross-plugin notification channel from a stable action service', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const actionRoot = await mkdtemp(join(tmpdir(), 'happier-notification-action-'));
        const channelRoot = await mkdtemp(join(tmpdir(), 'happier-notification-channel-'));
        const invocationLogRecords: Readonly<Record<string, unknown>>[] = [];
        const endpointSettingId = notificationChannelSettingFieldId('external', 'endpoint');
        const tokenSecretId = notificationChannelSettingFieldId('external', 'webhook-token');
        const optionalTokenSecretId = notificationChannelSettingFieldId('external', 'optional-webhook-token');
        const staleOptionalSecretSelection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: 'acme.notification.channel',
            accessId: 'optional-webhook-credential',
            capability: 'secrets',
            scope: {
                secretIds: [optionalTokenSecretId, tokenSecretId],
                access: ['read'],
            },
            selectedAtMs: 1,
        });
        const materialize = async (root: string, manifest: object, daemonSource: string) => {
            const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
            const daemonBytes = Buffer.from(daemonSource, 'utf8');
            await mkdir(join(root, '.happier-plugin'), { recursive: true });
            await writeFile(join(root, '.happier-plugin', 'plugin.json'), manifestBytes);
            await writeFile(join(root, 'daemon.mjs'), daemonBytes);
            return Object.freeze({ manifestBytes, daemonBytes });
        };
        const actionArtifact = await materialize(actionRoot, {
            schemaVersion: 2,
            id: 'acme.notification.action',
            version: '1.0.0',
            displayName: 'Notification action',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                actions: [{
                    id: 'send', title: 'Send', scopes: ['global'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe',
                }],
                events: [{ id: 'review-ready-event', kind: 'event', title: 'Review ready' }],
                notifications: [{
                    id: 'review-ready', kind: 'activity', title: 'Review ready', eventIds: ['review-ready-event'],
                    defaultChannels: [{ pluginId: 'acme.notification.channel', localId: 'external' }],
                }],
            },
        }, `export function activate(api) {
            api.actions.register('send', async (input, context) => {
                if (input.operation === 'preferences') {
                    return context.services.notifications.preferences('review-ready');
                }
                return context.services.notifications.send({
                    clientRequestId: input.clientRequestId,
                    categoryId: 'review-ready',
                    title: 'Review ready',
                    data: { credential: input.credential }
                });
            });
        }`);
        const channelArtifact = await materialize(channelRoot, {
            schemaVersion: 2,
            id: 'acme.notification.channel',
            version: '1.0.0',
            displayName: 'Notification channel',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'webhook-credential', capability: 'secrets', reason: 'Authenticate webhook delivery',
                    scope: { secretIds: [tokenSecretId], access: ['read'] },
                }],
                optional: [{
                    id: 'optional-webhook-credential', capability: 'secrets', reason: 'Use an optional webhook credential',
                    scope: { secretIds: [optionalTokenSecretId], access: ['read'] },
                }],
            },
            contributes: {
                notificationChannels: [{
                    id: 'external', kind: 'webhook', title: 'External', configurable: true, defaultEnabled: true,
                    settings: [{
                        id: 'endpoint',
                        title: 'Endpoint',
                        schema: { type: 'string', minLength: 1 },
                        default: 'https://default.invalid/webhook',
                    }, {
                        id: 'webhook-token',
                        title: 'Webhook token',
                        schema: { type: 'string', minLength: 1 },
                        secret: true,
                    }],
                }],
            },
        }, `export function activate(api) {
            api.notifications.registerChannel('external', async (request, context) => {
                try {
                    const endpoint = await context.services.settings.get(${JSON.stringify(endpointSettingId)});
                    const secretId = request.data?.credential === 'optional'
                        ? ${JSON.stringify(optionalTokenSecretId)}
                        : ${JSON.stringify(tokenSecretId)};
                    const token = await context.services.secrets.get(secretId, { reason: 'Authenticate webhook delivery' });
                    context.services.logger.info('notification credential ' + token);
                    if (endpoint !== 'https://default.invalid/webhook') {
                        return {
                            deliveryId: request.deliveryId,
                            channelId: request.channelId,
                            status: 'failed',
                            code: 'endpoint_invalid',
                            retryable: false
                        };
                    }
                    return token === 'configured-webhook-token'
                        ? { deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted', evidence: 'provider' }
                        : { deliveryId: request.deliveryId, channelId: request.channelId, status: 'failed', code: 'credential_invalid' };
                } catch (error) {
                    return {
                        deliveryId: request.deliveryId,
                        channelId: request.channelId,
                        status: 'failed',
                        code: typeof error?.code === 'string' ? error.code : 'credential_unavailable'
                    };
                }
            });
        }`);
        const store = createPluginStateStore({ happyHomeDir });
        const localPlugin = async (
            pluginId: string,
            root: string,
            manifestDigest: `sha256:${string}` | null = null,
        ) => ({
            source: {
                kind: 'path' as const,
                locator: root,
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
                resolvedPath: root,
                manifestPath: join(root, '.happier-plugin', 'plugin.json'),
            },
            compatibility: { status: 'unknown' as const, diagnostics: [] },
            install: {
                ...await createTrustedLocalLinkInstall({
                    pluginId,
                    sourceRootPath: root,
                    manifestVersion: '1.0.0',
                    manifestDigest,
                }),
                ...(pluginId === 'acme.notification.channel'
                    ? { optionalAccess: [staleOptionalSecretSelection] }
                    : {}),
            },
            state: { enabled: true },
        });
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.notification.action': await localPlugin('acme.notification.action', actionRoot),
                'acme.notification.channel': await localPlugin('acme.notification.channel', channelRoot),
            },
        });
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
        const preparePluginGeneration = async (params: Readonly<{
            pluginId: string;
            immutableGenerationId: string;
            root: string;
            artifact: Readonly<{ manifestBytes: Buffer; daemonBytes: Buffer }>;
        }>) => await prepareImmutablePluginGeneration({
            paths,
            sourceRootPath: params.root,
            record: {
                t: 'happier_plugin_generation_v1', schemaVersion: 1,
                pluginId: params.pluginId,
                immutableGenerationId: params.immutableGenerationId,
                fingerprint: digest(`${params.pluginId}:fingerprint`),
                packageDigest: `sha256:${'0'.repeat(64)}` as const,
                manifestDigest: digest(params.artifact.manifestBytes),
                runtimeDigest: digest(params.artifact.daemonBytes),
                installedUiArtifactDigest: digest(`${params.pluginId}:no-ui`),
                createdAtMs: 1,
                files: [
                    {
                        relativePath: '.happier-plugin/plugin.json',
                        byteLength: params.artifact.manifestBytes.byteLength,
                        digest: digest(params.artifact.manifestBytes),
                    },
                    {
                        relativePath: 'daemon.mjs',
                        byteLength: params.artifact.daemonBytes.byteLength,
                        digest: digest(params.artifact.daemonBytes),
                    },
                ],
                installedArtifactRecord: {
                    relativePath: 'daemon.mjs',
                    digest: digest(params.artifact.daemonBytes),
                },
            },
        });
        const [preparedAction, preparedChannel] = await Promise.all([
            preparePluginGeneration({
                pluginId: 'acme.notification.action',
                immutableGenerationId: 'notification-action-generation-1',
                root: actionRoot,
                artifact: actionArtifact,
            }),
            preparePluginGeneration({
                pluginId: 'acme.notification.channel',
                immutableGenerationId: 'notification-channel-generation-1',
                root: channelRoot,
                artifact: channelArtifact,
            }),
        ]);
        const seededCommit = await readPluginRegistryCommitRecord(paths);
        if (!seededCommit) throw new Error('Expected canonical notification fixture commit');
        await replacePluginRegistryCommitRecord({
            paths,
            expectedRevision: seededCommit.revision,
            next: {
                ...seededCommit,
                revision: seededCommit.revision + 1,
                transactionId: 'notification-runtime-commit',
                baseRevision: seededCommit.revision,
                pluginGenerations: {
                    ...seededCommit.pluginGenerations,
                    'acme.notification.action': preparedAction.reference,
                    'acme.notification.channel': preparedChannel.reference,
                },
                createdAtMs: 1,
                creator: { pid: 42, instanceId: 'notification-daemon' },
            },
        });
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.notification.action': await localPlugin(
                    'acme.notification.action',
                    preparedAction.rootPath,
                    digest(actionArtifact.manifestBytes),
                ),
                'acme.notification.channel': await localPlugin(
                    'acme.notification.channel',
                    preparedChannel.rootPath,
                    digest(channelArtifact.manifestBytes),
                ),
            },
        });
        const persistedChannelSecrets = createPluginSecretStore({
            pluginId: 'acme.notification.channel',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        await persistedChannelSecrets.set(tokenSecretId, 'configured-webhook-token');
        await persistedChannelSecrets.set(optionalTokenSecretId, 'configured-webhook-token');
        setActiveAccountSettingsSnapshot({
            source: 'cache',
            settings: accountSettingsParse({
                attentionDeliveryPolicyV1: {
                    channels: {
                        webhook: { enabled: true },
                    },
                },
            }),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'notification-integration',
        });

        const invocationLogSpy = vi.spyOn(logger, 'appendPluginInvocationLogRecord')
            .mockImplementation((record) => { invocationLogRecords.push(record); });
        const localContributes = await resolvePluginContributes({
            happyHomeDir,
            existingAgentIds: new Set(),
        });
        const localGenerationAuthority = await readCurrentCommittedPluginGenerations(paths, {
            bundledArtifacts: [],
        });
        if (!localGenerationAuthority) throw new Error('Expected current local notification generation authority');
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createMergedContributionRegistry(localContributes, {}),
            generationAuthority: localGenerationAuthority,
        });
        try {
            expect(runtimeRegistry.contributes.pluginDiagnosticsByPluginId['acme.notification.action'] ?? []).toEqual([]);
            expect(runtimeRegistry.contributes.activationTargets.map((target) => target.pluginId)).toContain('acme.notification.action');
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.action')).toBe(false);
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.channel')).toBe(false);
            const channelSettings = runtimeRegistry.createPluginSettingsService?.({
                pluginId: 'acme.notification.channel',
            });
            if (!channelSettings) throw new Error('Expected canonical notification channel settings service');
            const channelSettingDescriptors = channelSettings.describe();
            expect(channelSettingDescriptors).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: endpointSettingId }),
                expect.objectContaining({ id: tokenSecretId, secret: true }),
            ]));
            expect(channelSettingDescriptors.find((field) => field.id === endpointSettingId)?.secret).not.toBe(true);
            await expect(channelSettings.get(endpointSettingId)).resolves.toBe('https://default.invalid/webhook');
            await expect(channelSettings.get(tokenSecretId)).rejects.toMatchObject({
                code: 'plugin_settings_secret_materialization_required',
            });
            const activation = await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'acme.notification.action', family: 'actions', localId: 'send',
            }]);
            expect(activation).toEqual([{
                pluginId: 'acme.notification.action',
                diagnostics: [],
            }]);
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.action')).toBe(true);
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.channel')).toBe(false);

            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-configured', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'accepted',
                        evidence: 'provider',
                    })],
                },
            });
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.channel')).toBe(true);
            expect(JSON.stringify(invocationLogRecords)).toContain('[REDACTED]');
            expect(JSON.stringify(invocationLogRecords)).not.toContain('configured-webhook-token');

            await persistedChannelSecrets.set(tokenSecretId, 'invalid-webhook-token');
            const failedRequest = {
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-provider-failed', credential: 'required' }, surface: 'cli' as const,
            };
            await expect(runtimeRegistry.targetActionInvocations?.invoke(failedRequest)).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'failed',
                        code: 'credential_invalid',
                    })],
                },
            });
            await persistedChannelSecrets.set(tokenSecretId, 'configured-webhook-token');
            await expect(runtimeRegistry.targetActionInvocations?.invoke(failedRequest)).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: true,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'failed',
                        code: 'credential_invalid',
                    })],
                },
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-provider-recovered', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'accepted',
                        evidence: 'provider',
                    })],
                },
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({
                    attentionDeliveryPolicyV1: {
                        channels: {
                            webhook: { enabled: false },
                        },
                    },
                }),
                settingsVersion: 2,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'notification-integration',
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { operation: 'preferences' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: expect.objectContaining({
                    categoryId: 'review-ready',
                    enabled: false,
                    channelIds: [],
                }),
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-policy-suppressed', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'suppressed',
                        code: 'plugin_notification_channel_disabled',
                    })],
                },
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({
                    attentionDeliveryPolicyV1: {
                        channels: {
                            webhook: { enabled: true },
                        },
                    },
                }),
                settingsVersion: 3,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'notification-integration',
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({
                    attentionDeliveryPolicyV1: {
                        events: {
                            'acme.notification.action/review-ready-event': { enabled: false },
                        },
                        channels: {
                            webhook: { enabled: true },
                        },
                    },
                }),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'notification-integration',
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-event-policy-suppressed', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'suppressed',
                        code: 'plugin_notification_channel_disabled',
                    })],
                },
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({
                    attentionDeliveryPolicyV1: {
                        channels: {
                            webhook: { enabled: true },
                        },
                    },
                }),
                settingsVersion: 5,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'notification-integration',
            });

            await persistedChannelSecrets.delete(tokenSecretId);
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-missing', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'failed',
                        code: 'plugin_secret_missing',
                    })],
                },
            });

            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-denied', credential: 'optional' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'failed',
                        code: 'plugin_secret_access_denied',
                    })],
                },
            });
        } finally {
            invocationLogSpy.mockRestore();
            resetActiveAccountSettingsSnapshotForTests();
            await runtimeRegistry.dispose();
        }
    });

    it('does not report a dormant SCM registration as missing and refreshes SCM diagnostics after demand', async () => {
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry();
        const gitContribution = (runtimeRegistry.contributes.scmBackends ?? []).find((entry) => (
            entry.pluginId === 'happier.scm.backend.git' && entry.definition.id === 'git'
        ));
        expect(gitContribution).toBeDefined();

        expect(runtimeRegistry.pluginDiagnosticsByPluginId['happier.scm.backend.git'] ?? []).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_scm_backend_missing_activation' }),
            ]),
        );

        await runtimeRegistry.activateContributionsOnDemand([{
            pluginId: 'happier.scm.backend.git',
            family: 'scmBackends',
            localId: 'git',
        }]);

        expect(runtimeRegistry.scmBackendsById?.get('happier.scm.backend.git/git')).toEqual(expect.objectContaining({
            pluginId: 'happier.scm.backend.git',
        }));
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['happier.scm.backend.git'] ?? []).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_scm_backend_missing_activation' }),
            ]),
        );
        await runtimeRegistry.dispose();
    });

    it('loads current Agent and hook registrations from one local-path plugin state entry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        await materializeSamplePluginFixture(pluginRoot);
        await writeFile(join(pluginRoot, 'daemon.mjs'), `
            export function activate(api) {
                api.agents.register('sample-provider', () => ({
                    sessions: {
                        async open(request) {
                            return {
                                sessionId: request.sessionId,
                                async send() { return { status: 'admitted' }; },
                                watch() { return { dispose() {} }; },
                                async dispose() {},
                            };
                        },
                    },
                }));
                api.hooks.register('resolve-prerequisites', async (_payload, context) => {
                    context.services.logger.info('integration hook invoked');
                    await context.services.storage.local.set('hook-service-binding', 'integration-bound');
                    return await context.services.storage.local.get('hook-service-binding');
                });
            }
        `, 'utf8');
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.sample',
            sourceRootPath: pluginRoot,
            plugin: {
                source: {
                    kind: 'path',
                    locator: pluginRoot,
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                    resolvedPath: pluginRoot,
                    manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                },
                compatibility: {
                    status: 'unknown',
                    diagnostics: [],
                },
                install: await createTrustedLocalLinkInstall({
                    pluginId: 'acme.sample',
                    sourceRootPath: pluginRoot,
                    manifestVersion: '1.0.0',
                    manifestDigest: null,
                }),
                state: {
                    enabled: true,
                },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(runtimeRegistry.contributes.agentDefinitionsById.get(SAMPLE_PLUGIN_PROVIDER_ID)).toMatchObject({
            id: SAMPLE_PLUGIN_PROVIDER_ID,
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                id: SAMPLE_PLUGIN_PROVIDER_ID,
            },
        });
        expect(runtimeRegistry.contributes).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(runtimeRegistry.contributes).not.toHaveProperty('surfaceHandlersByBackendId');
        expect(runtimeRegistry).not.toHaveProperty('runtimeCoreHandlersByBackendId');
        expect(runtimeRegistry.agentRuntimesByAgentId.get(SAMPLE_PLUGIN_PROVIDER_ID)).toMatchObject({
            pluginId: SAMPLE_PLUGIN_ID,
            agentId: SAMPLE_PLUGIN_PROVIDER_ID,
        });
        expect(runtimeRegistry.contributes.catalogEntriesById[SAMPLE_PLUGIN_PROVIDER_ID]).toBeUndefined();

        expect(typeof runtimeRegistry.readHookEventEnvelopeV1).toBe('function');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 1,
            hookEventId: 'session.message.send',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })?.eventId).toBe('session.message.send');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 2,
            eventId: 'session.message.send',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })).toBe(null);

        const handlers = runtimeRegistry.hookHandlersByHookId.get('agent.resolvePrerequisites');
        const sampleHandler = handlers?.find((handler) => handler.pluginId === SAMPLE_PLUGIN_ID);
        expect(sampleHandler).toBeDefined();
        await expect(sampleHandler?.handler({ payload: {} }, {})).resolves.toBe('integration-bound');
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.sample']).toEqual([]);
        await runtimeRegistry.dispose();
    });

    it('requires explicit approval before loading executable hook handlers for prompt-trust plugins', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        await materializeSamplePluginFixture(pluginRoot);
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.sample',
            sourceRootPath: pluginRoot,
            plugin: {
                source: {
                    kind: 'archive',
                    locator: 'https://example.com/acme-sample.tar.gz',
                    trustPolicy: 'prompt',
                    installPolicy: 'managed_install',
                    resolvedPath: pluginRoot,
                    manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                },
                compatibility: {
                    status: 'unknown',
                    diagnostics: [],
                },
                install: {
                    mode: 'managed_install',
                    manifestVersion: '1.0.0',
                    manifestDigest: null,
                    installedPath: pluginRoot,
                },
                state: {
                    enabled: true,
                },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect((runtimeRegistry.hookHandlersByHookId.get('agent.resolvePrerequisites') ?? []).some(
            (handler) => handler.pluginId === SAMPLE_PLUGIN_ID,
        )).toBe(false);
        expect(runtimeRegistry.agentRuntimesByAgentId.has(SAMPLE_PLUGIN_PROVIDER_ID)).toBe(false);
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.sample']).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'plugin_trust_approval_required',
                    message: expect.stringMatching(/approval/i),
                }),
            ]),
        );
    });
});
