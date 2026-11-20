import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';

import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { deriveSessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/deriveSessionAuthoringSnapshot';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverFetch } from '@/sync/http/client';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';

import type { NewSessionTeamModelSeed } from './newSessionDraftSeed';

/** Read only the source model's authoring intent inside the mounted Account. */
export async function readNewSessionTeamModelSeed(input: Readonly<{
    agentTarget?: AgentExecutionTargetV1;
    scope: ServerAccountScope;
    sessionId: string;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>): Promise<Readonly<{ kind: 'available'; seed?: NewSessionTeamModelSeed } | { kind: 'unavailable' }>> {
    try {
        const { session } = await runWithServerRequestAuthorityForServerAccountScope({
            scope: input.scope, activeRequest: serverFetch, signal: input.signal,
        }, authority => readSessionSnapshotForAuthority({ authority, sessionId: input.sessionId,
            includeTurns: false, includeMetadataTupleMutationSnapshot: false, signal: input.signal, isCurrent: input.isCurrent,
        }));
        if (session.access?.capabilities.readTranscript !== true
            || !isSessionContentReadable(readSessionContentAvailability(session))) return { kind: 'unavailable' };
        const { agentTarget, modelSelection } = deriveSessionAuthoringSnapshot({ session });
        if (!agentTarget || modelSelection?.v !== 2 || modelSelection.ref.source !== 'team_resource'
            || (input.agentTarget && buildBackendTargetKeyV2(input.agentTarget) !== modelSelection.ref.agentTargetKey)) {
            return { kind: 'available' };
        }
        return { kind: 'available', seed: { agentTarget, modelSelection: { ...modelSelection, ref: modelSelection.ref } } };
    } catch (error) {
        // Triage keeps historical links even when their Session is gone.
        return error instanceof SessionSnapshotReadError && error.httpStatus === 404
            ? { kind: 'available' } : { kind: 'unavailable' };
    }
}
