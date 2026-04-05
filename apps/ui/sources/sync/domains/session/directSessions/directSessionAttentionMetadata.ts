import {
    applyObservedProgressToDirectSessionAttentionV1,
    buildDirectSessionAttentionV1,
    markDirectSessionAttentionViewedV1,
    type DirectSessionObservedProgress,
} from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import { readDirectSessionAttention } from './readDirectSessionAttention';
export { deriveDirectSessionObservedProgress } from '@happier-dev/protocol';

export function updateMetadataWithObservedDirectSessionProgress(
    metadata: Metadata,
    progress: DirectSessionObservedProgress | null,
): Metadata {
    if (!progress) return metadata;

    const attention = readDirectSessionAttention(metadata);
    const nextAttention = applyObservedProgressToDirectSessionAttentionV1(attention, progress);
    if (nextAttention === attention) return metadata;

    return {
        ...metadata,
        ...(nextAttention ? { directSessionAttentionV1: buildDirectSessionAttentionV1(nextAttention) } : {}),
    };
}

export function updateMetadataWithViewedDirectSessionProgress(metadata: Metadata): Metadata {
    const attention = readDirectSessionAttention(metadata);
    if (!attention) return metadata;

    const nextAttention = markDirectSessionAttentionViewedV1(attention);
    if (nextAttention === attention) return metadata;

    return {
        ...metadata,
        ...(nextAttention ? { directSessionAttentionV1: buildDirectSessionAttentionV1(nextAttention) } : {}),
    };
}
