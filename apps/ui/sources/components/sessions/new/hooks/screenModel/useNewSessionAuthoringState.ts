import * as React from 'react';

import { buildNewSessionAuthoringContext } from '@/components/sessions/authoring/context/buildNewSessionAuthoringContext';
import {
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildPersistedNewSessionDraftFromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { clearNewSessionDraft, saveNewSessionDraft } from '@/sync/domains/state/persistence';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type PersistedDraft = ReturnType<typeof buildPersistedNewSessionDraftFromAuthoringDraft>;
type BuildResolvedInputs = Parameters<typeof buildNewSessionAuthoringDraftFromResolvedInputs>[0];
type BuildPersistedInputs = Parameters<typeof buildPersistedNewSessionDraftFromAuthoringDraft>[0];

export function useNewSessionAuthoringState(params: Readonly<{
    automationDraft: NewSessionAutomationDraft;
    automationFeatureEnabled: boolean;
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    selectedPath: string;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    sessionPrompt: string;
    agentType: AgentId;
    backendTarget: BackendTargetRefV1 | null;
    transcriptStorage: BuildResolvedInputs['transcriptStorage'];
    useProfiles: boolean;
    selectedProfileId: string | null;
    resumeSessionId: string;
    permissionMode: PermissionMode;
    modelMode: ModelMode;
    mcpSelection: BuildResolvedInputs['mcpSelection'];
    agentNewSessionOptions: Record<string, unknown> | null;
    settings: Settings;
    effectiveWindowsRemoteSessionLaunchMode: BuildResolvedInputs['windowsRemoteSessionLaunchMode'];
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: BuildResolvedInputs['sessionConfigOptionOverrides'];
    automationEditId: string | null;
    automationRequestedByRoute: boolean;
    selectedSecretId: string | null;
    selectedSecretIdByProfileIdByEnvVarName: BuildPersistedInputs['selectedSecretIdByProfileIdByEnvVarName'];
    getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => BuildPersistedInputs['sessionOnlySecretValueEncByProfileIdByEnvVarName'];
    agentNewSessionOptionStateByAgentId: Record<string, Record<string, unknown>>;
    draftScope: ServerAccountScope | null;
}>): Readonly<{
    authoringContext: ReturnType<typeof buildNewSessionAuthoringContext>;
    currentAuthoringDraft: SessionAuthoringDraft;
    effectiveAutomationDraft: NewSessionAutomationDraft;
    canCreate: boolean;
    buildCurrentPersistedDraft: () => PersistedDraft;
    persistDraftIfEnabled: (draft: PersistedDraft) => void;
    disableDraftPersistence: () => void;
    draftPersistenceEnabled: boolean;
    draftPersistenceGenerationRef: React.MutableRefObject<number>;
}> {
    const [draftPersistenceEnabled, setDraftPersistenceEnabled] = React.useState(true);
    const draftPersistenceEnabledRef = React.useRef(true);
    const draftPersistenceGenerationRef = React.useRef(0);

    const buildCurrentAuthoringDraft = React.useCallback((effectiveAutomationDraft: NewSessionAutomationDraft) => buildNewSessionAuthoringDraftFromResolvedInputs({
        directory: params.selectedPath,
        checkoutCreationDraft: params.checkoutCreationDraft,
        prompt: params.sessionPrompt,
        displayText: params.sessionPrompt,
        agentId: params.agentType,
        backendTarget: params.backendTarget,
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: params.useProfiles ? (params.selectedProfileId ?? null) : null,
        environmentVariables: null,
        resumeSessionId: params.resumeSessionId,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: null,
        modelId: params.modelMode === 'default' ? null : params.modelMode,
        modelUpdatedAt: null,
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(params.agentNewSessionOptions?.connectedServices ?? null),
        terminal: resolveTerminalSpawnOptions({
            settings: params.settings,
            machineId: params.selectedMachineId,
        }) ?? null,
        windowsRemoteSessionLaunchMode: params.effectiveWindowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: null,
        experimentalCodexAcp: null,
        codexBackendMode: null,
        acpSessionModeId: params.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: params.sessionConfigOptionOverrides,
        automation: effectiveAutomationDraft.enabled ? effectiveAutomationDraft : null,
    }), [
        params.acpSessionModeId,
        params.agentNewSessionOptions,
        params.agentType,
        params.backendTarget,
        params.checkoutCreationDraft,
        params.effectiveWindowsRemoteSessionLaunchMode,
        params.mcpSelection,
        params.modelMode,
        params.permissionMode,
        params.resumeSessionId,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedProfileId,
        params.sessionConfigOptionOverrides,
        params.sessionPrompt,
        params.settings,
        params.transcriptStorage,
        params.useProfiles,
    ]);

    const authoringContext = React.useMemo(() => buildNewSessionAuthoringContext({
        automationDraft: params.automationDraft,
        automationFeatureEnabled: params.automationFeatureEnabled,
        selectedMachineId: params.selectedMachineId,
        selectedMachine: params.selectedMachine,
        selectedPath: params.selectedPath,
        automationEditId: params.automationEditId,
        buildDraft: buildCurrentAuthoringDraft,
    }), [
        buildCurrentAuthoringDraft,
        params.automationDraft,
        params.automationEditId,
        params.automationFeatureEnabled,
        params.selectedMachine,
        params.selectedMachineId,
        params.selectedPath,
    ]);

    const currentAuthoringDraft = authoringContext.draft;
    const effectiveAutomationDraft = authoringContext.effectiveAutomationDraft;
    const canCreate = authoringContext.canSubmit;

    const buildCurrentPersistedDraft = React.useCallback(() => buildPersistedNewSessionDraftFromAuthoringDraft({
        draft: currentAuthoringDraft,
        machineId: params.selectedMachineId,
        entryIntent: params.automationRequestedByRoute ? 'automation' : 'session',
        selectedSecretId: params.selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName: params.selectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueEncByProfileIdByEnvVarName: params.getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
        agentNewSessionOptionStateByAgentId: params.agentNewSessionOptionStateByAgentId,
        updatedAt: Date.now(),
    }), [
        currentAuthoringDraft,
        params.agentNewSessionOptionStateByAgentId,
        params.automationRequestedByRoute,
        params.getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        params.selectedMachineId,
        params.selectedSecretId,
        params.selectedSecretIdByProfileIdByEnvVarName,
    ]);

    const persistDraftIfEnabled = React.useCallback((draft: PersistedDraft) => {
        if (!draftPersistenceEnabledRef.current) {
            return;
        }

        if (params.draftScope) {
            saveNewSessionDraft(draft, params.draftScope);
            return;
        }
        saveNewSessionDraft(draft);
    }, [params.draftScope]);

    const disableDraftPersistence = React.useCallback(() => {
        draftPersistenceEnabledRef.current = false;
        draftPersistenceGenerationRef.current += 1;
        setDraftPersistenceEnabled(false);
    }, []);

    return {
        authoringContext,
        currentAuthoringDraft,
        effectiveAutomationDraft,
        canCreate,
        buildCurrentPersistedDraft,
        persistDraftIfEnabled,
        disableDraftPersistence,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
    };
}
