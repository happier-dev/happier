import { createPluginWidgetAreaHostPortV1, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { PluginUiWidgetAreaDeclarationsV1Schema } from '@happier-dev/protocol/plugins/contributions/ui';
import type { BoundPluginSurfaceFacts } from './boundPluginSurfaceController';
import { dispatchPluginSurfaceAction, type PluginSurfaceHostActionBinding, type PluginSurfaceActionMountedBinding } from './pluginSurfaceActionDispatch';
import type { PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';
import { PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

/** Admission comes from this exact normalized destination row, never a physical host name. */
export function createPluginWidgetAreaHostHandler(input: Readonly<{
    facts: BoundPluginSurfaceFacts; isCurrent(): boolean; lifetimeSignal: AbortSignal;
    hostAction: PluginSurfaceHostActionBinding; callerBinding: PluginSurfaceActionMountedBinding | null;
}>): PluginSurfaceHostApiMethodHandler | null {
    const { facts } = input;
    const scope = facts.accountLifetime?.scope;
    if (!scope || facts.serverId && scope.serverId !== facts.serverId) return null;
    const matches = Object.values(facts.pluginUiProjection?.surfacePlacementsById ?? {}).filter(row => row.pluginId === facts.pluginId
        && row.descriptorId === facts.contributionId && row.occurrenceId === facts.occurrenceId
        && row.binding.kind === 'destination' && row.binding.container === 'appPage');
    if (matches.length !== 1) return null;
    const declarations = PluginUiWidgetAreaDeclarationsV1Schema.safeParse(matches[0]!.widgetAreas);
    if (!declarations.success || !declarations.data.length) return null;
    const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: facts.pluginId, pageId: facts.contributionId,
            declarations: declarations.data, isCurrent: input.isCurrent,
            execute: async (actionId, actionInput, context) => {
                const outcome = await dispatchPluginSurfaceAction({ action: actionId, input: PluginUiJsonValueV1Schema.parse(actionInput),
                    ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}), callerPluginId: facts.pluginId, callerContributionLocalId: facts.contributionId,
                    ...(input.callerBinding ? { callerBinding: input.callerBinding } : {}),
                    hostAction: { ...input.hostAction, context: { ...input.hostAction.context, ...context } },
                    isCurrent: input.isCurrent, ...(context.signal ? { signal: context.signal } : {}) });
                return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, errorCode: outcome.reason, error: outcome.reason };
            },
    });
    return async (request, options) => {
        const lifetime = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        try {
            return PluginUiJsonValueV1Schema.parse(PluginUiWidgetAreaResultV1Schema.parse(await port.execute(request.payload, lifetime.signal, request.requestId)));
        } finally { lifetime.dispose(); }
    };
}
