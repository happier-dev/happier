import type { ActivityInteractionCommand } from '@/activity/actions/resolveActivityInteractionCommand';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { dispatchPluginDeclarativeButton } from '@/components/plugins/surfaces/pluginDeclarativeButtonDispatch';

/** Native presentation is intent only; current declarations and the Action front door admit effects. */
export async function executePluginNotificationButton(
    command: Extract<ActivityInteractionCommand, { kind: 'openNotice' }>,
    options: Readonly<{ allowExecution: boolean; signal?: AbortSignal }>,
): Promise<string | null> {
    if (options.signal?.aborted) return null;
    const press = command.pluginNotificationPress;
    if (!press) return command.route;
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(command.serverId), accountId: command.accountId };
    const readProjection = () => readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true });
    const key = buildQualifiedPluginContributionKey({ pluginId: press.notification.pluginId, localId: press.notification.categoryId });
    const category = readProjection()?.notificationCategoriesById[key];
    if (!category || category.occurrenceId !== press.notification.occurrenceId) return command.route;
    const button = category.definition.buttons?.find(candidate => candidate.id === press.buttonId);
    if (!button) return command.route;
    if (button.effect.kind === 'action' && (!options.allowExecution || button.effect.invocation.action.pluginId !== category.pluginId)) return command.route;
    const input = press.notification.buttonInputs && Object.prototype.hasOwnProperty.call(press.notification.buttonInputs, button.id)
        ? press.notification.buttonInputs[button.id] : undefined;
    const isCurrent = () => !options.signal?.aborted && readProjection()?.notificationCategoriesById[key] === category;
    // Keep the incumbent operation request id stable for a replay and within its
    // wire boundary, without restricting plugin-chosen button/send identifiers.
    const actionRequestId = button.effect.kind === 'action' ? `plugin-notification:${bytesToHex(sha256(utf8ToBytes(JSON.stringify([
        scope.serverId, scope.accountId, press.notification.pluginId, press.notification.categoryId,
        press.notification.occurrenceId, press.notification.clientRequestId, button.id,
    ]))))}` : undefined;
    const outcome = await dispatchPluginDeclarativeButton({ button, ownerPluginId: category.pluginId, scope,
        defaultRoute: command.route, isCurrent, interactivePresentation: 'unavailable', ...(actionRequestId ? { actionRequestId } : {}),
        ...(input === undefined ? {} : { input }), ...(options.signal ? { signal: options.signal } : {}),
        ...(command.defaultSessionId ? { sessionId: command.defaultSessionId } : {}),
    });
    if (!isCurrent()) return null;
    return outcome.kind === 'open' ? outcome.route : outcome.kind === 'action' && outcome.result.ok ? null : command.route;
}
