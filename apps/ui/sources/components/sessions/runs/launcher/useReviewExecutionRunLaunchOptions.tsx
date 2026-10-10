import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useHomeAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { useExecutionRunsBackendsForMachine } from '@/hooks/server/useExecutionRunsBackendsForSession';

import { ExecutionRunSecretReferenceOverlayField, resolveExecutionRunSessionLaunchProfile, type ExecutionRunSecretReferenceOverlayState } from './ExecutionRunSecretReferenceOverlayField';
import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';
import { useExecutionRunLaunchContext } from './useExecutionRunLaunchContext';
import { useExecutionRunTeamCredentialModel } from './useExecutionRunTeamCredentialModel';

/** The incumbent review launcher's Secret/Team controls and their exact Home defaults. */
export function useReviewExecutionRunLaunchOptions(params: Readonly<{
    sessionId: string | null;
    machineId?: string;
    cwd?: string;
    serverId: string | null;
    engineIds: readonly string[];
    busy: boolean;
}>) {
    const launcher = useExecutionRunLaunchContext(params.sessionId, params.serverId,
        params.machineId && params.cwd ? { machineId: params.machineId, cwd: params.cwd } : undefined);
    const { settings, session, accountBinding, machineId } = launcher;
    const [launchInput, setLaunchInput] = React.useState<Record<string, unknown>>({});
    const [secretState, setSecretState] = React.useState<ExecutionRunSecretReferenceOverlayState>({ readiness: { ok: true } });
    const sharedSecrets = useFeatureEnabled('teams', { scopeKind: 'spawn', serverId: params.serverId });
    const profiles = useHomeAiLaunchProfiles(accountBinding?.scope ?? null);
    const profile = React.useMemo(() => resolveExecutionRunSessionLaunchProfile(session?.metadata, profiles), [session?.metadata, profiles]);
    const defaultSecretBindings = profile?.secretBindings ?? null;
    const launchability = useSessionExecutionRunLaunchability(params.sessionId ?? '', session, params.serverId);
    const executionRunsEnabled = useFeatureEnabled('execution.runs', { scopeKind: 'spawn', serverId: params.serverId });
    const machineBackends = useExecutionRunsBackendsForMachine({ machineId: params.machineId ?? '', serverId: params.serverId,
        enabled: !params.sessionId && Boolean(params.machineId) && executionRunsEnabled });
    const executionRunsBackends = params.sessionId ? launchability.executionRunsBackends : machineBackends;
    const backendChoices = React.useMemo(() => !launcher.acpCatalogReady ? [] : resolveExecutionRunLauncherBackendChoices({ intent: 'review',
        enabledAgentIds: launcher.enabledAgentIds, executionRunsBackends,
        acpCatalogSnapshot: launcher.acpCatalogSnapshot }), [launcher.acpCatalogReady, launcher.acpCatalogSnapshot, launcher.enabledAgentIds, executionRunsBackends]);
    const chosenBackend = params.engineIds.length === 1
        ? backendChoices.find((choice) => choice.backendId === params.engineIds[0] || choice.targetKey === params.engineIds[0]) ?? null
        : null;
    const teamCredential = useExecutionRunTeamCredentialModel({ sessionId: params.sessionId, serverId: params.serverId,
        selectedBackendChoice: chosenBackend, hasBackendChoices: backendChoices.length > 0, actionInput: launchInput,
        setActionInput: setLaunchInput });
    const ready = Boolean(launcher.exactSettings && launcher.acpCatalogReady && launcher.profileCatalogReady && launcher.accountLifetime?.isCurrent()
        && (params.sessionId ? session : params.machineId && params.cwd && executionRunsEnabled)
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
