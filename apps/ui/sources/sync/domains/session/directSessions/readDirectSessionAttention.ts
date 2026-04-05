import {
    deriveDirectSessionAttentionHasUnread as deriveDirectSessionAttentionHasUnreadSnapshot,
    readDirectSessionAttentionV1,
    type DirectSessionAttentionV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

export type DirectSessionAttention = DirectSessionAttentionV1;

export function readDirectSessionAttention(metadata: Metadata | null | undefined): DirectSessionAttention | null {
    return readDirectSessionAttentionV1(
        (metadata as { directSessionAttentionV1?: unknown } | null | undefined)?.directSessionAttentionV1,
    );
}

export function deriveDirectSessionAttentionHasUnread(metadata: Metadata | null | undefined): boolean | null {
    return deriveDirectSessionAttentionHasUnreadSnapshot(readDirectSessionAttention(metadata));
}
