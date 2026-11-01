import type { SessionOrganizationContentEnvelope, SessionOrganizationLabel } from '@happier-dev/protocol';
import { parseSessionAppearanceColor, readSessionAppearanceColorFromDisplay, type SessionAppearanceColor } from './appearanceColor';
import { buildSessionOrganizationLabelKey } from './keys';

export type WorkspaceDisplay = Readonly<{ label: string | null; color: SessionAppearanceColor | null }>;
const EMPTY_WORKSPACE_DISPLAY: WorkspaceDisplay = Object.freeze({ label: null, color: null });

/** One exact-Home lookup for headers, session rows and inbox. Never falls back to the active Home. */
export function resolveServerWorkspaceDisplay(
    labelsByLabelKey: Readonly<Record<string, SessionOrganizationLabel>> | undefined,
    serverId: string | null | undefined,
    workspaceKey: string | null | undefined,
): WorkspaceDisplay {
    if (!serverId?.trim() || !workspaceKey?.trim()) return EMPTY_WORKSPACE_DISPLAY;
    const label = labelsByLabelKey?.[buildSessionOrganizationLabelKey({ serverId, labelKind: 'workspace', scopeKey: workspaceKey })];
    return label && label.archivedAt == null ? readWorkspaceDisplay(label.display) : EMPTY_WORKSPACE_DISPLAY;
}

export function readWorkspaceDisplay(display: SessionOrganizationContentEnvelope | null | undefined): WorkspaceDisplay {
    const value = display?.t === 'plain' && display.v && typeof display.v === 'object' && !Array.isArray(display.v)
        ? display.v as Record<string, unknown> : {};
    return { label: typeof value.label === 'string' ? value.label.trim() || null : null, color: readSessionAppearanceColorFromDisplay(display) };
}

/** Patch only the requested fields. Both empty means the workspace label row can be deleted. */
export function mergeWorkspaceDisplay(display: SessionOrganizationContentEnvelope | null | undefined, patch: Readonly<{ label?: string | null; color?: SessionAppearanceColor | null }>): SessionOrganizationContentEnvelope | null {
    if (display?.t === 'encrypted') throw new Error('Workspace display must be opened before editing');
    const current = readWorkspaceDisplay(display);
    const label = patch.label === undefined ? current.label : patch.label?.trim() || null;
    const color = patch.color === undefined ? current.color : parseSessionAppearanceColor(patch.color);
    if (!label && !color) return null;
    const value = display?.t === 'plain' && display.v && typeof display.v === 'object' && !Array.isArray(display.v)
        ? { ...display.v } as Record<string, unknown> : {};
    delete value.label;
    delete value.color;
    return { t: 'plain', v: { ...value, ...(label ? { label } : {}), ...(color ? { color } : {}) } };
}
