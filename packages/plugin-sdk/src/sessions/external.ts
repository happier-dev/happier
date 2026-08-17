/** @moduleRealm daemon */
import {
    deriveExternalSessionActivity as deriveAgentsExternalSessionActivity,
} from '@happier-dev/agents';

export type {
    ExternalSessionCandidatePageV1,
    ExternalSessionFailureCodeV1,
    ExternalSessionResolvedIdentityV1,
    ExternalSessionTranscriptPageV1,
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
} from '@happier-dev/agents';

export {
    compareExternalSessionCandidatePrecedence,
    resolveExternalSessionCandidateIdentityKey,
} from './external/candidatePrecedence.js';

export const deriveExternalSessionActivity: (
    params: Readonly<{
        updatedAtMs: number | null | undefined;
        env?: Readonly<Record<string, string | undefined>>;
        nowMs?: number;
    }>,
) => 'running' | 'active_recently' | 'idle' | 'unknown' = deriveAgentsExternalSessionActivity;
