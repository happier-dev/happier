import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_MANIFEST as PI_PLUGIN_MANIFEST } from '@happier-dev/plugins-pi/manifest';

import type { TrackedSession } from '@/daemon/types';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { readPluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import {
    createImmutablePluginGenerationRecordFromSource,
    persistValidatedAgentSessionRunnerFactories,
    prepareImmutablePluginGeneration,
    readCurrentPluginImmutableGenerationIntegrityCurrentness,
    readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';

import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from './refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import {
    createAgentRuntimeDaemonServiceAuthorityPath,
    readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
    removeAgentRuntimeDaemonServiceAuthorityIfOwned,
} from './sessionBridgeAuthorization';

async function prepareAttestedRunnerBinding(happyHomeDir: string) {
    const pluginId = 'acme.runner-integrity';
    const sourceRootPath = join(happyHomeDir, 'source');
    const manifestRelativePath = '.happier-plugin/plugin.json';
    const manifestPath = join(sourceRootPath, manifestRelativePath);
    const moduleRelativePath = 'agent/runtime/factory.mjs';
    const moduleBytes =
        'export function createFixtureAgentRuntime() { return { sessions: { open() {} } }; }\n';
    const manifest = createPluginManifestV2Fixture({
        id: pluginId,
        contributes: {
            agents: [{
                id: 'fixture',
                title: 'Fixture',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
            }],
        },
    });
    await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
    await mkdir(join(sourceRootPath, 'agent', 'runtime'), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await writeFile(join(sourceRootPath, moduleRelativePath), moduleBytes, 'utf8');
    const generated = await createImmutablePluginGenerationRecordFromSource({
        pluginId,
        sourceRootPath,
        manifestRelativePath,
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 1,
    });
    const record = {
        ...generated,
        immutableGenerationId: 'generation-integrity',
    };
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const prepared = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record,
    });
    const locator = {
        module: './agent/runtime/factory',
        export: 'createFixtureAgentRuntime',
        runtimeApiVersion: 1 as const,
    };
    await persistValidatedAgentSessionRunnerFactories({
        paths,
        record,
        manifestAuthority: 'external',
        factories: [{
            localAgentId: 'fixture',
            locator,
            normalizedModulePath: moduleRelativePath,
            loadMode: 'immutable-js',
        }],
    });
    return {
        binding: createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId,
            pluginVersion: '1.0.0',
            agentId: 'codex',
            localAgentId: 'fixture',
            immutableGenerationId: record.immutableGenerationId,
            locator,
            normalizedModulePath: moduleRelativePath,
            loadMode: 'immutable-js',
        }),
        prepared,
        record,
        manifest,
    };
}

type HardRevocationRefreshInput = Parameters<
    typeof refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority
>[0] & Readonly<{
    readPluginHardRevocationRevision: (pluginId: string) => Promise<number>;
    readPluginImmutableGenerationIntegrityCurrentness?: (
        pluginId: string,
        immutableGenerationId: string,
    ) => Promise<boolean>;
    hardRevokeRunningSessionsForGenerationIntegrityFailure?: (
        input: Readonly<{
            pluginId: string;
            immutableGenerationId: string;
        }>,
    ) => Promise<void>;
}>;

const refreshWithHardRevocationCurrentness =
    refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority as unknown as (
        input: HardRevocationRefreshInput,
    ) => ReturnType<typeof refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority>;

describe('hard-revoked Runner Agent authority', () => {
    it('advances direct hard-revocation currentness for a tampered generated bundle and rejects its repaired retained authority after daemon replacement', async () => {
        const happyHomeDir = await mkdtemp(`${tmpdir()}/happier-bundled-integrity-runner-`);
        try {
            const bundledArtifact = BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find(
                (artifact) => artifact.record.pluginId === 'happier.agent.pi',
            );
            if (!bundledArtifact) throw new Error('Expected generated bundled Pi artifact');
            const moduleRelativePath = 'dist/agent/runtime/engine.js';
            const moduleFile = bundledArtifact.record.files.find(
                (file) => file.relativePath === moduleRelativePath,
            );
            if (!moduleFile) throw new Error('Expected generated bundled Pi runtime module');
            const paths = resolvePluginStorePaths({ happyHomeDir });
            const createStateStore = () => createPluginRegistryStateStore({
                happyHomeDir,
                runtimeLifecycle: Object.freeze({
                    prepare: async () => Object.freeze({
                        abort: async () => undefined,
                        adopt: async () => undefined,
                    }),
                }),
                runHardRevocationCurrentnessChange: async (_pluginId, change) =>
                    await change({ onApplied: () => undefined }),
            });
            const stateStore = createStateStore();
            await stateStore.initialize();
            const locator = {
                module: './agent/runtime/engine',
                export: 'createPiAgentRuntime',
                runtimeApiVersion: 1 as const,
                externalSessionsExport: 'piExternalSessionsContribution',
            };
            await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
                paths,
                pluginId: bundledArtifact.record.pluginId,
                immutableGenerationId: bundledArtifact.record.immutableGenerationId,
                bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
            })).resolves.toBe(true);
            await persistValidatedAgentSessionRunnerFactories({
                paths,
                record: bundledArtifact.record,
                manifestAuthority: 'bundled_first_party',
                factories: [{
                    localAgentId: 'pi',
                    locator,
                    normalizedModulePath: moduleRelativePath,
                    loadMode: 'immutable-js',
                }],
            });
            const binding = createAgentSessionRunnerFactoryBinding({
                v: 1,
                pluginId: bundledArtifact.record.pluginId,
                pluginVersion: PI_PLUGIN_MANIFEST.version,
                agentId: 'pi',
                localAgentId: 'pi',
                immutableGenerationId:
                    bundledArtifact.record.immutableGenerationId,
                locator,
                normalizedModulePath: moduleRelativePath,
                loadMode: 'immutable-js',
            });
            const command =
                '/immutable/runtime/versions/1.2.3/bin/happier pi --existing-session session-bundled-integrity';
            const processCommandHash = createHash('sha256').update(command).digest('hex');
            const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir,
                publicReleaseRing: 'stable',
            });
            const tracked: TrackedSession = {
                startedBy: 'daemon',
                pid: 4401,
                sessionRunnerPid: 4402,
                happySessionId: 'session-bundled-integrity',
                processCommandHash,
                processStartTimeMs: 42_345,
                processCommand: command,
                agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
                spawnOptions: {
                    directory: '/repo',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'pi',
                        sourceKind: 'built_in',
                    },
                    modelSelection: {
                        v: 1,
                        ref: {
                            agentTargetKey: 'backend:pi',
                            providerConnectionId: null,
                            modelId: 'native',
                        },
                        updatedAt: 1,
                    },
                },
            };
            const resolveCurrentRetainedAgent = vi.fn(async () => binding);
            const readProcessIdentityByPidFn = async (pid: number) => ({
                pid,
                command,
                processStartTimeMs: 42_345,
            });
            await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-bundled-integrity',
                tracked,
                resolveCurrentRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
            });
            tracked.reattachedFromDiskMarker = true;
            const immutableModulePath = join(
                paths.generationsDir,
                bundledArtifact.record.immutableGenerationId,
                moduleRelativePath,
            );
            const originalModuleBytes = await readFile(immutableModulePath);
            await writeFile(immutableModulePath, 'tampered bundled runtime', 'utf8');
            const resolveReattachedRetainedAgent = vi.fn(
                async () => {
                    throw new Error(
                        'Reattached authority must not resolve a current retained Agent',
                    );
                },
            );

            const tamperedBundleIntegrityOwner = vi.fn(
                stateStore.hardRevokeRunningSessionsForGenerationIntegrityFailure,
            );
            await expect(refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-bundled-integrity',
                tracked,
                resolveCurrentRetainedAgent:
                    resolveReattachedRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                hardRevokeRunningSessionsForGenerationIntegrityFailure:
                    tamperedBundleIntegrityOwner,
            })).rejects.toThrow(/hard-revoked/i);
            expect(tamperedBundleIntegrityOwner).toHaveBeenCalledOnce();
            expect(tamperedBundleIntegrityOwner).toHaveBeenCalledWith({
                pluginId: binding.pluginId,
                immutableGenerationId: binding.immutableGenerationId,
            });

            const revokedCommit = await readPluginRegistryCommitRecord(paths);
            if (!revokedCommit) throw new Error('Expected durable integrity commit');
            const revokedState = await readInstallationStateRevision({
                paths,
                reference: revokedCommit.installationState,
            });
            expect(revokedState.plugins).toEqual({});
            expect(revokedState.hardRevocationRevisions?.[binding.pluginId])
                .toBe(revokedCommit.revision);

            // Hard revocation removes the admitted generation. Recreate the
            // hostile byte path to prove restored bytes still cannot revive
            // the exact revoked authority.
            await mkdir(dirname(immutableModulePath), { recursive: true });
            await writeFile(immutableModulePath, originalModuleBytes);
            const factoryFactPath = join(
                paths.stateDir,
                'validated-agent-session-runner-factories',
                `${binding.immutableGenerationId}.v1.json`,
            );
            const factoryFactBytes = await readFile(factoryFactPath);
            await rm(factoryFactPath);
            const missingFactIntegrityOwner = vi.fn(
                createStateStore()
                    .hardRevokeRunningSessionsForGenerationIntegrityFailure,
            );
            await expect(refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-bundled-integrity',
                tracked,
                resolveCurrentRetainedAgent:
                    resolveReattachedRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                hardRevokeRunningSessionsForGenerationIntegrityFailure:
                    missingFactIntegrityOwner,
            })).rejects.toThrow(/hard-revoked/i);
            expect(missingFactIntegrityOwner).not.toHaveBeenCalled();

            await writeFile(factoryFactPath, factoryFactBytes);
            const replacementIntegrityOwner = vi.fn(
                createStateStore()
                    .hardRevokeRunningSessionsForGenerationIntegrityFailure,
            );
            await expect(refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-bundled-integrity',
                tracked,
                resolveCurrentRetainedAgent:
                    resolveReattachedRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                hardRevokeRunningSessionsForGenerationIntegrityFailure:
                    replacementIntegrityOwner,
            })).rejects.toThrow(/hard-revoked/i);
            expect(replacementIntegrityOwner).not.toHaveBeenCalled();
            expect(resolveReattachedRetainedAgent).not.toHaveBeenCalled();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('does not reinstall a reattached authority when the hard revision advances during exact retained-authority refresh', async () => {
        const happyHomeDir = await mkdtemp(`${tmpdir()}/happier-hard-race-runner-`);
        try {
            const { binding } = await prepareAttestedRunnerBinding(happyHomeDir);
            const command =
                '/immutable/runtime/versions/1.2.3/bin/happier fixture --existing-session session-race';
            const processCommandHash = createHash('sha256').update(command).digest('hex');
            const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir,
                publicReleaseRing: 'stable',
            });
            const tracked: TrackedSession = {
                startedBy: 'daemon',
                pid: 4201,
                sessionRunnerPid: 4202,
                happySessionId: 'session-race',
                processCommandHash,
                processStartTimeMs: 22_345,
                processCommand: command,
                agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
                spawnOptions: {
                    directory: '/repo',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'codex',
                        sourceKind: 'built_in',
                    },
                    modelSelection: {
                        v: 1,
                        ref: {
                            agentTargetKey: 'backend:codex',
                            providerConnectionId: null,
                            modelId: 'native',
                        },
                        updatedAt: 1,
                    },
                },
            };
            const resolveCurrentRetainedAgent = vi.fn(async () => binding);
            const readProcessIdentityByPidFn = async (pid: number) => ({
                pid,
                command,
                processStartTimeMs: 22_345,
            });
            const published = await refreshWithHardRevocationCurrentness({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-race',
                tracked,
                resolveCurrentRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async () => 0,
                readPluginImmutableGenerationIntegrityCurrentness:
                    async () => true,
            });
            tracked.reattachedFromDiskMarker = true;
            let reattachRevisionReads = 0;

            await expect(refreshWithHardRevocationCurrentness({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-race',
                tracked,
                resolveCurrentRetainedAgent: async () => {
                    throw new Error(
                        'Reattach must not resolve current retained authority',
                    );
                },
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async () => {
                    reattachRevisionReads += 1;
                    return reattachRevisionReads >= 4 ? 1 : 0;
                },
                readPluginImmutableGenerationIntegrityCurrentness:
                    async () => true,
            })).rejects.toThrow(/hard-revoked/i);
            expect(tracked.agentRuntimeDaemonServiceCapabilityHash).toBeUndefined();
            await expect(readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
                happyHomeDir,
                publicReleaseRing: 'stable',
                path: published.path,
                sessionId: 'session-race',
                runner: published.document.runner,
            })).resolves.toBeNull();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('commits an immediate hard currentness failure before restored immutable bytes can revive the old exact retained authority', async () => {
        const happyHomeDir = await mkdtemp(`${tmpdir()}/happier-integrity-restore-runner-`);
        try {
            const { binding, prepared, manifest } =
                await prepareAttestedRunnerBinding(happyHomeDir);
            const command =
                '/immutable/runtime/versions/1.2.3/bin/happier fixture --existing-session session-integrity';
            const processCommandHash = createHash('sha256').update(command).digest('hex');
            const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir,
                publicReleaseRing: 'stable',
            });
            const tracked: TrackedSession = {
                startedBy: 'daemon',
                pid: 4301,
                sessionRunnerPid: 4302,
                happySessionId: 'session-integrity',
                processCommandHash,
                processStartTimeMs: 32_345,
                processCommand: command,
                agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
                spawnOptions: {
                    directory: '/repo',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'codex',
                        sourceKind: 'built_in',
                    },
                    modelSelection: {
                        v: 1,
                        ref: {
                            agentTargetKey: 'backend:codex',
                            providerConnectionId: null,
                            modelId: 'native',
                        },
                        updatedAt: 1,
                    },
                },
            };
            const resolveCurrentRetainedAgent = vi.fn(async () => binding);
            const readProcessIdentityByPidFn = async (pid: number) => ({
                pid,
                command,
                processStartTimeMs: 32_345,
            });
            let generationIntegrityCurrent = true;
            await refreshWithHardRevocationCurrentness({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-integrity',
                tracked,
                resolveCurrentRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async () => 0,
                readPluginImmutableGenerationIntegrityCurrentness:
                    async () => generationIntegrityCurrent,
            });
            tracked.reattachedFromDiskMarker = true;
            const immutableManifestPath = join(
                prepared.rootPath,
                '.happier-plugin',
                'plugin.json',
            );
            await writeFile(immutableManifestPath, '{}', 'utf8');
            const hardRevokeIntegrityFailure = vi.fn(async () => {
                generationIntegrityCurrent = false;
                await writeFile(
                    immutableManifestPath,
                    JSON.stringify(manifest),
                    'utf8',
                );
            });
            const resolveReattachedRetainedAgent = vi.fn(
                async () => {
                    throw new Error(
                        'Reattach must not resolve current retained authority',
                    );
                },
            );
            const refresh = () => refreshWithHardRevocationCurrentness({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-integrity',
                tracked,
                resolveCurrentRetainedAgent:
                    resolveReattachedRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async () => 0,
                readPluginImmutableGenerationIntegrityCurrentness:
                    async () => generationIntegrityCurrent,
                hardRevokeRunningSessionsForGenerationIntegrityFailure:
                    hardRevokeIntegrityFailure,
            });

            await expect(refresh()).rejects.toThrow(/hard-revoked/i);
            expect(hardRevokeIntegrityFailure).toHaveBeenCalledWith({
                pluginId: binding.pluginId,
                immutableGenerationId: binding.immutableGenerationId,
            });
            await expect(refresh()).rejects.toThrow(/hard-revoked/i);
            expect(hardRevokeIntegrityFailure).toHaveBeenCalledTimes(2);
            expect(resolveReattachedRetainedAgent).not.toHaveBeenCalled();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('cannot resurrect a lingering exact retained authority after failed removal, failed termination, daemon replacement, and re-enable', async () => {
        const happyHomeDir = await mkdtemp(`${tmpdir()}/happier-hard-revoked-runner-`);
        try {
            const { binding } =
                await prepareAttestedRunnerBinding(happyHomeDir);
            const command =
                '/immutable/runtime/versions/1.2.3/bin/happier codex --existing-session session-a';
            const processCommandHash = createHash('sha256').update(command).digest('hex');
            const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir,
                publicReleaseRing: 'stable',
            });
            const tracked: TrackedSession = {
                startedBy: 'daemon',
                pid: 4101,
                sessionRunnerPid: 4102,
                happySessionId: 'session-a',
                processCommandHash,
                processStartTimeMs: 12_345,
                processCommand: command,
                agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
                spawnOptions: {
                    directory: '/repo',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'codex',
                        sourceKind: 'built_in',
                    },
                    modelSelection: {
                        v: 1,
                        ref: {
                            agentTargetKey: 'backend:codex',
                            providerConnectionId: null,
                            modelId: 'native',
                        },
                        updatedAt: 1,
                    },
                },
            };
            const resolveCurrentRetainedAgent = vi.fn(async () => binding);
            const readProcessIdentityByPidFn = async (pid: number) => ({
                pid,
                command,
                processStartTimeMs: 12_345,
            });

            const published = await refreshWithHardRevocationCurrentness({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-a',
                tracked,
                resolveCurrentRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async () => 0,
                readPluginImmutableGenerationIntegrityCurrentness:
                    async () => true,
            });

            await expect(removeAgentRuntimeDaemonServiceAuthorityIfOwned({
                happyHomeDir,
                publicReleaseRing: 'stable',
                path: published.path,
                capabilityDigest: `sha256:${'0'.repeat(64)}`,
            })).resolves.toBe(false);
            await expect(readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
                happyHomeDir,
                publicReleaseRing: 'stable',
                path: published.path,
                sessionId: 'session-a',
                runner: published.document.runner,
            })).resolves.toEqual(published.document);

            // The failed removal leaves the old exact authority document on disk and the Runner
            // is deliberately still alive. The replacement daemon observes the
            // durable hard-revocation revision after later re-enable; restored
            // current policy must not make the old authority reusable.
            tracked.reattachedFromDiskMarker = true;
            const resolveRestoredCurrentRetainedAgent = vi.fn(async () => {
                throw new Error(
                    'Reattached authority must not resolve current retained authority',
                );
            });
            const persistRestoredImmutableGeneration = vi.fn(async () => true);
            type HardRevocationAwareRefreshInput = Parameters<
                typeof refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority
            >[0] & Readonly<{
                readPluginHardRevocationRevision: (
                    pluginId: string,
                ) => Promise<number>;
            }>;
            const refreshAfterDaemonReplacement =
                refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority as unknown as (
                    input: HardRevocationAwareRefreshInput,
                ) => ReturnType<
                    typeof refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority
                >;
            await expect(refreshAfterDaemonReplacement({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-a',
                tracked,
                resolveCurrentRetainedAgent:
                    resolveRestoredCurrentRetainedAgent,
                persistRunnerAgentImmutableGenerationId:
                    persistRestoredImmutableGeneration,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async () => 1,
                readPluginImmutableGenerationIntegrityCurrentness:
                    async () => true,
            })).rejects.toThrow(/hard-revoked/i);
            expect(resolveRestoredCurrentRetainedAgent)
                .not.toHaveBeenCalled();
            expect(persistRestoredImmutableGeneration).not.toHaveBeenCalled();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('does not reissue G when the exact retained Provider P was hard-revoked before daemon replacement', async () => {
        const happyHomeDir = await mkdtemp(
            `${tmpdir()}/happier-hard-revoked-provider-runner-`,
        );
        try {
            const { binding } =
                await prepareAttestedRunnerBinding(happyHomeDir);
            const command =
                '/immutable/runtime/versions/1.2.3/bin/happier codex --existing-session session-provider-p';
            const processCommandHash = createHash('sha256')
                .update(command)
                .digest('hex');
            const authorityFilePath =
                await createAgentRuntimeDaemonServiceAuthorityPath({
                    happyHomeDir,
                    publicReleaseRing: 'stable',
                });
            const resolveCurrentRetainedAgent = vi.fn(async () => binding);
            const readProcessIdentityByPidFn = async (pid: number) => ({
                pid,
                command,
                processStartTimeMs: 52_345,
            });
            const daemonATracked: TrackedSession = {
                startedBy: 'daemon',
                pid: 4401,
                sessionRunnerPid: 4402,
                happySessionId: 'session-provider-p',
                processCommandHash,
                processStartTimeMs: 52_345,
                processCommand: command,
                agentRuntimeDaemonServiceAuthorityFilePath:
                    authorityFilePath,
                spawnOptions: {
                    directory: '/repo',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'codex',
                        sourceKind: 'built_in',
                    },
                },
            };
            await refreshWithHardRevocationCurrentness({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3210,
                sessionId: 'session-provider-p',
                tracked: daemonATracked,
                resolveCurrentRetainedAgent,
                persistRunnerAgentImmutableGenerationId: async () => true,
                persistRunnerManagedDependencyRetention: async () => true,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async () => 0,
                readPluginImmutableGenerationIntegrityCurrentness:
                    async () => true,
            });

            // Failed Provider cleanup and failed runner termination leave the
            // exact process plus daemon-A authority document in place. Daemon B
            // reconstructs only non-secret marker facts and must intersect G
            // direct retained-Agent authority with the retained P hard-revocation revision.
            const daemonBTracked: TrackedSession = {
                startedBy: 'daemon',
                pid: 4401,
                sessionRunnerPid: 4402,
                happySessionId: 'session-provider-p',
                processCommandHash,
                processStartTimeMs: 52_345,
                processCommand: command,
                agentRuntimeDaemonServiceAuthorityFilePath:
                    authorityFilePath,
                runnerAgentImmutableGenerationId:
                    binding.immutableGenerationId,
                runnerManagedDependencyRetentionV1: {
                    v: 1,
                    adoptedManagedProviderAuthority: {
                        pluginId: 'acme.provider.gateway',
                        immutableGenerationId: 'generation-provider-p',
                        manifestAuthority: 'external',
                        hardRevocationRevisionAtAdmission: 7,
                    },
                    sourceGenerationIds: [],
                    qualifiedDependencyIds: [],
                },
                reattachedFromDiskMarker: true,
                spawnOptions: daemonATracked.spawnOptions,
            };
            const resolveReattachedRetainedAgent = vi.fn(
                async () => {
                    throw new Error(
                        'Reattached authority must not resolve current retained authority',
                    );
                },
            );
            const persistRunnerAgentImmutableGenerationId =
                vi.fn(async () => true);
            const persistRunnerManagedDependencyRetention =
                vi.fn(async () => true);

            await expect(refreshWithHardRevocationCurrentness({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort: 3211,
                sessionId: 'session-provider-p',
                tracked: daemonBTracked,
                resolveCurrentRetainedAgent:
                    resolveReattachedRetainedAgent,
                persistRunnerAgentImmutableGenerationId,
                persistRunnerManagedDependencyRetention,
                readProcessIdentityByPidFn,
                readPluginHardRevocationRevision: async (pluginId) =>
                    pluginId === 'acme.provider.gateway' ? 7 : 0,
                readPluginImmutableGenerationIntegrityCurrentness:
                    async (pluginId, immutableGenerationId) => !(
                        pluginId === 'acme.provider.gateway'
                        && immutableGenerationId
                            === 'generation-provider-p'
                    ),
            })).rejects.toThrow(/Provider.*hard-revoked/i);
            expect(resolveReattachedRetainedAgent).not.toHaveBeenCalled();
            expect(persistRunnerAgentImmutableGenerationId)
                .not.toHaveBeenCalled();
            expect(persistRunnerManagedDependencyRetention)
                .not.toHaveBeenCalled();
            expect(daemonBTracked.agentRuntimeDaemonServiceCapabilityHash)
                .toBeUndefined();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
