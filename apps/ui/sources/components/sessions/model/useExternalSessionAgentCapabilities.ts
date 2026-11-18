import { resolveProjectedExternalSessionsAgent, supportsProjectedExternalSessionTranscript } from '@/agents/backendCatalog/currentAgentCapabilities';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { ExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

export function useExternalSessionAgentCapabilities(params: Readonly<{
    link: ExternalSessionLink | null;
    serverId: string | null | undefined;
    sourceMachineOnline: boolean;
    accountLifetime?: Parameters<typeof useDaemonMergedProjectionInputs>[0]['accountLifetime'];
}>) {
    const { link } = params;
    const projection = useDaemonMergedProjectionInputs({
        sections: ['agentsById'],
        machineId: link?.machineId,
        serverId: params.serverId,
        accountLifetime: params.accountLifetime,
        enabled: link !== null,
    });
    const declaration = link && projection.phase === 'ready'
        ? resolveProjectedExternalSessionsAgent({
            providerId: link.agentId,
            projection: projection.inputs?.pluginProjectionV2,
        })?.externalSessions
        : undefined;
    return {
        writerSafety: declaration?.writerSafety,
        materializeAvailable: params.sourceMachineOnline && link !== null
            && supportsProjectedExternalSessionTranscript(declaration, link.source),
    };
}
