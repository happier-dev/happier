import { SessionMcpSelectionV1Schema, type SessionMcpSelectionV1 } from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

export function computeNextSessionMcpSelectionMetadata(
    metadata: Metadata,
    selection: SessionMcpSelectionV1,
): Metadata {
    const normalized = SessionMcpSelectionV1Schema.parse(selection);
    const { mcpSelection: _legacyMcpSelection, ...canonicalMetadata } = metadata as Metadata & {
        mcpSelection?: unknown;
    };
    return {
        ...canonicalMetadata,
        mcpSelectionV1: normalized,
    };
}
