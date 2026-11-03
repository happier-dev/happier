import type { PluginResourceContextV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { PluginUiProjectionModel, PluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY, readPluginUiContributionOrigin, resolvePluginUiExecutionDeclaration } from '@/sync/domains/plugins/ui/projectionUnion';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readPluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginContextualResourceBinding } from './PluginContextualResourceStoreProvider';

export type PluginResourceBindingAdmission = Readonly<{
    projection: PluginUiProjectionModel | null;
    machineId: string | null;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    requireReadAuthority?: boolean;
    isCurrent(): boolean;
}>;

/** One declaration/occurrence owner for host contextual Resource consumers. */
export function resolvePluginContextualResourceBinding(input: PluginResourceBindingAdmission,
    declaration: PluginUiResourceProjection, context: PluginResourceContextV1): PluginContextualResourceBinding | null {
    if (!input.accountLifetime.isCurrent() || !input.isCurrent()) return null;
    if (declaration.execution?.target === 'account') {
        const projection = readCurrentAppShellPluginUiProjection({ scope: input.accountLifetime.scope, declarationsOnly: true });
        const selected = resolvePluginUiExecutionDeclaration(declaration, { current: readPluginUiResourceProjection(
            projection?.resourcesById, { pluginId: declaration.pluginId, localId: declaration.id }) });
        const accountOrigin = readPluginUiAccountExecutableOrigin(selected);
        if (!selected || selected.scope !== context.kind || !projection?.installedPackagesById[selected.pluginId]?.enabled
            || !accountOrigin || accountOrigin.serverId !== (input.serverId ?? input.accountLifetime.scope.serverId)
            || accountOrigin.serverId !== input.accountLifetime.scope.serverId
            || accountOrigin.accountId !== input.accountLifetime.scope.accountId) return null;
        return { pluginId: selected.pluginId, machineId: null, serverId: accountOrigin.serverId, accountLifetime: input.accountLifetime,
            ...(input.machineId ? { actionExecutionTarget: { machineId: input.machineId, serverId: accountOrigin.serverId } } : {}),
            expectedCallerOccurrenceId: accountOrigin.custodyId, context, accountResource: selected };
    }
    const plugin = input.projection?.installedPackagesById[declaration.pluginId];
    if (!declaration.scope || declaration.scope !== context.kind || !plugin?.enabled
        || typeof plugin.occurrenceId !== 'string' || !plugin.occurrenceId
        || declaration.occurrenceId !== undefined && declaration.occurrenceId !== plugin.occurrenceId) return null;
    const origin = readPluginUiContributionOrigin(declaration);
    if (Object.hasOwn(declaration, PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY) && !origin) return null;
    if (input.requireReadAuthority && origin && (origin.phase !== 'current' || !origin.interactionEnabled)) return null;
    const serverId = input.serverId ?? origin?.serverId ?? null;
    if (serverId !== input.accountLifetime.scope.serverId) return null;
    const packageOrigin = readPluginUiContributionOrigin(plugin);
    const machineId = input.machineId ?? origin?.machineId;
    if (!machineId || origin && (origin.machineId !== machineId || origin.serverId !== serverId)
        || packageOrigin && (packageOrigin.machineId !== machineId || packageOrigin.serverId !== serverId)) return null;
    return { pluginId: declaration.pluginId, machineId, serverId, accountLifetime: input.accountLifetime,
        expectedCallerOccurrenceId: plugin.occurrenceId, context };
}
