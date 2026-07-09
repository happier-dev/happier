export type {
    ExternalSessionActivityResultV1,
    ExternalSessionCandidateHostListRequestV1,
    ExternalSessionCandidateHostRuntimeServiceV1,
    ExternalSessionCandidatePageV1,
    ExternalSessionFailureCodeV1,
    ExternalSessionFileFollowInputV1,
    ExternalSessionFileFollowRuntimeServiceV1,
    ExternalSessionFollowLeaseV1,
    ExternalSessionFollowTranscriptPathResolutionV1,
    ExternalSessionProviderStoreKeyV1,
    ExternalSessionResolvedIdentityV1,
    ExternalSessionResolveFollowTranscriptPathRequestV1,
    ExternalSessionRuntimeContextV1,
    ExternalSessionSurfaceV1,
    ExternalSessionTranscriptPageV1,
    ExternalSessionTranscriptStoreFollowRequestV1,
    ExternalSessionTranscriptStorePageRequestV1,
    ExternalSessionTranscriptStoreReadAfterRequestV1,
    ExternalSessionTranscriptStoreRuntimeServiceV1,
    SessionStateUpdateV1,
    ExternalSessionAttachParamsV1,
    ExternalSessionAttachResultV1,
    ExternalSessionCandidateV1,
    ExternalSessionListCandidatesParamsV1,
    ExternalSessionListCandidatesResultV1,
    ExternalSessionSourceV1,
    ExternalSessionTakeoverInputV1,
    ExternalSessionTakeoverResultV1,
    ExternalSessionTranscriptItemV1,
    ExternalSessionTranscriptPageParamsV1,
    ExternalSessionTranscriptPageResultV1,
    ExternalSessionTranscriptReadAfterParamsV1,
    ExternalSessionTranscriptReadAfterResultV1,
    ExternalSessionTranscriptUpdateV1,
    PluginExternalSessionsServiceV1,
} from '@happier-dev/agents';
import type {
    ExternalSessionCandidateHostRuntimeServiceV1,
    ExternalSessionFileFollowRuntimeServiceV1,
    ExternalSessionTranscriptStoreRuntimeServiceV1,
} from '@happier-dev/agents';

import type { ExecRuntimeServiceV1 } from '../exec.js';

export type ExternalSessionRuntimeHostAdapterParamsV1 = Readonly<{
    activeServerDir: string;
    env: NodeJS.ProcessEnv;
    exec: ExecRuntimeServiceV1;
    fileFollow?: ExternalSessionFileFollowRuntimeServiceV1;
}>;

export type ExternalSessionCandidateHostAdapterV1 =
    ExternalSessionCandidateHostRuntimeServiceV1
    & Readonly<{ providerId: string }>;

export type ExternalSessionTranscriptStoreAdapterV1 =
    ExternalSessionTranscriptStoreRuntimeServiceV1
    & Readonly<{ providerId: string }>;

export type ExternalSessionHostAdaptersContributionV1 = Readonly<{
    createCandidateHostAdapter?: (
        params: ExternalSessionRuntimeHostAdapterParamsV1,
    ) => ExternalSessionCandidateHostAdapterV1;
    createTranscriptStoreAdapter?: (
        params: ExternalSessionRuntimeHostAdapterParamsV1,
    ) => ExternalSessionTranscriptStoreAdapterV1;
}>;
