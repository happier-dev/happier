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
    instructionsText: string;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const stateSnapshot = storage.getState() as any;
    const actionIds = listAgentInputActionChipActionIds(stateSnapshot);
    if (actionIds.length === 0) return [];

    const backendId = typeof params.defaultBackendId === 'string' && params.defaultBackendId.trim().length > 0
        ? params.defaultBackendId.trim()
        : null;
    const instructions = String(params.instructionsText ?? '');

    return actionIds.map((actionId) => {
        const spec = getActionSpec(actionId as any);
        const input = buildExecutionRunActionDraftInputForUi({
            actionId: actionId as any,
            sessionId: params.sessionId,
            defaultBackendTarget: params.defaultBackendTarget ?? null,
            defaultBackendId: backendId,
            instructions,
        });

        return createAgentInputActionShortcutChip({
            key: `session-action:${actionId}`,
            label: spec.title,
            layout: 'row',
            onPress: () => {
                storage.getState().createSessionActionDraft(params.sessionId, {
                    actionId,
                    input,
                });
            },
        });
    });
}
