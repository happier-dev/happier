import * as React from 'react';

import { buildNewSessionAuthoringContext } from '@/components/sessions/authoring/context/buildNewSessionAuthoringContext';
import {
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildPersistedNewSessionDraftFromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { resolveNewSessionCompatAgentType } from '@/components/sessions/new/modules/resolveNewSessionCompatAgentType';
import { writeNewSessionAuthoringDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { BackendTargetRefV2, SessionModelSelectionV1 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionPromptStore } from './newSessionPromptStore';
import type { BackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';

type PersistedDraft = ReturnType<typeof buildPersistedNewSessionDraftFromAuthoringDraft>;
type BuildResolvedInputs = Parameters<typeof buildNewSessionAuthoringDraftFromResolvedInputs>[0];
type BuildPersistedInputs = Parameters<typeof buildPersistedNewSessionDraftFromAuthoringDraft>[0];

export function useNewSessionAuthoringState(params: Readonly<{
    automationDraft: NewSessionAutomationDraft;
    automationFeatureEnabled: boolean;
    selectedMachineId: string | null;
    targetServerId: string | null;
    windowsRemoteSessionLaunchModeOverride: BuildPersistedInputs['windowsRemoteSessionLaunchModeOverride'];
    selectedMachine: Machine | null;
    selectedMachineSpawnReadiness?: MachineSpawnReadiness | null;
    selectedPath: string;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    promptStore: NewSessionPromptStore;
    /** Compatibility-only bundled identity for persisted legacy draft fields. */
    staticAgentId: AgentId | null;
    backendTarget: BackendTargetRefV2 | null;
    transcriptStorage: BuildResolvedInputs['transcriptStorage'];
    useProfiles: boolean;
    selectedProfileId: string | null;
    resumeSessionId: string;
    permissionMode: PermissionMode;
    modelSelection: SessionModelSelectionV1 | null;
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
    backendNewSessionOptionStateByTargetKey: BackendNewSessionOptionStateByTargetKey;
    composerAttachments?: BuildPersistedInputs['composerAttachments'];
    draftScope?: ServerAccountScope | null;
    draftId?: string;
    launchUserAttemptId?: string | null;
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
    const draftAgentId = React.useMemo(() => resolveNewSessionCompatAgentType({
        backendTarget: params.backendTarget,
        persistedAgentId: params.settings.lastUsedAgent,
        selectedBuiltInAgentId: params.staticAgentId,
    }), [params.backendTarget, params.settings.lastUsedAgent, params.staticAgentId]);

    // The live composer text is read from its store at build time instead of being a render
    // dependency: typing must not rebuild the authoring draft, but every build (render-time
    // or imperative, e.g. persist/submit) must see the current text.
    const promptStore = params.promptStore;
    const buildCurrentAuthoringDraft = React.useCallback((effectiveAutomationDraft: NewSessionAutomationDraft) => {
        const sessionPrompt = promptStore.getPrompt();
        return buildNewSessionAuthoringDraftFromResolvedInputs({
        directory: params.selectedPath,
        checkoutCreationDraft: params.checkoutCreationDraft,
        prompt: sessionPrompt,
        displayText: sessionPrompt,
        agentId: draftAgentId,
        backendTarget: params.backendTarget,
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: params.useProfiles ? (params.selectedProfileId ?? null) : null,
        environmentVariables: null,
        resumeSessionId: params.resumeSessionId,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: null,
        modelSelection: params.modelSelection,
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(params.agentNewSessionOptions?.connectedServices ?? null),
        terminal: resolveTerminalSpawnOptions({
            settings: params.settings,
            machineId: params.selectedMachineId,
        }) ?? null,
        windowsRemoteSessionLaunchMode: params.effectiveWindowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: typeof params.settings.sessionWindowsTerminalWindowName === 'string'
            ? params.settings.sessionWindowsTerminalWindowName.trim() || null
            : null,
        experimentalCodexAcp: null,
        codexBackendMode: null,
        acpSessionModeId: params.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: params.sessionConfigOptionOverrides,
        automation: effectiveAutomationDraft.enabled ? effectiveAutomationDraft : null,
        });
    }, [
        params.acpSessionModeId,
        params.staticAgentId,
        params.agentNewSessionOptions,
        params.backendTarget,
        params.checkoutCreationDraft,
        draftAgentId,
        params.effectiveWindowsRemoteSessionLaunchMode,
        params.mcpSelection,
        params.modelSelection,
        params.permissionMode,
        params.resumeSessionId,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedProfileId,
        params.sessionConfigOptionOverrides,
        promptStore,
        params.settings,
        params.transcriptStorage,
        params.useProfiles,
    ]);

    const authoringContext = React.useMemo(() => buildNewSessionAuthoringContext({
        automationDraft: params.automationDraft,
        automationFeatureEnabled: params.automationFeatureEnabled,
        selectedMachineId: params.selectedMachineId,
        selectedMachine: params.selectedMachine,
        selectedMachineSpawnReadiness: params.selectedMachineSpawnReadiness ?? null,
        selectedPath: params.selectedPath,
        automationEditId: params.automationEditId,
        buildDraft: buildCurrentAuthoringDraft,
    }), [
        buildCurrentAuthoringDraft,
        params.automationDraft,
        params.automationEditId,
        params.automationFeatureEnabled,
        params.selectedMachine,
        params.selectedMachineSpawnReadiness,
        params.selectedMachineId,
        params.selectedPath,
    ]);

    const currentAuthoringDraft = authoringContext.draft;
    const effectiveAutomationDraft = authoringContext.effectiveAutomationDraft;
    const canCreate = authoringContext.canSubmit;

    const buildCurrentPersistedDraft = React.useCallback(() => {
        // Rebuild from the live composer text rather than the last-rendered draft: the model
        // no longer re-renders per keystroke, so `currentAuthoringDraft` can lag the input.
        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: buildCurrentAuthoringDraft(effectiveAutomationDraft),
            machineId: params.selectedMachineId,
            targetServerId: params.targetServerId,
            windowsRemoteSessionLaunchModeOverride: params.windowsRemoteSessionLaunchModeOverride,
            entryIntent: params.automationRequestedByRoute ? 'automation' : 'session',
            selectedSecretId: params.selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName: params.selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: params.getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
            backendNewSessionOptionStateByTargetKey: params.backendNewSessionOptionStateByTargetKey,
            composerAttachments: params.composerAttachments,
            preferredPersistedAgentId: draftAgentId,
            updatedAt: Date.now(),
        });

        const launchUserAttemptId = typeof params.launchUserAttemptId === 'string'
            ? params.launchUserAttemptId.trim()
            : '';
        return {
            ...persistedDraft,
            ...(launchUserAttemptId ? { launchUserAttemptId } : {}),
            agentType: resolveNewSessionCompatAgentType({
                backendTarget: persistedDraft.backendTarget ?? null,
                persistedAgentId: draftAgentId,
                selectedBuiltInAgentId: params.staticAgentId ?? draftAgentId,
            }),
        };
    }, [
        buildCurrentAuthoringDraft,
        effectiveAutomationDraft,
        params.staticAgentId,
        params.backendNewSessionOptionStateByTargetKey,
        params.composerAttachments,
        params.automationRequestedByRoute,
        draftAgentId,
        params.getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        params.launchUserAttemptId,
        params.selectedMachineId,
        params.selectedSecretId,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.targetServerId,
        params.windowsRemoteSessionLaunchModeOverride,
    ]);

    const persistDraftIfEnabled = React.useCallback((draft: PersistedDraft) => {
        if (!draftPersistenceEnabledRef.current) {
            return;
        }

        if (!params.draftScope || !params.draftId) return;
        writeNewSessionAuthoringDraftToRepository({
            scope: params.draftScope,
            draftId: params.draftId,
            draft,
        });
    }, [params.draftId, params.draftScope]);

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
