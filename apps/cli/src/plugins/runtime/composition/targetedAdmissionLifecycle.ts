import { resolveAdmittedTargetedContributions } from '../../projection/registry/targetedContributions';
import type { ResolvedContributionRegistry } from '../../projection/registry/types';

/** Publish the admission for the current consumer occurrences, rebuilding only on retirement. */
export function createTargetedAdmissionLifecycle(
    initial: ResolvedContributionRegistry,
    isCurrent: (pluginId: string) => boolean,
) {
    let read = initial.readAdmittedTargetedContributions;
    const contributes = Object.freeze(Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(initial),
        readAdmittedTargetedContributions: {
            enumerable: true,
            value: (...args: Parameters<NonNullable<ResolvedContributionRegistry['readAdmittedTargetedContributions']>>) =>
                read?.(...args) ?? null,
        },
    })) as ResolvedContributionRegistry;
    return {
        contributes,
        refresh() {
            read = resolveAdmittedTargetedContributions({
                pluginContributionPoints: (initial.pluginContributionPoints ?? []).filter(item => isCurrent(item.pluginId)),
                targetedPluginContributions: (initial.targetedPluginContributions ?? []).filter(item => isCurrent(item.pluginId)),
                actions: initial.actions.filter(item => !item.pluginId || isCurrent(item.pluginId)),
                uiRenderersV2: (initial.uiRenderersV2 ?? []).filter(item => isCurrent(item.pluginId)),
                occurrenceIdsByPluginId: initial.occurrenceIdsByPluginId ?? {},
                unavailablePlugins: initial.unavailablePlugins,
            }).read;
        },
    };
}
