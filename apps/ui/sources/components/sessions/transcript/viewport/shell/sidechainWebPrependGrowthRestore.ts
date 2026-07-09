import {
    restoreWebDomPrependGrowth,
    type WebDomPrependGrowthResult,
} from '@/components/sessions/transcript/viewport/driver/webDom';
import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export function applySidechainWebPrependGrowthRestore(params: Readonly<{
    capturedMetrics: WebTranscriptScrollMetrics;
    webDomObservation: WebDomScrollObservation;
}>): WebDomPrependGrowthResult {
    return restoreWebDomPrependGrowth({
        capturedMetrics: params.capturedMetrics,
        observation: params.webDomObservation,
    });
}
