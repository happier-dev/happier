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
    // Built-in MCP servers (e.g. the default Happier server) are always present and should not
    // be counted towards the chip badge which is meant to reflect user-relevant session bindings.
    const visibleManagedServerIds = params?.visibleManagedServerIds ?? null;
    return preview.managed.filter((entry) =>
        entry.selected && (visibleManagedServerIds ? visibleManagedServerIds.has(entry.serverId) : true),
    ).length
        + preview.detected.filter((entry) => entry.selected).length;
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
