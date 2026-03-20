import * as React from 'react';

import { EnvironmentVariablesPreviewPanel } from '@/components/sessions/new/components/EnvironmentVariablesPreviewPanel';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

type Props = Readonly<{
    profile: AIBackendProfile;
    machineId: string | null;
    serverId?: string | null;
    machineName?: string | null;
    onClose: () => void;
    surfaceVariant?: 'modal' | 'popover';
}>;

export function NewSessionProfileEnvironmentVariablesPreview(props: Props) {
    return (
        <EnvironmentVariablesPreviewPanel
            environmentVariables={getProfileEnvironmentVariables(props.profile)}
            machineId={props.machineId}
            serverId={props.serverId}
            machineName={props.machineName}
            profileName={props.profile.name}
            onClose={props.onClose}
            surfaceVariant={props.surfaceVariant}
        />
    );
}
