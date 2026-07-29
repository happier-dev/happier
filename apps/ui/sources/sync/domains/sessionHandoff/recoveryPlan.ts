import {
    resolveAgentIdFromSessionMetadata,
    resolveVendorHandoffIdFromSessionMetadata,
    type AgentId,
} from '@happier-dev/agents';
import {
    normalizeCodexBackendMode,
    readRuntimeDescriptorV1FromMetadata,
    type RuntimeDescriptorV1,
    type SessionHandoffStorageMode,
    type SessionHandoffTransportStrategy,
} from '@happier-dev/protocol';
import { buildSessionHandoffSourceRecoveryResumePatch } from '@/agents/registry/registryUiBehavior';
import type { Metadata } from '@/sync/domains/state/storageTypes';

export type SessionHandoffRecoveryAction =
    | 'restart_on_source'
    | 'keep_stopped'
    | 'retry_source_cleanup';

export type SessionHandoffSourceResumePlan = Readonly<{
    sessionId: string;
    machineId: string;
    directory: string;
    agent: AgentId;
    resume?: string;
    transcriptStorage: 'direct' | 'persisted';
    serverId: string | null;
    runtimeDescriptorV1?: unknown;
    codexBackendMode?: 'mcp' | 'acp' | 'appServer';
    environmentVariables?: Record<string, string>;
}>;

function resolveRecoveryAgentId(metadata: Metadata): AgentId | null {
    return resolveAgentIdFromSessionMetadata(metadata);
}

export type SessionHandoffRecoveryPlan = Readonly<{
    handoffId: string;
    actions: readonly SessionHandoffRecoveryAction[];
    sourceResume?: SessionHandoffSourceResumePlan;
    committedTarget?: Readonly<{
        sessionId: string;
        sourceMachineId: string;
        targetMachineId: string;
        serverId: string | null;
        sourceMetadataForHandoff: Metadata;
        agentId: AgentId;
        sessionStorageBefore: SessionHandoffStorageMode;
        sessionStorageAfter: SessionHandoffStorageMode;
        targetPath: string;
        transportStrategy: SessionHandoffTransportStrategy;
        completedAtMs: number;
        targetRemoteSessionId: string;
        targetDirectSource: Record<string, unknown>;
        targetRuntimeDescriptor?: RuntimeDescriptorV1;
    }>;
    sourceCleanup?: Readonly<{
        machineId: string;
        serverId: string | null;
        workspaceReplicationReverseSourceRootPath: string;
        workspaceReplicationReverseTargetRootPath: string | null;
    }>;
}>;

function resolveVendorResumeId(metadata: Metadata): string | undefined {
    const agentId = resolveRecoveryAgentId(metadata);
    if (!agentId) return undefined;

    return resolveVendorHandoffIdFromSessionMetadata(agentId, metadata) ?? undefined;
}

export function buildSessionHandoffRecoveryPlan(input: Readonly<{
    handoffId: string;
    sessionId: string;
    sourceMachineId: string;
    sourceMetadata: Metadata;
    sessionStorageMode: 'direct' | 'persisted';
    serverId?: string | null;
}>): SessionHandoffRecoveryPlan | null {
    const agent = resolveRecoveryAgentId(input.sourceMetadata);
    const directory = typeof input.sourceMetadata.path === 'string' ? input.sourceMetadata.path.trim() : '';
    if (!agent || !directory) return null;

    const codexBackendMode = normalizeCodexBackendMode(input.sourceMetadata.codexBackendMode);
    const sourceRecoveryPatch = buildSessionHandoffSourceRecoveryResumePatch({
        agentId: agent,
        metadata: input.sourceMetadata,
    });

    return {
        handoffId: input.handoffId,
        actions: ['restart_on_source', 'keep_stopped'],
        sourceResume: {
            sessionId: input.sessionId,
            machineId: input.sourceMachineId,
            directory,
            agent,
            ...(resolveVendorResumeId(input.sourceMetadata) ? { resume: resolveVendorResumeId(input.sourceMetadata) } : {}),
            transcriptStorage: input.sessionStorageMode,
            serverId: typeof input.serverId === 'string' ? input.serverId.trim() || null : null,
            ...(readRuntimeDescriptorV1FromMetadata(input.sourceMetadata)
                ? { runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(input.sourceMetadata) }
                : {}),
            ...(codexBackendMode ? { codexBackendMode } : {}),
            ...(sourceRecoveryPatch.environmentVariables
                ? { environmentVariables: sourceRecoveryPatch.environmentVariables }
                : {}),
        },
    };
}
