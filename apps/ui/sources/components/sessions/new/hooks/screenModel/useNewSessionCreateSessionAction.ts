import * as React from 'react';

import { useCreateNewSession } from '@/components/sessions/new/hooks/useCreateNewSession';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';

type UseCreateNewSessionParams = Parameters<typeof useCreateNewSession>[0];
type UseCreateNewSessionResult = ReturnType<typeof useCreateNewSession>;

type UseNewSessionCreateSessionActionParams = Readonly<
    Omit<UseCreateNewSessionParams, 'authoringDraft' | 'allowedTargetServerIds'> & {
        currentAuthoringDraft: UseCreateNewSessionParams['authoringDraft'];
        allowedTargetServerIds: ReadonlyArray<string>;
        resolvedSettingsAllowedServerIds: ReadonlyArray<string>;
        capabilityServerId: string;
    }
>;

export function useNewSessionCreateSessionAction(params: UseNewSessionCreateSessionActionParams): Readonly<{
    handleCreateSession: UseCreateNewSessionResult['handleCreateSession'];
    providerLaunchError: UseCreateNewSessionResult['providerLaunchError'];
    retryProviderLaunch: UseCreateNewSessionResult['retryProviderLaunch'];
}> {
    const {
        currentAuthoringDraft,
        allowedTargetServerIds,
        resolvedSettingsAllowedServerIds,
        capabilityServerId,
        ...createSessionParams
    } = params;

    const createSession = useCreateNewSession({
        ...createSessionParams,
        authoringDraft: currentAuthoringDraft,
        allowedTargetServerIds: allowedTargetServerIds.length > 0
            ? allowedTargetServerIds
            : resolvedSettingsAllowedServerIds,
    });
    const handleCreateSession = React.useCallback(async (
        options?: Parameters<UseCreateNewSessionResult['handleCreateSession']>[0],
    ) => {
        const selectedMachineId = createSessionParams.selectedMachineId;
        if (selectedMachineId) {
            try {
                await ensureAgentInstallablesBackground({
                    agentId: createSessionParams.agentType,
                    machineId: selectedMachineId,
                    serverId: capabilityServerId,
                    settings: createSessionParams.settings,
                    resumeSessionId: createSessionParams.resumeSessionId,
                });
            } catch {
                // Install/update is best-effort; the canonical create path owns user-facing launch errors.
            }
        }
        return createSession.handleCreateSession(options);
    }, [
        capabilityServerId,
        createSession.handleCreateSession,
        createSessionParams.agentType,
        createSessionParams.resumeSessionId,
        createSessionParams.selectedMachineId,
        createSessionParams.settings,
    ]);

    return {
        handleCreateSession,
        providerLaunchError: createSession.providerLaunchError,
        retryProviderLaunch: createSession.retryProviderLaunch,
    };
}
