import * as React from 'react';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { useActiveServerAccountScopeLifetime, useWorkspaceScmSummarySnapshot } from '@/sync/domains/state/storage';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readProjectWidgetAreaContextV1, type ProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { useProjectSource } from './sources/useProjectSources';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

const ProjectContext = React.createContext<ProjectWidgetAreaContextV1 | null>(null);
export const ProjectContextProvider = ProjectContext.Provider;

/** The mounted Project/Account owns its baseline; reads never probe SCM or write accepted refs. */
export function useProjectContext(input: Readonly<{
    serverId: string;
    projectRef?: WorkspaceRefV1 | null;
    activeCheckout?: WorkspaceRefV1 | null;
    authority?: Readonly<{ isCurrent(): boolean }> | null;
}>): ProjectWidgetAreaContextV1 {
    const inherited = React.useContext(ProjectContext);
    const anchor = input.projectRef === undefined ? input.activeCheckout : input.projectRef;
    const selected = input.activeCheckout;
    const inheritedCheckout = inherited?.target?.checkout;
    const canInherit = inherited !== null && anchor != null && inherited.target !== null
        && (input.authority?.isCurrent() ?? true)
        && (inherited.scope.authority?.isCurrent() ?? true)
        && areServerProfileIdentifiersEquivalent(input.serverId, inherited.scope.serverId)
        && areServerProfileIdentifiersEquivalent(anchor.serverId, input.serverId)
        && projectWorkspaceRefV1(anchor).projectKey === inherited.target.projectKey
        && (input.authority === undefined || input.authority === inherited.scope.authority)
        && (selected ? inheritedCheckout?.id === selected.id && inheritedCheckout.machineId === selected.machineId
            && inheritedCheckout.rootPath === selected.rootPath && areServerProfileIdentifiersEquivalent(selected.serverId, inheritedCheckout.serverId)
            : inheritedCheckout === undefined);
    const lifetime = useActiveServerAccountScopeLifetime();
    const scopedLifetime = lifetime?.isCurrent() && selectActiveServerAccountScopeForServer(lifetime.scope, input.serverId) ? lifetime : null;
    const authority = input.authority === undefined ? scopedLifetime : input.authority;
    const demand = React.useRef<ProjectWidgetAreaContextV1 | null>(null);
    demand.current = canInherit ? inherited : readProjectWidgetAreaContextV1({ ...input, authority }, demand.current);
    const source = useProjectSource(canInherit ? null : scopedLifetime, canInherit ? null : demand.current.sourceId).source;
    const checkout = demand.current.target?.checkout;
    const workspaceScope = React.useMemo(() => checkout ? {
        serverId: checkout.serverId, machineId: checkout.machineId, rootPath: checkout.rootPath,
    } : null, [checkout?.serverId, checkout?.machineId, checkout?.rootPath]);
    const snapshot = useWorkspaceScmSummarySnapshot(canInherit ? null : workspaceScope);
    const previous = React.useRef<ProjectWidgetAreaContextV1 | null>(null);
    if (canInherit) return inherited;
    previous.current = readProjectWidgetAreaContextV1({ ...input, source, snapshot, authority }, previous.current);
    return previous.current;
}
