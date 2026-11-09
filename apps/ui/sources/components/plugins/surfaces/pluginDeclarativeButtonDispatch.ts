import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDeclarativeButtonV1 } from '@happier-dev/protocol/plugins/contributions/declarativeButtonsV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { withInternalRouteQueryParams } from '@/utils/path/routeUtils';

export type PluginDeclarativeButtonDispatchInput = Readonly<{
    button: PluginDeclarativeButtonV1;
    ownerPluginId: string;
    scope: ServerAccountScope;
    defaultRoute: string;
    sessionId?: string;
    isCurrent(): boolean;
    signal?: AbortSignal;
    input?: JsonValue;
    interactivePresentation?: 'unavailable';
    actionRequestId?: string;
}>;

export type PluginDeclarativeButtonDispatchOutcome =
    | Readonly<{ kind: 'open'; route: string }>
    | Readonly<{ kind: 'action'; result: ActionExecuteResult }>
    | Readonly<{ kind: 'unavailable' }>;

/** Host-rendered intent borrows viewer authority only at the ordinary Action front door. */
export async function dispatchPluginDeclarativeButton(input: PluginDeclarativeButtonDispatchInput): Promise<PluginDeclarativeButtonDispatchOutcome> {
    const unavailable = (): PluginDeclarativeButtonDispatchOutcome => ({ kind: 'unavailable' });
    if (input.signal?.aborted || !input.isCurrent()) return unavailable();
    const admitted = await resolveServerCredentialAccountScope(input.scope.serverId);
    if (input.signal?.aborted || !input.isCurrent() || admitted.kind !== 'bound'
        || admitted.scope.accountId !== input.scope.accountId
        || !areServerProfileIdentifiersEquivalent(admitted.scope.serverId, input.scope.serverId)) return unavailable();
    const scope = admitted.scope;
    const effect = input.button.effect;
    if (effect.kind === 'open') return { kind: 'open', route: effect.page ? withInternalRouteQueryParams(buildPluginAppPageRoutePath({
        pluginId: input.ownerPluginId, localId: effect.page.pageId, subPath: effect.page.subPath,
    }), { serverId: scope.serverId }) : input.defaultRoute };
    const readProjection = () => readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true });
    const action = createPluginUiProjectedActionResolver(readProjection()?.actionsById)(effect.invocation.action);
    if (!action?.occurrenceId) return unavailable();
    // An invocation always owns a cancellation signal, including on native
    // where the confirmation presenter needs it to use a dismissible dialog.
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
        const prepared = await createFrontDoorActionExecute().prepare('action.invoke', {
            action: effect.invocation.action, input: input.input === undefined ? effect.invocation.input : input.input,
        }, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
            expectedContributedActionOccurrenceId: action.occurrenceId, signal: controller.signal,
            ...(input.interactivePresentation ? { interactivePresentation: input.interactivePresentation } : {}),
            ...(input.actionRequestId ? { actionRequestId: input.actionRequestId } : {}),
            ...(input.sessionId ? { defaultSessionId: input.sessionId } : {}),
        });
        if (controller.signal.aborted) return unavailable();
        return { kind: 'action', result: prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result };
    } catch {
        return unavailable();
    } finally {
        input.signal?.removeEventListener('abort', abort);
    }
}
