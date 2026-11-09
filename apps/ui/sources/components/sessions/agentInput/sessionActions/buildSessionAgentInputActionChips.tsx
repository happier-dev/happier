import type { ExecutionRunLauncherDraftSeed } from '@/components/sessions/runs/launcher/prepareExecutionRunLauncherDraft';
import React from 'react';

import type { BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { storage } from '@/sync/domains/state/storage';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { createAgentInputActionShortcutChip } from '@/components/sessions/agentInput/sessionActions/createAgentInputActionShortcutChip';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { getAgentInputActionShortcutDefinition } from './agentInputActionShortcutPlacements';


export function buildSessionAgentInputActionChips(params: Readonly<{
    address: SessionAddress;
    openExecutionRunDraft: (seed: ExecutionRunLauncherDraftSeed) => void;
    accountScope: ServerAccountScope | null;
    accountScopeIsCurrent?: (() => boolean) | null;
    defaultBackendTarget?: BackendTargetRefV2Input | null;
    defaultBackendId: string | null;
    /** The composer text, read when a chip is pressed: typing never rebuilds the chips. */
    readInstructionsText: () => string;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const stateSnapshot = storage.getState() as any;
    if (
        !params.accountScope
        || params.accountScopeIsCurrent?.() === false
        || params.accountScope.serverId !== params.address.serverId
    ) return [];
    const accountScope = params.accountScope;
    const actionIds = listAgentInputActionChipActionIds(stateSnapshot);
    if (actionIds.length === 0) return [];

    const backendId = typeof params.defaultBackendId === 'string' && params.defaultBackendId.trim().length > 0
        ? params.defaultBackendId.trim()
        : null;
    return actionIds.map((actionId) => {
        return createAgentInputActionShortcutChip({
            ...getAgentInputActionShortcutDefinition('session', actionId),
            layout: 'row',
            onPress: () => {
                if (params.accountScopeIsCurrent?.() === false) return;
                const input = buildExecutionRunActionDraftInputForUi({
                    actionId: actionId as any,
                    sessionId: params.address.sessionId,
                    defaultBackendTarget: params.defaultBackendTarget ?? null,
                    defaultBackendId: backendId,
                    instructions: params.readInstructionsText(),
                });
                params.openExecutionRunDraft({ scope: accountScope, sessionId: params.address.sessionId, actionId, input });
            },
        });
    });
}
