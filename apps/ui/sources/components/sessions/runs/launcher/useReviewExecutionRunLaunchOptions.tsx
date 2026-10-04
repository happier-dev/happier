import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useHomeAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';

import { ExecutionRunSecretReferenceOverlayField, resolveExecutionRunSessionLaunchProfile, type ExecutionRunSecretReferenceOverlayState } from './ExecutionRunSecretReferenceOverlayField';
import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';
import { useExecutionRunLaunchContext } from './useExecutionRunLaunchContext';
import { useExecutionRunTeamCredentialModel } from './useExecutionRunTeamCredentialModel';

/** The incumbent review launcher's Secret/Team controls and their exact Home defaults. */
export function useReviewExecutionRunLaunchOptions(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    engineIds: readonly string[];
    busy: boolean;
}>) {
    const launcher = useExecutionRunLaunchContext(params.sessionId, params.serverId);
    const { settings, session, accountBinding, machineId } = launcher;
    const [launchInput, setLaunchInput] = React.useState<Record<string, unknown>>({});
    const [secretState, setSecretState] = React.useState<ExecutionRunSecretReferenceOverlayState>({ readiness: { ok: true } });
    const sharedSecrets = useFeatureEnabled('teams', { scopeKind: 'spawn', serverId: params.serverId });
    const profiles = useHomeAiLaunchProfiles(settings.profiles, accountBinding?.scope ?? null);
    const profile = React.useMemo(() => resolveExecutionRunSessionLaunchProfile(settings, session?.metadata, profiles), [settings, session?.metadata, profiles]);
    const defaultSecretBindings = React.useMemo(() => profile
        ? { ...profile.secretBindings, ...settings.currentSecretBindingsByProfileId[profile.id] }
        : null, [profile, settings.currentSecretBindingsByProfileId]);
    const launchability = useSessionExecutionRunLaunchability(params.sessionId, session, params.serverId);
    const backendChoices = React.useMemo(() => resolveExecutionRunLauncherBackendChoices({ intent: 'review',
        enabledAgentIds: launcher.enabledAgentIds, executionRunsBackends: launchability.executionRunsBackends,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1 }), [launcher.enabledAgentIds, launchability.executionRunsBackends, settings.acpCatalogSettingsV1]);
    const chosenBackend = params.engineIds.length === 1
        ? backendChoices.find((choice) => choice.backendId === params.engineIds[0] || choice.targetKey === params.engineIds[0]) ?? null
        : null;
    const teamCredential = useExecutionRunTeamCredentialModel({ sessionId: params.sessionId, serverId: params.serverId,
        selectedBackendChoice: chosenBackend, hasBackendChoices: backendChoices.length > 0, actionInput: launchInput,
        setActionInput: setLaunchInput });
    const ready = Boolean(launcher.exactSettings && launcher.accountLifetime?.isCurrent() && session
        && secretState.readiness.ok && teamCredential.available);
    const input = React.useMemo(() => ({ ...launchInput,
        ...(secretState.overlay ? { secretReferenceOverlay: secretState.overlay } : {}) }), [launchInput, secretState.overlay]);
    const controls = <>
        {teamCredential.picker}
        <ExecutionRunSecretReferenceOverlayField profile={profile} machineId={machineId} serverId={params.serverId}
            accountScope={accountBinding?.scope ?? null} defaultBindings={defaultSecretBindings}
            personalSecrets={settings.secrets} sharedEnabled={sharedSecrets} editable={!params.busy} onChange={setSecretState} />
    </>;
    return { launcher, ready, input, controls };
}
