import { describe, expect, it } from 'vitest';

import { resolveSessionHandoffExportMetadata } from './runtimeLocalSessionHandoffMetadata';

describe('resolveSessionHandoffExportMetadata', () => {
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

    it('writes a released linked row forward through the handoff metadata split', () => {
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

        expect(resolved).toMatchObject({
            directSessionV1: released,
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: 'machine_target',
                remoteSessionId: 'sess-released',
                source: released.source,
                linkData: { projectId: 'proj-released' },
            },
        });
        expect(resolved?.externalSessionV1).not.toHaveProperty('qualifiedIdentity');
    });

    it('preserves an unavailable plugin identity while deriving only the released rollback row', () => {
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

        expect(resolved).toMatchObject({
            externalSessionV1: {
                agentId: 'assistant',
                qualifiedIdentity,
                linkData: {
                    opaqueIdentity: 'plugin-owned',
                },
            },
            directSessionV1: {
                v: 1,
                providerId: 'assistant',
                machineId: 'machine_target',
                remoteSessionId: 'sess-qualified',
                source: {
                    kind: 'exampleHistory',
                    location: 'opaque-source',
                },
            },
        });
        expect(resolved?.directSessionV1).not.toHaveProperty('qualifiedIdentity');
        expect(resolved?.directSessionV1).not.toHaveProperty('linkData');
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
