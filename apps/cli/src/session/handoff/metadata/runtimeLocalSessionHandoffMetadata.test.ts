import { describe, expect, it } from 'vitest';

import { resolveSessionHandoffExportMetadata } from './runtimeLocalSessionHandoffMetadata';

describe('resolveSessionHandoffExportMetadata', () => {
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
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
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
            directSessionV1: {
                v: 1,
                providerId: 'claude',
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
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
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
            directSessionV1: {
                v: 1,
                providerId: 'claude',
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

    it('preserves remote handoffV1 when preferring local export metadata', () => {
        const remoteHandoffV1 = {
            v: 1,
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            providerId: 'claude',
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
