import type { PluginProjectScopeV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { setActivePluginAccountAvailabilityIntent } from '@/sync/api/plugins/availability/setActivePluginAccountAvailabilityIntent';

/** Account settings can render “All projects” or “Only in these projects” from this exact intent. */
export function usePluginProjectScopeControl(pluginId: string) {
    const lifetime = useActiveServerAccountScopeLifetime();
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
            if (!lifetime.isCurrent()) return { kind: 'unavailable', code: 'account_scope_changed' } as const;
            return await setActivePluginAccountAvailabilityIntent({
                pluginId,
                projectScope,
                enabled: intent?.enabled ?? true,
                desiredVersion: intent?.desiredVersion ?? null,
                offlineUiHosting: intent?.offlineUiHosting ?? 'disabled',
                writableCollections: intent?.writableCollections ?? [],
                expectedRevision: intent?.revision ?? null,
            });
        },
    } as const;
}
