import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { createPreflightComposerSuggestionCatalogSource, type ComposerSuggestionCatalogs } from '@/components/autocomplete/composerSuggestionCatalogs';
import { buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState } from '@/agents/catalog/catalog';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';
import { resolveStrictV2ProfileSecretReadiness } from '@/components/sessions/new/modules/resolveStrictV2ProfileSecretReadiness';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import { useAiLaunchProfiles, useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { canCreateSessionWithInitialAccess, useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { Machine } from '@/sync/domains/state/storageTypes';
import React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import {
    storage,
    useCurrentFavoriteModelSelectionsV1Mutable,
    useCurrentRememberedEngineSelectionsByScopeV1Mutable,
    useCurrentSecretBindingsByProfileIdMutable,
    useLaunchSelectionMachines,
    useMachineListByServerId,
    useSetting,
    useSettingMutable,
    useSettings,
} from '@/sync/domains/state/storage';
import { useAccountSettingsScope, useActiveServerAccountScope } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { projectCurrentSecretBindingsByProfileId } from '@/sync/domains/settings/secretBindings';
import { usePathname } from 'expo-router';
import { useNewSessionPlacementSessions } from '@/components/sessions/new/hooks/screenModel/useNewSessionPlacementSessions';
import {
    useNewSessionHostDemanded,
    useNewSessionHostCreationProfile,
    useNewSessionHostSpawnExecutor,
    useNewSessionHostNavigation,
    useNewSessionHostParams,
} from '@/components/sessions/new/navigation/newSessionHost';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { sync } from '@/sync/sync';
import { getTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import {
    buildNewSessionAutomationHandoffSeed,
    storeNewSessionAutomationHandoffSeed,
} from '@/sync/domains/workflows/newSessionAutomationHandoffSeed';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { Modal } from '@/modal';
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import {
    findAssignedProviderModelCredentialBinding,
    resourceHasAvailableTeamCredentialProviderModel,
} from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { readExactActiveParentTurn, type ExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { type PermissionMode, type ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    getProfileEnvironmentVariables,
    isProfileCompatibleWithBackendTarget,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile, getProfilePrimaryCli, isProfileEnabled } from '@/sync/domains/profiles/profileUtils';
import { getAgentCore, isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { createTemporaryComputerCreatorDependencies } from './creator/temporaryComputerCreatorDependencies';
import { createRunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { normalizeOptionalParam } from '@/profileRouteParams';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { resolveNewSessionShouldBottomAnchor } from '@/components/sessions/new/navigation/newSessionPresentation';
import { assertLaunchProfileReviewCurrent, LaunchProfileEnvironmentUnavailableError, materializeLaunchProfileEnvironment, useProfileMap } from '@/components/sessions/new/modules/profileHelpers';
import { newSessionScreenStyles } from '@/components/sessions/new/newSessionScreenStyles';
import { resolveNewSessionCapabilityServerId } from '@/components/sessions/new/modules/resolveNewSessionCapabilityServerId';
import { composeConnectedServiceTeamCredentialBindingIntents } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    buildNewSessionAuthoringDraftFromPersistedDraft,
    buildNewSessionAuthoringDraftFromTempData,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { useNewSessionActiveServerSource } from '@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource';
import { useNewSessionBackendTargetState } from '@/components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState';
import { useNewSessionMachinePathState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState';
import { useMachinePoolGroups } from '@/components/sessions/new/hooks/machines/useMachinePoolGroups';
import { invalidateMachinePoolProjection } from '@/sync/engine/machines/machinePoolProjection';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useNewSessionRepoScmSnapshot } from '@/components/sessions/new/hooks/screenModel/useNewSessionRepoScmSnapshot';
import { buildAcpConfigOptionOverridesV1, type AcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { MachinePoolSelectionOriginV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionAuthoringValueV1Schema } from '@happier-dev/protocol/sessions/authoring/index';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import type { WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol/sessions/metadata/windowsRemoteSessionLaunchMode';
import type {
    SessionTeamCredentialBindingIntentListV1,
    TeamCredentialProviderModelSelectionV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { useNewSessionAvailabilityState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAvailabilityState';
import { useNewSessionMachineRefreshState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachineRefreshState';
import { useNewSessionCheckoutSelectionState } from '@/components/sessions/new/hooks/screenModel/useNewSessionCheckoutSelectionState';
import { useNewSessionProfileEditPersistence } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileEditPersistence';
import { buildNewSessionScreenVariantModel } from '@/components/sessions/new/hooks/screenModel/buildNewSessionScreenVariantModel';
import { useNewSessionTranscriptStorageState } from '@/components/sessions/new/hooks/screenModel/useNewSessionTranscriptStorageState';
import { useNewSessionAgentAuthoringOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentAuthoringOptionsState';
import { useNewSessionPermissionModeState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPermissionModeState';
import { useNewSessionPromptAutomationState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPromptAutomationState';
import { useNewSessionSecretSelectionState } from '@/components/sessions/new/hooks/screenModel/useNewSessionSecretSelectionState';
import { buildSecretRequirementRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { useNewSessionHappyRouteFlag } from '@/components/sessions/new/hooks/screenModel/useNewSessionHappyRouteFlag';
import { useRouteBackendTargetSelectionSync } from '@/components/sessions/new/hooks/screenModel/useRouteBackendTargetSelectionSync';
import { useNewSessionInputPopovers } from '@/components/sessions/new/hooks/screenModel/useNewSessionInputPopovers';
import { useNewSessionAgentSelectionModelModeReconciliation } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentSelectionModelModeReconciliation';
import { useNewSessionProfileBackendReconciliation } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileBackendReconciliation';
import { useNewSessionProfileSelectionPresentation } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileSelectionPresentation';
import { useNewSessionProfileActions } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfileActions';
import {
    resolveNewSessionTargetMachines,
    resolveNewSessionTargetRecentMachinePaths,
    resolveNewSessionTargetSessions,
} from '@/components/sessions/new/modules/newSessionPlacementSources';
import { useNewSessionProfilePopover } from '@/components/sessions/new/hooks/screenModel/useNewSessionProfilePopover';
import { useNewSessionCreateSessionAction } from '@/components/sessions/new/hooks/screenModel/useNewSessionCreateSessionAction';
import { useNewSessionScreenAgentInputPresentation } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenAgentInputPresentation';
import { useNewSessionScreenAuthoringState } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenAuthoringState';
import { useNewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import { useNewSessionSourceContext } from '@/components/sessions/new/sourceContext/useNewSessionSourceContext';
import { useNewSessionScreenSimplePanelProps } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenSimplePanelProps';
import { useNewSessionScreenWizardProps } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenWizardProps';
import { useNewSessionConnectedServicesAgentOptions } from '@/components/sessions/new/hooks/screenModel/useNewSessionConnectedServicesAgentOptions';
import { useNewSessionScreenPreflightState } from '@/components/sessions/new/hooks/screenModel/useNewSessionScreenPreflightState';
import type {
    AgentPluginSettingsReadiness,
    AgentPluginSettingsSnapshot,
} from '@/agents/registry/registryUiBehavior';
import {
    readScopedPluginSettingsDeclaredFieldValue,
    projectScopedPluginSettingsFields,
    useScopedPluginSettingsProjection,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';
import { scopedPluginSettingsAdapter } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import {
    resolveScopedPluginSettingsServerIdentity,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { resolveScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    resolveAgentScopedPluginSettingsDeclarations,
    type AgentScopedPluginSettingsDeclarations,
} from '@/agents/registry/agentScopedPluginSettingsDeclarations';
import { resolveNewSessionOperationalBackendTarget } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { buildNewSessionLaunchStatusBadges } from '@/components/sessions/new/hooks/screenModel/newSessionLaunchStatusBadges';
import type { NewSessionScreenModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { isProfileCompatibleWithResolvedBackendEntry } from '@/components/profiles/edit/profileBackendEntryStorage';
import {
    readRememberedEngineSelection,
    type RememberedEngineSelectionV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { useDeferredRememberedEngineSelection } from '@/components/sessions/new/hooks/screenModel/useDeferredRememberedEngineSelection';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import {
    NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
    type ComposerReferenceSearchHost,
} from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { resolveNewSessionFileSuggestionScope } from '@/components/sessions/new/modules/resolveNewSessionFileSuggestionScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import {
    projectAiLaunchProfileForLegacyUi,
} from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { useDeleteAiLaunchProfile } from '@/sync/store/settingsWriters';
import { getMaterializedSavedSecrets } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { prepareRunnerMcpMaterial } from '@/sync/domains/ephemeralRunner/prepareRunnerMcpMaterial';
import { createRunnerCreatorSecretReader } from '@/sync/domains/ephemeralRunner/runnerCreatorSecretReader';
import { readProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { resolveVisibleBuiltInLaunchProfiles } from '@/sync/domains/profiles/visibleBuiltInLaunchProfiles';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { readProviderSettingsFromAccountSettingsV1 } from '@happier-dev/protocol/providers/settings/readFromAccountSettingsV1';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol/sessions/creation/sessionDirectoryIntentV1';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveNewSessionFolderChipState } from '@/components/sessions/new/modules/newSessionFolderChipState';
import { captureActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveLaunchProfileAuthoringIntent } from '@/sync/domains/profiles/resolveLaunchProfileAuthoringIntent';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useConfirmExperimentalProviderModel } from '@/providers/hooks/useConfirmExperimentalProviderModel';
import { hiddenModelVisibilityKeys } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import type { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { supportsFreeformModelSelectionForSession } from '@/sync/domains/models/modelOptions';
import { notifyComposerPresentationTargetChanged } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useNewSessionActionOperationReconciliation } from '@/components/sessions/new/hooks/screenModel/useNewSessionActionOperationReconciliation';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import { createNewSessionSeededPlacementActionChip } from '@/components/sessions/new/newSessionSeededPlacementActionChip';
import { useNewSessionOrganizationPlacement } from '@/components/sessions/new/organization/useNewSessionOrganizationPlacement';
import { useNewSessionAccessDraft } from '@/components/sessions/access/useNewSessionAccessDraft';
import { resolveNewSessionDraftAttachmentFlowId } from '@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId';
import { randomUUID } from '@/platform/randomUUID';
import { resolveNewSessionDraftRouteScope } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import {
    hasNewSessionDraftAccessConflict,
    hasNewSessionDraftPrimaryTeamConflict,
    readNewSessionDraftFromRepository,
    readNewSessionDraftProjectionFromRepository,
    writeTemporaryComputerActivationRefToRepository,
} from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { moveNewSessionDraftToScope, subscribeSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createApiSessionDraftsTransport } from '@/sync/api/account/apiSessionDrafts';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    resolveRunnerConnectedServiceReviewBindingsV1,
} from '@/sync/domains/ephemeralRunner/runnerConnectedServiceCustody';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    resolveTemporaryComputerDestinationProjectionState,
    useTemporaryComputerAvailability,
} from '@/components/sessions/new/hooks/useTemporaryComputerAvailability';
import { resolveTemporaryComputerAgentCompatibility } from '@/components/sessions/new/hooks/temporaryComputerAgentCompatibility';
import { resolveTemporaryComputerLaunchBlock } from '@/components/sessions/new/hooks/temporaryComputerLaunchReadiness';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import {
    TemporaryComputerLaunchDependencyUnavailableError,
    type TemporaryComputerLaunchController,
} from '@/components/sessions/new/hooks/useTemporaryComputerLaunch';
import type { NewSessionTemporaryComputerLaunch } from '@/components/sessions/new/components/NewSessionLaunchSurface';
import { resolveNewSessionLaunchPresentation } from '@/components/sessions/new/modules/newSessionLaunchPresentation';
import { homeDisplayName } from '@/components/settings/home/governance/homeGovernanceLabels';
import { stageRunnerAttachments, type StagedRunnerAttachments } from '@/sync/domains/ephemeralRunner/stageRunnerAttachments';
import {
    prepareTemporaryComputerActivation,
    RunnerCreatorRecipientAuthorityError,
} from '@/sync/domains/ephemeralRunner/prepareTemporaryComputerActivation';
import { acquireRunnerArtifact } from '@/sync/domains/ephemeralRunner/package/acquireRunnerArtifact';
import { exportRunnerActivationPackage } from '@/sync/domains/ephemeralRunner/package/exportRunnerActivationPackage';
import {
    openRunnerActivationKeyCustody,
} from '@/sync/domains/ephemeralRunner/runnerActivationKeyCustody';
import {
    retireRunnerActivationKeyCustodyAfterVerifiedClaim,
    type RunnerActivationCustody,
} from '@/sync/domains/ephemeralRunner/runnerActivationCustody';
import type { HandleCreateSessionOptions } from '@/components/sessions/new/hooks/useCreateNewSession';
import type { TemporaryComputerCreatorSettlement } from '@/components/sessions/new/hooks/useCreateNewSession';
import {
    buildRunnerMaterializationRequestV1,
    prepareAndStoreRunnerActivationReviewV1,
    type RunnerReviewCustodyV1,
} from '@/sync/domains/ephemeralRunner/runnerMaterialization';
import {
    acceptRunnerCreatorActivationBinding,
    beginRunnerCreatorAttachmentStagingCustody,
    RunnerCreatorLaunchCustodyUnavailableError,
    getOrCreateRunnerMaterializationRequest,
    readAcceptedRunnerCreatorActivationBinding,
    readPreparedRunnerCreatorLaunchCustody,
    readSubmittedRunnerCreatorTeamCredentialModel,
    readReviewedRunnerCreatorLaunchCustody,
    recordRunnerCreatorStagingCustodyHandle,
    recordRunnerCreatorStagedAttachmentCustody,
    writePreparedRunnerCreatorLaunchCustody,
    writeReviewedRunnerCreatorLaunchCustody,
} from '@/sync/domains/ephemeralRunner/runnerCreatorLaunchCustody';
import {
    recoverAndCreateRunnerActivationKeyCustodyForDraft,
    removeRunnerCreatorCustodyForActivation,
} from '@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval';
import { createServerRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { RunnerCredentialSelectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/review';
import type { ExpectedMarketplaceListingV1 } from '@happier-dev/protocol/marketplace/internal';
import { RunnerPreparedAuthoringV1Schema, type RunnerLaunchManifestV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import type { AgentState } from '@happier-dev/session-core/state';
import Constants from 'expo-constants';
import { resolveLocalDeviceLabel } from '@/utils/platform/resolveLocalDeviceLabel';
import { presentCreatedNewSession } from '@/components/sessions/new/navigation/presentCreatedNewSession';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import {
    presentMaterializedTemporaryComputerSessionAndContinueSettlement,
    settlePersistedMaterializedTemporaryComputerSession,
} from '@/components/sessions/new/navigation/settleMaterializedTemporaryComputerSession';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { AgentSessionStartBlocker } from '@/components/machines/agents/AgentSessionStartBlocker';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';


// Configuration constants
const readAbsentPreflightCatalogs = (): ComposerSuggestionCatalogs | undefined => undefined;
const subscribeAbsentPreflightCatalogs = (_listener: () => void): (() => void) => () => {};

const RECENT_PATHS_DEFAULT_VISIBLE = 5;
const styles = newSessionScreenStyles;

function resolveCompatibilityBackendTarget(
    agentTarget: AgentExecutionTargetV1 | null | undefined,
): BackendTargetRefV2 | null {
    if (!agentTarget) return null;
    try {
        return readBackendTargetRefV2(agentTarget);
    } catch {
        return null;
    }
}

function useLatestRef<Value>(value: Value): React.MutableRefObject<Value> {
    const ref = React.useRef(value);
    ref.current = value;
    return ref;
}

function buildNewSessionScreenAuthoringDraftSignature(draft: NewSessionDraft | null): string {
    if (draft === null) return 'null';
    try {
        // Composer text and attachments are observed by the incumbent repository
        // Composer document. Keeping them out of the screen-model signature prevents
        // that same repository notification from re-rendering the entire New Session
        // hook tree on each keystroke while authoring/routing changes still hydrate it.
        const screenAuthoringDraft = Object.fromEntries(
            Object.entries(draft).filter(([field]) => (
                field !== 'input'
                && field !== 'composerAttachments'
                && field !== 'updatedAt'
            )),
        );
        return JSON.stringify(screenAuthoringDraft) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

type EngineSelectionRememberPatch = Readonly<{
    modelMode?: ModelMode;
    modelSelection?: SessionModelSelectionV1 | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
}>;

function resolvePersistedWindowsLaunchOverrideForMachine(
    draft: NewSessionDraft | null,
    machineId: string | null,
): WindowsRemoteSessionLaunchMode | null {
    if (!draft?.windowsRemoteSessionLaunchModeOverride || !machineId) return null;
    return draft.windowsRemoteSessionLaunchModeOverride.machineId === machineId
        ? draft.windowsRemoteSessionLaunchModeOverride.mode
        : null;
}

/** One frozen empty projection record, so an absent projection keeps a stable identity. */
const EMPTY_PLUGIN_PROJECTION_RECORD = Object.freeze({}) as Readonly<Record<string, never>>;

export type TemporaryComputerCreatorDependencies = Readonly<{
    /**
     * Exact Lane 10 + endpoint authoring decision. It is responsible for the
     * managed-install, Provider-selection, and broker-resource intersection;
     * this screen must not infer those facts from an ordinary backend target.
     */
    isAuthoringCompatible: (params: Readonly<{
        backendTargetKey: string;
        agentTarget: NonNullable<ReturnType<typeof resolveAgentExecutionTargetForBackendTarget>>;
    }>) => boolean;
    /** Exact current Team resource/revision/model binding required before launch custody begins. */
    isLaunchReady: (params: Readonly<{
        backendTargetKey: string;
        agentTarget: NonNullable<ReturnType<typeof resolveAgentExecutionTargetForBackendTarget>>;
    }>) => boolean;
    /**
     * Exact reviewed distribution for an Agent contributed by an installed
     * external plugin, resolved from the marketplace index of the machine whose
     * Agent catalog this screen shows. `null` means the Runner artifact already
     * carries the reviewed generation, or that no exact commitment exists — the
     * producer records that gap and the launch fails closed.
     */
    resolveAgentPluginDistribution: (params: Readonly<{
        agentTarget: NonNullable<ReturnType<typeof resolveAgentExecutionTargetForBackendTarget>>;
        signal?: AbortSignal;
    }>) => Promise<ExpectedMarketplaceListingV1 | null>;
    resolveCredentialSelectionBinding: (params: Readonly<{
        projection: RunnerActivationProjectionV1;
        preparedAuthoring: Awaited<ReturnType<typeof readPreparedRunnerCreatorLaunchCustody>>;
        /** The Team model frozen with the submitted package; never the composer's current choice. */
        submittedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
        client: RunnerActivationClient;
        signal: AbortSignal;
    }>) => Promise<Readonly<{
        binding: RunnerCredentialSelectionBindingV1;
        reviewedProviderModel: RunnerLaunchManifestV1['reviewedProviderModel'];
        displayFacts: RunnerLaunchManifestV1['displayFacts'];
    }> | null>;
    resolveMaterializationInput: (params: Readonly<{
        projection: RunnerActivationProjectionV1;
        custody: RunnerReviewCustodyV1;
    }>) => Promise<Readonly<{
        tag: string;
        agentState: AgentState | null;
        initialAccess?: Parameters<typeof buildRunnerMaterializationRequestV1>[0]['initialAccess'];
        teamCredentialBindings?: Parameters<typeof buildRunnerMaterializationRequestV1>[0]['teamCredentialBindings'];
    }> | null>;
}>;

export function useNewSessionScreenModel(input?: Readonly<{
    composerTopContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
    /**
     * Explicit "Use current turn" adoption for the mounted exact-turn
     * Automation binding (New Automation route). Applied through the incumbent
     * automation-draft owner; route params are never the mutation owner.
     */
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
    /** Exact scoped Settings values for an installed Agent declaration. */
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    /** Exact producer facts owned by Lane 10 and the endpoint/materialization seam. */
    temporaryComputerCreatorDependencies?: TemporaryComputerCreatorDependencies;
    /**
     * A host that decides the directory itself (the embed's new chat passes `{kind:'managed'}`):
     * the intent is constant and the folder and checkout controls render nothing.
     */
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
}>): NewSessionScreenModel {
    const { theme, rt } = useUnistyles();
    // The route objects on `/new`; the embedding host's (Home) otherwise. See `newSessionHost`.
    const { router, navigation, embedded: embeddedInHost } = useNewSessionHostNavigation();
    const creationProfile = useNewSessionHostCreationProfile();
    const hostSpawnExecutor = useNewSessionHostSpawnExecutor();
    const hostBoundMachineId = hostSpawnExecutor && creationProfile?.hostBindsMachine
        ? creationProfile.machineId?.trim() || null
        : null;
    const requestedHostDemanded = useNewSessionHostDemanded();
    // A restricted host supplies its own creation options; Account daemon catalogs are not its authority.
    const hostDemanded = requestedHostDemanded && hostBoundMachineId === null;
    const pathname = usePathname();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { width: screenWidth } = useWindowDimensions();
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text.primary : theme.colors.button.primary.background;
    const popoverBoundaryRef = React.useRef<View>(null!);
    const [draftId] = React.useState(() => input?.draftId ?? randomUUID());

    const newSessionSidePadding = 16;
    const newSessionBottomPadding = Math.max(screenWidth < 420 ? 8 : 16, safeArea.bottom);
    const isNewSessionMobileLayoutWidth = isMobileLayoutWidth(screenWidth);

    // Simple (non-wizard) new-session screen spacing.
    // Keep wizard spacing unchanged (the wizard layout benefits from wider margins).
    const simpleNewSessionTopPadding = screenWidth < 420 ? 20 : 28;
    const simpleNewSessionSidePadding = screenWidth < 420 ? 16 : 24;
    const simpleNewSessionBottomPadding = 8;
    const {
        prompt,
        dataId,
        machineId: machineIdParam,
        machinePoolId: machinePoolIdParam,
        worktree: worktreeParam,
        directory: directoryParam,
        directoryKind: directoryKindParam,
        path: pathParam,
        profileId: profileIdParam,
        spawnServerId: spawnServerIdParam,
        automation: automationParam,
        resumeSessionId: resumeSessionIdParam,
        secretId: secretIdParam,
        secretSessionOnlyId,
        secretRequirementResultId,
        agentType: agentTypeParam,
        backendTarget: backendTargetParam,
        backendTargetKey: backendTargetKeyParam,
        draftServerId: draftServerIdParam,
        draftAccountId: draftAccountIdParam,
    } = useNewSessionHostParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string | string[];
        machinePoolId?: string | string[];
        worktree?: string | string[];
        directory?: string | string[];
        directoryKind?: string | string[];
        path?: string | string[];
        profileId?: string;
        spawnServerId?: string;
        automation?: string;
        resumeSessionId?: string;
        secretId?: string;
        secretSessionOnlyId?: string;
        secretRequirementResultId?: string;
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        draftServerId?: string;
        draftAccountId?: string;
    }>();
    const activeDraftScope = useActiveServerAccountScope();
    const requestedDraftScopeResolution = useServerCredentialAccountScopeResolution(draftServerIdParam);
    const draftScope = resolveNewSessionDraftRouteScope({
        activeScope: activeDraftScope,
        hostScope: creationProfile?.draftScope,
        draftServerId: draftServerIdParam,
        draftAccountId: draftAccountIdParam,
        requestedScopeResolution: requestedDraftScopeResolution,
    });
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const attachmentFlowId = React.useMemo(
        () => resolveNewSessionDraftAttachmentFlowId(draftId),
        [draftId],
    );
    // Try to get data from temporary store first so server-target hydration can decide
    // whether route/temp selections should replace saved draft selections.
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);
    const shouldReplacePersistedDraftSelections = tempSessionData?.replacePersistedDraftSelections === true;
    const loadScopedNewSessionDraft = React.useCallback(() => {
        return draftScope ? readNewSessionDraftProjectionFromRepository({ scope: draftScope, draftId }) : null;
    }, [draftId, draftScope]);

    // Load persisted draft state (survives remounts/screen navigation).
    const [scopedPersistedDraftProjection, setScopedPersistedDraftProjection] = React.useState(() => loadScopedNewSessionDraft());
    const scopedPersistedDraftSignatureRef = React.useRef(buildNewSessionScreenAuthoringDraftSignature(scopedPersistedDraftProjection?.draft ?? null));
    const scopedPersistedDraftConflictSignatureRef = React.useRef<string | null>(
        JSON.stringify(scopedPersistedDraftProjection?.conflict?.fields.map((field) => field.fieldId).sort() ?? null),
    );
    const setLoadedScopedPersistedDraft = React.useCallback((nextProjection: ReturnType<typeof readNewSessionDraftProjectionFromRepository>) => {
        const nextSignature = buildNewSessionScreenAuthoringDraftSignature(nextProjection?.draft ?? null);
        const nextConflictSignature = JSON.stringify(nextProjection?.conflict?.fields.map((field) => field.fieldId).sort() ?? null);
        if (scopedPersistedDraftSignatureRef.current === nextSignature
            && scopedPersistedDraftConflictSignatureRef.current === nextConflictSignature) {
            return;
        }
        scopedPersistedDraftSignatureRef.current = nextSignature;
        scopedPersistedDraftConflictSignatureRef.current = nextConflictSignature;
        setScopedPersistedDraftProjection(nextProjection);
    }, []);
    const scopedPersistedDraft = scopedPersistedDraftProjection?.draft ?? null;
    const scopedPersistedDraftRevision = scopedPersistedDraftProjection?.revision ?? null;
    const scopedPersistedDraftAccessConflict = hasNewSessionDraftAccessConflict(scopedPersistedDraftProjection?.conflict);
    const scopedPersistedDraftPrimaryTeamConflict = hasNewSessionDraftPrimaryTeamConflict(scopedPersistedDraftProjection?.conflict);
    const persistedDraft = shouldReplacePersistedDraftSelections ? null : scopedPersistedDraft;
    const initialSeededPlacementCandidates = React.useMemo(() => (
        persistedDraft?.placementCandidates
            ?? tempSessionData?.pluginNewSessionSeed?.placementCandidates
            ?? []
    ), [persistedDraft?.placementCandidates, tempSessionData?.pluginNewSessionSeed?.placementCandidates]);
    const [seededPlacementCandidates, setSeededPlacementCandidates] = React.useState<
        readonly PluginUiSessionPlacementCandidateV1[]
    >(() => initialSeededPlacementCandidates);
    React.useEffect(() => {
        setSeededPlacementCandidates(initialSeededPlacementCandidates);
    }, [initialSeededPlacementCandidates]);
    const [launchUserAttemptId, setLaunchUserAttemptId] = React.useState<string | null>(() => (
        typeof persistedDraft?.launchUserAttemptId === 'string' ? persistedDraft.launchUserAttemptId : null
    ));
    React.useEffect(() => {
        setLaunchUserAttemptId(
            typeof persistedDraft?.launchUserAttemptId === 'string' ? persistedDraft.launchUserAttemptId : null,
        );
    }, [draftScope, persistedDraft?.launchUserAttemptId]);
    const previousDraftScopeRef = React.useRef(draftScope);

    const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
    const accountSettingsScope = useAccountSettingsScope();
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedBackendTarget = useSetting('lastUsedBackendTarget');
    const newSessionDefaultPersistenceModeV1 = useSetting('newSessionDefaultPersistenceModeV1');
    const newSessionDefaultPersistenceModeByTargetKeyV1 = useSetting('newSessionDefaultPersistenceModeByTargetKeyV1');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    // The wizard is a full page; an embedding host (Home) always shows the composer.
    const useEnhancedSessionWizardSetting = useSetting('useEnhancedSessionWizard');
    const useEnhancedSessionWizard = embeddedInHost ? false : useEnhancedSessionWizardSetting;
    const newSessionPresentationModeV1 = useSetting('newSessionPresentationModeV1');
    const newSessionWizardSectionPresentationV1 = useSetting('newSessionWizardSectionPresentationV1');
    const newSessionWizardColumnsEnabled = useSetting('newSessionWizardColumnsEnabled');
    const shouldBottomAnchor = resolveNewSessionShouldBottomAnchor({
        mode: newSessionPresentationModeV1,
        platformOs: Platform.OS,
        isMobileLayoutWidth: isNewSessionMobileLayoutWidth,
    });

    useNewSessionHappyRouteFlag(pathname);

    const sessionPromptInputMaxHeight = undefined;
    const useProfiles = useSetting('useProfiles');
    const [secrets, setSecrets] = useSavedSecretsMutable();
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useCurrentSecretBindingsByProfileIdMutable();
    const sessionDefaultPermissionModeByTargetKey = useSetting('sessionDefaultPermissionModeByTargetKey');
    const accountSettings = useSettings() ?? settingsDefaults;
    const homeViewSelectionSettings = useHomeViewSelectionSettings();
    const settings = React.useMemo(() => ({
        ...accountSettings,
        ...homeViewSelectionSettings,
    }), [accountSettings, homeViewSelectionSettings]);
    const executionRunsEnabled = resolveLocalFeaturePolicyEnabled('execution.runs', settings);
    const activeServerSource = useNewSessionActiveServerSource();
    const {
        serverProfiles,
        resolvedSettingsTarget,
        allowedTargetServerIds,
        targetServerId,
        targetServerProfile,
        targetServerName,
        showServerPickerChip,
    } = useNewSessionServerTargetState({
        settings,
        hostTargetServerId: hostSpawnExecutor ? creationProfile?.draftScope?.serverId : undefined,
        activeServerId: activeServerSource.activeServerId,
        serverProfiles: activeServerSource.serverProfiles,
        request: {
            spawnServerIdParam,
            persistedTargetServerId: tempSessionData?.executionTarget?.kind === 'machine'
                ? tempSessionData.executionTarget.target.serverId
                : tempSessionData?.executionTarget?.serverId ?? persistedDraft?.targetServerId,
        },
    });
    const targetAccountScopeResolution = useServerCredentialAccountScopeResolution(targetServerId);
    const temporaryComputerTargetScope = targetAccountScopeResolution.kind === 'bound'
        ? targetAccountScopeResolution.scope
        : null;
    const [temporaryTargetDraftRevision, bumpTemporaryTargetDraftRevision] = React.useReducer((revision: number) => revision + 1, 0);
    React.useEffect(() => {
        if (!temporaryComputerTargetScope || (draftScope && areServerAccountScopesEqual(temporaryComputerTargetScope, draftScope))) return;
        return subscribeSessionDraft(temporaryComputerTargetScope, { kind: 'newSession', draftId }, bumpTemporaryTargetDraftRevision);
    }, [draftId, draftScope, temporaryComputerTargetScope]);
    const targetScopedDraft = React.useMemo(() => (
        temporaryComputerTargetScope
            ? readNewSessionDraftFromRepository({ scope: temporaryComputerTargetScope, draftId })
            : null
    ), [draftId, temporaryComputerTargetScope, temporaryTargetDraftRevision]);
    // The continuation recipe rides the same one-shot temp-data channel as every
    // other rich New Session handoff; removing the chip clears only this value.
    const sourceContextState = useNewSessionSourceContext({
        seed: tempSessionData,
        targetServerId: targetServerId ?? null,
    });
    // New-session capability gating should be evaluated in spawn scope (target server),
    // not in main selection scope (which can be a multi-server group).
    const automationsSupport = useAutomationsSupport({ scopeKind: 'spawn', serverId: targetServerId });
    const automationFeatureEnabled = automationsSupport?.enabled === true;

    const capabilityServerId = React.useMemo(() => {
        return resolveNewSessionCapabilityServerId({
            targetServerId,
            activeServerId: activeServerSource.activeServerId,
        });
    }, [activeServerSource.activeServerId, targetServerId]);
    const providersFeatureEnabled = useFeatureEnabled('providers', {
        scopeKind: 'spawn',
        serverId: capabilityServerId,
    });
    const credentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn', serverId: targetServerId,
    });
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId: targetServerId,
        enabled: credentialResourcesEnabled,
    });
    const teamCredentialConnectedServiceResources = React.useMemo(() => (
        teamCredentialCatalog.resources.filter((resource) => resource.connectedServiceSelections.length > 0)
    ), [teamCredentialCatalog.resources]);
    const [selectedTeamCredentialModel, setSelectedTeamCredentialModel] = React.useState<TeamCredentialProviderModelSelectionV1 | null>(null);
    React.useEffect(() => {
        setSelectedTeamCredentialModel(null);
    }, [targetServerId]);
    const externalSessionsFeatureEnabled = useFeatureEnabled('sessions.direct', { scopeKind: 'spawn', serverId: targetServerId });
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const rawProfiles = useSetting('profiles');
    const deleteAiLaunchProfile = useDeleteAiLaunchProfile();
    const launchProfiles = useAiLaunchProfiles(rawProfiles);
    const profiles = useAiLaunchProfilesForLegacyUi(rawProfiles);
    const lastUsedProfile = useAuthoringMemoryField('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [favoriteModelSelections, setFavoriteModelSelections] = useCurrentFavoriteModelSelectionsV1Mutable();
    const [favoriteBackendTargetKeys, setFavoriteBackendTargetKeys] = useSettingMutable('favoriteBackendTargetKeysV1');
    const [lastNewSessionAgentPickerView, setLastNewSessionAgentPickerView] = useSettingMutable('lastNewSessionAgentPickerViewV1');
    const rememberLastEngineSelections = useSetting('rememberLastEngineSelectionsV1') !== false;
    const [lastEngineSelectionsByScope, setLastEngineSelectionsByScope] = useCurrentRememberedEngineSelectionsByScopeV1Mutable();

    const hydratedTempAuthoringDraft = React.useMemo(() => {
        return tempSessionData
            ? buildNewSessionAuthoringDraftFromTempData(tempSessionData)
            : null;
    }, [tempSessionData]);
    const hydratedPersistedAuthoringDraft = React.useMemo(() => {
        return persistedDraft
            ? buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)
            : null;
    }, [persistedDraft]);
    const hydratedPersistedContentAuthoringDraft = React.useMemo(() => {
        return scopedPersistedDraft
            ? buildNewSessionAuthoringDraftFromPersistedDraft(scopedPersistedDraft)
            : null;
    }, [scopedPersistedDraft]);
    const hydratedTempBackendTarget = React.useMemo(
        () => resolveCompatibilityBackendTarget(hydratedTempAuthoringDraft?.agentTarget),
        [hydratedTempAuthoringDraft?.agentTarget],
    );
    const hydratedPersistedBackendTarget = React.useMemo(
        () => resolveCompatibilityBackendTarget(hydratedPersistedAuthoringDraft?.agentTarget),
        [hydratedPersistedAuthoringDraft?.agentTarget],
    );
    const hydratedResumeSessionId = React.useMemo(() => {
        if (typeof hydratedTempAuthoringDraft?.resumeSessionId === 'string') {
            return hydratedTempAuthoringDraft.resumeSessionId;
        }
        if (typeof hydratedPersistedAuthoringDraft?.resumeSessionId === 'string') {
            return hydratedPersistedAuthoringDraft.resumeSessionId;
        }
        return typeof resumeSessionIdParam === 'string' ? resumeSessionIdParam : '';
    }, [hydratedPersistedAuthoringDraft?.resumeSessionId, hydratedTempAuthoringDraft?.resumeSessionId, resumeSessionIdParam]);
    const [resumeSessionId, setResumeSessionId] = React.useState(hydratedResumeSessionId);

    const [backendNewSessionOptionStateByTargetKey, setBackendNewSessionOptionStateByTargetKey] = React.useState<
        Record<string, Record<string, unknown>>
    >(() => {
        return readBackendNewSessionOptionStateByTargetKey(tempSessionData)
            ?? readBackendNewSessionOptionStateByTargetKey(persistedDraft)
            ?? {};
    });

    const routeBackendTarget = React.useMemo(() => {
        return resolveBackendTargetFromRouteParams({
            backendTarget: backendTargetParam,
            backendTargetKey: backendTargetKeyParam,
            agentType: agentTypeParam,
        });
    }, [agentTypeParam, backendTargetKeyParam, backendTargetParam]);

    useFocusEffect(
        React.useCallback(() => {
            setLoadedScopedPersistedDraft(loadScopedNewSessionDraft());
            // Ensure newly-registered machines show up without requiring an app restart.
            // Throttled to avoid spamming the server when navigating back/forth.
            // Defer until after interactions so the screen feels instant on iOS;
            // the timeout fallback guarantees the refresh still runs when
            // interactions never settle (hang class).
            runAfterInteractionsWithFallback(() => {
                fireAndForget(sync.refreshMachinesThrottled({ staleMs: 15_000 }), { tag: 'NewSessionScreenModel.refreshMachinesThrottled.focus' });
            });
        }, [loadScopedNewSessionDraft, setLoadedScopedPersistedDraft])
    );

    React.useEffect(() => {
        if (previousDraftScopeRef.current === draftScope) {
            return;
        }
        previousDraftScopeRef.current = draftScope;
        setLoadedScopedPersistedDraft(loadScopedNewSessionDraft());
    }, [draftScope, loadScopedNewSessionDraft, setLoadedScopedPersistedDraft]);

    React.useEffect(() => {
        if (!draftScope) return;
        return subscribeSessionDraft(draftScope, { kind: 'newSession', draftId }, () => {
            setLoadedScopedPersistedDraft(loadScopedNewSessionDraft());
        });
    }, [draftId, draftScope, loadScopedNewSessionDraft, setLoadedScopedPersistedDraft]);

    // (prefetch effect moved below, after machines/recent/favorites are defined)

    const providerSettingsForProfileIntent = React.useMemo(() => (
        readProviderSettingsFromAccountSettingsV1({
            providerSettingsV1: settings.providerSettingsV1,
        }).settings
    ), [settings.providerSettingsV1]);
    const profileEnabledById = React.useMemo(
        () => readProfileEnabledById(settings.profileEnabledById),
        [settings.profileEnabledById],
    );

    // Combined profiles (built-in + custom)
    const allProfiles = React.useMemo(() => {
        const builtInProfiles = resolveVisibleBuiltInLaunchProfiles({
            lastUsedProfile,
            favoriteProfileIds,
            profileEnabledById,
            secretBindingsByProfileId,
            migration: providerSettingsForProfileIntent.migration,
        });
        return [...builtInProfiles, ...profiles];
    }, [favoriteProfileIds, lastUsedProfile, profileEnabledById, profiles, providerSettingsForProfileIntent.migration, secretBindingsByProfileId]);

    const profileMap = useProfileMap(allProfiles);
    const selectableProfiles = React.useMemo(() => {
        return allProfiles.filter((profile) => isProfileEnabled(profile, profileEnabledById));
    }, [allProfiles, profileEnabledById]);
    const selectableProfileMap = useProfileMap(selectableProfiles);
    const activeMachines = useLaunchSelectionMachines();
    const sessions = useNewSessionPlacementSessions();
    const machineListByServerId = useMachineListByServerId();
    // One resolved Home-group set feeds every destination family. When an explicit settings target
    // is rejected the Machine side used to widen to the resolved allowed Homes while Pools stayed
    // projected from the empty set, so one recovery path silently dropped every Pool row.
    const destinationServerIds = allowedTargetServerIds.length > 0
        ? allowedTargetServerIds
        : resolvedSettingsTarget.allowedServerIds;
    const serverScopedMachineGroups = useServerScopedMachineOptions({
        allowedServerIds: destinationServerIds,
        activeServerId: activeServerSource.activeServerId,
        activeMachines,
        refreshToken: activeServerSource.serverProfilesSignature,
    });
    const machinePoolGroups = useMachinePoolGroups(serverScopedMachineGroups);
    const machines = React.useMemo(() => resolveNewSessionTargetMachines({
        targetServerId,
        activeServerId: activeServerSource.activeServerId,
        activeMachines,
        machineListByServerId,
    }), [activeMachines, activeServerSource.activeServerId, machineListByServerId, targetServerId]);
    const hasExplicitSeededProfileSelection = React.useMemo(() => {
        if (!useProfiles) {
            return false;
        }
        const tempProfileId = typeof hydratedTempAuthoringDraft?.profileId === 'string'
            ? hydratedTempAuthoringDraft.profileId.trim()
            : '';
        if (tempProfileId.length > 0) {
            return true;
        }
        const draftProfileId = hydratedPersistedAuthoringDraft?.profileId;
        return Boolean(draftProfileId && selectableProfileMap.has(draftProfileId));
    }, [hydratedPersistedAuthoringDraft?.profileId, hydratedTempAuthoringDraft?.profileId, selectableProfileMap, useProfiles]);
    const initialImplicitProfileId = React.useMemo(() => {
        if (!useProfiles) {
            return null;
        }
        const tempProfileId = typeof hydratedTempAuthoringDraft?.profileId === 'string'
            ? hydratedTempAuthoringDraft.profileId.trim()
            : '';
        if (tempProfileId.length > 0) {
            return tempProfileId;
        }
        const draftProfileId = hydratedPersistedAuthoringDraft?.profileId;
        if (draftProfileId) {
            return draftProfileId;
        }
        if (lastUsedProfile) {
            return lastUsedProfile;
        }
        return null;
    }, [hydratedPersistedAuthoringDraft?.profileId, hydratedTempAuthoringDraft?.profileId, lastUsedProfile, useProfiles]);
    const initialProfileAuthoringIntent = React.useMemo(() => {
        return resolveLaunchProfileAuthoringIntent({
            profileId: initialImplicitProfileId,
            profiles: launchProfiles,
            migration: providerSettingsForProfileIntent.migration,
        });
    }, [initialImplicitProfileId, launchProfiles, providerSettingsForProfileIntent.migration]);

    // Wizard state
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => initialProfileAuthoringIntent.profileId);
    const hasUserTouchedProfileSelectionRef = React.useRef<boolean>(hasExplicitSeededProfileSelection);

    React.useEffect(() => {
        if (!useProfiles && selectedProfileId !== null) {
            setSelectedProfileId(null);
        }
    }, [useProfiles, selectedProfileId]);

    const emptyAutocompleteKinds = NEW_SESSION_COMPOSER_SUGGESTION_KINDS;

    const effectiveMachineIdParam = React.useMemo(() => {
        if (hostBoundMachineId) return hostBoundMachineId;
        const normalizedMachineIdParam = normalizeOptionalParam(machineIdParam);
        const raw = typeof normalizedMachineIdParam === 'string' ? normalizedMachineIdParam.trim() : '';
        if (raw) return raw;
        const temp = typeof tempSessionData?.machineId === 'string' ? tempSessionData.machineId.trim() : '';
        if (temp) return temp;
        return null;
    }, [hostBoundMachineId, machineIdParam, tempSessionData?.machineId]);

    const targetRecentMachinePaths = React.useMemo(
        () => resolveNewSessionTargetRecentMachinePaths({
            targetServerId,
            accountSettingsServerId: accountSettingsScope?.serverId,
            recentMachinePaths,
        }),
        [accountSettingsScope?.serverId, recentMachinePaths, targetServerId],
    );
    const targetSessions = React.useMemo(
        () => resolveNewSessionTargetSessions({ targetServerId, draftScopeServerId: draftScope?.serverId, sessions }),
        [draftScope?.serverId, sessions, targetServerId],
    );

    const persistedTargetMatches = !persistedDraft?.targetServerId || persistedDraft.targetServerId === targetServerId;
    const normalizedDirectoryKindParam = normalizeOptionalParam(directoryKindParam);
    const requestedDirectoryKind = normalizedDirectoryKindParam === 'managed' || normalizedDirectoryKindParam === 'path'
        ? normalizedDirectoryKindParam : null;
    const effectivePathParam = React.useMemo(() => {
        // A no-folder seed (new session here / fork from a no-folder session) carries no folder.
        if (requestedDirectoryKind === 'managed' || (requestedDirectoryKind !== 'path' && hydratedTempAuthoringDraft?.directoryKind === 'managed')) return null;
        const normalizedDirectoryParam = normalizeOptionalParam(directoryParam);
        const directory = typeof normalizedDirectoryParam === 'string' ? normalizedDirectoryParam.trim() : '';
        if (directory) return directory;

        const normalizedPathParam = normalizeOptionalParam(pathParam);
        const raw = typeof normalizedPathParam === 'string' ? normalizedPathParam.trim() : '';
        if (raw) return raw;
        const temp = typeof hydratedTempAuthoringDraft?.directory === 'string' ? hydratedTempAuthoringDraft.directory.trim() : '';
        if (temp) return temp;

        return null;
    }, [directoryParam, hydratedTempAuthoringDraft?.directory, hydratedTempAuthoringDraft?.directoryKind, pathParam, requestedDirectoryKind]);

    const effectiveWorktreeRouteMode = React.useMemo(() => {
        const normalizedWorktreeParam = normalizeOptionalParam(worktreeParam);
        const raw = typeof normalizedWorktreeParam === 'string' ? normalizedWorktreeParam.trim() : '';
        return raw || null;
    }, [worktreeParam]);

    const explicitMachineId = normalizeOptionalParam(machineIdParam)?.trim() ?? '';
    const routeSelectionOrigin = explicitMachineId
        ? MachinePoolSelectionOriginV1Schema.safeParse({
            kind: 'machine_pool',
            poolId: normalizeOptionalParam(machinePoolIdParam),
        })
        : null;
    const {
        executionTarget,
        selectedMachineId,
        agentCatalogMachineId,
        setSelectedMachineId,
        setSelectedMachineTarget,
        setTemporaryComputerTarget,
        selectedPath,
        rememberedPath,
        directoryKind,
        directoryIntentFixed,
        setDirectoryIntent,
        setSelectedPath,
        setDraftSelectedPath,
        getRequestedPath,
        getBestPathForMachine,
    } = useNewSessionMachinePathState({
        serverId: targetServerId,
        persistedExecutionTarget: hydratedTempAuthoringDraft?.executionTarget ?? hydratedPersistedAuthoringDraft?.executionTarget ?? undefined,
        executionTargetRequestKey: hydratedTempAuthoringDraft?.executionTarget !== undefined
            ? (typeof dataId === 'string' ? dataId : null)
            : null,
        routeSelectionOrigin: routeSelectionOrigin?.success ? routeSelectionOrigin.data : undefined,
        machines,
        recentMachinePaths: targetRecentMachinePaths,
        sessions: targetSessions,
        machineIdParam: effectiveMachineIdParam,
        pathParam: effectivePathParam,
        directoryKindParam: requestedDirectoryKind,
        persistedMachineId: persistedDraft?.selectedMachineId ?? tempSessionData?.machineId,
        persistedPath: persistedTargetMatches ? hydratedPersistedAuthoringDraft?.directory ?? hydratedTempAuthoringDraft?.directory : undefined,
        initialDirectoryKind: hydratedTempAuthoringDraft?.directoryKind ?? hydratedPersistedAuthoringDraft?.directoryKind ?? null,
        fixedDirectoryIntent: input?.fixedDirectoryIntent,
        cacheScopeKey: capabilityServerId,
    });
    const selectionOrigin = executionTarget?.kind === 'machine' ? executionTarget.selectionOrigin : undefined;
    // The Agent catalog is a machine's open plugin projection. For a machine
    // target that is the selected machine; for a Temporary computer, which has
    // no machine of its own, it is the creator's focused machine, so an
    // externally installed Agent can be chosen for it at all. Consumers that
    // need a real execution machine keep their own `selectedMachineId` guard.
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: agentCatalogMachineId,
        serverId: targetServerId,
        enabled: Boolean(agentCatalogMachineId),
        // An embedded composer serves the cached projection until the person reaches for it.
        load: hostDemanded,
    });
    // New Session currentness gate: inputs retained while the selected
    // machine's projection is loading/errored/unsupported are inert metadata.
    // Everything projected here for Agent selection — catalog entries, model
    // and permission state, preferred target restoration, and the spawn
    // target — derives only from an authoritative `ready` projection, so a
    // same-machine generation advance can never keep displaying, restoring,
    // or launching a previous generation's external Agent. Bundled defaults
    // do not depend on this projection and remain usable.
    const projectionCurrent = daemonMergedProjection.phase === 'ready';
    const currentProjectionInputs = projectionCurrent ? daemonMergedProjection.inputs : null;
    // The mounted authoring owner is the canonical composition point for the
    // Temporary-computer creator producers: it already holds the Agent catalog,
    // the entitled Team credential catalog and the current model selection, so
    // composing here keeps one store instead of a second parallel loader. An
    // explicit override stays available for harnesses that must substitute a
    // producer, but production no longer runs with these absent.
    const composedTemporaryComputerCreator = React.useMemo(() => (
        createTemporaryComputerCreatorDependencies({
            teamCredentialResources: teamCredentialCatalog.resources,
            currentTeamCredentialResourceKeys: teamCredentialCatalog.currentResourceKeys,
            teamCredentialServerId: targetServerId,
            selectedTeamCredentialModel,
            // The machine whose open Agent catalog this screen shows also owns
            // the marketplace index that resolves an installed Agent's exact
            // distribution, so both answers come from one machine.
            agentCatalogMachineId,
            projectedAgentsById: currentProjectionInputs?.pluginProjectionV2?.agentsById ?? EMPTY_PLUGIN_PROJECTION_RECORD,
            installedPluginPackagesById: currentProjectionInputs?.pluginProjectionV2?.installedPackagesById ?? EMPTY_PLUGIN_PROJECTION_RECORD,
        })
    ), [
        agentCatalogMachineId,
        currentProjectionInputs?.pluginProjectionV2,
        selectedTeamCredentialModel,
        targetServerId,
        teamCredentialCatalog.currentResourceKeys,
        teamCredentialCatalog.resources,
    ]);
    const temporaryComputerCreator: TemporaryComputerCreatorDependencies =
        input?.temporaryComputerCreatorDependencies ?? composedTemporaryComputerCreator.dependencies;
    // New Session draft records have no generation field. Revalidate them
    // only against the exact current machine/account projection; retained
    // inputs during a target/account transition are intentionally inert.
    const composerAttachmentEntriesById = React.useMemo(() => {
        return normalizePluginUiProjection(
            currentProjectionInputs?.pluginProjectionV2 ?? null,
        ).composerAttachmentsById;
    }, [currentProjectionInputs?.pluginProjectionV2]);
    const enabledAgentIds = useEnabledAgentIds();
    const { snapshot: acpCatalog } = useAcpCatalog(temporaryComputerTargetScope);
    const acpCatalogReady = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale;
    const resolvedBackendEntries = React.useMemo(() => {
        if (!acpCatalog || acpCatalog.stale || acpCatalog.catalog.status !== 'ready') return [];
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSnapshot: acpCatalog.catalog,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
            mergedProviderProjectionById: currentProjectionInputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: currentProjectionInputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: currentProjectionInputs?.discoveredBackendIds,
        });
    }, [
        currentProjectionInputs?.discoveredBackendIds,
        currentProjectionInputs?.mergedBackendProjectionById,
        currentProjectionInputs?.mergedProviderProjectionById,
        enabledAgentIds,
        acpCatalog,
        settings.backendEnabledByTargetKey,
    ]);
    const profilePreferredBackendTarget = React.useMemo(() => {
        if (!initialProfileAuthoringIntent.preferredAgentTargetKey) return null;
        return resolveBackendTargetFromRouteParams({
            backendTargetKey: initialProfileAuthoringIntent.preferredAgentTargetKey,
        });
    }, [initialProfileAuthoringIntent.preferredAgentTargetKey]);
    const implicitProfileBackendTarget = routeBackendTarget
        || hydratedTempBackendTarget
        || tempSessionData?.backendTarget
        || agentTypeParam
        || hydratedPersistedBackendTarget
        ? null
        : profilePreferredBackendTarget;
    const {
        backendTarget,
        setBackendTarget,
        selectedCatalogAgentId: staticAgentId,
        selectedRuntimeCarrierAgentId,
        selectedUiAgentType,
    } = useNewSessionBackendTargetState({
        entries: resolvedBackendEntries,
        lastUsedAgent,
        lastUsedBackendTarget,
        routeBackendTarget,
        persistedBackendTarget: hydratedPersistedBackendTarget,
        tempBackendTarget: routeBackendTarget
            ?? hydratedTempBackendTarget
            ?? tempSessionData?.backendTarget
            ?? implicitProfileBackendTarget,
        tempAgentType: agentTypeParam,
        projectionPhase: daemonMergedProjection.phase,
    });
    /**
     * The selected installed Agent's declarations are the only owners of the
     * settings consumed by its behavior. Account and daemon groups are both
     * legitimate and are projected independently through the canonical hook;
     * this model only selects exact Agent-targeted groups and never reads a
     * record directly.
     */
    const selectedAgentScopedSettingsDeclarations = React.useMemo<AgentScopedPluginSettingsDeclarations>(() => (
        resolveAgentScopedPluginSettingsDeclarations({
            agentId: selectedRuntimeCarrierAgentId,
            projectionInputs: currentProjectionInputs,
        })
    ), [currentProjectionInputs, selectedRuntimeCarrierAgentId]);
    const selectedAgentSettingsTargets = React.useMemo(() => {
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(targetServerId);
        const resolveTarget = (declaration: typeof selectedAgentScopedSettingsDeclarations.account) => (
            declaration
                ? resolveScopedPluginSettingsTarget({
                    scope: declaration.scope,
                    serverIdentityId,
                    machineId: selectedMachineId,
                    serverId: targetServerId,
                })
                : null
        );
        return Object.freeze({
            account: resolveTarget(selectedAgentScopedSettingsDeclarations.account),
            daemon: resolveTarget(selectedAgentScopedSettingsDeclarations.daemon),
        });
    }, [selectedAgentScopedSettingsDeclarations, selectedMachineId, targetServerId]);
    const selectedAgentSettingsFields = React.useMemo(() => Object.freeze({
        account: selectedAgentScopedSettingsDeclarations.account
            ? projectScopedPluginSettingsFields(selectedAgentScopedSettingsDeclarations.account.fields)
            : [],
        daemon: selectedAgentScopedSettingsDeclarations.daemon
            ? projectScopedPluginSettingsFields(selectedAgentScopedSettingsDeclarations.daemon.fields)
            : [],
    }), [selectedAgentScopedSettingsDeclarations]);
    const selectedAgentAccountSettings = useScopedPluginSettingsProjection({
        pluginId: selectedAgentScopedSettingsDeclarations.account?.pluginId ?? '',
        scope: { kind: 'account' },
        target: selectedAgentSettingsTargets.account,
        accountLifetime,
        fields: selectedAgentSettingsFields.account,
        sourceLifetimeIdentity: selectedAgentScopedSettingsDeclarations.account?.sourceLifetimeIdentity,
        perActiveServerIdentityId: resolveScopedPluginSettingsServerIdentity(targetServerId),
        enabled: projectionCurrent && selectedAgentSettingsTargets.account !== null,
        adapter: scopedPluginSettingsAdapter,
    });
    const selectedAgentDaemonSettings = useScopedPluginSettingsProjection({
        pluginId: selectedAgentScopedSettingsDeclarations.daemon?.pluginId ?? '',
        scope: { kind: 'daemon' },
        target: selectedAgentSettingsTargets.daemon,
        accountLifetime,
        fields: selectedAgentSettingsFields.daemon,
        sourceLifetimeIdentity: selectedAgentScopedSettingsDeclarations.daemon?.sourceLifetimeIdentity,
        perActiveServerIdentityId: resolveScopedPluginSettingsServerIdentity(targetServerId),
        enabled: projectionCurrent && selectedAgentSettingsTargets.daemon !== null,
        adapter: scopedPluginSettingsAdapter,
    });
    const selectedAgentSettingsSources = React.useMemo(() => [
        {
            declaration: selectedAgentScopedSettingsDeclarations.daemon,
            projection: selectedAgentDaemonSettings,
        },
        {
            declaration: selectedAgentScopedSettingsDeclarations.account,
            projection: selectedAgentAccountSettings,
        },
    ] as const, [
        selectedAgentAccountSettings,
        selectedAgentDaemonSettings,
        selectedAgentScopedSettingsDeclarations.account,
        selectedAgentScopedSettingsDeclarations.daemon,
    ]);
    const selectedAgentHasScopedSettings = React.useMemo(
        () => selectedAgentSettingsSources.some((source) => source.declaration !== null),
        [selectedAgentSettingsSources],
    );
    const selectedAgentSettingsReady = React.useMemo(
        () => !selectedAgentHasScopedSettings
            || selectedAgentSettingsSources.every((source) => source.declaration === null || source.projection.state.ready),
        [selectedAgentHasScopedSettings, selectedAgentSettingsSources],
    );
    const selectedAgentPluginSettings: AgentPluginSettingsSnapshot | null = React.useMemo(() => {
        if (!selectedAgentHasScopedSettings || !selectedAgentSettingsReady) return null;
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(targetServerId);
        const values: Record<'account' | 'daemon', Record<string, unknown>> = {
            account: {},
            daemon: {},
        };
        // Preserve both scope records independently. A declaration may reuse a
        // local field id in Account and daemon scopes; deduping here would make
        // the daemon-first iteration order an accidental precedence rule.
        for (const source of selectedAgentSettingsSources) {
            if (!source.declaration) continue;
            const scope = source.declaration.scope.kind;
            for (const field of source.declaration.fields) {
                const value = readScopedPluginSettingsDeclaredFieldValue({
                    values: source.projection.state.values,
                    field,
                    serverIdentityId,
                    releasedFlatSettings: scope === 'account' ? accountSettings : null,
                });
                if (value !== undefined) values[scope][field.key] = value;
            }
        }
        return Object.freeze({
            account: Object.freeze(values.account),
            daemon: Object.freeze(values.daemon),
        });
    }, [accountSettings, selectedAgentHasScopedSettings, selectedAgentSettingsReady, selectedAgentSettingsSources, targetServerId]);
    // Explicit embedding values are accepted only when this screen has an
    // identified selected Agent. Never let an unqualified snapshot become a
    // global availability input for every catalog Agent.
    const selectedPluginSettingsAgentId = selectedRuntimeCarrierAgentId ?? staticAgentId;
    const effectiveAgentPluginSettings = selectedAgentPluginSettings
        ?? (selectedPluginSettingsAgentId ? input?.pluginSettings ?? null : null);
    const effectiveAgentPluginSettingsReadiness: AgentPluginSettingsReadiness | null = React.useMemo(
        () => selectedAgentHasScopedSettings
            ? {
                ready: selectedAgentSettingsReady,
                settled: selectedAgentSettingsSources.every((source) => source.declaration === null || source.projection.state.settled),
                loading: selectedAgentSettingsSources.some((source) => source.declaration !== null && source.projection.state.loading),
                error: selectedAgentSettingsSources.find((source) => source.declaration !== null && source.projection.state.error)?.projection.state.error ?? null,
            }
            : null,
        [selectedAgentHasScopedSettings, selectedAgentSettingsReady, selectedAgentSettingsSources],
    );
    const operationalBackendTarget = React.useMemo(() => resolveNewSessionOperationalBackendTarget({
        backendTarget,
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
    }), [backendTarget, selectedRuntimeCarrierAgentId]);
    const canonicalAgentTarget = React.useMemo(() => resolveAgentExecutionTargetForBackendTarget({
        backendTarget: operationalBackendTarget,
        daemonMergedProjectionInputs: currentProjectionInputs,
    }), [currentProjectionInputs, operationalBackendTarget]);
    const selectedAgentProviderOwnedEnvironmentKeys = React.useMemo(() => {
        if (!canonicalAgentTarget) return Object.freeze([]) as readonly string[];
        const keys = new Set<string>();
        const bundledAgentId = resolveBundledAgentIdFromContributionIdentity(canonicalAgentTarget.identity);
        if (bundledAgentId) {
            for (const key of getAgentCore(bundledAgentId).providerOwnedEnvironmentKeys ?? []) keys.add(key);
        }
        for (const projected of Object.values(currentProjectionInputs?.pluginProjectionV2?.agentsById ?? {})) {
            if (
                !projected.identity
                || projected.identity.pluginId !== canonicalAgentTarget.identity.pluginId
                || projected.identity.localId !== canonicalAgentTarget.identity.localId
            ) continue;
            for (const key of projected.providerOwnedEnvironmentKeys) keys.add(key);
        }
        return Object.freeze([...keys]);
    }, [canonicalAgentTarget, currentProjectionInputs?.pluginProjectionV2]);
    const setAgentType = React.useCallback((next: React.SetStateAction<AgentId>) => {
        setBackendTarget((prevTarget) => {
            const currentAgentId = prevTarget.kind === 'agent'
                ? resolveBundledAgentIdFromContributionIdentity(prevTarget.identity)
                : (!prevTarget.configuredBackendId && isBundledAgentId(prevTarget.backendId)
                    ? prevTarget.backendId
                    : null);
            if (!currentAgentId && typeof next === 'function') return prevTarget;
            const nextAgentId = typeof next === 'function'
                ? next(currentAgentId ?? 'claude')
                : next;
            return resolvedBackendEntries.find((entry) => entry.builtInAgentId === nextAgentId)?.backendTarget
                ?? prevTarget;
        });
    }, [resolvedBackendEntries, setBackendTarget]);
    const selectedBackendTargetKey = React.useMemo(() => resolveBackendTargetKeyV2(backendTarget), [backendTarget]);
    const agentOptionState = backendNewSessionOptionStateByTargetKey[selectedBackendTargetKey] ?? null;
    const selectedBackendEntry = React.useMemo(() => {
        return resolvedBackendEntries.find((entry) => entry.backendTargetKey === selectedBackendTargetKey) ?? null;
    }, [resolvedBackendEntries, selectedBackendTargetKey]);
    const rememberedEngineSelection = React.useMemo(() => readRememberedEngineSelection({
        enabled: rememberLastEngineSelections,
        selectionsByScope: lastEngineSelectionsByScope,
        serverId: capabilityServerId,
        backendTarget: selectedBackendEntry?.backendTarget ?? backendTarget,
    }), [
        backendTarget,
        capabilityServerId,
        lastEngineSelectionsByScope,
        rememberLastEngineSelections,
        selectedBackendEntry?.backendTarget,
    ]);
    const agentPolicyType = staticAgentId ?? selectedUiAgentType;
    const agentLabel = selectedBackendEntry?.title ?? formatAgentLikeIdForDisplay(selectedUiAgentType);

    React.useEffect(() => {
        if (!useProfiles) return;
        if (!selectedProfileId) return;
        const selected = profileMap.get(selectedProfileId);
        if (!selected) {
            setSelectedProfileId(null);
            return;
        }
        if (!isProfileEnabled(selected, profileEnabledById)) {
            setSelectedProfileId(null);
            return;
        }
        if (resolvedBackendEntries.some((entry) => isProfileCompatibleWithResolvedBackendEntry(selected, entry))) {
            return;
        }
        setSelectedProfileId(null);
    }, [profileEnabledById, profileMap, resolvedBackendEntries, selectedProfileId, useProfiles]);

    useRouteBackendTargetSelectionSync({
        routeBackendTarget,
        resolvedBackendEntries,
        selectedBackendTargetKey,
        setBackendTarget,
    });

    const collaborationAvailability = useSessionCollaborationAvailability(targetServerId ?? '');
    const organizationPlacementState = useNewSessionOrganizationPlacement({
        executionTarget: executionTarget?.kind === 'machine' ? executionTarget.target : null,
        directory: selectedPath,
        directoryKind,
        initialPlacement: persistedDraft?.organizationPlacement ?? null,
    });
    const accessDraftState = useNewSessionAccessDraft({
        targetServerId: targetServerId ?? null,
        initialAccess: persistedDraft?.access !== undefined
            ? persistedDraft.access
            : hydratedTempAuthoringDraft?.access,
        initialPrimaryTeamId: persistedDraft?.primaryTeamId !== undefined
            ? persistedDraft.primaryTeamId
            : hydratedTempAuthoringDraft?.primaryTeamId,
        sourceRevision: scopedPersistedDraftRevision,
        sourceAccessConflict: scopedPersistedDraftAccessConflict,
        sourcePrimaryTeamConflict: scopedPersistedDraftPrimaryTeamConflict,
        useScreenHost: isNewSessionMobileLayoutWidth,
    });
    const {
        modelMode,
        modelSelection,
        setModelMode,
        setModelSelection,
        setModelSelectionForBackendTarget,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setEngineSelectionForBackendTarget,
        setAcpConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
    } = useNewSessionAgentAuthoringOptionsState({
        agentType: agentPolicyType,
        backendTargetKey: selectedBackendTargetKey,
        allowTargetlessDraftEngineSelection: routeBackendTarget === null,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        rememberedEngineSelection,
        implicitProfileModelSelection: initialProfileAuthoringIntent.modelSelection,
    });
    const hydratedTeamCredentialBindingKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const binding = findAssignedProviderModelCredentialBinding(persistedDraft?.teamCredentialBindings);
        const modelId = persistedDraft?.modelSelection?.ref.modelId;
        if (!binding || !modelId || selectedTeamCredentialModel) return;
        const hydrationKey = `${targetServerId ?? ''}:${binding.resourceId}:${binding.expectedResourceRevision}:${binding.deliveryMode}:${modelId}`;
        if (hydratedTeamCredentialBindingKeyRef.current === hydrationKey) return;
        const resource = teamCredentialCatalog.resources.find((candidate) => (
            candidate.id === binding.resourceId && candidate.resourceRevision === binding.expectedResourceRevision
        ));
        const selection = resource?.providerModels.find((candidate) => (
            candidate.selection.modelId === modelId
            && candidate.selection.deliveryMode === binding.deliveryMode
            && candidate.selection.agentTargetKey === persistedDraft.modelSelection?.ref.agentTargetKey
        ))?.selection;
        if (!selection) return;
        hydratedTeamCredentialBindingKeyRef.current = hydrationKey;
        setSelectedTeamCredentialModel(selection);
    }, [persistedDraft, selectedTeamCredentialModel, targetServerId, teamCredentialCatalog.resources]);
    const rememberEngineSelection = useDeferredRememberedEngineSelection({
        enabled: rememberLastEngineSelections,
        selectionsByScope: lastEngineSelectionsByScope,
        serverId: capabilityServerId,
        accountSettingsScope: draftScope,
        accountLifetime,
        commit: setLastEngineSelectionsByScope,
    });
    const currentEngineSelectionRef = useLatestRef({
        backendTarget: selectedBackendEntry?.backendTarget ?? backendTarget,
        modelMode,
        modelSelection,
        acpSessionModeId,
        sessionConfigOptionOverrides,
    });
    const rememberCurrentEngineSelection = React.useCallback((patch: EngineSelectionRememberPatch = {}) => {
        const current = currentEngineSelectionRef.current;
        rememberEngineSelection(current.backendTarget, {
            modelSelection: Object.prototype.hasOwnProperty.call(patch, 'modelSelection')
                ? patch.modelSelection ?? null
                : patch.modelMode === undefined
                ? current.modelSelection
                : patch.modelMode === 'default'
                    ? null
                    : current.modelSelection?.ref.modelId === patch.modelMode
                        ? current.modelSelection
                        : {
                            v: 1,
                            updatedAt: Date.now(),
                            ref: {
                                agentTargetKey: resolveBackendTargetKeyV2(current.backendTarget),
                                providerConnectionId: null,
                                modelId: patch.modelMode,
                            },
                        },
            acpSessionModeId: Object.prototype.hasOwnProperty.call(patch, 'acpSessionModeId')
                ? patch.acpSessionModeId ?? null
                : current.acpSessionModeId,
            sessionConfigOptionOverrides: Object.prototype.hasOwnProperty.call(patch, 'sessionConfigOptionOverrides')
                ? patch.sessionConfigOptionOverrides ?? null
                : current.sessionConfigOptionOverrides,
        });
    }, [currentEngineSelectionRef, rememberEngineSelection]);
    const setModelModeAndRemember = React.useCallback<React.Dispatch<React.SetStateAction<ModelMode>>>((next) => {
        const current = currentEngineSelectionRef.current.modelMode;
        const value = typeof next === 'function'
            ? (next as (value: ModelMode) => ModelMode)(current)
            : next;
        setModelMode(value);
        rememberCurrentEngineSelection({ modelMode: value });
    }, [currentEngineSelectionRef, rememberCurrentEngineSelection, setModelMode]);
    const setModelSelectionAndRemember = React.useCallback((selection: SessionModelSelectionV1 | null) => {
        setSelectedTeamCredentialModel(null);
        setModelSelection(selection);
        rememberCurrentEngineSelection({ modelSelection: selection });
    }, [rememberCurrentEngineSelection, setModelSelection]);
    const teamCredentialSelectionContextRef = useLatestRef({
        serverId: targetServerId ?? null,
        resources: teamCredentialCatalog.resources,
        currentResourceKeys: teamCredentialCatalog.currentResourceKeys,
    });
    const coordinateTeamCredentialSelection = useTeamCredentialSelectionCoordinator(targetServerId);
    const selectTeamCredentialModel = React.useCallback(async (selection: TeamCredentialProviderModelSelectionV1) => {
        const selectedResource = teamCredentialSelectionContextRef.current.resources.find((resource) => (
            resource.id === selection.resourceId
            && resource.teamId === selection.teamId
            && resource.resourceRevision === selection.expectedResourceRevision
        ));
        const resourceKey = `${selection.teamId}:${selection.resourceId}`;
        if (!selectedResource
            || !teamCredentialSelectionContextRef.current.currentResourceKeys.has(resourceKey)
            || !resourceHasAvailableTeamCredentialProviderModel(selectedResource, selection)) return;
        const expectedServerId = teamCredentialSelectionContextRef.current.serverId;
        const stillCurrent = () => {
            const current = teamCredentialSelectionContextRef.current;
            return current.serverId === expectedServerId
                && current.currentResourceKeys.has(resourceKey)
                && current.resources.some((resource) => (
                resource.id === selection.resourceId
                && resource.teamId === selection.teamId
                && resourceHasAvailableTeamCredentialProviderModel(resource, selection)
            ));
        };
        const selectionOutcome = await coordinateTeamCredentialSelection({
            resource: selectedResource,
            deliveryMode: selection.deliveryMode,
            selection,
            isCurrent: stillCurrent,
        });
        if (selectionOutcome.kind !== 'continue') return;
        if (selectedResource.sessionUsePolicy === 'team_visibility_required') {
            const confirmed = await Modal.confirm(
                t('teams.credentials.usePolicy.title'),
                t('teams.credentials.usePolicy.visibilityNote'),
                { confirmText: t('common.continue'), cancelText: t('common.cancel') },
            );
            if (!confirmed || !stillCurrent()) return;
        }
        if (selectedResource.sessionUsePolicy !== 'personal_allowed') {
            accessDraftState.applyTeamCredentialPolicy(
                selectedResource.teamId,
                selectedResource.sessionUsePolicy === 'team_visibility_required',
            );
        }
        setSelectedTeamCredentialModel(selectionOutcome.selection);
        setModelSelection({
            v: 1,
            updatedAt: Date.now(),
            ref: {
                agentTargetKey: selectionOutcome.selection.agentTargetKey,
                providerConnectionId: null,
                modelId: selectionOutcome.selection.modelId,
            },
        });
    }, [accessDraftState, coordinateTeamCredentialSelection, setModelSelection, teamCredentialSelectionContextRef]);
    const teamCredentialProviderBinding = React.useMemo(() => selectedTeamCredentialModel
        ? sessionModelSelectionV2TeamBindingIntent({
            v: 2,
            updatedAt: Date.now(),
            ref: {
                source: 'team_resource',
                resourceId: selectedTeamCredentialModel.resourceId,
                teamId: selectedTeamCredentialModel.teamId,
                expectedResourceRevision: selectedTeamCredentialModel.expectedResourceRevision,
                deliveryMode: selectedTeamCredentialModel.deliveryMode,
                agentTargetKey: selectedTeamCredentialModel.agentTargetKey,
                modelId: selectedTeamCredentialModel.modelId,
            },
        })
        : undefined, [selectedTeamCredentialModel]);
    const setAcpSessionModeIdAndRemember = React.useCallback<React.Dispatch<React.SetStateAction<string | null>>>((next) => {
        const current = currentEngineSelectionRef.current.acpSessionModeId;
        const value = typeof next === 'function'
            ? (next as (value: string | null) => string | null)(current)
            : next;
        setAcpSessionModeId(value);
        rememberCurrentEngineSelection({ acpSessionModeId: value });
    }, [currentEngineSelectionRef, rememberCurrentEngineSelection, setAcpSessionModeId]);
    const setAcpConfigOptionOverrideAndRemember = React.useCallback((configId: string, value: string) => {
        const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
        const normalizedValue = typeof value === 'string' ? value.trim() : '';
        if (!normalizedConfigId || !normalizedValue) return;
        const updatedAt = Date.now();
        const sessionConfigOptionOverrides = buildAcpConfigOptionOverridesV1({
            updatedAt,
            overrides: {
                ...(currentEngineSelectionRef.current.sessionConfigOptionOverrides?.overrides ?? {}),
                [normalizedConfigId]: {
                    updatedAt,
                    value: normalizedValue,
                },
            },
        });
        setSessionConfigOptionOverrides(sessionConfigOptionOverrides);
        rememberCurrentEngineSelection({ sessionConfigOptionOverrides });
    }, [currentEngineSelectionRef, rememberCurrentEngineSelection, setSessionConfigOptionOverrides]);

    const [pathPickerSearchQuery, setPathPickerSearchQuery] = React.useState('');
    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId) ?? null;
    }, [selectedMachineId, machines]);
    const selectedMachineHomeDir = selectedMachine?.metadata?.homeDir ?? null;
    const providerModelProjection = useProviderModelProjection({
        // A machine RPC: an embedded composer asks only once the person reaches for it.
        enabled: providersFeatureEnabled && selectedMachineId !== null && hostDemanded,
        machineId: selectedMachineId,
        serverId: capabilityServerId,
        agentTargetKey: selectedBackendTargetKey,
        ...(modelSelection ? { currentSelection: modelSelection.ref } : {}),
    });
    const confirmExperimentalProviderModel = useConfirmExperimentalProviderModel({
        enabled: providersFeatureEnabled,
        machineId: selectedMachineId,
        serverId: capabilityServerId,
        agentTargetKey: selectedBackendTargetKey,
        refresh: providerModelProjection.refresh,
    });
    const hiddenNativeModelKeys = React.useMemo(
        () => hiddenModelVisibilityKeys(
            providerSettingsForProfileIntent,
            { providersFeatureEnabled },
        ),
        [providerSettingsForProfileIntent.modelVisibilityByRef, providersFeatureEnabled],
    );
    const repoScmSnapshot = useNewSessionRepoScmSnapshot({
        serverId: targetServerId,
        machineId: selectedMachineId,
        path: selectedPath,
        machineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
        machinePlatform: selectedMachine?.metadata?.platform ?? null,
        enabled: hostDemanded,
    });
    const {
        checkoutCreationDraft,
        setCheckoutCreationDraft,
        checkoutPickerOpen,
        setCheckoutPickerOpen,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        checkoutChipModel,
    } = useNewSessionCheckoutSelectionState({
        persistedDraft,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        selectedMachineId,
        // The remembered folder: removing the folder hides the checkout chip (no SCM snapshot without
        // a folder) but keeps its draft, so choosing the folder again restores it.
        selectedPath: rememberedPath,
        machineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
        machinePlatform: selectedMachine?.metadata?.platform ?? null,
        repoScmSnapshot,
        autoOpenWorktreePickerKey: effectiveWorktreeRouteMode === 'new'
            ? `route:new:${selectedMachineId ?? ''}:${selectedPath}`
            : null,
    });
    const [agentInventoryDemanded, setAgentInventoryDemanded] = React.useState(false);
    const {
        machineAgentsById,
        cliAvailability,
        selectedMachineCapabilities,
        selectedMachineCapabilitiesSnapshot,
        tmuxRequested,
        showResumePicker,
        wizardInstallableDeps,
        isAgentSelectable,
        isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason,
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        selectedMachineSpawnReadiness,
        windowsTerminalAvailable,
    } = useNewSessionAvailabilityState({
        agentInventoryDemanded,
        selectedMachineId,
        selectedMachine,
        capabilityServerId,
        externalSessionsFeatureEnabled,
        settings,
        pluginSettings: effectiveAgentPluginSettings,
        pluginSettingsAgentId: selectedRuntimeCarrierAgentId ?? staticAgentId,
        pluginSettingsReadiness: effectiveAgentPluginSettingsReadiness,
        staticAgentId,
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
        pluginProjectionV2: currentProjectionInputs?.pluginProjectionV2 ?? null,
        resumeSessionId,
        backendNewSessionOptionStateByTargetKey,
        resolvedBackendEntries,
        selectedBackendEntry,
        setBackendTarget,
        machines,
        allProfiles,
    });
    const refreshCliAvailabilityRef = useLatestRef(cliAvailability.refresh);
    const refreshCliAvailability = React.useCallback(() => {
        void refreshCliAvailabilityRef.current({ bypassCache: true });
    }, [refreshCliAvailabilityRef]);
    const cliAvailabilityProbePhase: OptionPickerProbeState['phase'] = cliAvailability.isDetecting
        ? (cliAvailability.timestamp > 0 ? 'refreshing' : 'loading')
        : 'idle';

    const cliAvailabilityProbe = React.useMemo<OptionPickerProbeState | undefined>(() => {
        if (!selectedMachineId) return undefined;
        return {
            phase: cliAvailabilityProbePhase,
            onRefresh: refreshCliAvailability,
        };
    }, [cliAvailabilityProbePhase, refreshCliAvailability, selectedMachineId]);
    const applyConnectedServiceTeamCredentialPolicy = React.useCallback(async (
        resource: TeamCredentialResourceCatalogEntryV1,
        isCurrent: () => boolean,
    ) => {
        if (resource.sessionUsePolicy === 'team_visibility_required') {
            const confirmed = await Modal.confirm(
                t('teams.credentials.usePolicy.title'),
                t('teams.credentials.usePolicy.visibilityNote'),
                { confirmText: t('common.continue'), cancelText: t('common.cancel') },
            );
            if (!confirmed || !isCurrent()) return false;
        }
        if (resource.sessionUsePolicy !== 'personal_allowed') {
            accessDraftState.applyTeamCredentialPolicy(
                resource.teamId,
                resource.sessionUsePolicy === 'team_visibility_required',
            );
        }
        return true;
    }, [accessDraftState]);
    const {
        setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip,
        connectedServicesBindingsPayload,
        connectedServicesModelProbeCacheIdentity,
        agentNewSessionOptions,
    } = useNewSessionConnectedServicesAgentOptions({
        staticAgentId,
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
        selectedMachineId,
        targetServerId,
        selectedBackendTargetKey,
        connectedAccounts: selectedBackendEntry?.agentCatalogEntry.connectedAccounts,
        agentIdentity: selectedBackendEntry?.agentCatalogEntry.identity ?? null,
        teamCredentialResources: teamCredentialConnectedServiceResources,
        teamCredentialResourceCurrentKeys: teamCredentialCatalog.currentResourceKeys,
        teamNameById: teamCredentialCatalog.teamNameById,
        setBackendNewSessionOptionStateByTargetKey,
        agentOptionState,
        settings,
        router,
        applyTeamCredentialPolicy: applyConnectedServiceTeamCredentialPolicy,
    });
    const teamCredentialBindings = React.useMemo(() => {
        const bindings: SessionTeamCredentialBindingIntentListV1 = [
            ...(teamCredentialProviderBinding ? [teamCredentialProviderBinding] : []),
            ...(connectedServicesBindingsPayload && canonicalAgentTarget
                ? composeConnectedServiceTeamCredentialBindingIntents({
                    consumer: canonicalAgentTarget.identity,
                    declarations: selectedBackendEntry?.agentCatalogEntry.connectedAccounts ?? [],
                    bindings: connectedServicesBindingsPayload,
                    resources: teamCredentialCatalog.resources,
                })
                : []),
        ];
        return bindings.length > 0 ? bindings : undefined;
    }, [
        canonicalAgentTarget,
        connectedServicesBindingsPayload,
        selectedBackendEntry?.agentCatalogEntry.connectedAccounts,
        teamCredentialCatalog.resources,
        teamCredentialProviderBinding,
    ]);
    React.useEffect(() => {
        if (!useProfiles) {
            return;
        }
        if (hasUserTouchedProfileSelectionRef.current) {
            return;
        }

        const nextProfileId = initialImplicitProfileId;
        if (selectedProfileId === nextProfileId) {
            return;
        }
        setSelectedProfileId(nextProfileId);
    }, [initialImplicitProfileId, selectedProfileId, useProfiles]);
    const {
        preflightModels,
        preflightModelsTargetKey,
        modelOptions,
        modelOptionsProbeState,
        acpSessionModeOptions,
        acpSessionModeProbeState,
        acpConfigOptions,
        acpConfigOptionsProbeState,
    } = useNewSessionScreenPreflightState({
        backendTarget,
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
        selectedProfileId,
        settings,
        pluginSettings: effectiveAgentPluginSettings,
        pluginSettingsReadiness: effectiveAgentPluginSettingsReadiness,
        selectedMachineId,
        capabilityServerId,
        cwd: selectedPath,
        connectedServicesBindingsPayload,
        connectedServicesModelProbeCacheIdentity,
        machineProbesEnabled: hostDemanded,
    });

    const selectCreationModel = React.useCallback<React.ComponentProps<typeof SessionModelPicker>['onSelect']>((ref) => {
        // Host-restricted choices update this draft, not the Account's remembered engine selection.
        setSelectedTeamCredentialModel(null);
        setModelSelection(ref ? { v: 1, updatedAt: Date.now(), ref } : null);
    }, [setModelSelection]);
    const creationModelPickerProps = React.useMemo<React.ComponentProps<typeof SessionModelPicker> | undefined>(() => {
        if (!creationProfile) return undefined;
        const hostCatalog = creationProfile.modelCatalog;
        const projection = hostCatalog ? hostCatalog.providerProjection : providerModelProjection.data;
        return {
            agentTargetKey: selectedBackendTargetKey,
            nativeModels: hostCatalog?.nativeModels ?? modelOptions,
            providerGroups: projection?.groups ?? [],
            hiddenNativeModelKeys,
            providerProjectionAuthoritative: hostCatalog !== undefined
                ? hostCatalog.providerProjection !== null
                : providerModelProjection.status === 'success',
            projectionError: hostCatalog ? null : providerModelProjection.error,
            projectionFailures: hostCatalog ? [] : providerModelProjection.refreshFailures,
            retryProjection: hostCatalog ? null : providerModelProjection.refresh,
            currentSelectionRecovery: projection?.currentSelectionRecovery ?? null,
            selected: modelSelection?.ref ?? null,
            effectiveLabel: modelMode,
            probe: modelOptionsProbeState,
            experimentalConfirmation: hostBoundMachineId === null ? confirmExperimentalProviderModel : undefined,
            canEnterCustomNativeValue: supportsFreeformModelSelectionForSession(selectedUiAgentType, null),
            onSelect: selectCreationModel,
        };
    }, [creationProfile, confirmExperimentalProviderModel, hiddenNativeModelKeys, hostBoundMachineId, modelMode, modelOptions,
        modelOptionsProbeState, modelSelection, providerModelProjection.data, providerModelProjection.error,
        providerModelProjection.refresh, providerModelProjection.refreshFailures, providerModelProjection.status,
        selectCreationModel, selectedBackendTargetKey, selectedUiAgentType]);

    const allProfilesRequirementNames = React.useMemo(() => {
        const names = new Set<string>();
        for (const p of selectableProfiles) {
            for (const req of p.envVarRequirements ?? []) {
                const name = typeof req?.name === 'string' ? req.name : '';
                if (name) names.add(name);
            }
        }
        return Array.from(names);
    }, [selectableProfiles]);

    const machineEnvPresence = useMachineEnvPresence(
        hostDemanded ? selectedMachineId ?? null : null,
        allProfilesRequirementNames,
        { ttlMs: 5 * 60_000, serverId: capabilityServerId },
    );
    const refreshMachineEnvPresence = machineEnvPresence.refresh;

    //
    // Path selection
    //

    const readExactTurn = React.useCallback((sourceSessionId: string) => (
        readExactActiveParentTurn(storage.getState().sessions[sourceSessionId])
    ), []);
    // The shared Automation editor handoff is built further down, from the live
    // composer and authoring draft; the draft owner reaches it after render.
    const openAutomationEditorRef = React.useRef<((automation: NewSessionAutomationDraft) => void) | null>(null);
    const handOffLegacyAutomation = React.useCallback((automation: NewSessionAutomationDraft) => {
        openAutomationEditorRef.current?.(automation);
    }, []);
    const {
        promptStore,
        setSessionPrompt,
        automationDraft,
        automationRequestedByRoute,
        initialTriggers,
        setInitialTriggers,
    } = useNewSessionPromptAutomationState({
        prompt,
        dataId,
        automationParam,
        persistedDraftEntryIntent: scopedPersistedDraft?.entryIntent,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft: hydratedPersistedContentAuthoringDraft,
        initialTriggersDraftKey: `${draftScope?.serverId ?? ''}:${draftScope?.accountId ?? ''}:${draftId ?? ''}`,
        exactTurnRetargetRequest: input?.automationExactTurnRetarget ?? null,
        readExactTurn,
        handOffLegacyAutomation: automationFeatureEnabled ? handOffLegacyAutomation : null,
    });
    const [isCreatingLocally, setIsCreating] = React.useState(false);
    const temporaryComputerAvailability = useTemporaryComputerAvailability({
        serverId: targetServerId,
        accountScope: temporaryComputerTargetScope,
        profile: targetServerProfile,
        interactive: !automationRequestedByRoute,
    });
    // Destination eligibility (above) answers "can this Home offer a temporary
    // computer at all". Launch readiness (below) answers "can *this* authored
    // request run on one". Folding the second into the first used to delete the
    // destination row for an unsupported Agent, leaving no explanation and no
    // recovery; keeping them apart lets Send block with an exact reason while
    // the destination stays discoverable.
    const temporaryComputerDestinationProjectionState = resolveTemporaryComputerDestinationProjectionState(
        temporaryComputerAvailability,
    );
    const temporaryComputerDestinationRowCount = temporaryComputerAvailability.status === 'available'
        ? temporaryComputerAvailability.artifacts.length
        : 0;
    const temporaryComputerDestinationProjection = React.useMemo(() => ({
        state: temporaryComputerDestinationProjectionState,
        rowCount: temporaryComputerDestinationRowCount,
    }), [temporaryComputerDestinationProjectionState, temporaryComputerDestinationRowCount]);
    const actionOperationReconciliationCallbacksRef = React.useRef<Readonly<{
        disableDraftPersistence: () => void;
        resetLaunchRequestId: (requestId: null) => void;
    }>>({
        disableDraftPersistence: () => {},
        resetLaunchRequestId: () => {},
    });
    const disableDraftPersistenceForActionOperation = React.useCallback(() => {
        actionOperationReconciliationCallbacksRef.current.disableDraftPersistence();
    }, []);
    const resetLaunchRequestIdForActionOperation = React.useCallback((requestId: null) => {
        actionOperationReconciliationCallbacksRef.current.resetLaunchRequestId(requestId);
    }, []);
    const { isCreatingFromOperation } = useNewSessionActionOperationReconciliation({
        draftId,
        requestId: launchUserAttemptId,
        draftScope,
        localCreationInFlight: isCreatingLocally,
        disableDraftPersistence: disableDraftPersistenceForActionOperation,
        resetLaunchRequestId: resetLaunchRequestIdForActionOperation,
        router,
    });
    const isCreating = isCreatingLocally || isCreatingFromOperation;
    const [isResumeSupportChecking, setIsResumeSupportChecking] = React.useState(false);
    const [pendingLaunchAttempt, setPendingLaunchAttempt] = React.useState<NewSessionLaunchAttempt | null>(null);
    const newSessionComposerCanSubmitRef = React.useRef(false);
    const newSessionRouteIsFocused = useIsFocused();
    const newSessionLayoutPresented = useLayoutPresentationActive();
    const newSessionComposerPresentedRef = React.useRef(false);
    newSessionComposerPresentedRef.current = newSessionRouteIsFocused && newSessionLayoutPresented;
    const newSessionComposerDocument = useNewSessionComposerDocument({
        draftId,
        draftScope,
        promptStore,
        persistedAttachments: scopedPersistedDraft?.composerAttachments ?? [],
        persistedAttachmentSeeds: scopedPersistedDraft?.composerAttachmentSeeds ?? [],
        composerAttachmentEntriesById,
        composerPluginProjection: {
            machineId: selectedMachineId,
            serverId: targetServerId,
            phase: daemonMergedProjection.phase,
            inputs: daemonMergedProjection.inputs,
        },
        scopeKey: draftScope ? serverAccountScopeKeySuffix(draftScope) : null,
        canSubmitRef: newSessionComposerCanSubmitRef,
        isSubmitting: isCreating,
        isPresented: newSessionRouteIsFocused,
        setDirectoryIntent: directoryIntentFixed ? undefined : setDirectoryIntent,
    });

    const newSessionComposerReferenceSearchIsCurrent = newSessionComposerDocument.isReferenceSearchCurrent;
    const newSessionComposerReferenceHostRef = React.useRef<ComposerReferenceSearchHost | null>(null);
    const newSessionComposerReferenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => {
        const projection = currentProjectionInputs?.pluginProjectionV2 ?? null;
        if (
            selectedMachineId === null
            || projection === null
        ) {
            return null;
        }

        let host: ComposerReferenceSearchHost;
        host = {
            machineId: selectedMachineId,
            serverId: targetServerId,
            projection,
            isCurrent: () => (
                newSessionComposerReferenceHostRef.current === host
                && newSessionComposerReferenceSearchIsCurrent()
            ),
        };
        return host;
    }, [
        currentProjectionInputs?.pluginProjectionV2,
        newSessionComposerReferenceSearchIsCurrent,
        selectedMachineId,
        targetServerId,
    ]);
    newSessionComposerReferenceHostRef.current = newSessionComposerReferenceHost;
    const newSessionComposerDropHost = React.useMemo<ComposerReferenceSearchHost | null>(() => (
        newSessionComposerReferenceHost ? {
            ...newSessionComposerReferenceHost,
            isCurrent: () => newSessionComposerReferenceHostRef.current === newSessionComposerReferenceHost
                && newSessionComposerDocument.isCurrent() && newSessionComposerPresentedRef.current,
        } : null
    ), [newSessionComposerDocument.isCurrent, newSessionComposerReferenceHost, newSessionLayoutPresented, newSessionRouteIsFocused]);
    const newSessionComposerFileScope = React.useMemo(() => resolveNewSessionFileSuggestionScope({
        targetServerId, selectedMachineId, selectedMachineHomeDir, selectedPath,
    }), [selectedMachineHomeDir, selectedMachineId, selectedPath, targetServerId]);

    React.useEffect(() => {
        setResumeSessionId(hydratedResumeSessionId);
    }, [hydratedResumeSessionId]);

    // Handle resumeSessionId param from the resume picker screen
    React.useEffect(() => {
        if (typeof resumeSessionIdParam !== 'string') {
            return;
        }
        setResumeSessionId(resumeSessionIdParam);
    }, [resumeSessionIdParam]);

    // Computed values
    const compatibleProfiles = React.useMemo(() => {
        return selectableProfiles.filter((profile) => isProfileCompatibleWithBackendTarget(profile, backendTarget));
    }, [selectableProfiles, backendTarget]);
    const selectedProfile = React.useMemo(() => {
        if (!selectedProfileId) {
            return null;
        }
        if (profileMap.has(selectedProfileId)) {
            const profile = profileMap.get(selectedProfileId)!;
            return isProfileEnabled(profile, profileEnabledById) ? profile : null;
        }
        return null;
    }, [profileEnabledById, selectedProfileId, profileMap]);

    const persistedWindowsRemoteSessionLaunchModeOverride = resolvePersistedWindowsLaunchOverrideForMachine(
        persistedDraft,
        selectedMachineId,
    );
    const [windowsRemoteSessionLaunchModeOverride, setWindowsRemoteSessionLaunchModeOverride] =
        React.useState<WindowsRemoteSessionLaunchMode | null>(() => persistedWindowsRemoteSessionLaunchModeOverride);

    const persistedWindowsRemoteSessionLaunchModeOverrideMachineId = persistedDraft?.windowsRemoteSessionLaunchModeOverride?.machineId ?? null;
    const persistedWindowsRemoteSessionLaunchModeOverrideMode = persistedDraft?.windowsRemoteSessionLaunchModeOverride?.mode ?? null;
    React.useEffect(() => {
        setWindowsRemoteSessionLaunchModeOverride(
            resolvePersistedWindowsLaunchOverrideForMachine(persistedDraft, selectedMachineId),
        );
    }, [
        persistedDraft,
        persistedWindowsRemoteSessionLaunchModeOverrideMachineId,
        persistedWindowsRemoteSessionLaunchModeOverrideMode,
        selectedMachineId,
    ]);
    const effectiveWindowsRemoteSessionLaunchMode = React.useMemo(() => {
        return resolveEffectiveWindowsRemoteSessionLaunchMode({
            machineMetadata: selectedMachine?.metadata,
            settings,
            sessionOverride: windowsRemoteSessionLaunchModeOverride ?? undefined,
        }).mode;
    }, [selectedMachine?.metadata, settings, windowsRemoteSessionLaunchModeOverride]);
    const handleOpenMcpSettings = React.useCallback(() => {
        // `router.push` expects the public route (group segments like `/(app)` are not valid here on web).
        router.push('/settings/mcp' as any);
    }, [router]);
    const { mcpChip } = useNewSessionMcpSelection({
        selectedMachineId,
        selectedPath,
        selectedMachineName: getMachineDisplayName(selectedMachine),
        portableOnly: executionTarget?.kind === 'temporary_computer',
        agentType: selectedUiAgentType,
        targetServerId,
        mcpSelection,
        setMcpSelection,
        onOpenSettings: handleOpenMcpSettings,
    });

    const {
        selectedSecretIdByProfileIdByEnvVarName,
        setSelectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        setSessionOnlySecretValueByProfileIdByEnvVarName,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        openSecretRequirementModal,
        prepareSecretPromptForProfileSelection,
        suppressNextSecretAutoPromptKeyRef,
        selectedSecretId,
        setSelectedSecretId,
        sessionOnlySecretValue,
        setSessionOnlySecretValue,
        selectedSavedSecret,
        activeSecretSource,
        secretRequirements,
        shouldShowSecretSection,
        resolveSavedSecretReference,
    } = useNewSessionSecretSelectionState({
        persistedDraft,
        selectedProfileId,
        selectedProfile,
        secretBindingsByProfileId,
        setSecretBindingsByProfileId,
        secrets,
        setSecrets,
        selectedMachineId,
        machineEnvPresence,
        useProfiles,
        setSelectedProfileId,
        router,
        navigation: navigation as any,
        routeBackendParams: buildBackendTargetRouteParams({
            agentType: agentTypeParam,
            backendTarget: backendTargetParam,
            backendTargetKey: backendTargetKeyParam,
            fallbackTarget: backendTarget,
        }),
        routeContextParams: buildSecretRequirementRouteParams({
            dataId: typeof dataId === 'string' ? dataId : undefined,
            draftId,
            selectedMachineId,
            targetServerId,
        }),
        secretIdParam: typeof secretIdParam === 'string' ? secretIdParam : undefined,
        secretSessionOnlyId: typeof secretSessionOnlyId === 'string' ? secretSessionOnlyId : undefined,
        secretRequirementResultId: typeof secretRequirementResultId === 'string' ? secretRequirementResultId : undefined,
    });

    const nativeCatalogAgentId = resolveNewSessionBehaviorAgentId({
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
        staticAgentId,
        agentType: selectedUiAgentType,
    });
    const nativeCatalogAgentLaunchParams = React.useMemo(() => {
        if (!nativeCatalogAgentId || effectiveAgentPluginSettingsReadiness?.ready === false) return null;
        const newSessionOptions = { ...(agentNewSessionOptions ?? {}), targetServerId };
        const extras = buildSpawnSessionExtrasFromUiState({
            agentId: nativeCatalogAgentId, settings, pluginSettings: effectiveAgentPluginSettings,
            machineId: selectedMachineId, resumeSessionId, newSessionOptions, sessionConfigOptionOverrides,
        });
        const probeContext = resolveNewSessionCapabilityProbeContext({
            backendTarget, runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
            selectedProfileId: useProfiles ? selectedProfileId : null,
            settings, pluginSettings: effectiveAgentPluginSettings, machineId: selectedMachineId,
            runtimeDescriptorV1: extras.runtimeDescriptorV1 === undefined ? undefined : RuntimeDescriptorV1Schema.parse(extras.runtimeDescriptorV1),
        });
        return {
            ...(probeContext?.capabilityParams ?? {}),
            environmentVariables: buildSpawnEnvironmentVariablesFromUiState({
                environmentVariables: undefined,
                agentId: nativeCatalogAgentId, settings, pluginSettings: effectiveAgentPluginSettings,
                machineId: selectedMachineId, newSessionOptions,
            }) ?? {},
            ...(connectedServicesBindingsPayload ? { connectedServices: connectedServicesBindingsPayload } : {}),
        };
    }, [agentNewSessionOptions, backendTarget, connectedServicesBindingsPayload, effectiveAgentPluginSettings,
        effectiveAgentPluginSettingsReadiness?.ready, nativeCatalogAgentId, resumeSessionId, selectedMachineId,
        selectedProfileId, selectedRuntimeCarrierAgentId, sessionConfigOptionOverrides, settings, targetServerId, useProfiles]);
    const nativeCatalogProfile = useProfiles ? selectedProfile : null;
    const nativeCatalogSecretChoices = nativeCatalogProfile
        ? selectedSecretIdByProfileIdByEnvVarName[nativeCatalogProfile.id] ?? {} : {};
    const nativeCatalogSessionOnlyValues = nativeCatalogProfile
        ? sessionOnlySecretValueByProfileIdByEnvVarName[nativeCatalogProfile.id] ?? {} : {};
    const nativeCatalogDefaultBindings = nativeCatalogProfile ? secretBindingsByProfileId[nativeCatalogProfile.id] ?? null : null;
    const nativeCatalogMachineEnv = Object.fromEntries(
        Object.entries(machineEnvPresence.meta ?? {}).map(([name, value]) => [name, Boolean(value?.isSet)]),
    );
    const nativeCatalogScopeKey = stableJsonStringify({
        workspace: newSessionComposerFileScope, agentId: nativeCatalogAgentId, backendTarget: operationalBackendTarget,
        accountScope: draftScope, launchParams: nativeCatalogAgentLaunchParams,
        profile: nativeCatalogProfile, selectedSecrets: nativeCatalogSecretChoices,
        sessionOnlyValues: nativeCatalogSessionOnlyValues, defaultBindings: nativeCatalogDefaultBindings,
        machineEnv: nativeCatalogMachineEnv, connectedServicesIdentity: connectedServicesModelProbeCacheIdentity,
        projection: currentProjectionInputs?.pluginProjectionV2?.generation,
    });
    const nativeCatalogScope = React.useMemo(() => ({
        key: nativeCatalogScopeKey, workspace: newSessionComposerFileScope, agentId: nativeCatalogAgentId,
        backendTarget: operationalBackendTarget, accountScope: draftScope, launchParams: nativeCatalogAgentLaunchParams,
        profile: nativeCatalogProfile, selectedSecrets: nativeCatalogSecretChoices,
        sessionOnlyValues: nativeCatalogSessionOnlyValues, defaultBindings: nativeCatalogDefaultBindings,
        machineEnv: nativeCatalogMachineEnv, resolveSavedSecretReference,
    }), [nativeCatalogScopeKey, resolveSavedSecretReference]);
    const preflightComposerCatalogSource = React.useMemo(() => {
        const scope = nativeCatalogScope;
        if (!scope.workspace || !scope.agentId || !scope.launchParams) return undefined;
        return createPreflightComposerSuggestionCatalogSource({
            machineId: scope.workspace.machineId, serverId: scope.workspace.serverId,
            accountId: scope.accountScope?.serverId === scope.workspace.serverId ? scope.accountScope.accountId : null,
            agentId: scope.agentId, backendTarget: scope.backendTarget,
            capabilityParams: () => {
                const readiness = scope.profile ? resolveStrictV2ProfileSecretReadiness({
                    profile: scope.profile, defaultBindings: scope.defaultBindings, selectedSecretIds: scope.selectedSecrets,
                    sessionOnlyValues: scope.sessionOnlyValues, machineEnvReadyByName: scope.machineEnv,
                    resolveSavedSecretReference: scope.resolveSavedSecretReference,
                }) : { ok: true as const };
                if (!readiness.ok) throw new Error(`Pre-session profile unavailable (${readiness.reason})`);
                return {
                    ...scope.launchParams, cwd: scope.workspace!.rootPath, timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                    ...('secretReferenceOverlay' in readiness && readiness.secretReferenceOverlay
                        ? { secretReferenceOverlay: readiness.secretReferenceOverlay } : {}),
                };
            },
        });
    }, [nativeCatalogScope]);
    const preflightComposerCatalogs = React.useSyncExternalStore(
        preflightComposerCatalogSource?.subscribe ?? subscribeAbsentPreflightCatalogs,
        preflightComposerCatalogSource?.getSnapshot ?? readAbsentPreflightCatalogs,
        preflightComposerCatalogSource?.getSnapshot ?? readAbsentPreflightCatalogs,
    );
    // All triggers continue through the canonical registry, including plugin references.
    const emptyAutocompleteSuggestions = React.useCallback(
        (query: string, signal: AbortSignal) => getSuggestions(null, query, {
            kinds: NEW_SESSION_COMPOSER_SUGGESTION_KINDS, serverId: targetServerId,
            workspace: newSessionComposerFileScope, signal,
            composerReferenceHost: newSessionComposerReferenceHost,
            catalogs: preflightComposerCatalogs, loadCatalogs: preflightComposerCatalogSource?.read,
        }),
        [newSessionComposerReferenceHost, newSessionComposerFileScope, preflightComposerCatalogs,
            preflightComposerCatalogSource, targetServerId],
    );

    // NOTE: we intentionally do NOT clear per-profile secret overrides when profile changes.
    // Users may resolve secrets for multiple profiles and then switch between them before creating a session.

    const {
        transcriptStorage,
        setTranscriptStorage,
        supportsDirectTranscriptStorage,
        hasUserSelectedTranscriptStorageRef,
    } = useNewSessionTranscriptStorageState({
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        profileMap,
        selectedProfileId,
        newSessionDefaultPersistenceModeV1,
        newSessionDefaultPersistenceModeByTargetKeyV1,
        resolvedBackendTargets: resolvedBackendEntries.map((entry) => entry.backendTarget),
        agentType: agentPolicyType,
        selectedMachineId,
        backendTarget,
        settings,
        externalSessionsFeatureEnabled,
    });
    const {
        permissionMode,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        handlePermissionModeChange,
        resolveDefaultPermissionMode,
    } = useNewSessionPermissionModeState({
        agentType: agentPolicyType,
        backendTarget,
        hydratedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft,
        selectedProfileId,
        profileMap,
        enabledAgentIds,
        sessionDefaultPermissionModeByTargetKey,
    });

    const resolveSelectedProfileAuthoringIntent = React.useCallback((profileId: string) => (
        resolveLaunchProfileAuthoringIntent({
            profileId,
            profiles: launchProfiles,
            migration: providerSettingsForProfileIntent.migration,
        })
    ), [launchProfiles, providerSettingsForProfileIntent.migration]);

    // Profile/backend reconciliation and permission-mode fallback logic is owned by the
    // extracted hook so this screen model can keep route-specific profile param handling local.
    const { selectProfile } = useNewSessionProfileBackendReconciliation({
        useProfiles,
        selectedProfileId,
        setSelectedProfileId,
        profileMap,
        getCompatibleProfileBackendEntries,
        selectedBackendTargetKey,
        setBackendTarget,
        machineAgentsById,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        resolveDefaultPermissionMode,
        prepareSecretPromptForProfileSelection,
        hasUserTouchedProfileSelectionRef,
        agentType: agentPolicyType,
        resolveProfileAuthoringIntent: resolveSelectedProfileAuthoringIntent,
        setModelSelectionForBackendTarget,
    });

    const { onPressDefaultEnvironment, handleDeleteProfile } = useNewSessionProfileActions({
        hasUserTouchedProfileSelectionRef,
        setSelectedProfileId,
        selectedProfileId,
        deleteProfile: deleteAiLaunchProfile,
    });

    const {
        refreshMachineData,
        recentMachines,
        favoriteMachineItems,
        recentPaths,
    } = useNewSessionMachineRefreshState({
        capabilityServerId,
        selectedMachineId,
        machines,
        recentMachinePaths: targetRecentMachinePaths,
        sessions: targetSessions,
        favoriteMachines,
        useEnhancedSessionWizard,
        refreshMachineEnvPresence,
    });

    /**
     * The one commit for "this exact Machine is the authoring target", with
     * optional Pool provenance. The default working directory is not supplied
     * here: the path owner decides whether this is a qualified target change and
     * therefore whether the authored folder may be reconciled at all.
     */
    const commitExactMachineTarget = React.useCallback((target: Readonly<{
        serverId: string | null;
        machineId: string;
        poolId?: string;
    }>) => {
        if (!target.serverId) return;
        if (target.serverId === targetServerId) {
            setSelectedMachineTarget({
                machineId: target.machineId,
                selectionOrigin: target.poolId ? { kind: 'machine_pool', poolId: target.poolId } : null,
            });
        }
        router.setParams({
            machineId: target.machineId,
            machinePoolId: target.poolId,
            spawnServerId: target.serverId,
            directory: undefined,
            path: undefined,
        });
    }, [router, setSelectedMachineTarget, targetServerId]);
    const selectMachineTarget = React.useCallback((machine: Machine, serverId: string | null) => {
        commitExactMachineTarget({ serverId, machineId: machine.id });
    }, [commitExactMachineTarget]);
    const selectTemporaryComputer = React.useCallback((
        artifactTarget: Extract<NonNullable<typeof executionTarget>, { kind: 'temporary_computer' }>['artifactTarget'],
        workspace: Extract<NonNullable<typeof executionTarget>, { kind: 'temporary_computer' }>['workspace'],
        packageExpiresAt?: number,
    ) => {
        if (!targetServerId) return;
        setTemporaryComputerTarget({
            serverId: targetServerId,
            artifactTarget,
            workspace,
            // Omitted is Never, the product default; only an explicit author
            // choice writes an absolute instant.
            ...(packageExpiresAt !== undefined ? { packageExpiresAt } : {}),
        });
        router.setParams({ machineId: undefined, machinePoolId: undefined, spawnServerId: targetServerId });
    }, [router, setTemporaryComputerTarget, targetServerId]);
    // Recovery beside a failed or empty Pool row calls straight into the existing owners: the
    // canonical Pool projection refresh and the existing Machine Pool settings route.
    const onRefreshMachinePools = React.useCallback((serverId: string) => {
        fireAndForget(
            invalidateMachinePoolProjection(serverId, { forceFeatures: true }),
            { tag: 'NewSessionScreen.refreshMachinePools' },
        );
    }, []);
    const onOpenMachinePoolSettings = React.useCallback((target: Readonly<{ serverId: string; poolId: string }>) => {
        router.push(`/(app)/settings/machines/pools/${encodeURIComponent(target.poolId)}?serverId=${encodeURIComponent(target.serverId)}`);
    }, [router]);
    const selectMachinePoolTarget = React.useCallback((target: Readonly<{
        serverId: string;
        poolId: string;
        machineId: string;
    }>) => {
        commitExactMachineTarget(target);
    }, [commitExactMachineTarget]);
    const toggleFavoriteMachine = React.useCallback((machine: Machine) => {
        setFavoriteMachines(favoriteMachines.includes(machine.id)
            ? favoriteMachines.filter((id) => id !== machine.id)
            : [...favoriteMachines, machine.id]);
    }, [favoriteMachines, setFavoriteMachines]);
    const clearProfileRouteParam = React.useCallback(() => {
        const setParams = (navigation as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams({ profileId: undefined });
            return;
        }
        navigation.dispatch({
            type: 'SET_PARAMS',
            payload: { params: { profileId: undefined } },
        } as never);
    }, [navigation]);

    const clearBackendTargetRouteParamsAfterExplicitSelection = React.useCallback(() => {
        const paramsToClear = {
            agentType: undefined,
            backendTarget: undefined,
            backendTargetKey: undefined,
        };
        if (
            typeof agentTypeParam !== 'string'
            && typeof backendTargetParam !== 'string'
            && typeof backendTargetKeyParam !== 'string'
        ) {
            return;
        }
        const setParams = (navigation as any)?.setParams ?? (router as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams(paramsToClear);
            return;
        }
        const dispatch = (navigation as any)?.dispatch;
        if (typeof dispatch !== 'function') return;
        dispatch({
            type: 'SET_PARAMS',
            payload: { params: paramsToClear },
        } as never);
    }, [agentTypeParam, backendTargetKeyParam, backendTargetParam, navigation, router]);

    const canSelectProfile = React.useCallback((profileId: string): boolean => {
        const profile = profileMap.get(profileId);
        if (!profile) {
            return false;
        }
        if (!isProfileEnabled(profile, profileEnabledById)) {
            return false;
        }
        // Keep profiles selectable when they still have structural backend support,
        // even if all compatible backends are currently logged out or undiscovered.
        return getCompatibleProfileBackendEntries(profile).length > 0;
    }, [getCompatibleProfileBackendEntries, profileEnabledById, profileMap]);

    const {
        profilesGroupTitles,
        getProfileDisabled,
        getProfileSubtitleExtra,
        onPressProfile,
    } = useNewSessionProfileSelectionPresentation({
        useProfiles,
        profileIdParam,
        selectedProfileId,
        setSelectedProfileId,
        selectProfile,
        canSelectProfile,
        profileAvailabilityById,
        clearProfileRouteParam,
    });

    const {
        agentPickerOptions,
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
        handleAgentClick,
    } = useNewSessionAgentSelectionModelModeReconciliation({
        agentType: agentPolicyType,
        preflightModels,
        preflightModelsTargetKey,
        useProfiles,
        selectedProfileId,
        profileMap,
        resolvedBackendEntries,
        getCompatibleProfileBackendEntries,
        isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason,
        selectedBackendEntry,
        getBackendEntryMachineAgent: (entry) => machineAgentsById[entry.agentId] ?? null,
        selectedMachineName: getMachineDisplayName(selectedMachine),
        selectedBackendTargetKey,
        setBackendTarget,
        modelMode,
        modelSelection,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setEngineSelectionForBackendTarget,
        selectedMachineId,
        capabilityServerId,
        projectionCurrent,
        selectedPath,
        settings,
        favoriteModelSelections,
        setFavoriteModelSelections,
        favoriteBackendTargetKeys,
        setFavoriteBackendTargetKeys,
        rememberedAgentPickerView: lastNewSessionAgentPickerView,
        onRememberAgentPickerView: setLastNewSessionAgentPickerView,
        rememberEngineSelectionsEnabled: rememberLastEngineSelections,
        rememberedEngineSelectionsByScope: lastEngineSelectionsByScope,
        rememberedEngineSelectionServerId: capabilityServerId,
        onRememberEngineSelection: rememberEngineSelection,
        onExplicitBackendTargetSelection: clearBackendTargetRouteParamsAfterExplicitSelection,
        refreshProbe: cliAvailabilityProbe ?? null,
        providerProjection: providerModelProjection,
        experimentalConfirmation: confirmExperimentalProviderModel,
    });

    const {
        authoringContext: newSessionAuthoringContext,
        currentAuthoringDraft,
        buildCurrentAuthoringDraft,
        effectiveAutomationDraft,
        canCreate: canCreateFromAuthoring,
        buildCurrentPersistedDraft,
        persistDraftIfEnabled,
        persistCurrentDraftAndPause,
        pauseDraftPersistence,
        resumeDraftPersistence,
        disableDraftPersistence,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
    } = useNewSessionScreenAuthoringState({
        zenTaskSource: persistedDraft?.zenTaskSource,
        automationDraft,
        automationFeatureEnabled,
        initialTriggers,
        hostBoundMachineId,
        selectedMachineId,
        targetServerId,
        executionTarget,
        temporaryComputerActivationRef: temporaryComputerTargetScope !== null
            ? targetScopedDraft?.temporaryComputerActivationRef
            : hydratedTempAuthoringDraft?.temporaryComputerActivationRef !== undefined
            ? hydratedTempAuthoringDraft.temporaryComputerActivationRef
            : hydratedPersistedAuthoringDraft?.temporaryComputerActivationRef,
        organizationPlacement: organizationPlacementState.placement,
        access: accessDraftState.access,
        primaryTeamId: accessDraftState.primaryTeamId,
        teamCredentialBindings,
        selectedMachine,
        selectedMachineSpawnReadiness,
        selectedPath: rememberedPath,
        directoryKind,
        checkoutCreationDraft,
        promptStore,
        staticAgentId,
        backendTarget: operationalBackendTarget,
        agentTarget: canonicalAgentTarget,
        transcriptStorage,
        useProfiles,
        selectedProfileId,
        resumeSessionId,
        permissionMode,
        modelSelection,
        mcpSelection,
        agentNewSessionOptions,
        settings,
        effectiveWindowsRemoteSessionLaunchMode,
        windowsRemoteSessionLaunchModeOverride: selectedMachineId && windowsRemoteSessionLaunchModeOverride
            ? {
                machineId: selectedMachineId,
                mode: windowsRemoteSessionLaunchModeOverride,
            }
            : null,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        automationRequestedByRoute,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        backendNewSessionOptionStateByTargetKey,
        composerAttachments: newSessionComposerDocument.attachments,
        placementCandidates: seededPlacementCandidates,
        draftScope,
        draftId,
        launchUserAttemptId,
    });
    const selectSeededPlacement = React.useCallback((candidate: PluginUiSessionPlacementCandidateV1) => {
        try {
            router.setParams({
                spawnServerId: candidate.serverId,
                machineId: candidate.machineId,
                directory: candidate.rootPath,
            });
        } catch {
            return;
        }
        setSeededPlacementCandidates([]);
        // The unresolved choices belong to this draft. Clear them durably so
        // a remount or route detour cannot resurrect a choice already made.
        persistDraftIfEnabled({
            ...buildCurrentPersistedDraft(),
            targetServerId: candidate.serverId,
            selectedMachineId: candidate.machineId,
            selectedPath: candidate.rootPath,
            executionTarget: {
                kind: 'machine',
                target: {
                    serverId: candidate.serverId,
                    machineId: candidate.machineId,
                },
            },
            placementCandidates: [],
        });
    }, [buildCurrentPersistedDraft, persistDraftIfEnabled, router]);
    const seededPlacementActionChip = React.useMemo(() => (
        createNewSessionSeededPlacementActionChip({
            candidates: seededPlacementCandidates,
            onSelect: selectSeededPlacement,
        })
    ), [seededPlacementCandidates, selectSeededPlacement]);
    const effectiveCurrentAuthoringDraft = currentAuthoringDraft;
    const temporaryComputerLaunchBlock = React.useMemo(() => {
        // Same "is the Agent side even present" owner the picker uses; only the
        // creator producer differs, because this surface holds the exact model
        // selection a launch needs and the picker does not.
        const ready = resolveTemporaryComputerAgentCompatibility({
            catalogEntryPresent: selectedBackendEntry !== null,
            canonicalAgentTargetPresent: canonicalAgentTarget !== null,
            creatorReadinessProducerPresent: canonicalAgentTarget !== null
                && temporaryComputerCreator.isLaunchReady({
                    backendTargetKey: selectedBackendTargetKey,
                    agentTarget: canonicalAgentTarget,
                }),
        });
        return resolveTemporaryComputerLaunchBlock({
            ready,
            authoring: effectiveCurrentAuthoringDraft,
            selectedAgentProviderOwnedEnvironmentKeys,
            // A substituted producer publishes no gap vocabulary; an unexplained
            // "not ready" still blocks rather than opening the launch path.
            gaps: temporaryComputerCreator === composedTemporaryComputerCreator.dependencies
                ? composedTemporaryComputerCreator.readGaps()
                : [],
        });
    }, [
        canonicalAgentTarget,
        composedTemporaryComputerCreator,
        effectiveCurrentAuthoringDraft,
        selectedBackendEntry,
        selectedBackendTargetKey,
        selectedAgentProviderOwnedEnvironmentKeys,
        temporaryComputerCreator,
    ]);
    const selectedServerId = targetServerId;
    const selectNoFolder = React.useCallback(() => {
        setDirectoryIntent({ kind: 'managed' });
        announceAccessibilityMessage(t('newSession.folder.a11y.removed'));
    }, [setDirectoryIntent]);
    // No folder is a machine target's choice; a Temporary computer's endpoint chooses its folder.
    const offersNoFolder = executionTarget?.kind === 'machine' && !directoryIntentFixed;
    const { pathPopover: composerPathPopover, machinePopover, resumePopover } = useNewSessionInputPopovers({
        selectedMachine,
        selectedMachineId,
        selectedPath,
        setSelectedPath,
        setDraftSelectedPath,
        noFolderSelected: directoryKind === 'managed',
        onSelectNoFolder: offersNoFolder ? selectNoFolder : undefined,
        recentPaths,
        usePathPickerSearch,
        pathPickerSearchQuery,
        setPathPickerSearchQuery,
        favoriteDirectories,
        setFavoriteDirectories,
        machineGroups: serverScopedMachineGroups,
        selectedServerId,
        recentMachines,
        favoriteMachineItems,
        selectMachineTarget,
        toggleFavoriteMachine,
        useMachinePickerSearch,
        machinePoolGroups,
        machinePoolRequestKey: draftId,
        selectMachinePoolTarget,
        onRefreshMachines: refreshMachineData,
        onRefreshMachinePools,
        onOpenMachinePoolSettings,
        executionTarget,
        temporaryComputerAvailability,
        temporaryComputerLaunchBlock,
        selectTemporaryComputer,
        targetServerId,
        externalSessionsFeatureEnabled,
        resumeSessionId,
        setResumeSessionId,
        agentType: selectedUiAgentType,
        agentLabel,
        agentOptionState,
        settings,
        pluginProjectionV2: currentProjectionInputs?.pluginProjectionV2 ?? null,
    });
    // New Session's Automation entry transfers the composed draft to the one
    // workflow editor instead of embedding a second settings surface.
    // The source draft is not cleared: Back or cancel returns to it intact.
    const openAutomationEditor = React.useCallback((automation: NewSessionAutomationDraft) => {
        // Read the live composer and rebuild the draft here, not from the last
        // render: the model does not rerender per keystroke, so a chip press
        // straight after typing would otherwise transfer older text and the
        // destination could save or run a prompt nobody saw. The snapshot goes
        // over whole — ranges, staged bytes, caret — for the destination's
        // composer custody; the handoff derives the portable draft from it.
        const composerSnapshot = newSessionComposerDocument.readCurrentDocumentSnapshot();
        const seedId = storeNewSessionAutomationHandoffSeed(buildNewSessionAutomationHandoffSeed({
            draftId: `workflow-new-session-${randomUUID()}`,
            authoring: buildCurrentAuthoringDraft(automation),
            automation,
            ...(composerSnapshot === null ? {} : { composer: composerSnapshot }),
        }));
        // "Make this prompt a workflow…" (04 §5.5): the neutral editor reviews the composed prompt;
        // its triggers are added in Runs automatically and written through `workflow.trigger.*`.
        navigateWithBlurOnWeb(() => router.push({
            pathname: '/workflows/new',
            params: { newSessionDraftSeedId: seedId },
        } as never));
    }, [buildCurrentAuthoringDraft, newSessionComposerDocument, router]);
    openAutomationEditorRef.current = openAutomationEditor;
    const openAutomationEditorWithComposedDraft = React.useCallback(() => {
        openAutomationEditor(effectiveAutomationDraft);
    }, [effectiveAutomationDraft, openAutomationEditor]);
    const onLaunchUserAttemptIdChange = React.useCallback((nextUserAttemptId: string | null) => {
        const normalized = typeof nextUserAttemptId === 'string' && nextUserAttemptId.trim().length > 0
            ? nextUserAttemptId.trim()
            : null;
        setLaunchUserAttemptId(normalized);
        const currentDraft = buildCurrentPersistedDraft();
        if (normalized) {
            persistDraftIfEnabled({ ...currentDraft, launchUserAttemptId: normalized });
            return;
        }
        const nextDraft = { ...currentDraft };
        delete nextDraft.launchUserAttemptId;
        persistDraftIfEnabled(nextDraft);
    }, [buildCurrentPersistedDraft, persistDraftIfEnabled]);
    actionOperationReconciliationCallbacksRef.current = {
        disableDraftPersistence,
        resetLaunchRequestId: onLaunchUserAttemptIdChange,
    };
    const launchIntentSignature = React.useMemo(() => JSON.stringify({
        draft: effectiveCurrentAuthoringDraft,
        composerDocumentRevision: newSessionComposerDocument.revision,
        machineId: selectedMachineId,
        sourceContext: sourceContextState.sourceContext,
        selectedSecretReferences: selectedSecretIdByProfileIdByEnvVarName,
        targetServerId: targetServerId ?? null,
    }), [
        effectiveCurrentAuthoringDraft,
        newSessionComposerDocument.revision,
        selectedMachineId,
        sourceContextState.sourceContext,
        selectedSecretIdByProfileIdByEnvVarName,
        targetServerId,
    ]);
    const previousLaunchIntentSignatureRef = React.useRef(launchIntentSignature);
    React.useEffect(() => {
        if (previousLaunchIntentSignatureRef.current === launchIntentSignature) return;
        previousLaunchIntentSignatureRef.current = launchIntentSignature;
        if (launchUserAttemptId) onLaunchUserAttemptIdChange(null);
    }, [launchIntentSignature, launchUserAttemptId, onLaunchUserAttemptIdChange]);
    const spawnBackendTarget = operationalBackendTarget;
    const existingTemporaryComputerActivationRef = temporaryComputerTargetScope !== null
        ? targetScopedDraft?.temporaryComputerActivationRef ?? null
        : hydratedTempAuthoringDraft?.temporaryComputerActivationRef !== undefined
        ? hydratedTempAuthoringDraft.temporaryComputerActivationRef
        : hydratedPersistedAuthoringDraft?.temporaryComputerActivationRef ?? null;

    type TemporarySubmission = NonNullable<HandleCreateSessionOptions['temporaryComputerSubmission']>;
    const [authorizeTemporaryComputerTeamAccess, setAuthorizeTemporaryComputerTeamAccess] = React.useState(false);
    const temporaryComputerTeamAccessForActivationRef = React.useRef(false);
    React.useEffect(() => {
        if (effectiveCurrentAuthoringDraft.executionTarget?.kind !== 'temporary_computer'
            || existingTemporaryComputerActivationRef !== null) {
            setAuthorizeTemporaryComputerTeamAccess(false);
        }
    }, [effectiveCurrentAuthoringDraft.executionTarget?.kind, existingTemporaryComputerActivationRef]);
    type TemporaryLocalLaunch = Readonly<{
        key: Awaited<ReturnType<typeof openRunnerActivationKeyCustody>>;
        staged: StagedRunnerAttachments | null;
        acquired: Awaited<ReturnType<typeof acquireRunnerArtifact>>;
        preparedAuthoring: Awaited<ReturnType<typeof prepareTemporaryComputerActivation>>['preparedAuthoring'] | null;
        submission: TemporarySubmission | null;
    }>;
    const temporarySubmissionRef = React.useRef<TemporarySubmission | null>(null);
    const temporaryLocalLaunchRef = React.useRef<TemporaryLocalLaunch | null>(null);
    const temporaryCreatorSettlementRef = React.useRef<TemporaryComputerCreatorSettlement | null>(null);
    const temporaryMaterializationSettlementRef = React.useRef<Readonly<{
        activationId: string;
        sessionId: string;
        run: () => Promise<void>;
    }> | null>(null);
    const temporaryPresentationAccountLifetimeRef = React.useRef<typeof accountLifetime>(null);
    if (existingTemporaryComputerActivationRef && temporaryPresentationAccountLifetimeRef.current === null) {
        temporaryPresentationAccountLifetimeRef.current = accountLifetime;
    }
    const temporaryComputerLaunchControlRef = React.useRef<TemporaryComputerLaunchController | null>(null);
    const [temporaryComputerLaunchActive, setTemporaryComputerLaunchActive] = React.useState(false);
    const prepareTemporaryComputerLaunchDraft = React.useCallback(async (input: Readonly<{
        sourceScope: NonNullable<typeof draftScope>;
        targetScope: NonNullable<typeof temporaryComputerTargetScope>;
        draftId: string;
    }>) => {
        // Flush the complete live authoring draft before freezing autosave. The
        // canonical cross-Home mover must read this value, not the last value
        // whose debounce happened to finish before Send.
        persistCurrentDraftAndPause(input.sourceScope);
        let resumableScope = input.sourceScope;
        let context: Awaited<ReturnType<typeof captureActionAccountContext>> | null = null;
        try {
            if (areServerAccountScopesEqual(input.sourceScope, input.targetScope)) {
                router.setParams({
                    draftServerId: input.targetScope.serverId,
                    draftAccountId: input.targetScope.accountId,
                });
                return;
            }
            context = await captureActionAccountContext(input.targetScope.serverId);
            context.assertCurrent();
            if (context.accountId !== input.targetScope.accountId) throw new Error('runner_creator_scope_mismatch');
            const result = await moveNewSessionDraftToScope({
                sourceScope: input.sourceScope,
                targetScope: input.targetScope,
                draftId: input.draftId,
                target: {
                    transport: createApiSessionDraftsTransport({ request: context.request }),
                    cipher: createSessionDraftCipher({
                        accountMode: context.accountMode,
                        accountCryptoMaterial: context.accountMode === 'e2ee'
                            ? resolveAccountScopedCryptoMaterialFromCredentials(context.credentials)
                            : null,
                        getSessionContext: () => null,
                        randomBytes: getRandomBytes,
                    }),
                },
            });
            if (result.status === 'moved' || result.status === 'already_moved') {
                resumableScope = input.targetScope;
                pauseDraftPersistence(input.targetScope);
            }
            context.assertCurrent();
            if (result.status !== 'moved' && result.status !== 'already_moved') {
                throw new Error(`runner_creator_draft_move_${result.status}`);
            }
            router.setParams({
                spawnServerId: input.targetScope.serverId,
                draftServerId: input.targetScope.serverId,
                draftAccountId: input.targetScope.accountId,
            });
        } catch (error) {
            resumeDraftPersistence(resumableScope);
            throw error;
        } finally {
            context?.dispose();
        }
    }, [pauseDraftPersistence, persistCurrentDraftAndPause, resumeDraftPersistence, router]);
    const selectedTemporaryArtifact = React.useMemo(() => {
        const executionTarget = effectiveCurrentAuthoringDraft.executionTarget;
        if (executionTarget?.kind !== 'temporary_computer' || temporaryComputerAvailability.status !== 'available') {
            return null;
        }
        return temporaryComputerAvailability.artifacts.find(
            (candidate) => candidate.identity.target === executionTarget.artifactTarget,
        ) ?? null;
    }, [effectiveCurrentAuthoringDraft.executionTarget, temporaryComputerAvailability]);
    const persistTemporaryComputerActivationRef = React.useCallback((reference: NonNullable<NewSessionDraft['temporaryComputerActivationRef']>) => {
        if (!temporaryComputerTargetScope) return;
        writeTemporaryComputerActivationRefToRepository({
            scope: temporaryComputerTargetScope,
            draftId,
            activationRef: reference,
        });
    }, [draftId, temporaryComputerTargetScope]);
    const clearTemporaryComputerActivationRef = React.useCallback((activationId: string): boolean => {
        if (!temporaryComputerTargetScope) return false;
        const current = readNewSessionDraftFromRepository({ scope: temporaryComputerTargetScope, draftId });
        if (current?.temporaryComputerActivationRef?.activationId !== activationId) {
            return current?.temporaryComputerActivationRef == null;
        }
        writeTemporaryComputerActivationRefToRepository({
            scope: temporaryComputerTargetScope,
            draftId,
            activationRef: null,
        });
        return readNewSessionDraftFromRepository({ scope: temporaryComputerTargetScope, draftId })
            ?.temporaryComputerActivationRef?.activationId !== activationId;
    }, [draftId, temporaryComputerTargetScope]);
    const discardTemporaryLocalLaunch = React.useCallback(async (activationId: string) => {
        const local = temporaryLocalLaunchRef.current;
        const matchingLocal = local?.key.activationId === activationId ? local : null;
        const cleanupResults = await Promise.allSettled([
            matchingLocal?.acquired.cleanup() ?? Promise.resolve(),
            temporaryComputerTargetScope
                ? removeRunnerCreatorCustodyForActivation(temporaryComputerTargetScope, activationId)
                : matchingLocal?.staged?.cleanup() ?? Promise.resolve(),
        ]);
        const cleanupFailure = cleanupResults.find((result) => result.status === 'rejected');
        if (cleanupFailure?.status === 'rejected') throw cleanupFailure.reason;
        if (matchingLocal) temporaryLocalLaunchRef.current = null;
    }, [temporaryComputerTargetScope]);
    const prepareTemporaryActivation = React.useCallback(async (signal: AbortSignal) => {
        const submission = temporarySubmissionRef.current;
        const availability = temporaryComputerAvailability;
        const profile = targetServerProfile;
        if (!submission || !temporaryComputerTargetScope || !profile?.homeConnectionDescriptor || availability.status !== 'available' || !selectedTemporaryArtifact) {
            throw new Error('runner_activation_creator_unavailable');
        }
        if (!canonicalAgentTarget || !temporaryComputerCreator.isLaunchReady({
            backendTargetKey: selectedBackendTargetKey,
            agentTarget: canonicalAgentTarget,
        })) {
            throw new Error('team_credential_model_unselected');
        }
        // The exact Team model this readiness check just admitted is part of
        // the immutable submission (lane 13.04 §8 step 2).
        const submittedTeamCredentialModel = selectedTeamCredentialModel;
        const settlement = temporaryCreatorSettlementRef.current;
        if (!settlement) throw new Error('runner_creator_attachment_custody_unavailable');
        signal.throwIfAborted();
        // Allocate and verify the one activation-local identity before any
        // durable attachment bytes exist. The same Account index then owns
        // partial-stage recovery after a process interruption.
        // A preparation failure can happen before the public draft reference is
        // written. Recover its exact durable draft-scoped custody before minting
        // another activation identity; cleanup failure remains visible/retryable.
        const custody = await recoverAndCreateRunnerActivationKeyCustodyForDraft(
            temporaryComputerTargetScope,
            draftId,
        );
        let staged: StagedRunnerAttachments | null = null;
        let acquired: Awaited<ReturnType<typeof acquireRunnerArtifact>> | null = null;
        try {
            await beginRunnerCreatorAttachmentStagingCustody({
                scope: temporaryComputerTargetScope,
                activationId: custody.activationId,
                attachmentMessageLocalId: settlement.attachmentMessageLocalId,
                firstTurnLocalId: settlement.firstTurnLocalId,
                maxFileBytes: submission.maxFileBytes,
            });
            staged = await stageRunnerAttachments(submission.attachmentDrafts, {
                maxFileBytes: submission.maxFileBytes,
                onCustodyAcquired: (custodyFile) => recordRunnerCreatorStagingCustodyHandle({
                    scope: temporaryComputerTargetScope,
                    activationId: custody.activationId,
                    custodyFile,
                }),
                onStagedAttachment: ({ reviewedFile, custodyFile }) => recordRunnerCreatorStagedAttachmentCustody({
                    scope: temporaryComputerTargetScope,
                    activationId: custody.activationId,
                    reviewedFile,
                    custodyFile,
                }),
            }, signal);
            signal.throwIfAborted();
            acquired = await acquireRunnerArtifact({ artifact: selectedTemporaryArtifact, signal });
            const context = await captureActionAccountContext(temporaryComputerTargetScope.serverId, signal);
            let prepared: Awaited<ReturnType<typeof prepareTemporaryComputerActivation>>;
            try {
                if (context.accountId !== temporaryComputerTargetScope.accountId) {
                    throw new RunnerCreatorRecipientAuthorityError('runner_creator_scope_mismatch');
                }
                const exactAccountSettings = await context.readSettings();
                // Every reviewed secret below belongs to the exact target
                // Account, not to whichever Account is currently in focus.
                const readReviewedSecret = await createRunnerCreatorSecretReader({
                    credentials: context.credentials,
                    scope: temporaryComputerTargetScope,
                });
                context.assertCurrent();
                let reviewedAuthoring = effectiveCurrentAuthoringDraft;
                const reviewedProfileId = reviewedAuthoring.profileId?.trim() ?? '';
                if (reviewedProfileId) {
                    const currentProfiles = (await context.readLaunchProfiles(exactAccountSettings?.profiles)).map(projectAiLaunchProfileForLegacyUi);
                    const currentProfile = currentProfiles.find((candidate) => candidate.id === reviewedProfileId)
                        ?? getBuiltInProfile(reviewedProfileId);
                    assertLaunchProfileReviewCurrent(selectedProfile, currentProfile);
                    const currentSecretBindings = projectCurrentSecretBindingsByProfileId(exactAccountSettings ?? {}, currentProfiles);
                    const sharedSecrets = getMaterializedSavedSecrets(temporaryComputerTargetScope);
                    const personalSecrets = exactAccountSettings?.secrets ?? [];
                    const launchSecrets = sharedSecrets.length === 0
                        ? personalSecrets
                        : [...personalSecrets, ...sharedSecrets];
                    const materializedProfile = materializeLaunchProfileEnvironment({
                        profile: currentProfile,
                        selectedAgentProviderOwnedEnvironmentKeys,
                        secrets: launchSecrets,
                        defaultBindings: currentSecretBindings[reviewedProfileId] ?? null,
                        selectedSecretIds: selectedSecretIdByProfileIdByEnvVarName[reviewedProfileId] ?? {},
                        sessionOnlyValues: sessionOnlySecretValueByProfileIdByEnvVarName[reviewedProfileId] ?? {},
                        // Temporary computer has no pre-existing Machine environment.
                        machineEnvReadyByName: Object.fromEntries(
                            (currentProfile.envVarRequirements ?? []).map((requirement) => [requirement.name, false]),
                        ),
                        decryptSecretValue: readReviewedSecret,
                    });
                    if (!materializedProfile.ok) {
                        throw new LaunchProfileEnvironmentUnavailableError(materializedProfile.reason);
                    }
                    reviewedAuthoring = {
                        ...reviewedAuthoring,
                        environmentVariables: materializedProfile.environmentVariables,
                    };
                }
                context.assertCurrent();
                const materializedMcpSecrets = [
                    ...(exactAccountSettings?.secrets ?? []),
                    ...getMaterializedSavedSecrets(temporaryComputerTargetScope),
                ];
                const mcpMaterial = prepareRunnerMcpMaterial({
                    settingsLike: exactAccountSettings?.mcpServersSettingsV1,
                    selection: reviewedAuthoring.mcpSelection,
                    secrets: materializedMcpSecrets,
                    decryptSecretValue: readReviewedSecret,
                });
                context.assertCurrent();
                // The reviewed Agent's exact distribution is resolved here, from
                // the same machine catalog the Agent was chosen in, so the sealed
                // submission commits to bytes the endpoint can acquire. A bundled
                // Agent resolves to null: the Runner artifact already carries it.
                const agentPluginDistribution = await temporaryComputerCreator
                    .resolveAgentPluginDistribution({ agentTarget: canonicalAgentTarget, signal });
                context.assertCurrent();
                prepared = await prepareTemporaryComputerActivation({
                    client: availability.client,
                    custody,
                    scope: temporaryComputerTargetScope,
                    credentials: context.credentials,
                    encryption: context.encryption,
                    draftId,
                    homeServerIdentityId: profile.homeConnectionDescriptor.homeServerIdentityId,
                    artifact: selectedTemporaryArtifact,
                    authoring: SessionAuthoringValueV1Schema.parse(reviewedAuthoring),
                    composer: submission.composer,
                    reviewComments: RunnerPreparedAuthoringV1Schema.shape.reviewComments.parse(submission.reviewComments),
                    files: staged.reviewedFiles,
                    attachmentDestination: submission.attachmentDestination,
                    actionsSettings: normalizeActionsSettingsV1(exactAccountSettings?.actionsSettingsV1),
                    mcpMaterial,
                    selectedAgentProviderOwnedEnvironmentKeys,
                    agentPluginDistribution,
                    authorizeUnattendedTeamAccess: temporaryComputerTeamAccessForActivationRef.current,
                    signal,
                });
            } finally {
                context.dispose();
            }
            await writePreparedRunnerCreatorLaunchCustody({
                scope: temporaryComputerTargetScope,
                activationId: prepared.custody.activationId,
                preparedAuthoring: prepared.preparedAuthoring,
                // Frozen with the package: review binds exactly this choice.
                submittedTeamCredentialModel: submittedTeamCredentialModel,
                attachmentUpload: {
                    attachmentMessageLocalId: settlement.attachmentMessageLocalId,
                    firstTurnLocalId: settlement.firstTurnLocalId,
                    maxFileBytes: submission.maxFileBytes,
                    files: staged.custodyFiles,
                },
            });
            const local = {
                key: prepared.custody,
                staged,
                acquired,
                preparedAuthoring: prepared.preparedAuthoring,
                submission,
            } as const;
            temporaryLocalLaunchRef.current = local;
            return {
                request: prepared.request,
                acceptCreated: (projection: RunnerActivationProjectionV1) => acceptRunnerCreatorActivationBinding(temporaryComputerTargetScope, projection),
                createdOnDeviceLabel: resolveLocalDeviceLabel({
                    deviceName: Constants.deviceName,
                    platform: Platform.OS,
                }) ?? t('sessionDrafts.conflict.mine'),
                discard: async () => {
                    const cleanupResults = await Promise.allSettled([
                        acquired?.cleanup() ?? Promise.resolve(),
                        removeRunnerCreatorCustodyForActivation(temporaryComputerTargetScope, prepared.custody.activationId),
                    ]);
                    const cleanupFailure = cleanupResults.find((result) => result.status === 'rejected');
                    if (cleanupFailure?.status === 'rejected') throw cleanupFailure.reason;
                    if (temporaryLocalLaunchRef.current?.key.activationId === prepared.custody.activationId) {
                        temporaryLocalLaunchRef.current = null;
                    }
                },
            };
        } catch (error) {
            await removeRunnerCreatorCustodyForActivation(
                temporaryComputerTargetScope,
                custody.activationId,
            ).catch(() => undefined);
            await acquired?.cleanup().catch(() => undefined);
            throw error;
        }
    }, [
        canonicalAgentTarget,
        draftId,
        effectiveCurrentAuthoringDraft,
        selectedBackendTargetKey,
        selectedAgentProviderOwnedEnvironmentKeys,
        selectedProfile,
        selectedSecretIdByProfileIdByEnvVarName,
        selectedTeamCredentialModel,
        selectedTemporaryArtifact,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        targetServerProfile,
        temporaryComputerAvailability,
        temporaryComputerCreator,
        temporaryComputerTargetScope,
    ]);
    const onTemporaryComputerMaterialized = React.useCallback(async (
        sessionId: string,
        materializedProjection: RunnerActivationProjectionV1,
    ) => {
        const settlement = temporaryCreatorSettlementRef.current;
        if (!temporaryComputerTargetScope) {
            throw new Error('runner_creator_materialization_custody_unavailable');
        }
        const activationId = materializedProjection.activationId;
        if (materializedProjection.state !== 'materialized'
            || materializedProjection.materialization?.sessionId !== sessionId) {
            throw new Error('runner_activation_binding_mismatch');
        }
        const presentMaterializedSession = settlement
            ? () => settlement.present(sessionId)
            : async () => {
                const result = await presentCreatedNewSession({
                    sessionId,
                    serverId: temporaryComputerTargetScope.serverId,
                    accountId: temporaryComputerTargetScope.accountId,
                    requestId: launchUserAttemptId ?? activationId,
                    router,
                    isStillActive: () => temporaryPresentationAccountLifetimeRef.current?.isCurrent() === true
                        && temporaryMaterializationSettlementRef.current?.activationId === activationId,
                });
                if (result !== 'opened') throw new Error(`created_new_session_presentation_${result}`);
            };
        const existingSettlement = temporaryMaterializationSettlementRef.current;
        if (existingSettlement) {
            if (existingSettlement.activationId !== activationId || existingSettlement.sessionId !== sessionId) {
                throw new Error('runner_creator_materialized_session_changed');
            }
            await presentMaterializedTemporaryComputerSessionAndContinueSettlement({
                present: presentMaterializedSession,
                settle: existingSettlement.run,
            });
            return;
        }
        const runSettlement = () => settlePersistedMaterializedTemporaryComputerSession({
            scope: temporaryComputerTargetScope,
            draftScope: temporaryComputerTargetScope,
            draftId,
            activationId,
            launchUserAttemptId,
            sessionId,
            projection: materializedProjection,
            present: async () => undefined,
            ...(settlement ? { complete: (uploaded) => settlement.complete(sessionId, uploaded) } : {}),
            beforeCleanup: async () => {
                temporaryCreatorSettlementRef.current = null;
                const matchingLocal = temporaryLocalLaunchRef.current?.key.activationId === activationId
                    ? temporaryLocalLaunchRef.current
                    : null;
                if (matchingLocal) temporaryLocalLaunchRef.current = null;
                await matchingLocal?.acquired.cleanup().catch(() => undefined);
            },
        });
        temporaryMaterializationSettlementRef.current = { activationId, sessionId, run: runSettlement };
        await presentMaterializedTemporaryComputerSessionAndContinueSettlement({
            present: presentMaterializedSession,
            settle: runSettlement,
        });
    }, [draftId, launchUserAttemptId, router, temporaryComputerTargetScope]);
    const onTemporaryComputerClosed = React.useCallback(async (closed: Readonly<{ activationId: string }>) => {
        temporaryCreatorSettlementRef.current?.reject();
        temporaryCreatorSettlementRef.current = null;
        if (temporaryMaterializationSettlementRef.current?.activationId === closed.activationId) {
            temporaryMaterializationSettlementRef.current = null;
        }
        await discardTemporaryLocalLaunch(closed.activationId);
        if (!clearTemporaryComputerActivationRef(closed.activationId) || !temporaryComputerTargetScope) {
            throw new Error('runner_creator_activation_reference_cleanup_failed');
        }
        resumeDraftPersistence(temporaryComputerTargetScope);
    }, [clearTemporaryComputerActivationRef, discardTemporaryLocalLaunch, resumeDraftPersistence, temporaryComputerTargetScope]);
    // Transport for an activation that already exists. New-launch eligibility —
    // the feature bit, artifact publication, Agent/broker intersection — decides
    // whether another launch may *start*; it must never make a live activation
    // unobservable or uncancelable, which would strand an open package.
    const temporaryComputerActivationTransport = React.useMemo(() => {
        if (!targetServerId || !targetServerProfile || !temporaryComputerTargetScope) return null;
        const activeRequest = createServerFetchAtEndpoint({
            endpointUrl: targetServerProfile.serverUrl,
            serverId: targetServerId,
        });
        return createRunnerActivationClient(createServerRequestForServerAccountScope({
            scope: temporaryComputerTargetScope,
            activeRequest,
        }));
    }, [targetServerId, targetServerProfile, temporaryComputerTargetScope]);
    /**
     * The one answer to "may this device act as the creator for this activation?".
     *
     * Creator custody is deliberately device-local and unsynchronized, so the
     * custody owner already decides it — by refusing to produce the prepared
     * authoring or the accepted binding. A device of the same Account that did
     * not create the package is an observer, not a failure: it inspects and
     * cancels, and the creator work is simply not available here. Translating
     * that one typed refusal into the controller's existing unavailable
     * vocabulary is what keeps a healthy launch from presenting as `failed` on
     * the second device.
     */
    const asCreatorUnavailable = React.useCallback(<T,>(
        dependency: 'review' | 'materialization',
        run: () => Promise<T>,
    ): Promise<T> => run().catch((error: unknown) => {
        if (error instanceof RunnerCreatorLaunchCustodyUnavailableError) {
            throw new TemporaryComputerLaunchDependencyUnavailableError(dependency);
        }
        throw error;
    }), []);
    const prepareTemporaryComputerReview = React.useCallback(
        async (projection: RunnerActivationProjectionV1, signal: AbortSignal): Promise<void> => {
            if (!temporaryComputerTargetScope || !temporaryComputerActivationTransport) {
                throw new TemporaryComputerLaunchDependencyUnavailableError('review');
            }
            const preparedAuthoring = await readPreparedRunnerCreatorLaunchCustody(temporaryComputerTargetScope, projection.activationId);
            const submittedTeamCredentialModel = await readSubmittedRunnerCreatorTeamCredentialModel(temporaryComputerTargetScope, projection.activationId);
            const expectedBinding = await readAcceptedRunnerCreatorActivationBinding(temporaryComputerTargetScope, projection.activationId, projection);
            const credentialSelection = await temporaryComputerCreator
                .resolveCredentialSelectionBinding({
                    projection,
                    preparedAuthoring,
                    submittedTeamCredentialModel,
                    client: temporaryComputerActivationTransport,
                    signal,
                });
            if (!credentialSelection) throw new TemporaryComputerLaunchDependencyUnavailableError('review');
            const context = await captureActionAccountContext(temporaryComputerTargetScope.serverId, signal);
            try {
                if (context.accountId !== temporaryComputerTargetScope.accountId) {
                    throw new TemporaryComputerLaunchDependencyUnavailableError('review');
                }
                const connectedServiceReviewBindings = await resolveRunnerConnectedServiceReviewBindingsV1({
                    bindings: preparedAuthoring.authoring.connectedServices ?? { v: 2, bindingsByServiceId: {} },
                    signal,
                });
                context.assertCurrent();
                await prepareAndStoreRunnerActivationReviewV1({
                    client: temporaryComputerActivationTransport,
                    projection,
                    expectedBinding,
                    preparedAuthoring,
                    credentialSelectionBinding: credentialSelection.binding,
                    reviewedProviderModel: credentialSelection.reviewedProviderModel,
                    displayFacts: credentialSelection.displayFacts,
                    credentials: context.credentials,
                    encryption: context.encryption,
                    connectedServiceReviewBindings,
                    readRetainedCustody: async () => {
                        try {
                            return await readReviewedRunnerCreatorLaunchCustody(
                                temporaryComputerTargetScope,
                                projection.activationId,
                            );
                        } catch {
                            return null;
                        }
                    },
                    // Retain the randomized sealed review before publication so a
                    // response-lost retry sends identical bytes and rejoins the
                    // server's exact idempotency identity.
                    retainPreparedCustody: async (custody) => await writeReviewedRunnerCreatorLaunchCustody({
                        scope: temporaryComputerTargetScope,
                        activationId: projection.activationId,
                        custody,
                    }),
                });
            } finally {
                context.dispose();
            }
        },
        [temporaryComputerActivationTransport, temporaryComputerCreator, temporaryComputerTargetScope],
    );
    const materializeTemporaryComputer = React.useCallback(
        async (projection: RunnerActivationProjectionV1) => {
            if (!temporaryComputerTargetScope || !temporaryComputerActivationTransport) {
                throw new TemporaryComputerLaunchDependencyUnavailableError('materialization');
            }
            const request = await getOrCreateRunnerMaterializationRequest({
                scope: temporaryComputerTargetScope,
                activationId: projection.activationId,
                projection,
                build: async (custody) => {
                    const materializationInput = await temporaryComputerCreator
                        .resolveMaterializationInput({ projection, custody });
                    if (!materializationInput) throw new TemporaryComputerLaunchDependencyUnavailableError('materialization');
                    const context = await captureActionAccountContext(temporaryComputerTargetScope.serverId);
                    try {
                        if (context.accountId !== temporaryComputerTargetScope.accountId) {
                            throw new TemporaryComputerLaunchDependencyUnavailableError('materialization');
                        }
                        context.assertCurrent();
                        return await buildRunnerMaterializationRequestV1({
                            projection,
                            custody,
                            credentials: context.credentials,
                            encryption: context.encryption,
                            requestRecipientEnvelopeProjection: async (accountId) => {
                                context.assertCurrent();
                                const response = await context.request(`/v1/user/${encodeURIComponent(accountId)}`);
                                context.assertCurrent();
                                return response;
                            },
                            ...materializationInput,
                        });
                    } finally {
                        context.dispose();
                    }
                },
            });
            return temporaryComputerActivationTransport.materialize(request);
        },
        [temporaryComputerActivationTransport, temporaryComputerCreator, temporaryComputerTargetScope],
    );
    /**
     * The composer's own Send, registered by whichever panel owns submission.
     *
     * "Create new package" is a fresh submission, not a controller restart: the
     * closed activation already released this draft's creator settlement
     * custody, and only the Send owner allocates another one.
     */
    const temporaryComputerReplacementLaunchRef = React.useRef<(() => void) | null>(null);
    const registerTemporaryComputerReplacementLaunch = React.useCallback((send: () => void) => {
        temporaryComputerReplacementLaunchRef.current = send;
        return () => {
            if (temporaryComputerReplacementLaunchRef.current === send) {
                temporaryComputerReplacementLaunchRef.current = null;
            }
        };
    }, []);
    const requestTemporaryComputerReplacementLaunch = React.useCallback(() => {
        temporaryComputerReplacementLaunchRef.current?.();
    }, []);
    const temporaryComputerLaunchInput: NewSessionTemporaryComputerLaunch['input'] = {
        client: temporaryComputerActivationTransport,
        requestReplacementLaunch: requestTemporaryComputerReplacementLaunch,
        // The activation is owned by the *target* Home, not the Home the draft
        // is synchronized in. Waking on the draft Home would leave a cross-Home
        // launch permanently stale.
        serverId: targetServerId ?? null,
        draftId,
        draftLaunchOperationKey: temporaryComputerTargetScope
            ? `${serverAccountScopeKeySuffix(temporaryComputerTargetScope)}\u0000${draftId}`
            : undefined,
        existingPublicRef: existingTemporaryComputerActivationRef,
        prepareActivation: prepareTemporaryActivation,
        persistPublicRef: persistTemporaryComputerActivationRef,
        prepareReview: (projection, signal) => asCreatorUnavailable(
            'review',
            () => prepareTemporaryComputerReview(projection, signal),
        ),
        materialize: (projection) => asCreatorUnavailable(
            'materialization',
            () => materializeTemporaryComputer(projection),
        ),
        onClaimed: async (claimed) => {
            if (!temporaryComputerTargetScope) {
                throw new TemporaryComputerLaunchDependencyUnavailableError('activation');
            }
            let expectedBinding;
            try {
                expectedBinding = await readAcceptedRunnerCreatorActivationBinding(
                    temporaryComputerTargetScope,
                    claimed.activationId,
                    claimed,
                );
            } catch (error) {
                // A device that never held this activation's signing key has
                // nothing to retire. Treating that as a failure is what turned
                // an otherwise healthy launch into a `failed` screen on every
                // other device of the same Account.
                if (error instanceof RunnerCreatorLaunchCustodyUnavailableError) return;
                throw error;
            }
            await retireRunnerActivationKeyCustodyAfterVerifiedClaim({
                scope: temporaryComputerTargetScope,
                expectedBinding,
                projection: claimed,
            });
        },
        onMaterialized: onTemporaryComputerMaterialized,
        onClosed: onTemporaryComputerClosed,
        onAbandoned: async () => {
            temporaryCreatorSettlementRef.current?.reject();
            temporaryCreatorSettlementRef.current = null;
            if (temporaryComputerTargetScope) resumeDraftPersistence(temporaryComputerTargetScope);
        },
    };
    const exportTemporaryComputerPackage = React.useCallback(async (projection: RunnerActivationProjectionV1) => {
        const profile = targetServerProfile;
        if (!projection || !profile?.homeConnectionDescriptor || !temporaryComputerTargetScope) return;
        const homeConnectionDescriptor = profile.homeConnectionDescriptor;
        const activationId = projection.activationId;
        const binding = await readAcceptedRunnerCreatorActivationBinding(temporaryComputerTargetScope, activationId, projection);
        let local = temporaryLocalLaunchRef.current;
        if (!local || local.key.activationId !== activationId) {
            let artifact = temporaryComputerAvailability.status === 'available'
                ? temporaryComputerAvailability.artifacts.find((candidate) => (
                    candidate.identity.product === projection.artifact.product
                    && candidate.identity.version === projection.artifact.version
                    && candidate.identity.sha256 === projection.artifact.sha256
                    && candidate.identity.target === projection.artifact.target
                )) ?? null
                : null;
            if (!artifact && temporaryComputerActivationTransport) {
                const exactAvailability = await temporaryComputerActivationTransport.listArtifacts(
                    undefined,
                    projection.artifact.version,
                );
                artifact = exactAvailability.artifacts.find((candidate) => (
                    candidate.identity.product === projection.artifact.product
                    && candidate.identity.version === projection.artifact.version
                    && candidate.identity.sha256 === projection.artifact.sha256
                    && candidate.identity.target === projection.artifact.target
                )) ?? null;
            }
            if (!artifact) throw new Error('runner_package_artifact_unavailable');
            const [key, acquired] = await Promise.all([
                openRunnerActivationKeyCustody(temporaryComputerTargetScope, activationId),
                acquireRunnerArtifact({ artifact }),
            ]);
            local = {
                key,
                staged: null,
                acquired,
                preparedAuthoring: null,
                submission: null,
            };
            // Reopened exports acquire the same verified artifact through the
            // canonical sink; retain that handle so acknowledged closure owns
            // its cleanup just like the first export.
            temporaryLocalLaunchRef.current = local;
        }
        const custody: RunnerActivationCustody = {
            scope: temporaryComputerTargetScope,
            key: local.key,
            binding,
        };
        await exportRunnerActivationPackage({
            ...local.acquired,
            custody,
            home: homeConnectionDescriptor,
            projection,
        });
    }, [targetServerProfile, temporaryComputerActivationTransport, temporaryComputerAvailability, temporaryComputerTargetScope]);
    const launchOnTemporaryComputer = React.useCallback(async (
        submission: TemporarySubmission,
        settlement: TemporaryComputerCreatorSettlement,
    ) => {
        temporaryComputerTeamAccessForActivationRef.current = authorizeTemporaryComputerTeamAccess;
        setAuthorizeTemporaryComputerTeamAccess(false);
        temporarySubmissionRef.current = submission;
        temporaryCreatorSettlementRef.current = settlement;
        temporaryMaterializationSettlementRef.current = null;
        temporaryPresentationAccountLifetimeRef.current = captureActiveServerAccountScopeLifetime();
        const controller = temporaryComputerLaunchControlRef.current;
        if (!controller) throw new TemporaryComputerLaunchDependencyUnavailableError('activation');
        await controller.start();
    }, [authorizeTemporaryComputerTeamAccess]);
    const temporaryComputerLaunch: NewSessionTemporaryComputerLaunch = {
        input: temporaryComputerLaunchInput,
        controlRef: temporaryComputerLaunchControlRef,
        scope: temporaryComputerTargetScope,
        committedTarget: executionTarget?.kind === 'temporary_computer' ? executionTarget : null,
        homeLabel: temporaryComputerTargetScope ? homeDisplayName(temporaryComputerTargetScope.serverId) : null,
        accountLabel: temporaryComputerTargetScope
            && temporaryComputerTargetScope.accountId !== activeDraftScope?.accountId
            ? temporaryComputerTargetScope.accountId : null,
        exportPackage: exportTemporaryComputerPackage,
        onActiveChange: setTemporaryComputerLaunchActive,
        // Embedded, there is no screen to leave: the page stays where it is.
        onLeave: embeddedInHost ? () => undefined : () => safeRouterBack({ router, navigation, fallbackHref: '/' }),
    };
    const launchPresentation = resolveNewSessionLaunchPresentation({
        temporaryComputerLaunchActive,
        isCreating,
        pendingLaunchAttempt,
    });

    const {
        handleCreateSession,
        providerLaunchError,
        retryProviderLaunch,
    } = useNewSessionCreateSessionAction({
        zenTaskSource: persistedDraft?.zenTaskSource,
        targetAccountScope: temporaryComputerTargetScope,
        flushComposerInput: newSessionComposerDocument.flushComposerInput,
        draftId,
        router,
        selectedMachineId,
        selectedPath: rememberedPath,
        directoryKind,
        getRequestedPath,
        selectedMachine,
        setIsCreating,
        setIsResumeSupportChecking,
        checkoutCreationDraft,
        transcriptStorage,
        settings,
        pluginSettings: effectiveAgentPluginSettings,
        pluginSettingsReadiness: effectiveAgentPluginSettingsReadiness,
        useProfiles,
        selectedProfileId,
        profileMap,
        recentMachinePaths,
        agentType: selectedUiAgentType,
        staticAgentId,
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
        backendTarget,
        spawnBackendTarget,
        executionRunsEnabled,
        permissionMode,
        modelMode,
        acpSessionModeId,
        sessionConfigOptionOverrides,
        preflightModels,
        preflightModelsTargetKey,
        promptStore,
        setSessionPrompt,
        resumeSessionId,
        agentNewSessionOptions,
        currentAuthoringDraft: effectiveCurrentAuthoringDraft,
        mcpSelection,
        windowsRemoteSessionLaunchModeOverride,
        machineEnvPresence,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        selectedMachineCapabilities,
        targetServerId,
        allowedTargetServerIds,
        daemonMergedProjectionInputs: currentProjectionInputs,
        resolvedSettingsAllowedServerIds: resolvedSettingsTarget.allowedServerIds,
        draftScope,
        temporaryComputerTargetScope,
        prepareTemporaryComputerLaunchDraft,
        disableDraftPersistence,
        onLaunchAttemptChange: setPendingLaunchAttempt,
        launchIntentSignature,
        launchUserAttemptId,
        onLaunchUserAttemptIdChange,
        authoringCommitPending: confirmExperimentalProviderModel.pending,
        sourceContext: sourceContextState.sourceContext,
        temporaryComputerLaunch: launchOnTemporaryComputer,
    });

    // Send needs both contracts: a published artifact for the chosen platform
    // (eligibility) and an exact, current, compatible Team credential provider
    // model for the selected Agent (readiness). Launching without the second
    // would create a Session whose first real Provider request has no broker
    // authority, which the endpoint cannot recover from.
    const temporaryComputerTargetReady = effectiveCurrentAuthoringDraft.executionTarget?.kind !== 'temporary_computer'
        || (temporaryComputerAvailability.status === 'available'
            && selectedTemporaryArtifact !== null
            && temporaryComputerLaunchBlock === null);
    const canCreate = canCreateFromAuthoring
        && acpCatalogReady
        && temporaryComputerTargetReady
        && (effectiveCurrentAuthoringDraft.executionTarget?.kind === 'temporary_computer'
            || (selectedBackendEntry !== null && isBackendEntrySelectable(selectedBackendEntry)))
        && canCreateSessionWithInitialAccess(currentAuthoringDraft.access, collaborationAvailability)
        && targetServerId !== null
        && selectedAgentSettingsReady
        && organizationPlacementState.valid
        && !confirmExperimentalProviderModel.pending
        // V1 requires the source Session and the target to share a server. Block
        // submission rather than silently dropping the continuation recipe; the
        // user can switch back or remove the chip.
        && !sourceContextState.serverMismatch;
    const canCreateWithoutActiveTemporaryLaunch = canCreate
        && !temporaryComputerLaunchActive;
    newSessionComposerCanSubmitRef.current = canCreateWithoutActiveTemporaryLaunch;
    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(newSessionComposerDocument.ref);
    }, [canCreate, newSessionComposerDocument.ref]);

    const {
        connectionStatus,
        agentInputExtraActionChips,
    } = useNewSessionScreenAgentInputPresentation({
        theme,
        selectedMachine,
        selectedMachineSpawnReadiness,
        automationFeatureEnabled,
        automationDraft,
        onOpenAutomationEditor: openAutomationEditorWithComposedDraft,
        showInitialTriggers: automationFeatureEnabled,
        initialTriggers,
        onInitialTriggersChange: setInitialTriggers,
        repoScmSnapshot,
        checkoutChipModel,
        organizationPlacementActionChips: organizationPlacementState.actionChips,
        sessionAccess: accessDraftState.chip,
        checkoutPickerOpen,
        setCheckoutPickerOpen,
        checkoutCreationDraft,
        selectedMachineId,
        selectedPath,
        setSelectedPath,
        setCheckoutCreationDraft,
        pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        router,
        promptStore,
        setSessionPrompt,
        handleCreateSession,
        backendTarget: operationalBackendTarget,
        agentType: selectedUiAgentType,
        staticAgentId,
        runtimeCarrierAgentId: selectedRuntimeCarrierAgentId,
        agentOptionState,
        setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip,
        seededPlacementActionChip,
        showAutomationActionChipsFromAuthoringContext: newSessionAuthoringContext.showAutomationActionChips,
        showServerPickerChip,
        targetServerId,
        targetServerName,
        mcpChip,
        externalSessionsFeatureEnabled,
        supportsDirectTranscriptStorage,
        transcriptStorage,
        hasUserSelectedTranscriptStorageRef,
        setTranscriptStorage,
        selectedMachineIsWindows,
        effectiveWindowsRemoteSessionLaunchMode,
        windowsTerminalAvailable,
        setWindowsRemoteSessionLaunchModeOverride,
        temporaryComputerTeamAccess: effectiveCurrentAuthoringDraft.executionTarget?.kind === 'temporary_computer'
            && existingTemporaryComputerActivationRef === null
            ? {
                authorized: authorizeTemporaryComputerTeamAccess,
                onChange: setAuthorizeTemporaryComputerTeamAccess,
            }
            : null,
    });

    // The one folder chip: its state comes from the directory-intent owner and the machine's own
    // availability; a fixed intent (embed) renders no folder control at all.
    const pathPopover = directoryIntentFixed ? undefined : composerPathPopover;
    const machineUnavailableReason = selectedMachineId !== null
        && selectedMachine != null
        && !canAttemptMachineSpawn({ selectedMachineId, machine: selectedMachine, spawnReadiness: selectedMachineSpawnReadiness })
        ? (connectionStatus?.text ?? null)
        : null;
    const folderChipState = React.useMemo(() => resolveNewSessionFolderChipState({
        directoryKind,
        selectedPath,
        machineUnavailableReason,
    }), [directoryKind, machineUnavailableReason, selectedPath]);
    const removeFolder = offersNoFolder ? selectNoFolder : undefined;

    // Auto-persist watches the composer text out of render: a keystroke re-arms the debounce
    // through the store subscription instead of re-running this model.
    const draftTextSource = React.useMemo(() => ({
        getLength: () => promptStore.getPrompt().length,
        subscribe: promptStore.subscribe,
    }), [promptStore]);

    const {
        openProfileEdit,
        handleAddProfile,
        handleDuplicateProfile,
    } = useNewSessionProfileEditPersistence({
        router,
        draftId,
        selectedMachineId,
        backendTargetRouteParams: buildBackendTargetRouteParams({
            agentType: agentTypeParam,
            backendTarget: backendTargetParam,
            backendTargetKey: backendTargetKeyParam,
            fallbackTarget: backendTarget,
        }),
        buildCurrentPersistedDraft,
        persistDraftIfEnabled,
        draftPersistenceEnabled,
        draftPersistenceGenerationRef,
        draftText: draftTextSource,
        draftChangeKey: launchIntentSignature,
    });

    const launchStatusBadges = React.useMemo(
        () => buildNewSessionLaunchStatusBadges({ isCreating, translate: t }),
        [isCreating],
    );
    const composerStatusBadges = React.useMemo(
        () => [...launchStatusBadges, ...(input?.statusBadges ?? [])],
        [input?.statusBadges, launchStatusBadges],
    );

    // Why the chosen agent can't start on the chosen machine, with its fix (lab agent-setup ST):
    // the one inventory owner decides; Set up / Sign in opens the machine's Agents section.
    const selectedMachineAgent = selectedBackendEntry ? machineAgentsById[selectedBackendEntry.agentId] ?? null : null;
    const agentStartBlocker = selectedMachineAgent && selectedMachineId ? (
        <AgentSessionStartBlocker
            agent={selectedMachineAgent}
            machineName={getMachineDisplayName(selectedMachine) ?? selectedMachineId}
            onSetUp={targetServerId === null ? undefined : () => router.push(machineCollectionHref({ machineId: selectedMachineId, serverId: targetServerId }) as never)}
        />
    ) : null;
    const composerTopContent = agentStartBlocker || input?.composerTopContent
        ? <>{agentStartBlocker}{input?.composerTopContent}</>
        : undefined;

    const {
        layout: wizardLayoutProps,
        useColumnLayout: wizardUseColumnLayout,
        profiles: wizardProfilesProps,
        agent: wizardAgentProps,
        machine: wizardMachineProps,
        footer: wizardFooterProps,
    } = useNewSessionScreenWizardProps({
        layout: {
            theme,
            styles,
            safeAreaTop: safeArea.top,
            safeAreaBottom: safeArea.bottom,
            headerHeight,
            newSessionTopPadding: simpleNewSessionTopPadding,
            newSessionSidePadding,
            newSessionBottomPadding,
            shouldBottomAnchor,
        },
        sectionPresentation: newSessionWizardSectionPresentationV1,
        useColumnLayout: newSessionWizardColumnsEnabled === true,
        profiles: {
            useProfiles,
            profiles,
            favoriteProfileIds,
            setFavoriteProfileIds,
            selectedProfileId,
            onPressDefaultEnvironment,
            onPressProfile,
            selectedMachineId,
            getProfileDisabled,
            getProfileSubtitleExtra,
            handleAddProfile,
            openProfileEdit,
            handleDuplicateProfile,
            handleDeleteProfile,
            suppressNextSecretAutoPromptKeyRef,
            openSecretRequirementModal,
            profilesGroupTitles,
        },
        profileSecrets: {
            machineEnvPresence,
            secrets,
            secretBindingsByProfileId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueByProfileIdByEnvVarName,
        },
        installables: {
            wizardInstallableDeps,
            selectedMachineCapabilities,
        },
        agent: {
            cliAvailability,
            tmuxRequested,
            enabledAgentIds,
            isAgentSelectable,
            agentType: selectedUiAgentType,
            agentLabel,
            setAgentType,
            agentPickerOptions,
            agentPickerSelectedOptionId,
            selectedBackendTargetKey,
            selectedBackendEntryTargetKey: selectedBackendEntry?.backendTargetKey,
            onAgentPickerSelect: handleAgentPickerSelect,
            selectedBackendEntry,
            modelOptions,
            modelOptionsProbeState,
            favoriteModelSelections,
            setFavoriteModelSelections,
            acpSessionModeOptions,
            acpSessionModeProbeState: {
                phase: acpSessionModeProbeState.phase,
                onRefresh: acpSessionModeProbeState.onRefresh,
            },
            acpSessionModeId,
            setAcpSessionModeId: setAcpSessionModeIdAndRemember,
            acpConfigOptions: acpConfigOptions ?? undefined,
            acpConfigOptionsProbeState: {
                phase: acpConfigOptionsProbeState.phase,
                onRefresh: acpConfigOptionsProbeState.onRefresh,
            },
            acpConfigOptionOverrides: sessionConfigOptionOverrides,
            setAcpConfigOptionOverride: setAcpConfigOptionOverrideAndRemember,
            modelMode,
            modelSelection,
            setModelMode: setModelModeAndRemember,
            setModelSelection: setModelSelectionAndRemember,
            teamCredentialResources: teamCredentialCatalog.resources,
            teamNameById: teamCredentialCatalog.teamNameById,
            homeNameByTeamId: teamCredentialCatalog.homeNameByTeamId,
            currentTeamCredentialResourceKeys: teamCredentialCatalog.currentResourceKeys,
            selectedTeamCredentialModel,
            onSelectTeamCredentialModel: selectTeamCredentialModel,
            providerModelGroups: providersFeatureEnabled
                ? (providerModelProjection.data?.groups ?? [])
                : [],
            providerModelProjectionAuthoritative: providerModelProjection.status === 'success',
            providerModelProjectionError: providersFeatureEnabled ? providerModelProjection.error : null,
            providerModelProjectionFailures: providersFeatureEnabled ? providerModelProjection.refreshFailures : [],
            retryProviderModelProjection: providersFeatureEnabled ? providerModelProjection.refresh : null,
            providerCurrentSelectionRecovery: providersFeatureEnabled
                ? providerModelProjection.data?.currentSelectionRecovery ?? null
                : null,
            hiddenNativeModelKeys,
            experimentalModelConfirmation: confirmExperimentalProviderModel,
            selectedIndicatorColor,
            profileMap,
            permissionMode,
            handlePermissionModeChange,
        },
        machine: {
            machines,
            // The wizard's adaptive presentation counts the same rendered destinations as the
            // picker, so it receives the one resolved Home-group set and its Pool projections.
            machineGroups: serverScopedMachineGroups,
            machinePoolGroups,
            temporaryComputerProjection: temporaryComputerDestinationProjection,
            targetServerId,
            selectedMachine: selectedMachine ?? null,
            recentMachines,
            favoriteMachineItems,
            useMachinePickerSearch,
            refreshMachineData,
            setSelectedMachineId,
            getBestPathForMachine,
            setSelectedPath,
            setDraftSelectedPath,
            favoriteMachines,
            setFavoriteMachines,
            selectedPath,
            recentPaths,
            usePathPickerSearch,
            favoriteDirectories,
            setFavoriteDirectories,
        },
        footer: {
            promptStore,
            composerDocument: newSessionComposerDocument,
            composerReferenceHost: newSessionComposerDropHost,
            composerFileScope: newSessionComposerFileScope,
            setSessionPrompt,
            handleCreateSession,
            registerTemporaryComputerReplacementLaunch,
            canCreate: canCreateWithoutActiveTemporaryLaunch,
            isCreating,
            pendingLaunchAttempt,
            launchPendingPreviewVisible: launchPresentation === 'machine',
            providerLaunchError,
            retryProviderLaunch,
            emptyAutocompleteKinds,
            emptyAutocompleteSuggestions,
            connectionStatus,
            statusBadges: composerStatusBadges,
            composerTopContent,
            statusTrailingActions: input?.statusTrailingActions,
            machinePopover,
            pathPopover,
            folderChipState,
            onRemoveFolder: removeFolder,
            resumeSessionId,
            resumePopover,
            isResumeSupportChecking,
            sessionPromptInputMaxHeight,
            agentInputExtraActionChips,
            sourceContextPresentation: sourceContextState.presentation,
            attachmentFlowId,
        },
    });

    const { profilePopover } = useNewSessionProfilePopover({
        useProfiles,
        profilesProps: wizardProfilesProps,
        serverId: targetServerId,
        machineName: getMachineDisplayName(selectedMachine) ?? (selectedMachineId || undefined),
        popoverBoundaryRef,
    });

    const simplePanelProps = useNewSessionScreenSimplePanelProps({
        layout: {
            popoverBoundaryRef,
            headerHeight,
            safeAreaTop: safeArea.top,
            safeAreaBottom: safeArea.bottom,
            newSessionTopPadding: simpleNewSessionTopPadding,
            newSessionSidePadding: simpleNewSessionSidePadding,
            newSessionBottomPadding: simpleNewSessionBottomPadding,
            shouldBottomAnchor,
            containerStyle: styles.container as any,
        },
        creation: {
            promptStore,
            composerDocument: newSessionComposerDocument,
            composerReferenceHost: newSessionComposerDropHost,
            composerFileScope: newSessionComposerFileScope,
            setSessionPrompt,
            handleCreateSession,
            registerTemporaryComputerReplacementLaunch,
            canCreate: canCreateWithoutActiveTemporaryLaunch,
            isCreating,
            pendingLaunchAttempt,
            launchPendingPreviewVisible: launchPresentation === 'machine',
            providerLaunchError,
            retryProviderLaunch,
            emptyAutocompleteKinds,
            emptyAutocompleteSuggestions,
            sessionPromptInputMaxHeight,
            statusBadges: composerStatusBadges,
            composerTopContent,
            statusTrailingActions: input?.statusTrailingActions,
        },
        agent: {
            agentInputExtraActionChips,
            sourceContextPresentation: sourceContextState.presentation,
            agentType: selectedUiAgentType,
            agentLabel,
            handleAgentClick,
            agentPickerOptions,
            agentPickerSelectedOptionId,
            onAgentPickerSelect: handleAgentPickerSelect,
            agentPickerProbe: cliAvailabilityProbe,
            onAgentPickerVisibilityChange: setAgentInventoryDemanded,
            selectedBackendTargetKey,
            selectedBackendEntryTargetKey: selectedBackendEntry?.backendTargetKey,
        },
        model: {
            permissionMode,
            handlePermissionModeChange,
            modelMode,
            setModelMode: setModelModeAndRemember,
            modelOptions,
            modelOptionsProbeState,
            modelPickerProps: creationModelPickerProps,
        },
        acp: {
            acpSessionModeOptions,
            acpSessionModeId,
            setAcpSessionModeId: setAcpSessionModeIdAndRemember,
            acpConfigOptions: acpConfigOptions ?? undefined,
            acpConfigOptionOverrides: sessionConfigOptionOverrides,
            setAcpConfigOptionOverride: setAcpConfigOptionOverrideAndRemember,
            acpSessionModeProbeState: {
                phase: acpSessionModeProbeState.phase,
                onRefresh: acpSessionModeProbeState.onRefresh,
            },
            acpConfigOptionsProbeState: {
                phase: acpConfigOptionsProbeState.phase,
                onRefresh: acpConfigOptionsProbeState.onRefresh,
            },
        },
        machineAndResume: {
            connectionStatus,
            machineDisplayName: selectedMachine?.metadata?.displayName,
            machineHost: selectedMachine?.metadata?.host,
            executionTarget,
            destination: {
                selectionOrigin,
                machineGroups: serverScopedMachineGroups,
                poolGroups: machinePoolGroups,
            },
            machinePopover,
            selectedMachineHomeDir: selectedMachine?.metadata?.homeDir ?? null,
            selectedPath,
            pathPopover,
            folderChipState,
            onRemoveFolder: removeFolder,
            showResumePicker,
            resumeSessionId,
            resumePopover,
            isResumeSupportChecking,
        },
        profile: {
            useProfiles,
            selectedProfileId,
            selectedMachineId,
            profilePopover,
        },
        targetServerId,
        attachmentFlowId,
    });

    const destinationWizardFooterProps = React.useMemo(() => ({
        ...wizardFooterProps,
        machineName: simplePanelProps.machineName,
    }), [wizardFooterProps, simplePanelProps.machineName]);

    return buildNewSessionScreenVariantModel({
        useEnhancedSessionWizard,
        popoverBoundaryRef,
        launchOverlay: accessDraftState.screen?.content ?? null,
        temporaryComputerLaunch,
        launchOnRequestClose: accessDraftState.screen?.onRequestClose,
        overlayPresentation: accessDraftState.screen ? 'screen' : 'card',
        overlayFocusReturnRef: accessDraftState.screen?.focusReturnRef,
        overlayAccessibilityLabel: accessDraftState.screen ? t('session.access.title') : undefined,
        simplePanelProps,
        checkoutCreationDraft,
        setCheckoutCreationDraft,
        wizardLayoutProps,
        wizardSectionPresentation: newSessionWizardSectionPresentationV1,
        wizardUseColumnLayout,
        wizardProfilesProps,
        wizardAgentProps,
        wizardMachineProps,
        wizardFooterProps: destinationWizardFooterProps,
    });
}
