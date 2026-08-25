import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexBackendMode } from '@happier-dev/protocol';

const buildProviderPatchInputMock = vi.hoisted(() => vi.fn());

vi.mock('@/agents/registry/registryUiBehavior', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/registry/registryUiBehavior')>();
    return {
        ...actual,
        resolveAgentUiBehavior: (
            agentId: Parameters<typeof actual.resolveAgentUiBehavior>[0],
            machineId?: Parameters<typeof actual.resolveAgentUiBehavior>[1],
        ) => {
            const behavior = actual.resolveAgentUiBehavior(agentId, machineId);
            const buildProviderPatch = behavior.sessionHandoff?.buildProviderPatch;
            if (!buildProviderPatch) return behavior;
            return {
                ...behavior,
                sessionHandoff: {
                    ...behavior.sessionHandoff,
                    buildProviderPatch: (input: Parameters<typeof buildProviderPatch>[0]) => {
                        buildProviderPatchInputMock({ ...input, resolvedForMachineId: machineId ?? null });
                        return buildProviderPatch(input);
                    },
                },
            };
        },
    };
});

import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';

import { buildSessionHandoffMetadataPatch } from './buildSessionHandoffMetadataPatch';

describe('buildSessionHandoffMetadataPatch', () => {
    const legacyCodexBackendMode = '  mcp_resume  ' as unknown as CodexBackendMode;

    beforeEach(() => {
        buildProviderPatchInputMock.mockReset();
        clearProjectedAgentUiBehaviorDescriptors();
    });

    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
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
                opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
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
                opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
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
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4097/', directory: '/repo/target' },
        });

        expect(updated.opencodeSessionId).toBe('sess_new');
        expect(updated.opencodeBackendMode).toBe('server');
        expect(updated.opencodeServerBaseUrl).toBe('http://127.0.0.1:4097');
        expect(updated.opencodeServerBaseUrlExplicit).toBe(true);
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'opencode',
            agent: {
                backendMode: 'server',
                providerSessionId: 'sess_new',
                serverBaseUrl: 'http://127.0.0.1:4097',
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
        // The Agent-facing handoff view carries the Agent's own resume facts and
        // nothing the host owns, and the behavior is resolved for the machine that
        // owns the session after the handoff.
        expect(buildProviderPatchInputMock).toHaveBeenCalledWith(expect.objectContaining({
            resolvedForMachineId: 'machine_target',
            metadata: {
                path: '/repo/target',
                providerSessionId: 'sess_new',
                opencodeSessionId: 'sess_new',
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
                opencodeServerBaseUrlExplicit: true,
            },
            sourceMetadataForHandoff: {
                path: '/repo/source',
                providerSessionId: 'sess_old',
                opencodeSessionId: 'sess_old',
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
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
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4097/', directory: '/repo/target' },
            targetRuntimeDescriptor: {
                v: 1,
                agentId: 'opencode',
                agent: {
                    backendMode: 'server',
                    providerSessionId: 'sess_new',
                    serverBaseUrl: 'http://127.0.0.1:4098/',
                    serverBaseUrlExplicit: true,
                },
            },
        });

        expect(updated.opencodeBackendMode).toBe('server');
        expect(updated.opencodeServerBaseUrl).toBe('http://127.0.0.1:4098');
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'opencode',
            agent: {
                backendMode: 'server',
                providerSessionId: 'sess_new',
                serverBaseUrl: 'http://127.0.0.1:4098',
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
                    source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
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
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4097/', directory: '/repo/target' },
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

    it('preserves an installed Agent handoff identity and runtime descriptor without a bundled behavior patch', () => {
        const runtimeDescriptorV1 = {
            v: 1,
            agentId: 'acme.agent',
            agent: {
                providerSessionId: 'external_target_session',
            },
        } as const;

        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'claude',
                host: 'source-host',
                machineId: 'machine_source',
                path: '/repo/source',
                claudeSessionId: 'claude_source_session',
            },
            agentId: 'acme.agent',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'persisted',
            sessionStorageAfter: 'direct',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 123,
            targetRemoteSessionId: 'external_target_session',
            targetDirectSource: { kind: 'claudeConfig', configDir: null, projectId: null },
            targetRuntimeDescriptor: runtimeDescriptorV1,
        });

        expect(updated).toMatchObject({
            flavor: 'acme.agent',
            machineId: 'machine_target',
            path: '/repo/target',
            runtimeDescriptorV1,
            externalSessionV1: {
                agentId: 'acme.agent',
                machineId: 'machine_target',
                remoteSessionId: 'external_target_session',
                runtimeDescriptorV1,
            },
            handoffV1: {
                agentId: 'acme.agent',
            },
        });
        expect(updated).not.toHaveProperty('claudeSessionId');
        expect(buildProviderPatchInputMock).not.toHaveBeenCalled();
    });

    it("applies an installed Agent's declared handoff cleanup from the target machine descriptor", () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine_target',
            descriptorsByAgentId: {
                'acme.agent': {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: 'acme.agent',
                    version: 1,
                    behavior: {
                        externalSessions: {
                            sessionHandoff: { clearMetadataKeys: ['acmeTargetStaleKey'] },
                        },
                    },
                },
            },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine_source',
            descriptorsByAgentId: {
                'acme.agent': {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: 'acme.agent',
                    version: 1,
                    behavior: {
                        externalSessions: {
                            sessionHandoff: { clearMetadataKeys: ['acmeSourceOnlyKey'] },
                        },
                    },
                },
            },
        });

        const updated = buildSessionHandoffMetadataPatch({
            metadata: {
                flavor: 'acme.agent',
                host: 'source-host',
                machineId: 'machine_source',
                path: '/repo/source',
                acmeTargetStaleKey: 'stale',
                acmeSourceOnlyKey: 'kept',
            } as unknown as Parameters<typeof buildSessionHandoffMetadataPatch>[0]['metadata'],
            agentId: 'acme.agent',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageBefore: 'persisted',
            sessionStorageAfter: 'persisted',
            targetPath: '/repo/target',
            transportStrategy: 'server_routed_stream',
            completedAtMs: 123,
            targetRemoteSessionId: 'acme_target_session',
            targetDirectSource: { kind: 'acmeWorkspace' },
        });

        expect(updated).not.toHaveProperty('acmeTargetStaleKey');
        expect(updated.acmeSourceOnlyKey).toBe('kept');
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
            targetDirectSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4097/', directory: '/repo/target' },
        });

        expect(updated.opencodeBackendMode).toBe('server');
        expect(updated.opencodeServerBaseUrl).toBe('http://127.0.0.1:4097');
        expect(updated.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'opencode',
            agent: {
                backendMode: 'server',
                providerSessionId: 'sess_new',
                serverBaseUrl: 'http://127.0.0.1:4097',
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
