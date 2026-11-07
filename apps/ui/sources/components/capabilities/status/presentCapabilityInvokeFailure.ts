import type { CapabilityInvokeFailure } from '@happier-dev/protocol/capabilities';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { t } from '@/text';

/** Reuse the existing recovery copy; keep an unfamiliar capability reason visible without classifying it. */
export function presentCapabilityInvokeFailure(failure: CapabilityInvokeFailure): string {
    return `${t(presentProviderError(failure.errorCode).descriptionKey)} (${failure.errorCode})`;
}
