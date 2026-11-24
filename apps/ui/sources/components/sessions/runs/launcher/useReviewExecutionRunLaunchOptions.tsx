import * as React from 'react';
import { PersonalSessionModelRefSchema } from '@happier-dev/protocol/providers/selection/v2';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import type { PluginUiSelectActionInputHostActionV1, PluginUiSelectActionInputResultV1 } from '@happier-dev/protocol/plugins/ui';

import { SessionModelPicker, type SessionModelPickerProps } from '@/components/sessions/modelPicker/SessionModelPicker';
import { useExactModelChoice } from '@/components/sessions/modelPicker/useExactModelChoice';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHomeAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';

import { ExecutionRunSecretReferenceOverlayField, resolveExecutionRunSessionLaunchProfile, type ExecutionRunSecretReferenceOverlayState } from './ExecutionRunSecretReferenceOverlayField';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import type { useExecutionRunLaunchContext } from './useExecutionRunLaunchContext';
import { useExecutionRunTeamCredentialModel } from './useExecutionRunTeamCredentialModel';
import { applyExecutionRunChildSelection, clearExecutionRunChildSelection } from './executionRunChildChoice';
import { useReviewLauncherEngineConfiguration } from './reviewLauncherSelection';
import { t } from '@/text';

export type ReviewInputSelectionProjection = Extract<PluginUiSelectActionInputHostActionV1, { action: 'review.start' }>['projection'];
export type ReviewInputSelection = Extract<PluginUiSelectActionInputResultV1, { kind: 'executionRunLaunch' | 'reviewComposition' }>;

/** Complete authoring settles before execution admission; the credential chooser retains its admission. */
export async function settleReviewInputSelection(params: Readonly<{
    launcher: ReturnType<typeof useExecutionRunLaunchContext>;
    draft: Record<string, unknown>;
    operationId: string;
    isCurrent: () => boolean;
    projection: ReviewInputSelectionProjection;
}>): Promise<ReviewInputSelection | null> {
    if (!params.isCurrent()) return null;
    const admitted = ReviewStartInputSchema.parse(params.launcher.prepareStartInput('review.start', params.draft));
    if (params.projection === 'composition') {
        return params.launcher.accountLifetime?.isCurrent() ? { kind: 'reviewComposition', input: admitted } : null;
    }
    const engines = admitted.reviewers.filter(reviewer => reviewer.kind === 'engine');
    const selected = engines.length === 1 ? { ...admitted, ...engines[0] } : admitted;
    await params.launcher.admitExactTarget({
        secretReferenceOverlay: selected.secretReferenceOverlay !== undefined,
        teamCredentialModel: selected.teamCredentialModel !== undefined,
    }, params.operationId);
    if (!params.isCurrent() || !params.launcher.accountLifetime?.isCurrent()) return null;
    return { kind: 'executionRunLaunch', input: {
        ...(selected.secretReferenceOverlay ? { secretReferenceOverlay: selected.secretReferenceOverlay } : {}),
        ...(selected.teamCredentialModel ? { teamCredentialModel: selected.teamCredentialModel } : {}),
        ...(selected.teamCredentialSessionBindingConsent ? { teamCredentialSessionBindingConsent: selected.teamCredentialSessionBindingConsent } : {}),
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
    const { launcher } = params;
    const { actionInput: launchInput, setActionInput: setLaunchInput } = useReviewLauncherEngineConfiguration(params.actionInput, params.setActionInput, Array.isArray(params.actionInput.reviewers));
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
        const parsed = PersonalSessionModelRefSchema.safeParse(launchInput.modelSelection);
        return parsed.success ? parsed.data : null;
    }, [launchInput.modelSelection]);
    const inheritedModel = launcher.inheritedModelSelection;
    const connectedServices = React.useMemo(() => {
        if (launchInput.connectedServices == null) return launchInput.connectedServices;
        const parsed = ConnectedServiceBindingsV2Schema.safeParse(launchInput.connectedServices);
        return parsed.success ? parsed.data : undefined;
    }, [launchInput.connectedServices]);
    const displayedModel = selectedModel ?? (chosenBackend && inheritedModel
        && backendTargetKeysMatch(inheritedModel.agentTargetKey, chosenBackend.backendTarget) ? inheritedModel : null);
    const model = useExactModelChoice({
        agentTargetKey: chosenBackend?.targetKey ?? null, agentId: chosenBackend?.agentId ?? null,
        machineId, serverId: params.serverId, selected: displayedModel,
        includeProviderConnectedAccounts: true,
        connectedServices,
        title: t('agentInput.model.title'), fallbackLabel: t('settingsAgents.defaultModelTitle'),
        clearOptionLabel: t('settingsAgents.defaultModelTitle'),
        enabled: chosenBackend !== null && params.modelSelectionEnabled !== false && !params.credentialSelectionOnly,
        teamModelChoice: teamCredential.pickerProps,
    });
    const onSelectModel = React.useCallback<SessionModelPickerProps['onSelect']>((selection, binding) => {
        params.onSelectionChange?.();
        params.setActionInput(previous => selection
            ? applyExecutionRunChildSelection(previous, selection, binding) : clearExecutionRunChildSelection(previous));
    }, [params.onSelectionChange, params.setActionInput]);
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
