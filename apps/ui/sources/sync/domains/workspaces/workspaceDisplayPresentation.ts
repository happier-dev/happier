import { resolveWorkspaceDisplayLabel } from './workspaceLabel';
import type { WorkspaceRefV1 } from './workspaceRefModel';
import { findWorkspaceRefByScope } from './workspaceRefs';
import type { WorkspaceScopeBase } from './workspaceScope';

export type WorkspaceDisplayEllipsizeMode = 'head' | 'tail';
export type WorkspacePathDisplayModeV1 = 'name' | 'path';

export type WorkspaceDisplayPresentation = Readonly<{
    displayTitle: string;
    hasCustomLabel: boolean;
    subtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
    workspaceRefId: string | null;
}>;

function normalizeOptionalLabel(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveWorkspaceBasename(path: string): string {
    const normalized = path.trim().replace(/[\\/]+$/, '');
    if (!normalized || normalized === '~') return normalized;
    const segments = normalized.split(/[\\/]+/);
    return normalizeOptionalLabel(segments[segments.length - 1]) ?? normalized;
}

export function resolveWorkspaceDisplayPresentation(input: Readonly<{
    scope: WorkspaceScopeBase | null | undefined;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    fallbackPathLabel: string;
    fallbackPathDisplayMode?: WorkspacePathDisplayModeV1 | null;
    legacyLabel?: string | null | undefined;
}>): WorkspaceDisplayPresentation {
    const legacyLabel = normalizeOptionalLabel(input.legacyLabel);
    const fallbackTitle = input.fallbackPathDisplayMode === 'path'
        ? input.fallbackPathLabel
        : resolveWorkspaceBasename(input.fallbackPathLabel);
    if (!input.scope) {
        const displayTitle = legacyLabel ?? fallbackTitle;
        return {
            displayTitle,
            hasCustomLabel: Boolean(legacyLabel),
            subtitleEllipsizeMode: legacyLabel || input.fallbackPathDisplayMode !== 'path' ? 'tail' : 'head',
            workspaceRefId: null,
        };
    }

    const workspaceRef = findWorkspaceRefByScope(input.workspaceRefs, input.scope);
    const workspaceLabel = normalizeOptionalLabel(workspaceRef?.label);
    return {
        displayTitle: resolveWorkspaceDisplayLabel({
            scope: input.scope,
            workspaceRef,
            fallbackPathLabel: fallbackTitle,
        }),
        hasCustomLabel: Boolean(workspaceLabel),
        subtitleEllipsizeMode: workspaceLabel || input.fallbackPathDisplayMode !== 'path' ? 'tail' : 'head',
        workspaceRefId: String(workspaceRef?.id ?? '').trim() || null,
    };
}
