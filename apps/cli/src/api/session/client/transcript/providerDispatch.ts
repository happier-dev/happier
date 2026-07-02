import { randomUUID } from 'node:crypto';

import { normalizeToolCallV2, normalizeToolResultV2 } from '@/agent/tools/normalization';
import {
    applyRuntimeOutboundTranscriptPostSendEffects,
    commitRuntimeOutboundTranscriptDispatchPlan,
    recordRuntimeOutboundTranscriptToolTraceEvents,
    readRuntimeOutboundTranscriptDispatchBackendId,
    resolveRuntimeOutboundTranscriptDispatchFacet,
    RuntimeOutboundTranscriptDispatchUnavailableError,
    type RuntimeOutboundTranscriptDispatchFacetResolution,
} from '../../outbound/transcriptDispatch';
import type { PostSendReactionPort } from '../reactions/providers/postSendReactionPort';
import type { SessionClientTranscriptSendPort } from './sendMessages';

export type ProviderTranscriptDispatchRequest = Readonly<{
    body: unknown;
    meta?: Record<string, unknown>;
}>;

export type ProviderTranscriptDispatchOpts = Readonly<{
    sessionId: string;
    postSendReactionPort: PostSendReactionPort;
    resolveTranscriptDispatchFacet?: (params: Readonly<{
        metadata: ReturnType<SessionClientTranscriptSendPort['getMetadataSnapshot']>;
    }>) => Promise<RuntimeOutboundTranscriptDispatchFacetResolution | null>;
}>;

export async function dispatchProviderTranscriptMessage(
    port: SessionClientTranscriptSendPort,
    request: ProviderTranscriptDispatchRequest,
    opts: ProviderTranscriptDispatchOpts,
): Promise<void> {
    const metadata = port.getMetadataSnapshot();
    const backendId = readRuntimeOutboundTranscriptDispatchBackendId(metadata);
    const resolved = await (opts.resolveTranscriptDispatchFacet ?? resolveRuntimeOutboundTranscriptDispatchFacet)({
        metadata,
    });
    if (!resolved) {
        throw new RuntimeOutboundTranscriptDispatchUnavailableError({ backendId });
    }

    const plan = resolved.facet.prepareDispatch({
        body: request.body,
        meta: request.meta,
        metadata,
        now: () => Date.now(),
        randomId: () => randomUUID(),
        debug: port.debug,
        debugLargeJson: port.debugLargeJson,
        toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
        permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
        toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
        toolNormalization: {
            normalizeToolCallV2,
            normalizeToolResultV2,
        },
    });

    recordRuntimeOutboundTranscriptToolTraceEvents(opts.sessionId, plan.toolTraceEvents);
    commitRuntimeOutboundTranscriptDispatchPlan(port, plan);
    applyRuntimeOutboundTranscriptPostSendEffects(opts.postSendReactionPort, plan.postSendEffects);
}
