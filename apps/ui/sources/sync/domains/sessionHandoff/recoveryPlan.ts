import {
    projectSessionMetadataForAgentHandoff,
    resolveAgentIdFromSessionMetadata,
    resolveVendorHandoffIdFromSessionMetadata,
    isBundledAgentId,
} from '@happier-dev/agents';
import {
    ExternalSessionAgentIdSchema,
    readRuntimeDescriptorV1FromMetadata,
    type ExternalSessionAgentId,
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
    agent: ExternalSessionAgentId;
    resume?: string;
    transcriptStorage: 'direct' | 'persisted';
    serverId: string | null;
    runtimeDescriptorV1?: unknown;
    environmentVariables?: Record<string, string>;
}>;

function resolveRecoveryAgentId(metadata: Metadata): ExternalSessionAgentId | null {
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const parsed = ExternalSessionAgentIdSchema.safeParse(agentId);
    return parsed.success ? parsed.data : null;
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
        agentId: ExternalSessionAgentId;
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

function resolveRuntimeDescriptorVendorResumeId(
    runtimeDescriptor: RuntimeDescriptorV1 | null,
): string | undefined {
    const providerSessionId = runtimeDescriptor?.agent.providerSessionId;
    if (typeof providerSessionId !== 'string') return undefined;
    const normalized = providerSessionId.trim();
    return normalized || undefined;
}

function resolveVendorResumeId(
    agentId: ExternalSessionAgentId,
    metadata: ReturnType<typeof projectSessionMetadataForAgentHandoff>,
    runtimeDescriptor: RuntimeDescriptorV1 | null,
): string | undefined {
    const descriptorResumeId = resolveRuntimeDescriptorVendorResumeId(runtimeDescriptor);
    if (!isBundledAgentId(agentId)) return descriptorResumeId;
    return resolveVendorHandoffIdFromSessionMetadata(agentId, metadata) ?? descriptorResumeId;
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

    const agentMetadata = projectSessionMetadataForAgentHandoff(input.sourceMetadata);
    const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(agentMetadata);
    // Every Agent reaches the one descriptor interpreter here: a bundled Agent
    // through its build-time projection and an installed one through the
    // descriptor its source machine published. The machine is passed explicitly
    // because the Agent-facing metadata view carries no host-owned machine id.
    const sourceRecoveryPatch = buildSessionHandoffSourceRecoveryResumePatch({
        agentId: agent,
        machineId: input.sourceMachineId,
        metadata: agentMetadata,
        ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    });
    const vendorResumeId = resolveVendorResumeId(agent, agentMetadata, runtimeDescriptorV1);

    return {
        handoffId: input.handoffId,
        actions: ['restart_on_source', 'keep_stopped'],
        sourceResume: {
            sessionId: input.sessionId,
            machineId: input.sourceMachineId,
            directory,
            agent,
            ...(vendorResumeId ? { resume: vendorResumeId } : {}),
            transcriptStorage: input.sessionStorageMode,
            serverId: typeof input.serverId === 'string' ? input.serverId.trim() || null : null,
            ...(runtimeDescriptorV1
                ? { runtimeDescriptorV1 }
                : {}),
            ...(sourceRecoveryPatch?.environmentVariables
                ? { environmentVariables: sourceRecoveryPatch.environmentVariables }
                : {}),
        },
    };
}
