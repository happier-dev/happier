import { resolveAgentStateRequestCoverageOptions, type AgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES, isBundledAgentId } from '@happier-dev/agents/agent-ids';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { readDaemonMergedProjectionSummary } from '@/agents/backendCatalog/daemonMergedProjectionCache';
import { resolveSessionMachineId } from '../external/resolveSessionMachineId';
import { readSessionOwnerMetadataView } from '../readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '../presentation/readSessionPresentationAgentId';

type SessionRequestCoverageInput = Readonly<{
    metadata?: unknown;
    ownerMetadataView?: unknown;
    metadataLayoutVersion?: number;
    serverId?: string;
}>;

/** Select one already-published Machine declaration; reading pending state starts no catalog work. */
export function readSessionRequestCoverage(
    session: SessionRequestCoverageInput,
    agentId: string | null = readSessionPresentationAgentId(session),
): AgentStateRequestCoverageOptions | undefined {
    if (!agentId) return undefined;
    const machineId = resolveSessionMachineId(readSessionOwnerMetadataView(session) ?? session.metadata);
    if (machineId) {
        const qualifiedId = isBundledAgentId(agentId)
            ? buildQualifiedPluginContributionKey(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId])
            : agentId;
        const declaration = readDaemonMergedProjectionSummary({ machineId, serverId: session.serverId })
            .inputs?.agentDeclarationsById?.[qualifiedId];
        // A selected Machine's declaration also owns the absence of coverage.
        if (declaration) return declaration.requestCoverage;
    }
    return resolveAgentStateRequestCoverageOptions({ agentId });
}
