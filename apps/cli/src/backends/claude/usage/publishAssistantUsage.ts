import type { Usage } from '@/api/types';
import type { SessionUsageObservationPublisher } from '@/api/session/client/reactions/usagePublishing';
import { logger } from '@/ui/logger';
import { buildLegacyUsageReportFromUsageObservation } from '@/usage/usageObservation';
import { buildClaudeAssistantUsageObservation } from './buildClaudeAssistantUsageObservation';

export function publishClaudeAssistantUsage(params: Readonly<{
    sessionId: string;
    publisher: SessionUsageObservationPublisher;
    usage: Usage;
    model?: string;
}>): void {
    const observation = buildClaudeAssistantUsageObservation({
        modelId: params.model ?? null,
        usage: params.usage,
    });
    if (!observation) {
        return;
    }
    logger.debugLargeJson('[SOCKET] Sending usage data:', buildLegacyUsageReportFromUsageObservation({
        sessionId: params.sessionId,
        observation,
    }));
    void params.publisher.publish({
        sessionId: params.sessionId,
        observation,
    });
}
