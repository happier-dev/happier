import {
    deriveExternalSessionAttentionHasUnread as deriveExternalSessionAttentionHasUnreadSnapshot,
    readExternalSessionAttentionV1,
    type ExternalSessionAttentionV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

export type ExternalSessionAttention = ExternalSessionAttentionV1;

export function readExternalSessionAttention(metadata: Metadata | null | undefined): ExternalSessionAttention | null {
    return readExternalSessionAttentionV1(
        (metadata as { externalSessionAttentionV1?: unknown } | null | undefined)?.externalSessionAttentionV1,
    );
}

export function deriveExternalSessionAttentionHasUnread(metadata: Metadata | null | undefined): boolean | null {
    return deriveExternalSessionAttentionHasUnreadSnapshot(readExternalSessionAttention(metadata));
}
