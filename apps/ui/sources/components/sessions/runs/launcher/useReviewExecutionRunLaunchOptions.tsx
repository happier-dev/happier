import * as React from 'react';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import type { PluginUiSelectActionInputResultV1 } from '@happier-dev/protocol/plugins/ui';

import { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { useExactModelChoice } from '@/components/sessions/modelPicker/useExactModelChoice';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHomeAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';

import { ExecutionRunSecretReferenceOverlayField, resolveExecutionRunSessionLaunchProfile, type ExecutionRunSecretReferenceOverlayState } from './ExecutionRunSecretReferenceOverlayField';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import type { useExecutionRunLaunchContext } from './useExecutionRunLaunchContext';
import { useExecutionRunTeamCredentialModel } from './useExecutionRunTeamCredentialModel';
import { applyExecutionRunChildSelection, clearExecutionRunChildSelection } from './executionRunChildChoice';
import { t } from '@/text';

export type ReviewExecutionRunLaunchSelection = Extract<PluginUiSelectActionInputResultV1, { kind: 'executionRunLaunch' }>;

/** Settles the existing credential chooser without invoking the review Action. */
export async function admitReviewExecutionRunLaunchSelection(params: Readonly<{
    launcher: ReturnType<typeof useExecutionRunLaunchContext>;
    draft: Record<string, unknown>;
    operationId: string;
    isCurrent: () => boolean;
}>): Promise<ReviewExecutionRunLaunchSelection | null> {
    if (!params.isCurrent()) return null;
    const admitted = ReviewStartInputSchema.parse(params.draft);
    await params.launcher.admitExactTarget({
        secretReferenceOverlay: admitted.secretReferenceOverlay !== undefined,
        teamCredentialModel: admitted.teamCredentialModel !== undefined,
    }, params.operationId);
    if (!params.isCurrent() || !params.launcher.accountLifetime?.isCurrent()) return null;
    return { kind: 'executionRunLaunch', input: {
        ...(admitted.secretReferenceOverlay ? { secretReferenceOverlay: admitted.secretReferenceOverlay } : {}),
        ...(admitted.teamCredentialModel ? { teamCredentialModel: admitted.teamCredentialModel } : {}),
        ...(admitted.teamCredentialSessionBindingConsent ? { teamCredentialSessionBindingConsent: admitted.teamCredentialSessionBindingConsent } : {}),
    } };
}

/** The review launcher's model and Secret controls, scoped to its exact Home and Agent. */
export function useReviewExecutionRunLaunchOptions(params: Readonly<{
    launcher: ReturnType<typeof useExecutionRunLaunchContext>;
    sessionId: string | null;
    serverId: string | null;
    backendChoices: readonly ExecutionRunLauncherBackendChoice[];
    selectedBackendChoice: ExecutionRunLauncherBackendChoice | null;
    actionInput: Record<string, unknown>;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    inheritedSelection?: Parameters<typeof useExecutionRunTeamCredentialModel>[0]['inheritedSelection'];
    onSelectionChange?: () => void;
    /** Route and child-refusal pickers already have a separate, demanded model owner. */
    modelSelectionEnabled?: boolean;
    busy: boolean;
    /** The plugin host's credential-only settlement cannot carry a personal model choice. */
    credentialSelectionOnly?: boolean;
}>) {
    const { launcher, actionInput: launchInput, setActionInput: setLaunchInput } = params;
    const { settings, session, accountBinding, machineId } = launcher;
    const [secretState, setSecretState] = React.useState<ExecutionRunSecretReferenceOverlayState>({ readiness: { ok: true } });
    const sharedSecrets = useFeatureEnabled('teams', { scopeKind: 'spawn', serverId: params.serverId });
    const profiles = useHomeAiLaunchProfiles(accountBinding?.scope ?? null);
    const profile = React.useMemo(() => resolveExecutionRunSessionLaunchProfile(session?.metadata, profiles), [session?.metadata, profiles]);
    const defaultSecretBindings = profile?.secretBindings ?? null;
    const chosenBackend = params.selectedBackendChoice;
    const teamCredential = useExecutionRunTeamCredentialModel({ sessionId: params.sessionId, serverId: params.serverId,
        machineId,
        selectedBackendChoice: chosenBackend, hasBackendChoices: params.backendChoices.length > 0, actionInput: launchInput,
        setActionInput: setLaunchInput, inheritedSelection: params.inheritedSelection, onSelectionChange: params.onSelectionChange });
    const selectedModel = React.useMemo(() => {
        const parsed = ProviderBoundModelRefSchema.safeParse(launchInput.modelSelection);
        return parsed.success ? parsed.data : null;
    }, [launchInput.modelSelection]);
    const inheritedModel = launcher.inheritedModelSelection;
    const displayedModel = selectedModel ?? (chosenBackend && inheritedModel
        && backendTargetKeysMatch(inheritedModel.agentTargetKey, chosenBackend.backendTarget) ? inheritedModel : null);
    const model = useExactModelChoice({
        agentTargetKey: chosenBackend?.targetKey ?? null, agentId: chosenBackend?.agentId ?? null,
        machineId, serverId: params.serverId, selected: displayedModel,
        title: t('agentInput.model.title'), fallbackLabel: t('settingsAgents.defaultModelTitle'),
        clearOptionLabel: t('settingsAgents.defaultModelTitle'),
        enabled: chosenBackend !== null && params.modelSelectionEnabled !== false && !params.credentialSelectionOnly,
        teamModelChoice: teamCredential.pickerProps,
    });
    const onSelectModel = React.useCallback((selection: ProviderBoundModelRef | null) => {
        params.onSelectionChange?.();
        setLaunchInput(previous => selection
            ? applyExecutionRunChildSelection(previous, selection) : clearExecutionRunChildSelection(previous));
    }, [params.onSelectionChange, setLaunchInput]);
    // Native, Provider and Team offers share the exact Agent's existing catalog owner.
    const modelChoice = params.credentialSelectionOnly ? teamCredential.picker
        : model.pickerProps ? <SessionModelPicker {...model.pickerProps} showTitle={false} onSelect={onSelectModel} /> : null;
    const controls = <>
        <ExecutionRunSecretReferenceOverlayField profile={profile} machineId={machineId} serverId={params.serverId}
            accountScope={accountBinding?.scope ?? null} defaultBindings={defaultSecretBindings}
            personalSecrets={settings.secrets} sharedEnabled={sharedSecrets} editable={!params.busy} onChange={setSecretState} />
    </>;
    // The chosen reviewer's row names its model; the picker opens under the list from its Change.
    const modelSubtitle = modelChoice && !params.credentialSelectionOnly
        ? [model.presentation.subtitle, model.presentation.detail].filter(Boolean).join(' · ') || null : null;
    return { controls, modelChoice, modelSubtitle, teamCredential, secretState };
}
