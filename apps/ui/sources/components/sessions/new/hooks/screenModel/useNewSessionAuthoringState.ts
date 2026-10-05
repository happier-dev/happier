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
import type { AgentExecutionTargetV1, BackendTargetRefV2, SessionModelSelectionV1, SessionOrganizationPlacementV1 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionPromptStore } from './newSessionPromptStore';
import type { BackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    createNewSessionDraftPersistenceBinding,
    persistNewSessionDraftAndPause,
} from './newSessionDraftPersistenceBinding';
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';

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
    hostBoundMachineId?: string | null;
    selectedMachineSpawnReadiness?: MachineSpawnReadiness | null;
    /** The authored folder; kept while there is no folder, so choosing it again restores it. */
    selectedPath: string;
    /** `managed`: no folder (the machine keeps a private one). */
    directoryKind: 'path' | 'managed';
    executionTarget: SessionAuthoringDraft['executionTarget'];
    temporaryComputerActivationRef?: SessionAuthoringDraft['temporaryComputerActivationRef'];
    organizationPlacement: SessionOrganizationPlacementV1;
    access?: SessionAuthoringDraft['access'];
    primaryTeamId?: SessionAuthoringDraft['primaryTeamId'];
    teamCredentialBindings?: SessionAuthoringDraft['teamCredentialBindings'];
    initialTriggers?: SessionAuthoringDraft['initialTriggers'];
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    promptStore: NewSessionPromptStore;
    /** Compatibility-only bundled identity for persisted legacy draft fields. */
    staticAgentId: AgentId | null;
    backendTarget: BackendTargetRefV2 | null;
    agentTarget: AgentExecutionTargetV1 | null;
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
    automationRequestedByRoute: boolean;
    selectedSecretId: string | null;
    selectedSecretIdByProfileIdByEnvVarName: BuildPersistedInputs['selectedSecretIdByProfileIdByEnvVarName'];
    getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => BuildPersistedInputs['sessionOnlySecretValueEncByProfileIdByEnvVarName'];
    backendNewSessionOptionStateByTargetKey: BackendNewSessionOptionStateByTargetKey;
    composerAttachments?: BuildPersistedInputs['composerAttachments'];
    draftScope?: ServerAccountScope | null;
    draftId?: string;
    launchUserAttemptId?: string | null;
    placementCandidates?: readonly PluginUiSessionPlacementCandidateV1[];
    zenTaskSource?: NewSessionDraft['zenTaskSource'];
}>): Readonly<{
    authoringContext: ReturnType<typeof buildNewSessionAuthoringContext>;
    currentAuthoringDraft: SessionAuthoringDraft;
    /**
     * Rebuilds the authoring draft from live input at the moment it is called.
     *
     * `currentAuthoringDraft` is a render projection and can lag the composer,
     * so an action that hands the draft somewhere else — persisting, submitting
     * or the Automation chip — must build from here instead.
     */
    buildCurrentAuthoringDraft: (effectiveAutomationDraft: NewSessionAutomationDraft) => SessionAuthoringDraft;
    effectiveAutomationDraft: NewSessionAutomationDraft;
    canCreate: boolean;
    buildCurrentPersistedDraft: () => PersistedDraft;
    persistDraftIfEnabled: (draft: PersistedDraft) => void;
    persistCurrentDraftAndPause: (scope: ServerAccountScope) => void;
    pauseDraftPersistence: (scope: ServerAccountScope) => void;
    resumeDraftPersistence: (scope: ServerAccountScope) => void;
    disableDraftPersistence: () => void;
    draftPersistenceEnabled: boolean;
    draftPersistenceGenerationRef: React.MutableRefObject<number>;
}> {
    const initiallyFrozenByActivation = params.draftScope !== null
        && params.draftScope !== undefined
        && params.temporaryComputerActivationRef != null;
    const [draftPersistenceEnabled, setDraftPersistenceEnabled] = React.useState(!initiallyFrozenByActivation);
    const draftPersistenceBindingRef = React.useRef(createNewSessionDraftPersistenceBinding(params.draftScope ?? null));
    draftPersistenceBindingRef.current.follow(params.draftScope ?? null);
    // Reopening a waiting draft must be frozen before the first autosave effect,
    // including while an explicitly routed Home binding resolves after mount.
    if (params.draftScope && params.temporaryComputerActivationRef != null) {
        draftPersistenceBindingRef.current.pause(params.draftScope);
    }
    const draftPersistenceGenerationRef = React.useRef(0);
    React.useEffect(() => {
        if (params.draftScope && params.temporaryComputerActivationRef != null) {
            setDraftPersistenceEnabled(false);
        }
    }, [params.draftScope, params.temporaryComputerActivationRef]);
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
        executionTarget: params.executionTarget,
        temporaryComputerActivationRef: params.temporaryComputerActivationRef,
        directory: params.selectedPath,
        directoryKind: params.directoryKind,
        checkoutCreationDraft: params.checkoutCreationDraft,
        organizationPlacement: params.organizationPlacement,
        access: params.access,
        primaryTeamId: params.primaryTeamId,
        teamCredentialBindings: params.teamCredentialBindings,
        initialTriggers: params.initialTriggers,
        prompt: sessionPrompt,
        displayText: sessionPrompt,
        agentTarget: params.agentTarget,
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
        runtimeDescriptorV1: null,
        acpSessionModeId: params.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: params.sessionConfigOptionOverrides,
        // Only a genuinely hydrated, enabled Automation draft reaches the
        // retained one-shot writer. A route flag is not authored work, and
        // treating it as one kept a second create-an-Automation surface alive
        // inside New Session after every first-party entry had migrated to the
        // shared wrapper.
        automation: effectiveAutomationDraft.enabled ? effectiveAutomationDraft : null,
        });
    }, [
        params.acpSessionModeId,
        params.temporaryComputerActivationRef,
        params.staticAgentId,
        params.agentNewSessionOptions,
        params.backendTarget,
        params.agentTarget,
        params.checkoutCreationDraft,
        draftAgentId,
        params.effectiveWindowsRemoteSessionLaunchMode,
        params.mcpSelection,
        params.modelSelection,
        params.permissionMode,
        params.resumeSessionId,
        params.selectedMachineId,
        params.selectedPath,
        params.directoryKind,
        params.executionTarget,
        params.organizationPlacement,
        params.access,
        params.primaryTeamId,
        params.initialTriggers,
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
        hostBoundMachineId: params.hostBoundMachineId,
        selectedMachineSpawnReadiness: params.selectedMachineSpawnReadiness ?? null,
        selectedPath: params.selectedPath,
        directoryKind: params.directoryKind,
        buildDraft: buildCurrentAuthoringDraft,
    }), [
        params.directoryKind,
        buildCurrentAuthoringDraft,
        params.automationDraft,
        params.automationFeatureEnabled,
        params.selectedMachine,
        params.hostBoundMachineId,
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
            placementCandidates: params.placementCandidates,
            preferredPersistedAgentId: draftAgentId,
            updatedAt: Date.now(),
        });

        const launchUserAttemptId = typeof params.launchUserAttemptId === 'string'
            ? params.launchUserAttemptId.trim()
            : '';
        return {
            ...persistedDraft,
            ...(params.zenTaskSource === undefined ? {} : { zenTaskSource: params.zenTaskSource }),
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
        params.placementCandidates,
        params.automationRequestedByRoute,
        draftAgentId,
        params.getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        params.launchUserAttemptId,
        params.zenTaskSource,
        params.selectedMachineId,
        params.selectedSecretId,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.targetServerId,
        params.windowsRemoteSessionLaunchModeOverride,
    ]);

    const persistDraftIfEnabled = React.useCallback((draft: PersistedDraft) => {
        const scope = draftPersistenceBindingRef.current.readScopeForWrite();
        if (!scope || !params.draftId) return;
        writeNewSessionAuthoringDraftToRepository({
            scope,
            draftId: params.draftId,
            draft,
        });
    }, [params.draftId]);

    const pauseDraftPersistence = React.useCallback((scope: ServerAccountScope) => {
        draftPersistenceBindingRef.current.pause(scope);
        draftPersistenceGenerationRef.current += 1;
        setDraftPersistenceEnabled(false);
    }, []);

    const persistCurrentDraftAndPause = React.useCallback((scope: ServerAccountScope) => {
        const draftId = params.draftId;
        if (!draftId) {
            throw new Error('runner_creator_draft_unavailable');
        }
        persistNewSessionDraftAndPause({
            binding: draftPersistenceBindingRef.current,
            scope,
            persist: (exactScope) => {
                writeNewSessionAuthoringDraftToRepository({
                    scope: exactScope,
                    draftId,
                    draft: buildCurrentPersistedDraft(),
                });
            },
        });
        draftPersistenceGenerationRef.current += 1;
        setDraftPersistenceEnabled(false);
    }, [buildCurrentPersistedDraft, params.draftId]);

    const resumeDraftPersistence = React.useCallback((scope: ServerAccountScope) => {
        if (!draftPersistenceBindingRef.current.resume(scope)) return;
        draftPersistenceGenerationRef.current += 1;
        setDraftPersistenceEnabled(true);
    }, []);

    const disableDraftPersistence = React.useCallback(() => {
        draftPersistenceBindingRef.current.disable();
        draftPersistenceGenerationRef.current += 1;
        setDraftPersistenceEnabled(false);
    }, []);

    return {
        authoringContext,
        currentAuthoringDraft,
        buildCurrentAuthoringDraft,
        effectiveAutomationDraft,
        canCreate,
        buildCurrentPersistedDraft,
        persistDraftIfEnabled,
        persistCurrentDraftAndPause,
        pauseDraftPersistence,
        resumeDraftPersistence,
        disableDraftPersistence,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
    };
}
