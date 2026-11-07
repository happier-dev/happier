import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginSurfaceAccountActionContext, dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginSurfaceActionFailureError } from '@/components/plugins/surfaces/actionFailure';
import { createPluginSurfaceAccountActionServices } from '@/components/plugins/surfaces/pluginSurfaceAccountActionServices';
import type { PluginUiClientWorkItemsRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { readPluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { BoardTaskSource } from './boardTaskItems';

/** Bind a live read to its existing Account services, without a daemon service facade. */
export function createBoardTaskActionContext(input: Readonly<{
    source: BoardTaskSource;
    registration: PluginUiClientWorkItemsRegistration['registration'];
    signal: AbortSignal;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): Readonly<{ context: ReturnType<typeof createPluginSurfaceAccountActionContext>; dispose: () => void }> {
    const { source, registration } = input;
    const accountLifetime = registration.accountLifetime ?? input.accountLifetime;
    if (!accountLifetime) throw new PluginError({ code: 'plugin_surface_account_action_unavailable' });
    const readProjection = () => input.pluginUiProjection ?? readCurrentAppShellPluginUiProjection({
        scope: accountLifetime.scope, declarationsOnly: true,
    });
    const accountOrigin = readPluginUiAccountExecutableOrigin(source);
    const sourceCustody = accountOrigin?.sourceCustody
        ?? (registration.executionOrigin && 'sourceRef' in registration.executionOrigin ? registration.executionOrigin.sourceRef.sourceCustody : undefined);
    const isCurrent = registration.lifecycle.isCurrent;
    const hostAction = {
        execute: createFrontDoorActionExecute(),
        context: { serverId: accountLifetime.scope.serverId, expectedAccountId: accountLifetime.scope.accountId },
    };
    const capability = createPluginSurfaceAccountActionServices({
        pluginId: source.pluginId, occurrenceId: registration.occurrenceId, sourceCustody,
        accountLifetime, signal: input.signal, isCurrent,
        execute: async (action, value, options) => {
            const projection = readProjection();
            const outcome = await dispatchPluginSurfaceAction({
                callerPluginId: source.pluginId, callerSourceCustody: sourceCustody,
                hostAction, actionAccountLifetime: accountLifetime,
                action, input: value, invocationSurface: 'plugin', originSurface: 'ui', clientAction: {},
                invocation: { kind: 'clientPluginAction', clientActionBinding: {
                    pluginId: source.pluginId, contributionLocalId: source.definition.id,
                    occurrenceId: registration.occurrenceId, sourceCustody, pluginVersion: source.pluginVersion,
                    ...(registration.executionOrigin && 'materializationRef' in registration.executionOrigin
                        ? { materializationRef: registration.executionOrigin.materializationRef } : {}),
                } },
                pluginUiProjection: projection,
                resolveContributedAction: projection ? createPluginUiProjectedActionResolver(projection.actionsById) : undefined,
                signal: options.signal, isCurrent: options.isCurrent,
                ...(options.sessionAddress === undefined ? {} : { sessionAddress: options.sessionAddress }),
                ...(options.requiredReadOnly ? { requiredReadOnly: true } : {}),
                ...(options.readObservation ? { readObservation: options.readObservation } : {}),
                ...(options.expectedContributorOccurrenceId === undefined ? {} : {
                    expectedContributorOccurrenceId: options.expectedContributorOccurrenceId,
                }),
            });
            if (!outcome.ok) throw createPluginSurfaceActionFailureError(outcome);
            return outcome.result;
        },
    });
    return {
        context: createPluginSurfaceAccountActionContext({
            plugin: { id: source.pluginId, version: source.pluginVersion },
            contribution: { id: source.definition.id, qualifiedId: source.id },
            surface: 'ui', signal: capability.signal, accountScope: accountLifetime.scope,
            services: capability.services,
        }),
        dispose: capability.dispose,
    };
}
