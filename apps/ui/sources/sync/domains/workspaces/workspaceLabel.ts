import type { WorkspaceScopeBase } from './workspaceScope';
import type { WorkspaceRefV1 } from './workspaceRefModel';

function normalizeOptionalLabel(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveWorkspaceDisplayLabel(params: Readonly<{
    scope: WorkspaceScopeBase;
    workspaceRef: WorkspaceRefV1 | null;
    fallbackPathLabel: string;
}>): string {
    const label = normalizeOptionalLabel(params.workspaceRef?.label);
    if (label) return label;
    return params.fallbackPathLabel;
}
