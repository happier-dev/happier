import type { PluginUiHostApi, PluginUiActionFailureV1, PluginUiActionFailurePresentationV1 } from './hostApi.js';
import type { PluginCancellationOptions } from '../lifecycle.js';

/** Prefer the host presenter; older hosts retain the producer's message and correlation. */
export async function presentActionFailure(
    hostApi: Pick<PluginUiHostApi, 'version'> & Partial<Pick<PluginUiHostApi, 'presentActionFailure'>>,
    failure: PluginUiActionFailureV1,
    options?: PluginCancellationOptions,
): Promise<PluginUiActionFailurePresentationV1> {
    if (hostApi.version().methods.includes('presentActionFailure') && hostApi.presentActionFailure) {
        return hostApi.presentActionFailure(failure, options);
    }
    return { reason: failure.message ?? failure.error ?? failure.errorCode, nextStep: null, technicalDetails: [
        { key: 'code', label: 'Code', value: failure.errorCode },
        ...(failure.requestId ? [{ key: 'requestId', label: 'Request ID', value: failure.requestId }] : []),
    ] };
}
