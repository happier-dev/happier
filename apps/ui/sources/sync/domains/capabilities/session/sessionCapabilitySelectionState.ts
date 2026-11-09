import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1,
} from '@happier-dev/protocol/mcp/servers/previewV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { SessionCapabilitySelectionAuthoringV1Schema, setSessionCapabilitySelectionItemV1,
    type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

function normalizeSelection(selection: SessionCapabilitySelectionV1 | null | undefined): SessionCapabilitySelectionV1 {
    return SessionCapabilitySelectionAuthoringV1Schema.parse(selection ?? {});
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
    selection: SessionCapabilitySelectionV1 | null | undefined,
    enabled: boolean,
): SessionCapabilitySelectionV1 {
    const normalized = normalizeSelection(selection);
    return normalizeSelection({
        ...normalized,
        mcp: { ...SessionMcpSelectionV1Schema.parse(normalized.mcp ?? {}), managedServersEnabled: enabled },
    });
}

export function toggleManagedSessionMcpSelection(
    selection: SessionCapabilitySelectionV1 | null | undefined,
    entry: Pick<ManagedMcpPreviewEntryV1, 'serverId' | 'selected' | 'selectable' | 'defaultSelected'>,
): SessionCapabilitySelectionV1 {
    const normalized = normalizeSelection(selection);
    if (!entry.selectable) return normalized;
    const state = entry.selected ? (entry.defaultSelected ? 'off' : 'inherit') : (entry.defaultSelected ? 'inherit' : 'on');
    return setSessionCapabilitySelectionItemV1(normalized, 'mcp_server', entry.serverId, state);
}

export { setSessionCapabilitySelectionItemV1 as setSessionCapabilitySelectionItem };
