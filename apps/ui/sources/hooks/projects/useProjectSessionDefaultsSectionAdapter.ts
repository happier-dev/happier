import * as React from 'react';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { ProjectSessionDefaultsV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';
import { resolveInheritedManagedSessionDefaults, type ManagedDefaultSourceNamesV1,
    type ManagedSessionDefaultsContext, type ResolvedInheritedManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';
import type { ProjectSourceIdentityV1 } from '@happier-dev/protocol/projects/sources/projectSourceIdentityV1';
import { withApprovalProfile } from '@/components/settings/teams/defaults/memberDefaults';
import { isProjectSessionDefaultsEditUnchanged } from '@/sync/ops/actions/projectSessionDefaultsActions';

/** The whole shared editor writes through its selected scope; every pick is one edit. */
export type ProjectSessionDefaultsSectionInput = Readonly<{
    defaults: ProjectSessionDefaultsV1;
    save: (next: ProjectSessionDefaultsV1 | null) => Promise<void>;
    scope: 'personal-project' | 'project';
    addressKey?: string;
    context: ManagedSessionDefaultsContext | undefined;
    source?: ProjectSourceIdentityV1 | null;
    teamName?: string;
    projectName?: string;
}>;

export type ProjectSessionDefaultsInheritance = Readonly<{
    approvalProfileId: ResolvedInheritedManagedSessionDefaults['approvalProfileId'];
    agentTarget: ResolvedInheritedManagedSessionDefaults['agentTarget'];
    placement: ResolvedInheritedManagedSessionDefaults['placement'];
    forAgent: (target: AgentExecutionTargetV1) => ResolvedInheritedManagedSessionDefaults;
}>;

/** Project-only Agent selection and empty-layer clearing stay out of the page and row renderers. */
export function useProjectSessionDefaultsSectionAdapter(input: ProjectSessionDefaultsSectionInput) {
    const [failedPick, setFailedPick] = React.useState<Readonly<{
        cause: unknown;
        base: ProjectSessionDefaultsV1;
        next: ProjectSessionDefaultsV1;
        scope: ProjectSessionDefaultsSectionInput['scope'];
        addressKey: string | undefined;
    }> | null>(null);
    const { defaults, save: hostSave } = input;
    const error = failedPick && failedPick.scope === input.scope && failedPick.addressKey === input.addressKey
        && isProjectSessionDefaultsEditUnchanged(defaults, failedPick.base) ? failedPick : null;
    const names = React.useMemo<ManagedDefaultSourceNamesV1>(() => ({
        teamName: input.teamName,
        projectName: input.source?.name ?? input.projectName,
        organization: input.context?.policyDefaults?.organization,
    }), [input.teamName, input.source?.name, input.projectName, input.context?.policyDefaults?.organization]);
    const inheritance = React.useMemo<ProjectSessionDefaultsInheritance>(() => {
        const inherited = resolveInheritedManagedSessionDefaults({ ...input.context, scope: input.scope, names });
        return {
            approvalProfileId: inherited.approvalProfileId,
            agentTarget: inherited.agentTarget,
            placement: inherited.placement,
            forAgent: agentTarget => resolveInheritedManagedSessionDefaults({ ...input.context, scope: input.scope, names, agentTarget }),
        };
    }, [input.context, input.scope, names]);
    const save = React.useCallback((next: ProjectSessionDefaultsV1) => {
        setFailedPick(null);
        void hostSave(Object.keys(next).length === 0 ? null : next).catch(cause => setFailedPick({
            cause, base: defaults, next, scope: input.scope, addressKey: input.addressKey,
        }));
    }, [defaults, hostSave, input.addressKey, input.scope]);
    const retry = React.useCallback(() => {
        if (error) save(error.next);
    }, [error, save]);
    const selectAgent = React.useCallback((target: AgentExecutionTargetV1 | undefined) => {
        const { defaultAgentTarget: _previous, ...rest } = defaults;
        save(target ? { ...rest, defaultAgentTarget: target } : rest);
    }, [defaults, save]);
    const selectApprovalProfile = React.useCallback((id: string | null | undefined) => {
        save(withApprovalProfile(defaults, id));
    }, [defaults, save]);
    return { save, selectAgent, selectApprovalProfile, error, retry, inheritance };
}
