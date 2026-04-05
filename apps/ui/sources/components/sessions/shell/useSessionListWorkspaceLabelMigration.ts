import * as React from 'react';

import { migrateLegacyWorkspaceLabelsToWorkspaceRefs } from '@/sync/domains/workspaces/workspaceLabelsMigration';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export function useSessionListWorkspaceLabelMigration(input: Readonly<{
    workspaceLabels: Readonly<Record<string, string> | null | undefined>;
    setWorkspaceLabels: (value: Record<string, string>) => void;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1> | null | undefined;
    setWorkspaceRefs: (value: WorkspaceRefV1[]) => void;
    scopeHintByLegacyWorkspaceKey: ReadonlyMap<string, WorkspaceScopeBase>;
}>) {
    React.useEffect(() => {
        const legacyWorkspaceLabels = input.workspaceLabels ?? {};
        const legacyKeys = Object.keys(legacyWorkspaceLabels);
        if (legacyKeys.length === 0) return;

        const result = migrateLegacyWorkspaceLabelsToWorkspaceRefs({
            legacyWorkspaceLabels,
            workspaceRefs: input.workspaceRefs ?? [],
            nowMs: Date.now(),
            resolveScopeForLegacyKey: (legacyKey) => input.scopeHintByLegacyWorkspaceKey.get(legacyKey) ?? null,
        });
        if (result.migratedCount <= 0) return;

        input.setWorkspaceRefs(result.nextWorkspaceRefs);
        input.setWorkspaceLabels(result.nextLegacyWorkspaceLabels);
    }, [
        input.scopeHintByLegacyWorkspaceKey,
        input.setWorkspaceLabels,
        input.setWorkspaceRefs,
        input.workspaceLabels,
        input.workspaceRefs,
    ]);
}
