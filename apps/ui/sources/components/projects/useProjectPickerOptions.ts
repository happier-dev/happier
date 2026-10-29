import * as React from 'react';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { resolveWorkspaceRefDisplayNames } from './resolveWorkspaceRefDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useProjectOrganizations, useWorkspaceRefs } from '@/sync/domains/state/storage';

export type ProjectPickerOption = QualifiedProjectKeyV1 & Readonly<{ label: string; disabled?: boolean }>;

/** The existing Project picker choices, shared by Sessions and Store: same projection and names as Projects. */
export function useProjectPickerOptions(): readonly ProjectPickerOption[] {
    const serverId = String(useActiveServerSnapshot().serverId ?? '').trim();
    const workspaceRefs = useWorkspaceRefs();
    const organizations = useProjectOrganizations();
    return React.useMemo(() => {
        if (!serverId) return [];
        const { projectGroups } = projectProjectListV1({ serverId,
            workspaceRefs: Array.isArray(workspaceRefs) ? workspaceRefs : [], organizations,
            normalizeServerId: resolveServerProfileScopeIdForIdentifier });
        const names = resolveWorkspaceRefDisplayNames(projectGroups.flatMap(group => group.items.slice(0, 1)));
        return projectGroups.flatMap((group, index) => group.items.length > 0
            ? [{ serverId, projectKey: group.projectKey.projectKey, label: names[index] ?? group.projectKey.projectKey }]
            : []);
    }, [organizations, serverId, workspaceRefs]);
}
