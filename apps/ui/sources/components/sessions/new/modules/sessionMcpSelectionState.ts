import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1,
    SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

function normalizeSelection(selection: SessionMcpSelectionV1 | null | undefined): SessionMcpSelectionV1 {
    return SessionMcpSelectionV1Schema.parse(selection ?? {});
}

export function countSelectedSessionMcpPreviewEntries(
    preview: PreviewSuccess | null | undefined,
    params?: Readonly<{
        visibleManagedServerIds?: ReadonlySet<string> | null;
    }>,
): number {
    if (!preview) return 0;
    // The new-session chip badge should reflect detected/provider servers only.
    // (Managed/Happier servers are configured separately and should not contribute to this badge.)
    void params;
    return preview.detected.filter((entry) => entry.selected).length;
}

export function setManagedSessionMcpServersEnabled(
    selection: SessionMcpSelectionV1 | null | undefined,
    enabled: boolean,
): SessionMcpSelectionV1 {
    return normalizeSelection({
        ...normalizeSelection(selection),
        managedServersEnabled: enabled,
    });
}

export function toggleManagedSessionMcpSelection(
    selection: SessionMcpSelectionV1 | null | undefined,
    entry: Pick<ManagedMcpPreviewEntryV1, 'serverId' | 'selected' | 'selectable' | 'defaultSelected'>,
): SessionMcpSelectionV1 {
    const normalized = normalizeSelection(selection);
    if (!entry.selectable) return normalized;

    const forceIncludeServerIds = new Set(normalized.forceIncludeServerIds);
    const forceExcludeServerIds = new Set(normalized.forceExcludeServerIds);

    if (entry.selected) {
        forceIncludeServerIds.delete(entry.serverId);
        if (entry.defaultSelected) {
            forceExcludeServerIds.add(entry.serverId);
        } else {
            forceExcludeServerIds.delete(entry.serverId);
        }
    } else {
        forceExcludeServerIds.delete(entry.serverId);
        if (!entry.defaultSelected) {
            forceIncludeServerIds.add(entry.serverId);
        }
    }

    return normalizeSelection({
        ...normalized,
        forceIncludeServerIds: Array.from(forceIncludeServerIds),
        forceExcludeServerIds: Array.from(forceExcludeServerIds),
    });
}
