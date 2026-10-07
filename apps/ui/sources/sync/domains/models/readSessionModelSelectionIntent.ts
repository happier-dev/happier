import { resolveModelSelectionIntentFromSessionMetadata } from '@happier-dev/agents';
import {
    SessionModelSelectionResolutionError,
    type SessionModelSelectionIntentV1,
} from '@happier-dev/protocol/providers/model-selection';

import { log } from '@/log';

/**
 * The app's one read of a Session's persisted model intent for its current Agent target.
 *
 * A persisted selection keyed to another Agent target is stale for this Session (an
 * earlier build's key spelling, or an Agent change). It is never sendable here, so the
 * read treats it as absent — the Agent's default model applies — and logs a diagnostic
 * instead of throwing into render. Launch and runner paths keep their fail-closed checks.
 */
export function readSessionModelSelectionIntentFromMetadata(
    metadata: unknown,
    agentTargetKey: string,
): SessionModelSelectionIntentV1 | null {
    try {
        return resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey);
    } catch (error) {
        if (error instanceof SessionModelSelectionResolutionError && error.code === 'model_selection_agent_target_mismatch') {
            log.log(`[session-model] dropped a stored model selection that does not target ${agentTargetKey}`);
            return null;
        }
        throw error;
    }
}
