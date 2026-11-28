import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { AGENT_IDS } from '@happier-dev/agents';
import { describe, expect, it } from 'vitest';

import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { HostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import type {
    HostSessionRuntimeFactoryParams,
    HostSessionRuntimeHookRuntime,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Credentials } from '@/persistence';
import { isPrimaryAgentContributionDefinition } from '@/plugins/projection/registry/agentContributionDefinition';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { PluginManagedDependencyContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/managedDependencies';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { createUnboundConnectedAccountsFixture } from './engineRegistry/connectedAccounts.testkit';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { bindNativeAgentLaunchPreparationFixture, createNativeAgentLaunchPreparationFixture } from './engineRegistry/nativeAgentSession.composed.testkit';

function createTestCredentials(): Credentials {
    return {
        token: 'first-party-native-dispatch-test-token',
        encryption: {
            type: 'legacy',
            secret: new Uint8Array(32).fill(1),
        },
    };
}

async function createFailingProcessBoundary(params: Readonly<{
    directory: string;
    agentId: string;
    canonicalExecutableName: string;
}>): Promise<Readonly<{ executableName: string; executablePath: string; markerPath: string }>> {
    const markerPath = join(params.directory, `${params.agentId}-process-boundary.json`);
    const scriptPath = join(params.directory, `${params.agentId}-process-boundary.mjs`);
    await writeFile(scriptPath, [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ argv: process.argv.slice(2) }));`,
        'process.exit(86);',
    ].join('\n'));
    const executablePath = process.platform === 'win32'
        ? join(params.directory, `${params.canonicalExecutableName}.cmd`)
        : join(params.directory, params.canonicalExecutableName);
    if (process.platform === 'win32') {
        await writeFile(
            executablePath,
            `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
        );
    } else {
        await writeFile(executablePath, [
            `#!${process.execPath}`,
            "import { writeFileSync } from 'node:fs';",
            `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ argv: process.argv.slice(2) }));`,
            'process.exit(86);',
        ].join('\n'));
        chmodSync(executablePath, 0o755);
    }
    return Object.freeze({
        executableName: basename(executablePath),
        executablePath,
        markerPath,
    });
}

async function markerWasWritten(markerPath: string): Promise<boolean> {
    return await readFile(markerPath, 'utf8').then(() => true, () => false);
}

async function waitForProcessBoundary(markerPath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await markerWasWritten(markerPath)) return true;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 10);
            timer.unref?.();
        });
    }
    return false;
}

describe('first-party native Agent production dispatch', () => {
    it('routes every bundled Agent with a declared CLI tool through its primary runtime surface', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-agent-dispatch-'));
        const originalPath = process.env.PATH;
        process.env.PATH = happyHomeDir;
        const builtInContributions = resolveBuiltInContributions();
        // Account-configured ACP commands have no intrinsic executable. Their
        // admitted definition/command/environment/exit journey is covered by
        // accountConfiguredAcp.session.composed.test.ts.
        const executableAgentIds = AGENT_IDS.filter(agentId => {
            const pluginId = builtInContributions.agents.find(agent => agent.id === agentId)?.pluginId;
            return pluginId && builtInContributions.systemTools?.some(tool => tool.pluginId === pluginId);
        });
        const processBoundaries = new Map(
            await Promise.all(executableAgentIds.map(async (agentId) => {
                const canonicalExecutableName = builtInContributions.agents.find(
                    (agent) => agent.id === agentId,
                )?.runtimeSpec?.binaryName;
                if (!canonicalExecutableName) {
                    throw new Error(`Missing canonical Agent CLI executable name for '${agentId}'`);
                }
                return [
                    agentId,
                    await createFailingProcessBoundary({
                        directory: happyHomeDir,
                        agentId,
                        canonicalExecutableName,
                    }),
                ] as const;
            })),
        );
        const pluginIdByAgentId = new Map(
            builtInContributions.agents.flatMap((agent) => (
                agent.pluginId ? [[agent.id, agent.pluginId] as const] : []
            )),
        );
        const activationTargets = builtInContributions.activationTargets;
        if (!activationTargets) {
            throw new Error('Bundled Agent dispatch proof requires activation targets');
        }
        const processBoundaryByPluginId = new Map(
            [...processBoundaries].flatMap(([agentId, boundary]) => {
                const pluginId = pluginIdByAgentId.get(agentId);
                return pluginId ? [[pluginId, boundary] as const] : [];
            }),
        );
        const contributes = createResolvedContributionRegistry({
            ...builtInContributions,
            activationTargets: activationTargets.map((target) => {
                const processBoundary = processBoundaryByPluginId.get(target.pluginId);
                if (!processBoundary) return target;
                return {
                    ...target,
                    manifest: {
                        ...target.manifest,
                        contributes: {
                            ...target.manifest.contributes,
                            systemTools: (target.manifest.contributes.systemTools ?? []).map((tool) => ({
                                ...tool,
                                executableNames: [processBoundary.executableName],
                            })),
                            // ACP can launch a declared dependency instead of the Agent's
                            // CLI tool. Supply the same real OS boundary through its
                            // source declaration; keep managed-reference resolution real.
                            managedDependencies: (target.manifest.contributes.managedDependencies ?? []).map((dependency) => ({
                                ...dependency,
                                sources: [{ kind: 'system' as const, executableNames: [processBoundary.executableName] }, ...dependency.sources],
                            })),
                        },
                    },
                };
            }),
            systemTools: (builtInContributions.systemTools ?? []).map((tool) => {
                const processBoundary = tool.pluginId
                    ? processBoundaryByPluginId.get(tool.pluginId)
                    : null;
                return processBoundary
                    ? {
                            ...tool,
                            definition: {
                                ...tool.definition,
                                executableNames: [processBoundary.executableName],
                            },
                    }
                    : tool;
            }),
            managedDependencies: (builtInContributions.managedDependencies ?? []).map((dependency) => {
                const processBoundary = dependency.pluginId ? processBoundaryByPluginId.get(dependency.pluginId) : null;
                if (!processBoundary) return dependency;
                const definition = PluginManagedDependencyContributionV2Schema.parse(dependency.definition);
                return { ...dependency, definition: {
                    ...definition,
                    sources: [{ kind: 'system' as const, executableNames: [processBoundary.executableName] }, ...definition.sources],
                } };
            }),
        });
        const bundledAgents = executableAgentIds.map((agentId) => {
            const contribution = contributes.agentDefinitionsById.get(agentId);
            if (!contribution?.pluginId || !contribution.identity) {
                throw new Error(`Missing bundled contribution identity for '${agentId}'`);
            }
            return Object.freeze({
                agentId,
                pluginId: contribution.pluginId,
                contribution,
            });
        });
        for (const { agentId, pluginId } of bundledAgents) {
            const processBoundary = processBoundaries.get(agentId);
            if (!processBoundary) {
                throw new Error(`Missing process-boundary fixture for '${agentId}'`);
            }
            expect(
                (contributes.systemTools ?? [])
                    .filter((tool) => tool.pluginId === pluginId)
                    .map((tool) => tool.definition.executableNames),
                `${agentId}: resolved system-tool projection`,
            ).toContainEqual([processBoundary.executableName]);
        }
        const launchPreparation = await createNativeAgentLaunchPreparationFixture();
        try {
            for (const { agentId, pluginId, contribution } of bundledAgents) {
                const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    contributes,
                    pluginIds: [pluginId],
                    resolveDevelopmentSourceAuthority: ({ pluginId: sourcePluginId, rootPath }) => ({
                        kind: 'development',
                        registeredRootId: `first-party-native-dispatch:${sourcePluginId}`,
                        canonicalRoot: rootPath,
                        observedRevision: 1,
                    }),
                    generationAuthority: {
                        commit: null,
                        generations: new Map(),
                        rejectedGenerations: new Map(),
                    },
                    connectedAccounts: createUnboundConnectedAccountsFixture(),
                });
                let pendingOpenAttempt: Promise<
                    | Readonly<{
                        status: 'opened';
                        runtime: HostSessionRuntimeFactoryResult<HostSessionRuntimeHookRuntime>;
                    }>
                    | Readonly<{ status: 'rejected'; error: unknown }>
                > | null = null;

                try {
                    const systemToolDefinitions = Object.freeze(
                        (contributes.systemTools ?? []).flatMap((tool) => (
                            tool.pluginId === pluginId ? [tool.definition] : []
                        )),
                    );
                    const runtimeRegistryForResolution = bindNativeAgentLaunchPreparationFixture(Object.freeze({
                        ...runtimeRegistry,
                        systemToolDefinitionsByPluginId: new Map([
                            ...(runtimeRegistry.systemToolDefinitionsByPluginId ?? new Map()),
                            [pluginId, systemToolDefinitions],
                        ]),
                    }), launchPreparation);
                    const resolution = await resolveBackendEngineAdapterResolution(agentId, {
                        runtimeRegistry: runtimeRegistryForResolution,
                    });

                    expect(resolution, agentId).toMatchObject({
                        backendId: agentId,
                        agentId,
                        selectedSource: 'plugin',
                        runtimeOwner: {
                            selected: {
                                kind: 'plugin_engine',
                                pluginId,
                            },
                        },
                        diagnostics: [],
                    });

                    const definition = contribution.richDefinition?.definition;
                    if (!definition || !isPrimaryAgentContributionDefinition(definition)) {
                        throw new Error(`Bundled Agent '${agentId}' has no primary runtime surface`);
                    }
                    const primary = definition.primary;
                    if (primary === 'executionRuns') {
                        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
                            scope: 'detached',
                            backendId: agentId,
                            cwd: happyHomeDir,
                            permissionMode: 'read_only',
                            runId: `native-dispatch-${agentId}`,
                            start: {
                                profileId: 'review',
                                intent: 'review',
                            },
                        });
                        await expect(runtime.provisionRuntime({
                            initialPrompt: `Prove native ${agentId} dispatch`,
                        }), agentId).resolves.toEqual({
                            runtimeId: `native-dispatch-${agentId}`,
                        });
                        await runtime.dispose();
                        continue;
                    }

                    expect(primary, agentId).toBe('sessions');
                    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
                        credentials: createTestCredentials(),
                        directory: happyHomeDir,
                        backendTarget: { kind: 'backend', backendId: agentId },
                        permissionMode: 'read_only',
                        ...(agentId === 'gemini'
                            ? { environmentVariables: { GEMINI_API_KEY: 'test-only-native-dispatch-key' } }
                            : agentId === 'opencode'
                                ? { environmentVariables: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' } }
                            : {}),
                        ...(agentId === 'opencode' ? {
                            sessionConfigOptionOverrides: {
                                v: 1,
                                updatedAt: 1,
                                overrides: {
                                    opencodeBackendMode: { value: 'acp', updatedAt: 1 },
                                },
                            },
                        } : {}),
                    });
                    expect(plan, agentId).toMatchObject({
                        kind: 'hostSessionRuntimePlan',
                        agentId,
                        config: {
                            createSessionRuntime: expect.any(Function),
                        },
                    });
                    const sessionId = `native-dispatch-${agentId}`;
                    const session = createMutableApiSessionClientFixture({
                        overrides: {
                            sessionId,
                            rpcHandlerManager: createRpcHandlerManager({
                                scopePrefix: 'session',
                                encryptionKey: new Uint8Array(32),
                                encryptionVariant: 'legacy',
                                encryptionMode: 'plain',
                            }),
                        },
                    });
                    const runtimeParams = {
                        directory: happyHomeDir,
                        metadata: createTestMetadata({ path: happyHomeDir }),
                        machineId: `machine-${agentId}`,
                        agentTargetKey: `backend:${agentId}`,
                        session,
                        transcriptSession: session,
                        currentSessionPresentation: createCurrentSessionPresentationHost({ session, signal: new AbortController().signal }).bindCurrentSession,
                        messageBuffer: new MessageBuffer(),
                        mcpServers: {},
                        permissionHandler: createProviderEnforcedPermissionHandler({
                            session,
                            logPrefix: `[${agentId} native dispatch proof]`,
                        }),
                        getPermissionMode: () => 'read-only' as const,
                        memoryRecallGuidanceEnabled: false,
                        runnerProcessIdentity: null,
                        startupModelSelection: null,
                        runWithTerminalModelSelection: async (effect) => ({
                            status: 'completed',
                            value: await effect(null, async (localEffect) => ({
                                status: 'completed',
                                value: await localEffect(),
                            })),
                        }),
                    } satisfies HostSessionRuntimeFactoryParams;
                    const processBoundary = processBoundaries.get(agentId);
                    if (!processBoundary) {
                        throw new Error(`Missing process-boundary fixture for '${agentId}'`);
                    }
                    const openAttempt = Promise.resolve(
                        plan.config.createSessionRuntime!(runtimeParams),
                    ).then(
                        (runtime) => ({ status: 'opened' as const, runtime }),
                        (error: unknown) => ({ status: 'rejected' as const, error }),
                    );
                    pendingOpenAttempt = openAttempt;
                    const opened = await Promise.race([
                        openAttempt,
                        waitForProcessBoundary(processBoundary.markerPath, 10_000).then(
                            (reached) => reached
                                ? ({ status: 'process-boundary' as const })
                                : ({ status: 'timeout' as const }),
                        ),
                    ]);
                    const openDiagnostic = opened.status === 'rejected'
                        ? opened.error instanceof Error
                            ? `${opened.error.name}: ${opened.error.message}`
                            : String(opened.error)
                        : opened.status;
                    const processBoundaryReached = opened.status === 'process-boundary'
                        || await markerWasWritten(processBoundary.markerPath);
                    expect(
                        opened.status === 'opened' || processBoundaryReached,
                        `${agentId}: ${openDiagnostic}`,
                    ).toBe(true);
                    if (opened.status === 'opened') {
                        await opened.runtime.operations.resetOrDisposeRuntime();
                        pendingOpenAttempt = null;
                    } else if (opened.status === 'rejected') {
                        pendingOpenAttempt = null;
                    }
                } finally {
                    await runtimeRegistry.dispose({ timeoutMs: 10_000 });
                    if (pendingOpenAttempt) {
                        const settled = await Promise.race([
                            pendingOpenAttempt,
                            new Promise<Readonly<{ status: 'cleanup-timeout' }>>((resolve) => {
                                const timer = setTimeout(
                                    () => resolve({ status: 'cleanup-timeout' }),
                                    10_000,
                                );
                                timer.unref?.();
                            }),
                        ]);
                        expect(settled.status, `${agentId}: pending open survived registry disposal`)
                            .not.toBe('cleanup-timeout');
                        if (settled.status === 'opened') {
                            await settled.runtime.operations.resetOrDisposeRuntime();
                        }
                    }
                }
            }
        } finally {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    }, 180_000);
});
