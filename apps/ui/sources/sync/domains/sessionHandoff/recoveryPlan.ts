import {
    buildOpenCodeAgentRuntimeDescriptor,
    readSessionMetadataRuntimeDescriptor,
    resolveVendorHandoffIdFromSessionMetadata,
    type AgentId,
} from '@happier-dev/agents';
import { normalizeCodexBackendMode } from '@happier-dev/protocol';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import type { Metadata } from '@/sync/domains/state/storageTypes';

type SessionHandoffRecoveryAction = 'restart_on_source' | 'keep_stopped';

export type SessionHandoffSourceResumePlan = Readonly<{
    sessionId: string;
    machineId: string;
    directory: string;
    agent: AgentId;
    resume?: string;
    transcriptStorage: 'direct' | 'persisted';
    serverId: string | null;
    agentRuntimeDescriptorV1?: unknown;
    codexBackendMode?: 'mcp' | 'acp' | 'appServer';
    environmentVariables?: Record<string, string>;
}>;

function buildSourceResumeEnvironmentVariables(metadata: Metadata): Record<string, string> | undefined {
    const openCodeRuntime = readSessionMetadataRuntimeDescriptor(metadata, 'opencode');
    const legacyBackendMode = metadata.opencodeBackendMode === 'server' || metadata.opencodeBackendMode === 'acp'
        ? metadata.opencodeBackendMode
        : null;
    const backendMode = openCodeRuntime?.backendMode ?? legacyBackendMode;
    if (backendMode === 'server') {
        const serverBaseUrl = openCodeRuntime?.serverBaseUrl ?? (typeof metadata.opencodeServerBaseUrl === 'string' ? metadata.opencodeServerBaseUrl : null);
        const serverBaseUrlExplicit = openCodeRuntime?.serverBaseUrlExplicit ?? Boolean(metadata.opencodeServerBaseUrlExplicit);
        const env: Record<string, string> = {
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        };
        if (serverBaseUrl) {
            env.HAPPIER_OPENCODE_SERVER_URL = serverBaseUrl;
            if (serverBaseUrlExplicit) {
                env.HAPPIER_OPENCODE_SERVER_URL_EXPLICIT = '1';
            }
        }
        return env;
    }
    return undefined;
}

function resolveRecoveryAgentId(metadata: Metadata): AgentId | null {
    const byFlavor = resolveAgentIdFromFlavor(metadata.flavor);
    if (byFlavor) return byFlavor;

    if (readSessionMetadataRuntimeDescriptor(metadata, 'codex')) return 'codex';
    if (readSessionMetadataRuntimeDescriptor(metadata, 'opencode')) return 'opencode';
    if (readSessionMetadataRuntimeDescriptor(metadata, 'pi')) return 'pi';
    return null;
}

export type SessionHandoffRecoveryPlan = Readonly<{
    handoffId: string;
    actions: readonly SessionHandoffRecoveryAction[];
    sourceResume?: SessionHandoffSourceResumePlan;
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
            ...(input.sourceMetadata.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: input.sourceMetadata.agentRuntimeDescriptorV1 } : {}),
            ...(codexBackendMode ? { codexBackendMode } : {}),
            ...(buildSourceResumeEnvironmentVariables(input.sourceMetadata)
                ? { environmentVariables: buildSourceResumeEnvironmentVariables(input.sourceMetadata)! }
                : {}),
        },
    };
}
