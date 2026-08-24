/** @moduleRealm daemon */
import {
    deriveExternalSessionActivity as deriveAgentsExternalSessionActivity,
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
