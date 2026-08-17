import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexBackendMode } from '@happier-dev/protocol';

const buildProviderPatchInputMock = vi.hoisted(() => vi.fn());

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getAgentBehavior: (agentId: Parameters<typeof actual.getAgentBehavior>[0]) => {
            const behavior = actual.getAgentBehavior(agentId);
            const buildProviderPatch = behavior.sessionHandoff?.buildProviderPatch;
            return {
                ...behavior,
                sessionHandoff: {
                    ...behavior.sessionHandoff,
                    buildProviderPatch: buildProviderPatch
                        ? (input: Parameters<typeof buildProviderPatch>[0]) => {
                            buildProviderPatchInputMock(input);
                            return buildProviderPatch(input);
                        }
                        : undefined,
                },
            };
        },
    };
});

import { buildSessionHandoffMetadataPatch } from './buildSessionHandoffMetadataPatch';

describe('buildSessionHandoffMetadataPatch', () => {
    const legacyCodexBackendMode = '  mcp_resume  ' as unknown as CodexBackendMode;

    beforeEach(() => {
        buildProviderPatchInputMock.mockReset();
    });

    it('stores source/target workspace roots in handoffV1 for handoff-back planning', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'claude',
                path: '/Users/leeroy/wsrepl-large',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_old',
            },
            agentId: 'claude',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'persisted',
            sessionStorageAfter: 'persisted',
            targetPath: '/home/guest/wsrepl-large-replication-9',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 123,
            targetRemoteSessionId: 'claude_new',
            targetDirectSource: { kind: 'claudeConfig', configDir: null, projectId: null },
        });

        expect(updated.handoffV1).toMatchObject({
            sourceWorkspaceRootPath: '/Users/leeroy/wsrepl-large',
            targetWorkspaceRootPath: '/home/guest/wsrepl-large-replication-9',
        });
    });

    it('preserves a Windows source workspace root as opaque handoff-back state', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'claude',
                path: 'C:\\Users\\alice\\projects\\demo',
                host: 'windows-source',
                machineId: 'machine_windows_source',
                claudeSessionId: 'claude_old',
            },
            agentId: 'claude',
            sourceMachineId: 'machine_windows_source',
            targetMachineId: 'machine_linux_target',
            sessionStorageBefore: 'persisted',
            sessionStorageAfter: 'persisted',
            targetPath: '/home/guest/projects/demo-replication-9',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 123,
            targetRemoteSessionId: 'claude_new',
            targetDirectSource: { kind: 'claudeConfig', configDir: null, projectId: null },
        });

        expect(updated.handoffV1).toMatchObject({
            sourceWorkspaceRootPath: 'C:\\Users\\alice\\projects\\demo',
            targetWorkspaceRootPath: '/home/guest/projects/demo-replication-9',
        });
    });

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
            agentId: 'codex',
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
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'codex',
            agent: {
                backendMode: 'acp',
                providerSessionId: 'thread_new',
                agentExtra: {
                    owner: 'codex',
                    schemaId: 'codex.agentRuntimeDescriptorExtra',
                    v: 1,
                },
            },
        });
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
    });

    it('normalizes legacy codex backend aliases when rebuilding handoff metadata', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'codex',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                codexSessionId: 'thread_old',
                codexBackendMode: legacyCodexBackendMode,
            },
            agentId: 'codex',
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

        expect(updated.codexBackendMode).toBe('acp');
        expect(updated.runtimeDescriptorV1).toMatchObject({
            agentId: 'codex',
            agent: {
                backendMode: 'acp',
                providerSessionId: 'thread_new',
            },
        });
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
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
            agentId: 'codex',
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
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'thread_connected',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex',
                },
            },
        });

        expect(updated.externalSessionV1).toMatchObject({
            source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
        });
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'codex',
            agent: {
                backendMode: 'appServer',
                providerSessionId: 'thread_connected',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
            },
        });
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
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
            agentId: 'codex',
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

        expect(updated.runtimeDescriptorV1).toMatchObject({
            agentId: 'codex',
            agent: {
                backendMode: 'acp',
                providerSessionId: 'thread_connected',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
                homePath: '/tmp/connected-codex-home',
            },
        });
        expect(updated.externalSessionV1).toMatchObject({
            source: {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
                homePath: '/tmp/connected-codex-home',
            },
            runtimeDescriptorV1: expect.objectContaining({
                agentId: 'codex',
            }),
        });
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
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
                externalSessionOperationV1: {
                    v: 1,
                    progress: { operationId: 'target-owner-operation-private' },
                },
                externalSessionOperationPresentationV1: {
                    v: 1,
                    operationId: 'target-shared-operation-private',
                },
                unrelatedOwnerOnlySentinel: 'target-must-not-reach-agent-code',
            },
            sourceMetadataForHandoff: {
                flavor: 'opencode',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                opencodeSessionId: 'sess_old',
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'http://old.example',
                opencodeServerBaseUrlExplicit: true,
                externalSessionOperationV1: {
                    v: 1,
                    progress: { operationId: 'source-owner-operation-private' },
                },
                externalSessionOperationPresentationV1: {
                    v: 1,
                    operationId: 'source-shared-operation-private',
                },
                unrelatedOwnerOnlySentinel: 'source-must-not-reach-agent-code',
            },
            agentId: 'opencode',
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
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'opencode',
            agent: {
                backendMode: 'server',
                providerSessionId: 'sess_new',
                serverBaseUrl: 'http://new.example',
                serverBaseUrlExplicit: true,
                agentExtra: {
                    owner: 'opencode',
                    schemaId: 'opencode.agentRuntimeDescriptorExtra',
                    v: 1,
                },
            },
        });
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
        expect(updated.externalSessionOperationV1).toEqual({
            v: 1,
            progress: { operationId: 'target-owner-operation-private' },
        });
        expect(buildProviderPatchInputMock).toHaveBeenCalledWith(expect.objectContaining({
            metadata: {
                path: '/repo/target',
                opencodeSessionId: 'sess_new',
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'http://old.example',
                opencodeServerBaseUrlExplicit: true,
            },
            sourceMetadataForHandoff: {
                path: '/repo/source',
                opencodeSessionId: 'sess_old',
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'http://old.example',
                opencodeServerBaseUrlExplicit: true,
            },
        }));
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
            agentId: 'opencode',
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
                agentId: 'opencode',
                agent: {
                    backendMode: 'server',
                    providerSessionId: 'sess_new',
                    serverBaseUrl: 'http://canonical.example',
                    serverBaseUrlExplicit: true,
                },
            },
        });

        expect(updated.opencodeBackendMode).toBe('server');
        expect(updated.opencodeServerBaseUrl).toBe('http://canonical.example');
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'opencode',
            agent: {
                backendMode: 'server',
                providerSessionId: 'sess_new',
                serverBaseUrl: 'http://canonical.example',
                serverBaseUrlExplicit: true,
            },
        });
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
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
                    agentId: 'opencode',
                    remoteSessionId: 'old_remote',
                    importedAtMs: 1,
                    source: { kind: 'opencodeServer', baseUrl: 'http://old.example' },
                },
            },
            agentId: 'opencode',
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
                    agentId: 'codex',
                    provider: { backendMode: 'appServer', providerSessionId: 'thread_old' },
                },
            },
            agentId: 'claude',
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

        expect(updated).not.toHaveProperty('runtimeDescriptorV1');
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
    });

    it('clears stale Claude machine-local transcript metadata after handoff rebinding', () => {
        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'claude',
                path: '/repo/source',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_old',
                claudeTranscriptPath: '/Users/source/.claude/projects/proj-old/claude_session_old.jsonl',
                claudeLastCheckpointId: 'checkpoint_old',
                claudeLastAssistantUuid: 'assistant_old',
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine_source',
                    remoteSessionId: 'claude_session_old',
                    source: {
                        kind: 'claudeConfig',
                        configDir: '/Users/source/.claude',
                        projectId: 'proj-old',
                    },
                    linkedAtMs: 1,
                },
            },
            agentId: 'claude',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 1234,
            targetRemoteSessionId: 'claude_session_new',
            targetDirectSource: {
                kind: 'claudeConfig',
                configDir: '/Users/target/.claude',
                projectId: 'proj-target',
            },
        });

        expect(updated.claudeSessionId).toBe('claude_session_new');
        expect(updated).not.toHaveProperty('claudeTranscriptPath');
        expect(updated).not.toHaveProperty('claudeLastCheckpointId');
        expect(updated).not.toHaveProperty('claudeLastAssistantUuid');
        expect(updated.externalSessionV1).toMatchObject({
            machineId: 'machine_target',
            remoteSessionId: 'claude_session_new',
            source: {
                kind: 'claudeConfig',
                configDir: '/Users/target/.claude',
                projectId: 'proj-target',
            },
        });
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
            agentId: 'opencode',
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
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'opencode',
            agent: {
                backendMode: 'server',
                providerSessionId: 'sess_new',
                serverBaseUrl: 'http://new.example',
                serverBaseUrlExplicit: true,
                agentExtra: {
                    owner: 'opencode',
                    schemaId: 'opencode.agentRuntimeDescriptorExtra',
                    v: 1,
                },
            },
        });
        expect(updated).not.toHaveProperty('agentRuntimeDescriptorV1');
    });
});
