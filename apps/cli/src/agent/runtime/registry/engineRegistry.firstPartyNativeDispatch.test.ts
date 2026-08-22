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
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { resolveBackendEngineAdapterResolution } from './engineRegistry';

function createTestCredentials(): Credentials {
    return {
        token: 'first-party-native-dispatch-test-token',
        encryption: {
            type: 'legacy',
            secret: new Uint8Array(32).fill(1),
        },
    };
}

function createUnboundConnectedAccountsOwner(): StablePluginConnectedAccountsOwner {
    return Object.freeze({
        getBinding: async () => null,
        requestSelection: async () => {
            throw new Error('Connected Account selection is outside this dispatch proof.');
        },
        materialize: async () => {
            throw new Error('Connected Account materialization is outside this dispatch proof.');
        },
        listAccounts: async () => {
            throw new Error('Connected Account listing is outside this fixture');
        },
        materializeListedAccount: async () => {
            throw new Error('Exact-listed Connected Account materialization is outside this fixture');
        },
        watch: () => Object.freeze({ dispose() {} }),
    });
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
    it('routes the exact sixteen predecessor Agents and native-only Grok through their declared primary runtime surfaces', async () => {
        const predecessorAgentIds = AGENT_IDS.filter((agentId) => agentId !== 'grok');
        expect(predecessorAgentIds).toHaveLength(16);
        expect(AGENT_IDS).toHaveLength(17);

        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-agent-dispatch-'));
        const originalPath = process.env.PATH;
        process.env.PATH = happyHomeDir;
        const builtInContributions = resolveBuiltInContributions();
        const processBoundaries = new Map(
            await Promise.all(AGENT_IDS.map(async (agentId) => {
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
        });
        const bundledAgents = AGENT_IDS.map((agentId) => {
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
        try {
            for (const { agentId, pluginId, contribution } of bundledAgents) {
                const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    contributes,
                    pluginIds: [pluginId],
                    generationAuthority: {
                        commit: null,
                        generations: new Map(),
                        rejectedGenerations: new Map(),
                        unavailableBundledPackageNames: new Set(),
                        isCurrent: async () => true,
                    },
                    connectedAccounts: createUnboundConnectedAccountsOwner(),
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
                    const runtimeRegistryForResolution = Object.freeze({
                        ...runtimeRegistry,
                        systemToolDefinitionsByPluginId: new Map([
                            ...(runtimeRegistry.systemToolDefinitionsByPluginId ?? new Map()),
                            [pluginId, systemToolDefinitions],
                        ]),
                    });
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
                            backendId: agentId,
                            cwd: happyHomeDir,
                            permissionMode: 'read_only',
                            runId: `native-dispatch-${agentId}`,
                            start: {
                                profileId: 'review',
                                intent: 'review',
                            },
                        });
                        await expect(runtime.provisionSession({
                            initialPrompt: `Prove native ${agentId} dispatch`,
                        }), agentId).resolves.toEqual({
                            sessionId: `native-dispatch-${agentId}`,
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
                        messageBuffer: new MessageBuffer(),
                        mcpServers: {},
                        permissionHandler: createProviderEnforcedPermissionHandler({
                            session,
                            logPrefix: `[${agentId} native dispatch proof]`,
                        }),
                        getPermissionMode: () => 'read-only' as const,
                        setThinking: () => undefined,
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
