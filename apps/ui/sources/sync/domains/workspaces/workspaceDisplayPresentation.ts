import { resolveWorkspaceDisplayLabel } from './workspaceLabel';
import type { WorkspaceRefV1 } from './workspaceRefModel';
import { findWorkspaceRefByScope } from './workspaceRefs';
import type { WorkspaceScopeBase } from './workspaceScope';

export type WorkspaceDisplayEllipsizeMode = 'head' | 'tail';

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

export function resolveWorkspaceDisplayPresentation(input: Readonly<{
    scope: WorkspaceScopeBase | null | undefined;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    fallbackPathLabel: string;
    legacyLabel?: string | null | undefined;
}>): WorkspaceDisplayPresentation {
    const legacyLabel = normalizeOptionalLabel(input.legacyLabel);
    if (!input.scope) {
        const displayTitle = legacyLabel ?? input.fallbackPathLabel;
        return {
            displayTitle,
            hasCustomLabel: Boolean(legacyLabel),
            subtitleEllipsizeMode: legacyLabel ? 'tail' : 'head',
            workspaceRefId: null,
        };
    }

    const workspaceRef = findWorkspaceRefByScope(input.workspaceRefs, input.scope);
    const workspaceLabel = normalizeOptionalLabel(workspaceRef?.label);
    return {
        displayTitle: resolveWorkspaceDisplayLabel({
            scope: input.scope,
            workspaceRef,
            fallbackPathLabel: input.fallbackPathLabel,
        }),
        hasCustomLabel: Boolean(workspaceLabel),
        subtitleEllipsizeMode: workspaceLabel ? 'tail' : 'head',
        workspaceRefId: String(workspaceRef?.id ?? '').trim() || null,
    };
}
