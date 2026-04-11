import type { ACPProvider } from './sessionMessageTypes';

import {
    buildLegacyUsageReportFromUsageObservation,
    extractUsageObservationFromTokenCountMessage,
    type UsageReportV1,
} from '@/usage/usageObservation';

export function buildUsageReportFromAcpTokenCount(params: {
  provider: ACPProvider;
  sessionId: string;
  body: unknown;
}): UsageReportV1 | null {
    const observation = extractUsageObservationFromTokenCountMessage({
        provider: params.provider,
        body: params.body,
    });
    if (!observation) return null;
    return buildLegacyUsageReportFromUsageObservation({
        sessionId: params.sessionId,
        observation,
    });
}
