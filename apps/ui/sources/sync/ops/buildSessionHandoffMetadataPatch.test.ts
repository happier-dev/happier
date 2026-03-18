import { describe, expect, it } from 'vitest';

import { buildSessionHandoffMetadataPatch } from './buildSessionHandoffMetadataPatch';

describe('buildSessionHandoffMetadataPatch', () => {
    it('rebuilds codex runtime descriptor metadata after handoff', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'codex',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                codexSessionId: 'thread_old',
                codexBackendMode: 'acp',
            },
            providerId: 'codex',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'persisted',
            sessionStorageAfter: 'persisted',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 123,
            targetRemoteSessionId: 'thread_new',
            targetDirectSource: { kind: 'codexHome', home: 'user' },
        });

        expect(updated.codexSessionId).toBe('thread_new');
        expect(updated.codexBackendMode).toBe('acp');
        expect(updated.agentRuntimeDescriptorV1).toMatchObject({
            v: 1,
            providerId: 'codex',
            provider: {
                backendMode: 'acp',
                vendorSessionId: 'thread_new',
                providerExtra: {
                    owner: 'codex',
                    schemaId: 'codex.agentRuntimeDescriptorExtra',
                    v: 1,
                    runtimeAffinity: {
                        backendMode: 'acp',
                        vendorSessionId: 'thread_new',
                    },
                },
            },
        });
    });

    it('preserves the imported codex runtime descriptor and connected-service source after handoff', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'codex',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                codexSessionId: 'thread_old',
                codexBackendMode: 'acp',
            },
            providerId: 'codex',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 789,
            targetRemoteSessionId: 'thread_connected',
            targetDirectSource: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
            targetRuntimeDescriptor: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'thread_connected',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex',
                },
            },
        });

        expect(updated.directSessionV1).toMatchObject({
            source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
        });
        expect(updated.agentRuntimeDescriptorV1).toMatchObject({
            v: 1,
            providerId: 'codex',
            provider: {
                backendMode: 'appServer',
                vendorSessionId: 'thread_connected',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
            },
        });
        expect(updated.codexBackendMode).toBe('appServer');
    });

    it('rebuilds codex runtime descriptor with exact connected-service source affinity when no descriptor is imported', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'codex',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                codexSessionId: 'thread_old',
                codexBackendMode: 'acp',
            },
            providerId: 'codex',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 789,
            targetRemoteSessionId: 'thread_connected',
            targetDirectSource: {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
                homePath: '/tmp/connected-codex-home',
            },
        });

        expect(updated.agentRuntimeDescriptorV1).toMatchObject({
            providerId: 'codex',
            provider: {
                backendMode: 'acp',
                vendorSessionId: 'thread_connected',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
                homePath: '/tmp/connected-codex-home',
            },
        });
        expect(updated.directSessionV1).toMatchObject({
            source: {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
                homePath: '/tmp/connected-codex-home',
            },
            agentRuntimeDescriptorV1: expect.objectContaining({
                providerId: 'codex',
            }),
        });
    });

    it('rebuilds opencode runtime descriptor metadata with target server affinity', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'opencode',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                opencodeSessionId: 'sess_old',
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'http://old.example',
                opencodeServerBaseUrlExplicit: true,
            },
            providerId: 'opencode',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'direct_peer',
            completedAtMs: 456,
            targetRemoteSessionId: 'sess_new',
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://new.example', directory: '/repo/target' },
        });

        expect(updated.opencodeSessionId).toBe('sess_new');
        expect(updated.opencodeBackendMode).toBe('server');
        expect(updated.opencodeServerBaseUrl).toBe('http://new.example');
        expect(updated.opencodeServerBaseUrlExplicit).toBe(true);
        expect(updated.agentRuntimeDescriptorV1).toMatchObject({
            v: 1,
            providerId: 'opencode',
            provider: {
                backendMode: 'server',
                vendorSessionId: 'sess_new',
                serverBaseUrl: 'http://new.example',
                serverBaseUrlExplicit: true,
                providerExtra: {
                    owner: 'opencode',
                    schemaId: 'opencode.agentRuntimeDescriptorExtra',
                    v: 1,
                    runtimeHandle: {
                        backendMode: 'server',
                        vendorSessionId: 'sess_new',
                        serverBaseUrl: 'http://new.example',
                        serverBaseUrlExplicit: true,
                    },
                },
            },
        });
    });

    it('preserves the imported OpenCode runtime descriptor when provided', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'opencode',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                opencodeSessionId: 'sess_old',
                opencodeBackendMode: 'acp',
            },
            providerId: 'opencode',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 456,
            targetRemoteSessionId: 'sess_new',
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://new.example', directory: '/repo/target' },
            targetRuntimeDescriptor: {
                v: 1,
                providerId: 'opencode',
                provider: {
                    backendMode: 'server',
                    vendorSessionId: 'sess_new',
                    serverBaseUrl: 'http://canonical.example',
                    serverBaseUrlExplicit: true,
                },
            },
        });

        expect(updated.opencodeBackendMode).toBe('server');
        expect(updated.opencodeServerBaseUrl).toBe('http://canonical.example');
        expect(updated.agentRuntimeDescriptorV1).toMatchObject({
            v: 1,
            providerId: 'opencode',
            provider: {
                backendMode: 'server',
                vendorSessionId: 'sess_new',
                serverBaseUrl: 'http://canonical.example',
                serverBaseUrlExplicit: true,
            },
        });
    });

    it('clears stale externalHistoryImportV1 when a later handoff lands in direct mode', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'opencode',
                host: 'source-host',
                machineId: 'machine_source',
                path: '/repo/source',
                externalHistoryImportV1: {
                    v: 1,
                    providerId: 'opencode',
                    remoteSessionId: 'old_remote',
                    importedAtMs: 1,
                    source: { kind: 'opencodeServer', baseUrl: 'http://old.example' },
                },
            },
            providerId: 'opencode',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'persisted',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'direct_peer',
            completedAtMs: 10,
            targetRemoteSessionId: 'sess_direct',
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://new.example', directory: '/repo/target' },
        });

        expect(updated).not.toHaveProperty('externalHistoryImportV1');
    });

    it('clears stale runtime descriptors when the target provider has no runtime descriptor', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'codex',
                host: 'source-host',
                machineId: 'machine_source',
                path: '/repo/source',
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'codex',
                    provider: { backendMode: 'appServer', vendorSessionId: 'thread_old' },
                },
            },
            providerId: 'claude',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'persisted',
            sessionStorageAfter: 'persisted',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 999,
            targetRemoteSessionId: 'claude_target',
            targetDirectSource: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'p1' },
        });

        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
    });

    it('prefers target OpenCode server affinity over stale legacy backend metadata when no runtime descriptor is imported', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'opencode',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                opencodeSessionId: 'sess_old',
                opencodeBackendMode: 'acp',
            },
            providerId: 'opencode',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'direct_peer',
            completedAtMs: 456,
            targetRemoteSessionId: 'sess_new',
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://new.example', directory: '/repo/target' },
        });

        expect(updated.opencodeBackendMode).toBe('server');
        expect(updated.opencodeServerBaseUrl).toBe('http://new.example');
        expect(updated.agentRuntimeDescriptorV1).toMatchObject({
            v: 1,
            providerId: 'opencode',
            provider: {
                backendMode: 'server',
                vendorSessionId: 'sess_new',
                serverBaseUrl: 'http://new.example',
                serverBaseUrlExplicit: true,
                providerExtra: {
                    owner: 'opencode',
                    schemaId: 'opencode.agentRuntimeDescriptorExtra',
                    v: 1,
                    runtimeHandle: {
                        backendMode: 'server',
                        vendorSessionId: 'sess_new',
                        serverBaseUrl: 'http://new.example',
                        serverBaseUrlExplicit: true,
                    },
                },
            },
        });
    });
});
