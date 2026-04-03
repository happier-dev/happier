import type { WorkspaceScopeBase } from './workspaceScope';
import type { WorkspaceRefV1 } from './workspaceRefModel';
import { findWorkspaceRefByScope, upsertWorkspaceRefByScope } from './workspaceRefs';

function normalizeOptionalLabel(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export type LegacyWorkspaceLabelMigrationResult = Readonly<{
    nextWorkspaceRefs: WorkspaceRefV1[];
    nextLegacyWorkspaceLabels: Record<string, string>;
    migratedCount: number;
}>;

export function migrateLegacyWorkspaceLabelsToWorkspaceRefs(input: Readonly<{
    legacyWorkspaceLabels: Record<string, string>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    nowMs: number;
    resolveScopeForLegacyKey: (legacyKey: string) => WorkspaceScopeBase | null;
}>): LegacyWorkspaceLabelMigrationResult {
    let nextWorkspaceRefs: WorkspaceRefV1[] = [...input.workspaceRefs];
    const nextLegacyWorkspaceLabels: Record<string, string> = { ...input.legacyWorkspaceLabels };
    let migratedCount = 0;

    for (const [legacyKey, rawLabel] of Object.entries(input.legacyWorkspaceLabels)) {
        const label = normalizeOptionalLabel(rawLabel);
        if (!label) continue;
        const scope = input.resolveScopeForLegacyKey(legacyKey);
        if (!scope) continue;

        const existing = findWorkspaceRefByScope(nextWorkspaceRefs, scope);
        if (normalizeOptionalLabel(existing?.label)) {
            // A canonical label already exists; do not overwrite it.
            continue;
        }

        const before = nextWorkspaceRefs;
        nextWorkspaceRefs = upsertWorkspaceRefByScope(before, {
            scope,
            nowMs: input.nowMs,
            patch: { label },
        });
        if (nextWorkspaceRefs !== before) {
            delete nextLegacyWorkspaceLabels[legacyKey];
            migratedCount += 1;
        }
    }

    return {
        nextWorkspaceRefs,
        nextLegacyWorkspaceLabels,
        migratedCount,
    };
}
