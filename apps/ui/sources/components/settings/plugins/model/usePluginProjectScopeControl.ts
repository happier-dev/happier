import { PLUGIN_PROJECT_SCOPE_SET_ACTION_ID } from '@happier-dev/protocol/actions/pluginAccountAdministrationActionIds';
import { PluginAccountAdministrationActionOutputSchemas } from '@happier-dev/protocol/actions/pluginAccountAdministrationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginProjectScopeV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';

/** Account settings can render “All projects” or “Only in these projects” from this exact intent. */
export function usePluginProjectScopeControl(pluginId: string) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const execution = useMountedActionExecution(lifetime?.scope);
    const reader = useActivePluginAccountAvailabilityReader(pluginId);
    const intent = reader?.readCurrentAccountIntent(pluginId);
    if (!lifetime || intent === undefined) return { kind: 'unavailable' } as const;
    const projectScope = intent?.projectScope ?? null;
    const summary = projectScope === null
        ? { kind: 'all' } as const
        : projectScope.projectKeys.length === 1
            ? { kind: 'project', projectKey: projectScope.projectKeys[0]! } as const
            : { kind: 'projects', count: projectScope.projectKeys.length } as const;
    return {
        kind: 'available',
        projectScope,
        summary,
        async setProjectScope(projectScope: PluginProjectScopeV1 | null) {
            try {
                const result = await execution.executeForPresentation(PLUGIN_PROJECT_SCOPE_SET_ACTION_ID, {
                    pluginId, projectScope, expectedRevision: intent?.revision ?? null,
                });
                if (result === null) return null;
                if (!result.ok) return isActionApprovalDeclinedErrorCode(result.errorCode)
                    ? null : { kind: 'rejected' } as const;
                return PluginAccountAdministrationActionOutputSchemas[PLUGIN_PROJECT_SCOPE_SET_ACTION_ID].parse(result.result);
            } catch {
                return { kind: 'unavailable' } as const;
            }
        },
    } as const;
}
