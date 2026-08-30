import {
    areSessionMcpSelectionsEquivalent,
    readSessionMcpSelectionRestartRequiredV1FromMetadata,
    readSessionMcpSelectionV1FromMetadata,
    SessionMcpSelectionV1Schema,
    type SessionMcpSelectionV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

export function computeNextSessionMcpSelectionMetadata(
    metadata: Metadata,
    selection: SessionMcpSelectionV1,
    options: Readonly<{ sessionActive: boolean }> = { sessionActive: false },
): Metadata {
    const normalized = SessionMcpSelectionV1Schema.parse(selection);
    const currentSelection = readSessionMcpSelectionV1FromMetadata(metadata)
        ?? SessionMcpSelectionV1Schema.parse({});
    const existingMarker = readSessionMcpSelectionRestartRequiredV1FromMetadata(metadata);
    const appliedSelection = existingMarker?.appliedSelection ?? currentSelection;
    const {
        mcpSelection: _legacyMcpSelection,
        mcpSelectionRestartRequiredV1: _previousRestartMarker,
        ...canonicalMetadata
    } = metadata as Metadata & {
        mcpSelection?: unknown;
    };

    return {
        ...canonicalMetadata,
        mcpSelectionV1: normalized,
        ...(options.sessionActive && !areSessionMcpSelectionsEquivalent(normalized, appliedSelection)
            ? {
                mcpSelectionRestartRequiredV1: {
                    v: 1,
                    appliedSelection,
                },
            }
            : {}),
    };
}
