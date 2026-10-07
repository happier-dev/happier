import React from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds';
import { createAgentInputActionShortcutChip } from '@/components/sessions/agentInput/sessionActions/createAgentInputActionShortcutChip';

export function buildNewSessionActionShortcutChips(params: Readonly<{
    stateSnapshot: Readonly<{ settings?: unknown }>;
    onPressAction: (actionId: ActionId) => void;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const actionIds = listAgentInputActionChipActionIds(params.stateSnapshot);

    return actionIds.map((actionId) => {
        const spec = getActionSpec(actionId);
        return createAgentInputActionShortcutChip({
            key: `new-session-action:${actionId}`,
            label: spec.title,
            onPress: () => params.onPressAction(actionId),
        }) satisfies AgentInputExtraActionChip;
    });
}
