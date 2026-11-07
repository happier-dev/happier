import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { launchPluginSurfaceAction } from '@/components/plugins/surfaces/launchPluginSurfaceAction';
import { createPluginUiProjectedActionResolver, isPluginProjectedActionExecutable } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin, readPluginUiProjectionEntryExecutionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { PluginSurfaceActionDispatchOutcome } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { BoardCard } from './boardCards';

/** The role is source-owned; placement, policy and credentials remain with Action dispatch. */
export function readBoardTaskTransitionAction(card: BoardCard, view: AppShellPluginUiProjectionValue) {
    if (card.ref.kind !== 'task' || card.body.kind !== 'task' || card.availability !== 'ready'
        || !view.interactionEnabled || !view.accountLifetime?.isCurrent()
        || !areServerProfileIdentifiersEquivalent(card.ref.qualifiedId.serverId, view.accountLifetime.scope.serverId)) return null;
    const source = view.pluginUiProjection?.workItemsById[`${card.ref.pluginId}/work-items`];
    const localId = source?.definition.transitionAction;
    if (!source || !localId || source.pluginId !== card.ref.pluginId) return null;
    const identity = { pluginId: source.pluginId, localId };
    const action = createPluginUiProjectedActionResolver(view.pluginUiProjection?.actionsById)(identity);
    if (!isPluginProjectedActionExecutable(action)) return null;
    const origin = readPluginUiContributionOrigin(action);
    if (origin && (origin.phase !== 'current' || !origin.interactionEnabled
        || !areServerProfileIdentifiersEquivalent(origin.serverId, card.ref.qualifiedId.serverId))) return null;
    const executionOrigin = origin?.executionOrigin ?? readPluginUiProjectionEntryExecutionOrigin(action);
    const machineId = origin?.machineId ?? (executionOrigin ? getPluginMachineExecutionOriginRef(executionOrigin).machineId : null);
    if (action.execution.target === 'daemon' && !machineId) return null;
    return { identity, action, source, machineId, lifetime: view.accountLifetime };
}

export async function dispatchBoardTaskTransition(input: Readonly<{
    card: BoardCard;
    transitionId: string;
    readCurrentView: () => AppShellPluginUiProjectionValue;
    signal: AbortSignal;
}>): Promise<PluginSurfaceActionDispatchOutcome> {
    const selected = readBoardTaskTransitionAction(input.card, input.readCurrentView());
    if (!selected || input.card.body.kind !== 'task'
        || !input.card.body.item.transitions?.some(transition => transition.id === input.transitionId)) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    const isCurrent = () => {
        const current = readBoardTaskTransitionAction(input.card, input.readCurrentView());
        return current !== null && current.source === selected.source && current.action === selected.action && current.lifetime === selected.lifetime;
    };
    const launched = await launchPluginSurfaceAction({
        // Host-rendered intent: no plugin caller or autonomous invocation carrier.
        action: selected.identity,
        hostAction: { execute: createFrontDoorActionExecute(),
            context: { serverId: selected.lifetime.scope.serverId, expectedAccountId: selected.lifetime.scope.accountId } },
        actionAccountLifetime: selected.lifetime,
        input: { serverId: input.card.ref.qualifiedId.serverId, itemId: input.card.ref.qualifiedId.id, transitionId: input.transitionId },
        resolveContributedAction: identity => createPluginUiProjectedActionResolver(input.readCurrentView().pluginUiProjection?.actionsById)(identity),
        ...(selected.action.execution.target === 'daemon' ? { contributedAction: {
            machineId: selected.machineId!, serverId: input.card.ref.qualifiedId.serverId, accountLifetime: selected.lifetime,
        } } : { clientAction: {} }),
        pluginUiProjection: input.readCurrentView().pluginUiProjection,
        signal: input.signal, isCurrent,
    });
    return launched.outcome;
}
