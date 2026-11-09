import React from 'react';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds';
import { createAgentInputActionShortcutChip } from '@/components/sessions/agentInput/sessionActions/createAgentInputActionShortcutChip';
import { getAgentInputActionShortcutDefinition } from './agentInputActionShortcutPlacements';

export function buildNewSessionActionShortcutChips(params: Readonly<{
    stateSnapshot: Readonly<{ settings?: unknown }>;
    onPressAction: (actionId: ActionId) => void;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const actionIds = listAgentInputActionChipActionIds(params.stateSnapshot);

    return actionIds.map((actionId) => {
        return createAgentInputActionShortcutChip({
            ...getAgentInputActionShortcutDefinition('newSession', actionId),
            onPress: () => params.onPressAction(actionId),
        }) satisfies AgentInputExtraActionChip;
    });
}
