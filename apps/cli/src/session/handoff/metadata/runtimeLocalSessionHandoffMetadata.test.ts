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
});
