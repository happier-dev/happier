import * as React from 'react';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { resolveWorkspaceRefDisplayNames } from './resolveWorkspaceRefDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScopeLifetime, useProjectOrganizations, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { isProjectAccountRowsCensusComplete } from '@/sync/store/domains/projectAccountRows';
import { fireAndForget } from '@/utils/system/fireAndForget';

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

/** An opened picker joins the Account's existing initial census and observes its readiness. */
export function usePresentedProjectPicker(presented: boolean) {
    const projects = useProjectPickerOptions();
    const lifetime = useActiveServerAccountScopeLifetime(presented);
    const status = useProjectAccountRows(rows => {
        if (isProjectAccountRowsCensusComplete(rows)) return 'ready';
        if (rows?.status === 'error' || rows?.status === 'locked' || rows?.status === 'refused') return 'unavailable';
        return 'loading';
    }, presented);
    React.useEffect(() => {
        if (!lifetime?.isCurrent()) return;
        fireAndForget(getSyncSingleton().projectAccountRowsOwnerFor(lifetime.scope), { tag: 'ProjectPicker.census' });
    }, [lifetime]);
    return { projects, status };
}
