import * as React from 'react';

import { buildNewSessionAuthoringContext } from '@/components/sessions/authoring/context/buildNewSessionAuthoringContext';
import {
    buildLiveNewSessionAuthoringDraftFromResolvedInputs,
    buildPersistedNewSessionDraftFromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    flushSessionDraft,
    writeNewSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
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
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { buildNewSessionDraftPatch } from './newSessionDraftRepositoryAdapter';

import type { NewSessionPromptStore } from './newSessionPromptStore';

type PersistedDraft = ReturnType<typeof buildPersistedNewSessionDraftFromAuthoringDraft>;
type BuildResolvedInputs = Parameters<typeof buildLiveNewSessionAuthoringDraftFromResolvedInputs>[0];
type BuildPersistedInputs = Parameters<typeof buildPersistedNewSessionDraftFromAuthoringDraft>[0];

export function useNewSessionAuthoringState(params: Readonly<{
    automationDraft: NewSessionAutomationDraft;
    automationFeatureEnabled: boolean;
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    selectedMachineSpawnReadiness?: MachineSpawnReadiness | null;
    selectedPath: string;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    promptStore: NewSessionPromptStore;
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
    targetServerId: BuildPersistedInputs['targetServerId'];
    windowsRemoteSessionLaunchModeOverride: BuildPersistedInputs['windowsRemoteSessionLaunchModeOverride'];
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: BuildResolvedInputs['sessionConfigOptionOverrides'];
    automationEditId: string | null;
    automationRequestedByRoute: boolean;
    selectedSecretId: string | null;
    selectedSecretIdByProfileIdByEnvVarName: BuildPersistedInputs['selectedSecretIdByProfileIdByEnvVarName'];
    getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => BuildPersistedInputs['sessionOnlySecretValueEncByProfileIdByEnvVarName'];
    agentNewSessionOptionStateByAgentId: Record<string, Record<string, unknown>>;
    draftScope: ServerAccountScope | null;
    draftId: string;
    launchUserAttemptId?: string | null;
}>): Readonly<{
    authoringContext: ReturnType<typeof buildNewSessionAuthoringContext>;
    currentAuthoringDraft: SessionAuthoringDraft;
    effectiveAutomationDraft: NewSessionAutomationDraft;
    canCreate: boolean;
    buildCurrentPersistedDraft: () => PersistedDraft;
    stageDraftIfEnabled: (draft: PersistedDraft) => void;
    persistDraftIfEnabled: (draft: PersistedDraft) => void;
    disableDraftPersistence: () => void;
    draftPersistenceEnabled: boolean;
    draftPersistenceGenerationRef: React.MutableRefObject<number>;
}> {
    const [draftPersistenceEnabled, setDraftPersistenceEnabled] = React.useState(true);
    const draftPersistenceEnabledRef = React.useRef(true);
    const draftPersistenceGenerationRef = React.useRef(0);

    // The live composer text is read from its store at build time instead of being a render
    // dependency: typing must not rebuild the authoring draft, but every build (render-time
    // or imperative, e.g. persist/submit) must see the current text.
    const promptStore = params.promptStore;
    const buildCurrentAuthoringDraft = React.useCallback((effectiveAutomationDraft: NewSessionAutomationDraft) => {
        const sessionPrompt = promptStore.getPrompt();
        const shouldOmitLiveDisplayText = sessionPrompt.length > WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT;
        return buildLiveNewSessionAuthoringDraftFromResolvedInputs({
        directory: params.selectedPath,
        checkoutCreationDraft: params.checkoutCreationDraft,
        prompt: sessionPrompt,
        ...(shouldOmitLiveDisplayText ? {} : { displayText: sessionPrompt }),
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
        });
    }, [
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
        params.settings,
        promptStore,
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
        const draft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: buildCurrentAuthoringDraft(effectiveAutomationDraft),
            machineId: params.selectedMachineId,
            entryIntent: params.automationRequestedByRoute ? 'automation' : 'session',
            selectedSecretId: params.selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName: params.selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: params.getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
            agentNewSessionOptionStateByAgentId: params.agentNewSessionOptionStateByAgentId,
            targetServerId: params.targetServerId,
            windowsRemoteSessionLaunchModeOverride: params.windowsRemoteSessionLaunchModeOverride,
            updatedAt: Date.now(),
        });
        const launchUserAttemptId = typeof params.launchUserAttemptId === 'string'
            ? params.launchUserAttemptId.trim()
            : '';
        return launchUserAttemptId ? { ...draft, launchUserAttemptId } : draft;
    }, [
        buildCurrentAuthoringDraft,
        effectiveAutomationDraft,
        params.agentNewSessionOptionStateByAgentId,
        params.automationRequestedByRoute,
        params.getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        params.launchUserAttemptId,
        params.selectedMachineId,
        params.selectedSecretId,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.targetServerId,
        params.windowsRemoteSessionLaunchModeOverride,
    ]);

    const stageDraftIfEnabled = React.useCallback((_draft: PersistedDraft) => {
        if (!draftPersistenceEnabledRef.current) {
            return;
        }

        if (!params.draftScope) return;
        const address = { kind: 'newSession', draftId: params.draftId } as const;
        writeNewSessionDraft({
            scope: params.draftScope,
            draftId: params.draftId,
            patch: buildNewSessionDraftPatch({
                authoringDraft: buildCurrentAuthoringDraft(effectiveAutomationDraft),
                machineId: params.selectedMachineId,
                serverId: params.targetServerId ?? null,
                text: promptStore.getPrompt(),
            }),
            materializationIntent: 'userEdit',
        });
    }, [
        buildCurrentAuthoringDraft,
        effectiveAutomationDraft,
        params.draftId,
        params.draftScope,
        params.selectedMachineId,
        params.targetServerId,
        promptStore,
    ]);

    const persistDraftIfEnabled = React.useCallback((draft: PersistedDraft) => {
        stageDraftIfEnabled(draft);
        if (!draftPersistenceEnabledRef.current || !params.draftScope) return;
        const address = { kind: 'newSession', draftId: params.draftId } as const;
        fireAndForget(flushSessionDraft({ scope: params.draftScope, address }), {
            tag: 'NewSessionAuthoringState.flushSessionDraft',
        });
    }, [
        params.draftId,
        params.draftScope,
        stageDraftIfEnabled,
    ]);

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
        stageDraftIfEnabled,
        persistDraftIfEnabled,
        disableDraftPersistence,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
    };
}
