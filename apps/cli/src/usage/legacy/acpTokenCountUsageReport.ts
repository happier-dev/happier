/** Pre-v2 ACP `usage-report` compatibility; see `legacyUsageTransport.ts` for removal conditions. */
import type { ACPProvider } from '@/api/session/sessionMessageTypes';

import { extractUsageObservationFromTokenCountMessage } from '../usageObservation';
import {
    buildLegacyUsageReportFromUsageObservation,
    type UsageReportV1,
} from './legacyUsageTransport';

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
