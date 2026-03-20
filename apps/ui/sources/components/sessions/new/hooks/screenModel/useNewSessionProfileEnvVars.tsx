import * as React from 'react';

import { EnvironmentVariablesPreviewPanel } from '@/components/sessions/new/components/EnvironmentVariablesPreviewPanel';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';

type MachineMetadataLike = Readonly<{
    displayName?: string | null;
    host?: string | null;
}>;

type MachineLike = Readonly<{
    metadata?: MachineMetadataLike | null;
}> | null;

export function useNewSessionProfileEnvVars(params: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    selectedMachineId: string | null;
    selectedMachine: MachineLike;
    capabilityServerId: string | null;
}>): Readonly<{
    selectedProfileEnvVarsCount: number;
    envVarsPopover?: AgentInputContentPopoverConfig;
}> {
    const selectedProfileForEnvVars = React.useMemo(() => {
        if (!params.useProfiles || !params.selectedProfileId) return null;
        return params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId) || null;
    }, [params.profileMap, params.selectedProfileId, params.useProfiles]);

    const selectedProfileEnvVars = React.useMemo(() => {
        if (!selectedProfileForEnvVars) return {};
        return transformProfileToEnvironmentVars(selectedProfileForEnvVars) ?? {};
    }, [selectedProfileForEnvVars]);

    const selectedProfileEnvVarsCount = React.useMemo(() => {
        return Object.keys(selectedProfileEnvVars).length;
    }, [selectedProfileEnvVars]);

    const envVarsPopover = React.useMemo<AgentInputContentPopoverConfig | undefined>(() => {
        if (!selectedProfileForEnvVars) return undefined;
        return {
            maxHeightCap: 480,
            maxWidthCap: 460,
            renderContent: ({ requestClose }) => (
                <EnvironmentVariablesPreviewPanel
                    environmentVariables={selectedProfileEnvVars}
                    machineId={params.selectedMachineId}
                    serverId={params.capabilityServerId}
                    machineName={params.selectedMachine?.metadata?.displayName || params.selectedMachine?.metadata?.host}
                    profileName={selectedProfileForEnvVars.name}
                    onClose={requestClose}
                    surfaceVariant="popover"
                />
            ),
        };
    }, [
        params.capabilityServerId,
        params.selectedMachine,
        params.selectedMachineId,
        selectedProfileEnvVars,
        selectedProfileForEnvVars,
    ]);

    return {
        selectedProfileEnvVarsCount,
        envVarsPopover,
    };
}
