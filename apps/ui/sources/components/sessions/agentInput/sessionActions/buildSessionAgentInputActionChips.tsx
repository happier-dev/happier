import React from 'react';

import { getActionSpec, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { createAgentInputActionShortcutChip } from '@/components/sessions/agentInput/sessionActions/createAgentInputActionShortcutChip';


export function buildSessionAgentInputActionChips(params: Readonly<{
    sessionId: string;
    defaultBackendTarget?: BackendTargetRefV1 | null;
    defaultBackendId: string | null;
    /** Read when a chip is pressed: the chips must not change identity on every keystroke. */
    getInstructionsText: () => string;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const stateSnapshot = storage.getState() as any;
    const actionIds = listAgentInputActionChipActionIds(stateSnapshot);
    if (actionIds.length === 0) return [];

    const backendId = typeof params.defaultBackendId === 'string' && params.defaultBackendId.trim().length > 0
        ? params.defaultBackendId.trim()
        : null;
    return actionIds.map((actionId) => {
        const spec = getActionSpec(actionId as any);

        return createAgentInputActionShortcutChip({
            key: `session-action:${actionId}`,
            label: spec.title,
            layout: 'row',
            onPress: () => {
                storage.getState().createSessionActionDraft(params.sessionId, {
                    actionId,
                    input: buildExecutionRunActionDraftInputForUi({
                        actionId: actionId as any,
                        sessionId: params.sessionId,
                        defaultBackendTarget: params.defaultBackendTarget ?? null,
                        defaultBackendId: backendId,
                        instructions: params.getInstructionsText(),
                    }),
                });
            },
        });
    });
}
