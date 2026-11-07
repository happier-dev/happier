import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';

import { log } from '@/utils/logging/log';
import { readWebLatencyRequestId } from '@/utils/webLatencyTrace';

function contractRef(ref: PluginCollectionContractRefV1): PluginCollectionContractRefV1 {
    return { pluginId: ref.pluginId, collectionId: ref.collectionId,
        schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest };
}

/** Emit once where the read is refused, preserving the original typed error. */
export function diagnosePluginCollectionReadRefusal<TError extends Error & Readonly<{ code: string }>>(
    error: TError,
    decisionBranch: string,
    request: Readonly<{ pluginId: string; collectionId: string; readerContext: PluginCollectionContractRefV1 }>,
    writerRef?: PluginCollectionContractRefV1,
): TError {
    try {
        log({
            level: 'warn',
            module: 'plugin-collection-read',
            httpRequestId: readWebLatencyRequestId(),
            responseCode: error.code,
            decisionBranch,
            collectionRef: { pluginId: request.pluginId, collectionId: request.collectionId },
            readerRef: contractRef(request.readerContext),
            ...(writerRef ? { writerRef: contractRef(writerRef) } : {}),
        }, 'Plugin Collection read refused');
    } catch { /* A diagnostic sink failure must not change the refusal. */ }
    return error;
}
