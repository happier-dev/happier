import {
    applyObservedProgressToExternalSessionAttentionV1,
    buildExternalSessionAttentionV1,
    markExternalSessionAttentionUnreadV1,
    markExternalSessionAttentionViewedV1,
    type ExternalSessionObservedProgress,
} from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import { readExternalSessionAttention } from './readExternalSessionAttention';
export { deriveExternalSessionObservedProgress } from '@happier-dev/protocol';

export function updateMetadataWithObservedExternalSessionProgress(
    metadata: Metadata,
    progress: ExternalSessionObservedProgress | null,
): Metadata {
    if (!progress) return metadata;

    const attention = readExternalSessionAttention(metadata);
    const nextAttention = applyObservedProgressToExternalSessionAttentionV1(attention, progress);
    if (nextAttention === attention) return metadata;

    return {
        ...metadata,
        ...(nextAttention ? { externalSessionAttentionV1: buildExternalSessionAttentionV1(nextAttention) } : {}),
    };
}

export function updateMetadataWithViewedExternalSessionProgress(metadata: Metadata): Metadata {
    const attention = readExternalSessionAttention(metadata);
    if (!attention) return metadata;

    const nextAttention = markExternalSessionAttentionViewedV1(attention);
    if (nextAttention === attention) return metadata;

    return {
        ...metadata,
        ...(nextAttention ? { externalSessionAttentionV1: buildExternalSessionAttentionV1(nextAttention) } : {}),
    };
}

export function updateMetadataWithUnreadExternalSessionProgress(metadata: Metadata): Metadata {
    const attention = readExternalSessionAttention(metadata);
    if (!attention) return metadata;

    const nextAttention = markExternalSessionAttentionUnreadV1(attention);
    if (nextAttention === attention) return metadata;

    return {
        ...metadata,
        ...(nextAttention ? { externalSessionAttentionV1: buildExternalSessionAttentionV1(nextAttention) } : {}),
    };
}
