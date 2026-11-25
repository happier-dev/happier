import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildHandoffSessionMetadataFromTrackedSession } from '@/daemon/sessions/buildHandoffSessionMetadataFromTrackedSession';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { exportSessionHandoffAgentBundle } from '../agentBundle/export';
import { readSessionHandoffAgentBundleRecords } from '../agentBundle/records';

import { resolveSessionHandoffExportMetadata } from './runtimeLocalSessionHandoffMetadata';

describe('resolveSessionHandoffExportMetadata', () => {
    it('exports the persisted Claude transcript from the runner launch root on the same Machine', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-persisted-launch-'));
        const runtime = await createAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.claude'] },
        });
        try {
            const workspace = join(activeServerDir, 'workspace');
            await mkdir(workspace);
            const projectId = (await realpath(workspace)).replace(/[^a-zA-Z0-9]/g, '-');
            const daemonConfig = join(activeServerDir, 'daemon-config');
            const launchConfig = join(activeServerDir, 'launch-config');
            for (const [configDir, text] of [[daemonConfig, 'daemon_root'], [launchConfig, 'launch_root']] as const) {
                const projectDir = join(configDir, 'projects', projectId);
                await mkdir(projectDir, { recursive: true });
                await writeFile(join(projectDir, 'native-claude.jsonl'), JSON.stringify({ type: 'assistant', text }) + '\n');
            }
            vi.stubEnv('CLAUDE_CONFIG_DIR', daemonConfig);

            const startup = {
                machineId: 'machine-source', host: 'source', path: workspace, flavor: 'claude',
                claudeSessionId: 'native-claude',
                runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: { backendMode: 'agentSdk' } },
            };
            const localMetadata = await buildHandoffSessionMetadataFromTrackedSession({
                trackedSession: {
                    trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon', pid: 123,
                    happySessionMetadataFromLocalWebhook: startup,
                },
            });
            const metadata = resolveSessionHandoffExportMetadata({
                localMetadata,
                remoteMetadata: {
                    ...startup,
                    runtimeDescriptorV1: {
                        ...startup.runtimeDescriptorV1, agent: { backendMode: 'agentSdk', configDir: launchConfig },
                    },
                },
                preferredLocalExportMachineId: 'machine-source',
            });

            const { agentBundle } = await exportSessionHandoffAgentBundle({ activeServerDir, metadata });
            expect(await readSessionHandoffAgentBundleRecords(agentBundle)).toEqual([{ type: 'assistant', text: 'launch_root' }]);
        } finally {
            vi.unstubAllEnvs();
            await runtime.dispose();
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('supplements same-machine remote metadata with a local handoff overlay when the remote snapshot has dropped handoffV1', () => {
        const localHandoffV1 = {
            v: 1,
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            agentId: 'claude',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            transportStrategy: 'direct_peer',
            completedAtMs: 1,
            sourceWorkspaceRootPath: '/repo-source-root',
            targetWorkspaceRootPath: '/repo-target-root',
        };

        const resolved = resolveSessionHandoffExportMetadata({
            remoteMetadata: {
                machineId: 'machine_target',
                path: '/repo-target-root',
                homeDir: '/Users/target',
                flavor: 'claude',
            },
            localMetadata: {
                exportMetadata: {
                    machineId: 'machine_target',
                    path: '/repo-target-root',
                    homeDir: '/Users/target',
                    flavor: 'claude',
                    handoffV1: localHandoffV1,
                },
                runtimeLocalMetadata: {
                    claudeSessionId: 'sess-handoff-direct',
                },
            },
            preferredLocalExportMachineId: 'machine_target',
        });

        expect(resolved).toEqual({
            machineId: 'machine_target',
            path: '/repo-target-root',
            homeDir: '/Users/target',
            flavor: 'claude',
            handoffV1: localHandoffV1,
            claudeSessionId: 'sess-handoff-direct',
        });
    });

    it('preserves newer remote portable metadata while overlaying local runtime metadata', () => {
        const resolved = resolveSessionHandoffExportMetadata({
            remoteMetadata: {
                machineId: 'machine_target',
                path: '/repo-source-current',
                homeDir: '/Users/tester',
                flavor: 'claude',
            },
            localMetadata: {
                exportMetadata: {
                    machineId: 'machine_target',
                    path: '/repo-source-stale',
                    homeDir: '/Users/tester',
                    flavor: 'claude',
                },
                runtimeLocalMetadata: {
                    claudeSessionId: 'sess-handoff-direct',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine_target',
                        remoteSessionId: 'sess-handoff-direct',
                        source: {
                            kind: 'claudeConfig',
                            configDir: '/tmp/claude-config',
                            projectId: 'proj-handoff-direct',
                        },
                        linkedAtMs: 1,
                    },
                },
            },
        });

        expect(resolved).toEqual({
            machineId: 'machine_target',
            path: '/repo-source-current',
            homeDir: '/Users/tester',
            flavor: 'claude',
            claudeSessionId: 'sess-handoff-direct',
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: 'machine_target',
                remoteSessionId: 'sess-handoff-direct',
                source: {
                    kind: 'claudeConfig',
                    configDir: '/tmp/claude-config',
                    projectId: 'proj-handoff-direct',
                },
                linkedAtMs: 1,
            },
        });
    });

    it('ignores legacy raw-record local metadata (V2 split required; no undeployed compatibility)', () => {
        const resolved = resolveSessionHandoffExportMetadata({
            remoteMetadata: {
                machineId: 'machine_target',
                path: '/repo-source-current',
                homeDir: '/Users/tester',
                flavor: 'claude',
            },
            // Boundary cast: simulates legacy runtime input that no longer matches the V2-only type.
            localMetadata: ({
                // Previously we accepted raw-record local metadata and overlaid it.
                // This is intentionally rejected so handoff metadata is always shaped as the
                // split portable+runtime-local payload (no undeployed compatibility shims).
                machineId: 'machine_target',
                path: '/repo-source-stale',
                homeDir: '/Users/tester',
                flavor: 'claude',
                claudeSessionId: 'sess-legacy-local',
            }) as unknown as Parameters<typeof resolveSessionHandoffExportMetadata>[0]['localMetadata'],
        });

        expect(resolved).toEqual({
            machineId: 'machine_target',
            path: '/repo-source-current',
            homeDir: '/Users/tester',
            flavor: 'claude',
        });
    });

    it('prefers live local export metadata when the remote snapshot is still pinned to a different source machine', () => {
        const resolved = resolveSessionHandoffExportMetadata({
            remoteMetadata: {
                machineId: 'machine_source',
                path: '/repo-source-stale',
                homeDir: '/Users/source',
                flavor: 'claude',
                portableMetadataVersion: 'v2',
            },
            localMetadata: {
                exportMetadata: {
                    machineId: 'machine_target',
                    path: '/repo-source-current',
                    homeDir: '/Users/target',
                    flavor: 'claude',
                },
                runtimeLocalMetadata: {
                    claudeSessionId: 'sess-handoff-direct',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine_target',
                        remoteSessionId: 'sess-handoff-direct',
                        source: {
                            kind: 'claudeConfig',
                            configDir: '/tmp/claude-config',
                            projectId: 'proj-handoff-direct',
                        },
                        linkedAtMs: 1,
                    },
                },
            },
            preferredLocalExportMachineId: 'machine_target',
        });

        expect(resolved).toEqual({
            machineId: 'machine_target',
            path: '/repo-source-current',
            homeDir: '/Users/target',
            flavor: 'claude',
            portableMetadataVersion: 'v2',
            claudeSessionId: 'sess-handoff-direct',
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: 'machine_target',
                remoteSessionId: 'sess-handoff-direct',
                source: {
                    kind: 'claudeConfig',
                    configDir: '/tmp/claude-config',
                    projectId: 'proj-handoff-direct',
                },
                linkedAtMs: 1,
            },
        });
    });

    it('converts a released linked row to the canonical row through the handoff metadata split', () => {
        // Released ingress shape: the immutable `directSessionV1` writers used `providerId`.
        const released = {
            v: 1,
            providerId: 'claude',
            machineId: 'machine_target',
            remoteSessionId: 'sess-released',
            source: {
                kind: 'claudeConfig',
                configDir: '/tmp/claude-config',
                projectId: 'proj-released',
            },
            linkedAtMs: 1,
        };

        const resolved = resolveSessionHandoffExportMetadata({
            remoteMetadata: {
                machineId: 'machine_target',
                path: '/repo-target',
                directSessionV1: released,
            },
            localMetadata: null,
        });

        // The released row is accepted and normalized: the Protocol canonicalization owner emits
        // only the canonical `externalSessionV1` envelope and drops the released duplicate.
        expect(resolved).toEqual({
            machineId: 'machine_target',
            path: '/repo-target',
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: 'machine_target',
                remoteSessionId: 'sess-released',
                source: released.source,
                linkData: { projectId: 'proj-released' },
                linkedAtMs: 1,
            },
        });
        expect(resolved?.externalSessionV1).not.toHaveProperty('qualifiedIdentity');
    });

    it('preserves an unavailable plugin identity on the canonical linked row', () => {
        const qualifiedIdentity = {
            v: 1 as const,
            agent: {
                pluginId: 'com.example.uninstalled-agent',
                localId: 'assistant',
            },
            source: {
                kind: 'exampleHistory',
                contractVersion: 1 as const,
            },
        };

        const resolved = resolveSessionHandoffExportMetadata({
            remoteMetadata: {
                machineId: 'machine_target',
                path: '/repo-target',
                externalSessionV1: {
                    v: 1,
                    agentId: 'assistant',
                    machineId: 'machine_target',
                    remoteSessionId: 'sess-qualified',
                    source: {
                        kind: 'exampleHistory',
                        location: 'opaque-source',
                    },
                    qualifiedIdentity,
                    linkData: {
                        opaqueIdentity: 'plugin-owned',
                    },
                },
            },
            localMetadata: null,
        });

        // The plugin-owned identity survives canonicalization verbatim, and no released
        // duplicate row is written back alongside it.
        expect(resolved).toEqual({
            machineId: 'machine_target',
            path: '/repo-target',
            externalSessionV1: {
                v: 1,
                agentId: 'assistant',
                machineId: 'machine_target',
                remoteSessionId: 'sess-qualified',
                source: {
                    kind: 'exampleHistory',
                    location: 'opaque-source',
                },
                qualifiedIdentity,
                linkData: {
                    opaqueIdentity: 'plugin-owned',
                },
            },
        });
    });

    it('does not use a released row when the current linked row is present but malformed', () => {
        const metadata = {
            machineId: 'machine_target',
            path: '/repo-target',
            externalSessionV1: {
                v: 1,
                agentId: '',
                machineId: 'machine_target',
                remoteSessionId: 'sess-malformed',
                source: { kind: 'exampleHistory' },
            },
            directSessionV1: {
                v: 1,
                providerId: 'claude',
                machineId: 'machine_target',
                remoteSessionId: 'sess-released',
                source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
            },
        };

        expect(resolveSessionHandoffExportMetadata({
            remoteMetadata: metadata,
            localMetadata: null,
        })).toEqual(metadata);
    });

    it('preserves remote handoffV1 when preferring local export metadata', () => {
        const remoteHandoffV1 = {
            v: 1,
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            agentId: 'claude',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 1,
            // This is consumed by session handoff to resolve sync-changes handoff-back roots.
            sourceWorkspaceRootPath: '/repo-target',
        };

        const resolved = resolveSessionHandoffExportMetadata({
            remoteMetadata: {
                machineId: 'machine_source',
                path: '/repo-source-stale',
                homeDir: '/Users/source',
                flavor: 'claude',
                portableMetadataVersion: 'v2',
                handoffV1: remoteHandoffV1,
            },
            localMetadata: {
                exportMetadata: {
                    machineId: 'machine_target',
                    path: '/repo-source-current',
                    homeDir: '/Users/target',
                    flavor: 'claude',
                    // A stale local snapshot may still have a handoff marker that should not override the remote one.
                    handoffV1: {
                        v: 1,
                        sourceMachineId: 'machine_target',
                        targetMachineId: 'machine_source',
                    },
                },
                runtimeLocalMetadata: {
                    claudeSessionId: 'sess-handoff-direct',
                },
            },
            preferredLocalExportMachineId: 'machine_target',
        });

        expect(resolved).toEqual(expect.objectContaining({
            machineId: 'machine_target',
            path: '/repo-source-current',
            homeDir: '/Users/target',
            flavor: 'claude',
            portableMetadataVersion: 'v2',
            claudeSessionId: 'sess-handoff-direct',
            handoffV1: remoteHandoffV1,
        }));
    });
});
