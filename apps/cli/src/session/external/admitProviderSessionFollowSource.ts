import { buildLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionsAgentId, ExternalSessionsSource, PluginAgentExternalSessionLinkData } from '@happier-dev/protocol';

import {
    authenticateOwnedExternalSessionRecord,
    type LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { StoredCredentials } from '@/persistence';

export type ExternalSessionFollowSource = Omit<LoadedLinkedExternalSession, 'rawSession'> & Readonly<{
    rawSession?: LoadedLinkedExternalSession['rawSession'];
}>;

/** The bound runner owns its native identity; its parent Session only owns Account access. */
export async function admitProviderSessionFollowSource(params: Readonly<{
    credentials: StoredCredentials;
    sessionId: string;
    agentId: ExternalSessionsAgentId;
    machineId: string;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    linkData?: PluginAgentExternalSessionLinkData;
    signal?: AbortSignal;
    deadlineAtMs?: number;
}>): Promise<
    | Readonly<{ ok: true; session: ExternalSessionFollowSource }>
    | Readonly<{ ok: false; error: string; errorCode: 'invalid_request' | 'agent_unavailable' }>
> {
    const admitted = await authenticateOwnedExternalSessionRecord(params);
    if (!admitted.ok) return admitted;
    return {
        ok: true,
        session: {
            agentId: params.agentId,
            machineId: params.machineId,
            remoteSessionId: params.remoteSessionId,
            source: params.source,
            ...(params.linkData === undefined ? {} : { linkData: params.linkData }),
            linkGeneration: params.remoteSessionId,
            sessionPath: null,
            // Private adapter input only. A Run never becomes its parent's external link.
            metadata: buildLinkedExternalSessionMetadataV1({}, {
                v: 1,
                agentId: params.agentId,
                machineId: params.machineId,
                remoteSessionId: params.remoteSessionId,
                source: params.source,
                ...(params.linkData === undefined ? {} : { linkData: params.linkData }),
            }),
        },
    };
}
