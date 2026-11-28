import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ProviderWireProtocol } from '@happier-dev/protocol/providers/capabilities/v1';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import * as React from 'react';
import { isSessionModelRefSourceBound, readSessionModelRefProviderConnectionId, type PersonalSessionModelRef } from '@happier-dev/protocol/providers/selection/v2';
import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { SurfaceAddress } from '@happier-dev/plugin-ui';
import type { ThemeSelectionSurfaceBinding } from '@happier-dev/plugin-ui/presentation';

import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from '@/components/ui/selectionList/_constants';
import { providerDeclarationContext, readAccountAgentCatalogConnectedServices, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { providerCatalogPermitsUnlistedModelIdV1 } from '@happier-dev/protocol/providers/catalog/merge';
import { isFavoriteModelRefSelectable, type FavoriteModelRef } from '@happier-dev/protocol/providers/modelFavoritesV1';
import { isNativeAutomaticModelSelectionInputV1 } from '@happier-dev/protocol/providers/selection/v1';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type {
    DaemonProviderCurrentSelectionRecoveryV1,
    DaemonProviderModelProjectionRefreshFailureV1,
} from '@happier-dev/protocol/rpc';
import type {
    TeamCredentialProviderModelSelectionV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';

import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { ProviderPendingApproval } from '@/providers/actions/useProviderActionClient';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { useProviderConnectionUsageForSource } from '@/providers/hooks/useProviderConnectionUsageForSource';
import { providerConnectionSourceLabel } from '@/providers/session/resolveSessionRoutePresentation';
import { buildSessionRouteSourceRows } from '@/providers/session/buildSessionRouteSourceRows';
import {
    OptionPickerOverlay,
    type OptionPickerFavoriteOptions,
    type OptionPickerProbeState,
    type OptionPickerSelectedBand,
} from '@/components/sessions/pickers/OptionPickerOverlay';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { computeAcpConfigOptionControlsForProvider } from '@/sync/domains/sessionControl/configOptionsControl';
import type { SelectionListHeightBehavior } from '@/components/ui/selectionList';
import { t } from '@/text';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { foldUnavailableRows } from '@/components/sessions/pickers/foldUnavailableRows';
import type { ProviderModelSelectionPurpose } from '@/providers/models/presentProviderModelRow';
import {
    buildSessionModelPickerSections,
    findSessionModelProjectionRow,
    resolveSessionModelSourceDescriptor,
    isSessionModelGatewaySlotSection,
    sessionModelConnectionTitle,
    withSessionModelSourceSuffixes,
    type SessionModelPickerOption,
    type SessionModelPickerSection,
    type SessionModelGatewaySlot,
    type SessionModelProjectionGroup,
    type SessionNativeModelOption,
} from './buildSessionModelPickerSections';
import { useGatewaySlotTitle } from './useGatewaySlotTitle';
import { SessionModelSourceUsage } from './SessionModelSourceUsage';
import { selectSessionModelPickerSourceGroups } from './selectSessionModelPickerSourceGroups';
import { SessionModelFavoriteEffortNote, SessionModelRunsThrough, type SessionModelPickerSource } from './SessionModelRunsThrough';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { PROVIDER_REASONING_EFFORT_OPTION_ID, formatReasoningEffortTierLabel } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { assignFavoriteModelSlots, favoriteModelPickerKey, favoriteModelRefFromPickerValue } from './favoriteModelEntries';
import { retainedTeamModelUnavailableReason } from './buildTeamCredentialModelPickerSections';
import { AgentInputChipPickerCloseContext } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { SelectionListKeyboardHint, SelectionListQuickActionShortcut } from '@/components/ui/selectionList';
import { resolveModModifier } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { providerConnectionDetailRoute } from '@/components/settings/providers/collection/providerCollectionModel';
import {
    SessionModelHiddenSources,
    SessionModelSourceBack,
    type SessionModelBrowseScope,
    type SessionModelHiddenSource,
} from './SessionModelSourceScope';
import {
    SessionModelApplyTimingContext,
    SessionModelNativeSourceLabelContext,
    SessionModelSourceBrowseHandoffContext,
} from './SessionModelSourceBrowseHandoff';
import {
    isTeamCredentialProviderModelPickerValue,
    sessionModelPickerValueFromRef,
    sessionModelSelectionKey,
    type SessionModelPickerOptionValue,
    type SessionModelPickerValue,
} from './sessionModelSelectionKey';
import {
    ReportedModelSummary,
    reportedModelSummary,
    type ReportedModelStatus,
} from './reportedModelPresentation';

const EMPTY_CONNECTED_SERVICES: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {} };

const MODEL_PICKER_THEME_SURFACE = {
    root: { surface: 'model-picker', part: 'root', state: 'default' },
    row: { surface: 'model-picker', part: 'row', state: 'default' },
    sectionTitle: { surface: 'model-picker', part: 'provider', state: 'default' },
} as const satisfies ThemeSelectionSurfaceBinding;
const MODEL_PICKER_EFFORT_SURFACE = { surface: 'model-picker', part: 'effort', state: 'default' } as const satisfies SurfaceAddress;

export type SessionModelPickerExperimentalConfirmation = Readonly<{
    kind: 'confirm-experimental';
    connectionId: string;
    connectedAccountTarget?: SessionModelProjectionGroup['connectedAccountTarget'];
    catalogSourceKey?: string;
    expectedConnectionRevision: number;
    agentTargetKey: string;
    modelId: string | null;
    compatibilityFingerprint: string;
    providerName: string;
    modelName: string;
}>;

export type SessionModelPickerExperimentalConfirmationController = Readonly<{
    confirm: (
        confirmation: SessionModelPickerExperimentalConfirmation,
        commitSelection: () => void,
    ) => Promise<boolean>;
    pending: boolean;
    /** The model the waiting confirmation is for; the picker names it beside the approval it waits on. */
    pendingModelName?: string | null;
    pendingApproval?: ProviderPendingApproval | null;
    error: ProviderErrorV1 | null;
    retry: (() => Promise<boolean>) | null;
    clear: () => void;
}>;

export type SessionModelPickerFavoriteEntry = Readonly<{
    ref: FavoriteModelRef;
    label?: string;
    description?: string;
    accessibilityLabel?: string;
    reasoningEffort?: string;
}>;

export function buildSessionModelPickerNotes(input: Readonly<{
    notes: readonly string[];
    groups: readonly Pick<SessionModelProjectionGroup, 'connectionId' | 'suppressedConnectedServiceIds'>[];
    selected: SessionModelPickerValue;
    suppressionNote: string;
}>): readonly string[] {
    const selectedConnectionId = input.selected ? readSessionModelRefProviderConnectionId(input.selected) : null;
    const suppressesConnectedServices = selectedConnectionId !== null && input.groups.some(
        (group) => group.connectionId === selectedConnectionId && group.suppressedConnectedServiceIds.length > 0,
    );
    return suppressesConnectedServices
        ? [...input.notes, input.suppressionNote]
        : input.notes;
}

export function resolveSessionModelPickerSelection(input: Readonly<{
    purpose?: ProviderModelSelectionPurpose;
    groups: readonly SessionModelProjectionGroup[];
    ref: SessionModelPickerOptionValue;
}>): SessionModelPickerExperimentalConfirmation | Readonly<{ kind: 'select'; ref: SessionModelPickerOptionValue }> {
    if (input.ref === null || input.purpose === 'preference') return { kind: 'select', ref: input.ref };
    if (isTeamCredentialProviderModelPickerValue(input.ref)) return { kind: 'select', ref: input.ref };
    for (const group of input.groups) {
        const row = group.rows.find((candidate) => (
            sessionModelSelectionKey(candidate.ref) === sessionModelSelectionKey(input.ref)
        ));
        if (!row) continue;
        if (row.compatibility.result.status === 'experimental' && !row.compatibility.confirmed) {
            return {
                kind: 'confirm-experimental',
                connectionId: group.connectionId,
                ...(group.connectedAccountTarget ? { connectedAccountTarget: group.connectedAccountTarget } : {}),
                ...(row.confirmationSource ? { catalogSourceKey: row.confirmationSource.catalogSourceKey } : {}),
                expectedConnectionRevision: group.connectionRevision,
                agentTargetKey: row.ref.agentTargetKey,
                modelId: row.compatibility.result.confirmationScope.kind === 'model' ? row.compatibility.result.confirmationScope.modelId : null,
                compatibilityFingerprint: row.compatibility.compatibilityFingerprint,
                providerName: group.providerName,
                modelName: row.descriptor.name || row.ref.modelId,
            };
        }
        return { kind: 'select', ref: input.ref };
    }
    return { kind: 'select', ref: input.ref };
}

const EMPTY_NATIVE_MODELS: readonly SessionNativeModelOption[] = [];
const EMPTY_PROJECTION_GROUPS: readonly SessionModelProjectionGroup[] = [];

export type SessionModelPickerProps = Readonly<{
    /** Preferences retain compatibility and visibility, without execution readiness or consent. */
    purpose?: ProviderModelSelectionPurpose;
    agentTargetKey: string;
    declarationContext?: ProviderDeclarationContext;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    /** The host applies the Provider-purpose binding with its model selection. */
    includeProviderConnectedAccounts?: boolean;
    /** A runner may support a narrower transport set than the Agent itself. */
    providerProtocols?: readonly ProviderWireProtocol[];
    nativeModels: readonly SessionNativeModelOption[];
    providerGroups: readonly SessionModelProjectionGroup[];
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    teamNameById?: Readonly<Record<string, string>>;
    homeNameByTeamId?: Readonly<Record<string, string>>;
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    providerProjectionAuthoritative: boolean;
    /** The active source projection is still acquiring its first answer for this read. */
    providerProjectionResolving?: boolean;
    projectionError?: ProviderErrorV1 | null;
    projectionFailures?: readonly DaemonProviderModelProjectionRefreshFailureV1[];
    retryProjection?: (() => Promise<void> | void) | null;
    /** The model-list request waiting for its approval: the picker keeps the way to it in place. */
    projectionApproval?: ProviderPendingApproval | null;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys?: ReadonlySet<string>;
    /** Default `true`; `false` drops the automatic option (a model-restricted embed). */
    allowAutomatic?: boolean;
    clearOption?: Parameters<typeof buildSessionModelPickerSections>[0]['clearOption'];
    selected: SessionModelPickerOptionValue;
    /** Where the selected model came from when it is an inherited default ("Team default"); shown on that row only. */
    selectedAttribution?: string | null;
    reportedModel?: Readonly<{
        ref: NonNullable<SessionModelPickerOptionValue>;
        label?: string;
        status: ReportedModelStatus;
    }> | null;
    /**
     * The pane writes to several Sessions that run different models: no card reads as chosen (Mixed means nothing
     * is chosen) and the running line names the mix ("Running: Mixed · Applies from your next message").
     */
    mixedSelection?: Readonly<{ label: string; applyTiming?: string }>;
    canEnterCustomNativeValue?: boolean;
    /** `false` removes custom entry for both native and Provider models in a restricted presentation. */
    canEnterCustomValue?: boolean;
    notes?: readonly string[];
    probe?: OptionPickerProbeState;
    headerAccessory?: React.ReactNode;
    favoriteEntries?: readonly SessionModelPickerFavoriteEntry[];
    favoriteKeys?: ReadonlySet<string>;
    favoriteReasoningEffortByKey?: ReadonlyMap<string, string | undefined>;
    onToggleFavorite?: (ref: FavoriteModelRef, reasoningEffort?: string, modelLabel?: string) => void;
    onSelectFavoriteModel?: (ref: PersonalSessionModelRef, reasoningEffort?: string, binding?: QualifiedConnectedAccountPurposeBindingV1) => boolean | Promise<boolean>;
    onUpdateFavoriteModelReasoningEffort?: (ref: PersonalSessionModelRef, reasoningEffort: string) => void;
    selectedOptionControls?: ReadonlyArray<SessionConfigOptionControl>;
    /** Draft/session intent, applied to the selected source's own descriptors. */
    modelOptionOverrides?: Readonly<Record<string, string>>;
    onSelectOptionControlValue?: (configId: string, valueId: SessionConfigOptionValueId) => void;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    fillAvailableSpace?: boolean;
    showTitle?: boolean;
    maxHeight?: number;
    heightBehavior?: SelectionListHeightBehavior;
    autoFocusInputOnWeb?: boolean;
    onRequestClose?: () => void;
    favoriteActionVisibility?: 'selected-or-favorite' | 'all';
    /** Forwarded verbatim; the hosting surface decides, this adapter never does. */
    multiColumn?: boolean;
    /**
     * A host that applies a pick asynchronously (a running Session) resolves whether the model was
     * accepted; a card's option value is written only after that, so a refused model drops it.
     */
    onSelect: (ref: SessionModelPickerValue, connectedAccountBinding?: QualifiedConnectedAccountPurposeBindingV1) => void;
    onSelectTeamCredentialModel?: (selection: TeamCredentialProviderModelSelectionV1) => boolean | void | Promise<boolean | void>;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    /** Heading and "via" name for the Agent's own models: its signed-in account or pool. */
    nativeSourceLabel?: string | null;
    /** Sources switched off for the picker that still offer this Agent models (the projection's `hiddenSources`). */
    hiddenSources?: readonly SessionModelHiddenSource[];
    /**
     * Where to project one source while it is browsed in place. Hosts that omit it offer no browsing.
     * Browsing is local to this picker: it never writes the selection; only picking a model does.
     */
    sourceBrowse?: Readonly<{ machineId: string | null; serverId: string | null }>;
}>;

/**
 * The engine popover's model pane (D13: Agent rail + model cards, the selected card with its own
 * options). It also owns the one piece of local navigation Design A adds: browsing a single source
 * that is hidden from the main list. The scope is forgotten when the pane closes.
 */
type SessionModelPickerRenderProps = Omit<SessionModelPickerProps, 'selected'> & Readonly<{
    selected: SessionModelPickerValue;
}>;

export function SessionModelPicker(input: SessionModelPickerProps) {
    const selectedTeam = isTeamCredentialProviderModelPickerValue(input.selected) ? input.selected : null;
    const favoriteReasoningEffortByKey = React.useMemo(
        () => input.favoriteReasoningEffortByKey ?? (input.favoriteEntries
            ? new Map(input.favoriteEntries.map(entry => [favoriteModelPickerKey(sessionModelPickerValueFromRef(entry.ref)), entry.reasoningEffort]))
            : undefined),
        [input.favoriteEntries, input.favoriteReasoningEffortByKey],
    );
    const favoriteKeys = React.useMemo(
        () => input.favoriteKeys ?? (favoriteReasoningEffortByKey ? new Set(favoriteReasoningEffortByKey.keys()) : undefined),
        [favoriteReasoningEffortByKey, input.favoriteKeys],
    );
    const props: SessionModelPickerRenderProps = { ...input,
        favoriteReasoningEffortByKey,
        favoriteKeys,
        selected: isTeamCredentialProviderModelPickerValue(input.selected) ? null : input.selected,
        selectedTeamCredentialModel: selectedTeam ?? input.selectedTeamCredentialModel,
    };
    return (props.connectedServices || props.includeProviderConnectedAccounts) && props.sourceBrowse
        ? <SessionAccountModelPicker picker={props} connectedServices={props.connectedServices ?? EMPTY_CONNECTED_SERVICES} sourceBrowse={props.sourceBrowse} />
        : <SessionModelPickerContent {...props} />;
}

/** Selected Account catalogs use the shared Provider projection and picker presentation. */
function SessionAccountModelPicker({ picker, connectedServices, sourceBrowse }: Readonly<{
    picker: SessionModelPickerRenderProps;
    connectedServices: ConnectedServiceBindingsV2;
    sourceBrowse: NonNullable<SessionModelPickerProps['sourceBrowse']>;
}>) {
    const declarations = useDaemonMergedProjectionInputs({ machineId: sourceBrowse.machineId,
        sections: ['agentsById', 'familiesById.providers'], serverId: sourceBrowse.serverId,
        enabled: picker.declarationContext === undefined && Boolean(sourceBrowse.machineId) });
    const context = picker.declarationContext ?? providerDeclarationContext(sourceBrowse.machineId,
        declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 : null);
    const accountSources = picker.includeProviderConnectedAccounts ? connectedServices
        : readAccountAgentCatalogConnectedServices(picker.agentTargetKey, context, connectedServices);
    const projection = useProviderModelProjection({ enabled: accountSources !== null, ...sourceBrowse,
        agentTargetKey: picker.agentTargetKey, ...(accountSources ? { connectedServices: accountSources } : {}),
        ...(picker.selected && !('source' in picker.selected) ? { currentSelection: picker.selected } : {}) });
    if (!accountSources) return <SessionModelPickerContent {...picker} declarationContext={context} />;
    const accountGroups = projection.data?.groups ?? EMPTY_PROJECTION_GROUPS;
    return <SessionModelPickerContent {...picker} declarationContext={context}
        providerGroups={[...picker.providerGroups, ...(picker.includeProviderConnectedAccounts ? accountGroups
            : accountGroups.filter(group => !group.rows.some(row => 'source' in row.ref)))]}
        providerProjectionAuthoritative={picker.providerProjectionAuthoritative && projection.status === 'success'}
        providerProjectionResolving={picker.providerProjectionResolving || projection.status === 'pending'}
        projectionError={projection.error ?? picker.projectionError}
        projectionFailures={[...(picker.projectionFailures ?? []), ...projection.refreshFailures]}
        retryProjection={projection.error ? projection.refresh : picker.retryProjection}
        projectionApproval={projection.pendingApproval ?? picker.projectionApproval}
        probe={mergeOptionPickerProbes([picker.probe, { phase: projection.loading ? 'loading' : 'idle',
            onRefresh: () => { void projection.refresh(); } }])} />;
}

function SessionModelPickerContent(props: SessionModelPickerRenderProps) {
    // "Runs through" can ask the pane to open on one source; the request names the Agent it was made for.
    const handoff = React.useContext(SessionModelSourceBrowseHandoffContext);
    const requested = handoff?.request?.agentTargetKey === props.agentTargetKey
        && (props.sourceBrowse || handoff.request.scope.connectionId === null) ? handoff.request : null;
    const requestedScopeRef = React.useRef(requested?.scope ?? null);
    requestedScopeRef.current = requested?.scope ?? null;
    const [browseScope, setBrowseScope] = React.useState<SessionModelBrowseScope | null>(requestedScopeRef.current);
    const requestKey = requested?.key ?? null;
    React.useEffect(() => {
        setBrowseScope(requestedScopeRef.current);
    }, [requestKey, props.agentTargetKey]);
    const exitBrowse = React.useCallback(() => setBrowseScope(null), []);
    const scope = React.useMemo(() => browseScope ? { scope: browseScope, onExit: exitBrowse } : undefined, [browseScope, exitBrowse]);
    if (browseScope) {
        if (browseScope.connectionId === null) {
            return <SessionModelPickerPane
                {...props}
                providerGroups={EMPTY_PROJECTION_GROUPS}
                projectionError={null}
                projectionFailures={undefined}
                currentSelectionRecovery={null}
                teamCredentialResources={undefined}
                selectedTeamCredentialModel={undefined}
                favoriteEntries={props.favoriteEntries?.filter(entry => !isSessionModelRefSourceBound(entry.ref))}
                scope={scope}
                onSelect={(ref) => {
                    if (browseScope === requested?.scope) requested.onSelect?.();
                    return props.onSelect(ref);
                }}
            />;
        }
        if (props.sourceBrowse) return <SessionModelSourceBrowse picker={props} sourceBrowse={props.sourceBrowse}
            scope={browseScope} onExit={exitBrowse} />;
    }
    // Provider discovery is a separate catalog from the authored native probe. Its failures
    // describe the selected Provider (or an empty picker), never the selected native catalog.
    // Browsing a source above retains that source's own projection and recovery.
    const nativeCatalogSelected = !(props.selected && isSessionModelRefSourceBound(props.selected))
        && !props.selectedTeamCredentialModel
        && (Boolean(props.selected) || props.nativeModels.some((model) => model.value !== 'default'));
    const nativeCatalogReady = nativeCatalogSelected && !props.probe?.failed
        && props.nativeModels.some((model) => model.value !== 'default');
    return <SessionModelPickerPane {...props}
        projectionError={nativeCatalogSelected && (props.projectionError?.connectionId || nativeCatalogReady)
            ? null : props.projectionError}
        projectionFailures={nativeCatalogSelected ? undefined : props.projectionFailures}
        onBrowseSource={props.sourceBrowse ? setBrowseScope : undefined} />;
}

/** One source, in the same pane: its models, the scope bar, nothing committed until a card is picked. */
function SessionModelSourceBrowse(props: Readonly<{
    picker: SessionModelPickerRenderProps;
    sourceBrowse: NonNullable<SessionModelPickerProps['sourceBrowse']>;
    scope: SessionModelBrowseScope & Readonly<{ connectionId: string }>;
    onExit: () => void;
}>) {
    const { picker } = props;
    const sourceUsage = useProviderConnectionUsageForSource({ ...props.sourceBrowse,
        connectionId: props.scope.connectionId, declarationContext: picker.declarationContext, active: true });
    const projection = useProviderModelProjection({
        enabled: true,
        machineId: props.sourceBrowse.machineId,
        serverId: props.sourceBrowse.serverId,
        agentTargetKey: picker.agentTargetKey,
        sourceConnectionId: props.scope.connectionId,
        ...(picker.selected ? { currentSelection: picker.selected } : {}),
    });
    const scope = React.useMemo(() => ({ scope: props.scope, onExit: props.onExit }), [props.onExit, props.scope]);
    const gatewaySlotTitle = useGatewaySlotTitle(projection.data?.groups ?? EMPTY_PROJECTION_GROUPS, props.sourceBrowse.serverId);
    const notes = React.useMemo(() => [t('agentInput.model.nativeSubagentNote')], []);
    const sourceAuthorization = projection.data?.groups.find(group => group.connectionId === props.scope.connectionId)?.authorization;
    const authorizationError = sourceAuthorization?.authorized === false ? sourceAuthorization.error : null;
    return (
        <SessionModelPickerPane
            agentTargetKey={picker.agentTargetKey}
            declarationContext={picker.declarationContext}
            sourceBrowse={picker.sourceBrowse}
            nativeModels={EMPTY_NATIVE_MODELS}
            providerGroups={projection.data?.groups ?? EMPTY_PROJECTION_GROUPS}
            providerProtocols={picker.providerProtocols}
            providerProjectionAuthoritative={projection.status === 'success'}
            providerProjectionResolving={projection.status === 'pending'}
            projectionError={projection.error ?? authorizationError}
            projectionFailures={projection.refreshFailures}
            retryProjection={projection.refresh}
            projectionApproval={projection.pendingApproval}
            allowAutomatic={false}
            canEnterCustomValue={false}
            selected={picker.selected}
            reportedModel={picker.reportedModel}
            favoriteEntries={picker.favoriteEntries?.filter(entry => readSessionModelRefProviderConnectionId(entry.ref) === props.scope.connectionId)}
            favoriteKeys={picker.favoriteKeys}
            favoriteReasoningEffortByKey={picker.favoriteReasoningEffortByKey}
            onToggleFavorite={picker.onToggleFavorite}
            onSelectFavoriteModel={picker.onSelectFavoriteModel}
            onUpdateFavoriteModelReasoningEffort={picker.onUpdateFavoriteModelReasoningEffort}
            favoriteActionVisibility={picker.favoriteActionVisibility}
            notes={notes}
            // One refresh for the whole source: its models and its balance.
            probe={projection.loading || sourceUsage.refreshing
                ? { phase: 'loading' }
                : { phase: 'idle', onRefresh: () => { void projection.refresh(); void sourceUsage.refresh?.(); } }}
            experimentalConfirmation={picker.experimentalConfirmation}
            purpose={picker.purpose}
            fillAvailableSpace={picker.fillAvailableSpace}
            showTitle={picker.showTitle}
            maxHeight={picker.maxHeight}
            heightBehavior={picker.heightBehavior}
            autoFocusInputOnWeb={picker.autoFocusInputOnWeb}
            onRequestClose={picker.onRequestClose}
            multiColumn={picker.multiColumn}
            onSelect={picker.onSelect}
            selectedOptionControls={picker.selectedOptionControls}
            modelOptionOverrides={picker.modelOptionOverrides}
            onSelectOptionControlValue={picker.onSelectOptionControlValue}
            gatewaySlotTitle={gatewaySlotTitle}
            scope={scope}
            sourceUsage={sourceUsage}
        />
    );
}

function SessionModelPickerPane(props: SessionModelPickerRenderProps & Readonly<{
    sourceUsage?: ReturnType<typeof useProviderConnectionUsageForSource>;
    onBrowseSource?: (scope: SessionModelBrowseScope) => void;
    /** While one Gateway is browsed: names the subscription behind each vendor slot so models group by it. */
    gatewaySlotTitle?: (slot: SessionModelGatewaySlot) => string | null;
    /** Set while one source is browsed: the scope bar and its way back to every shown source. */
    scope?: Readonly<{ scope: SessionModelBrowseScope; onExit: () => void }>;
}>) {
    const canConfirmExperimental = Boolean(props.experimentalConfirmation);
    const declarations = useDaemonMergedProjectionInputs({ machineId: props.sourceBrowse?.machineId,
        sections: ['agentsById', 'familiesById.providers'],
        serverId: props.sourceBrowse?.serverId, enabled: props.declarationContext === undefined && Boolean(props.sourceBrowse?.machineId) });
    const projection = declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 : null;
    const declarationContext = React.useMemo(() => props.declarationContext
        ?? providerDeclarationContext(props.sourceBrowse?.machineId, projection),
        [props.declarationContext, props.sourceBrowse?.machineId, projection]);
    const router = useRouter();
    const selectedOptionControls = React.useMemo(() => {
        const selected = props.selectedTeamCredentialModel ?? props.selected;
        if (!selected) return undefined;
        const descriptor = resolveSessionModelSourceDescriptor({
            selected, providerGroups: props.providerGroups, teamCredentialResources: props.teamCredentialResources,
        });
        // Native controls may include runtime-applied/pending state. Source-backed
        // choices instead use their exact catalog descriptor, never a same-id native row.
        if (!isTeamCredentialProviderModelPickerValue(selected) && !isSessionModelRefSourceBound(selected) && !descriptor) {
            return props.selectedOptionControls;
        }
        // A surface must supply editable intent before these declaration-only
        // controls can reflect changes. Runtime native controls retain their own state above.
        if (!props.onSelectOptionControlValue || props.modelOptionOverrides === undefined) return undefined;
        return computeAcpConfigOptionControlsForProvider({
            providerId: props.agentTargetKey,
            configOptions: descriptor?.modelOptions,
            overrides: Object.fromEntries(Object.entries(props.modelOptionOverrides ?? {})
                .map(([id, value]) => [id, { value }])),
        }) ?? undefined;
    }, [props.agentTargetKey, props.modelOptionOverrides, props.onSelectOptionControlValue,
        props.providerGroups, props.selected, props.selectedOptionControls,
        props.selectedTeamCredentialModel, props.teamCredentialResources]);
    const experimentalApprovalHref = props.experimentalConfirmation?.pending
        ? props.experimentalConfirmation.pendingApproval?.href ?? null
        : null;
    const experimentalPendingModelName = props.experimentalConfirmation?.pendingModelName ?? null;
    const experimentalApproval = React.useMemo(() => experimentalApprovalHref ? {
        modelName: experimentalPendingModelName,
        onOpen: () => router.pushRetainingCurrent(experimentalApprovalHref as never),
    } : null, [experimentalApprovalHref, experimentalPendingModelName, router]);
    const sourceUsageApprovalHref = props.sourceUsage?.pendingApproval?.href ?? null;
    const sourceUsageApprovalOpen = React.useMemo(() => sourceUsageApprovalHref
        ? () => router.pushRetainingCurrent(sourceUsageApprovalHref as never)
        : null, [sourceUsageApprovalHref, router]);
    const projectionApprovalHref = props.projectionApproval?.href ?? null;
    const projectionApprovalOpen = React.useMemo(() => projectionApprovalHref
        ? () => router.pushRetainingCurrent(projectionApprovalHref as never)
        : null, [projectionApprovalHref, router]);
    const hostNativeSourceLabel = React.useContext(SessionModelNativeSourceLabelContext);
    const hostApplyTiming = React.useContext(SessionModelApplyTimingContext);
    const nativeSourceLabel = props.nativeSourceLabel ?? hostNativeSourceLabel;
    const baseSections = React.useMemo(() => buildSessionModelPickerSections({
        purpose: props.purpose,
        agentTargetKey: props.agentTargetKey,
        declarationContext,
        nativeModels: props.nativeModels,
        providerGroups: props.providerGroups,
        providerProtocols: props.providerProtocols,
        hiddenNativeModelKeys: props.hiddenNativeModelKeys ?? new Set<string>(),
        canConfirmExperimental,
        providerProjectionAuthoritative: props.providerProjectionAuthoritative,
        selected: props.selected,
        allowAutomatic: props.allowAutomatic,
        clearOption: props.clearOption,
        selectedTeamCredentialModel: props.selectedTeamCredentialModel ?? undefined,
        currentSelectionRecovery: props.currentSelectionRecovery,
        teamCredentialResources: props.teamCredentialResources,
        teamCredentialDisplayNames: props.teamCredentialDisplayNames,
        teamNameById: props.teamNameById,
        homeNameByTeamId: props.homeNameByTeamId,
        teamCredentialResourceStatusByKey: props.teamCredentialResourceStatusByKey,
        onRecoverTeamCredentialResource: props.onRecoverTeamCredentialResource,
        nativeSourceLabel,
        recoverMissingSelection: props.scope === undefined,
        gatewaySlotTitle: props.gatewaySlotTitle,
    }), [
        props.purpose,
        props.agentTargetKey,
        declarationContext,
        props.allowAutomatic,
        props.clearOption,
        nativeSourceLabel,
        props.scope,
        props.gatewaySlotTitle,
        props.currentSelectionRecovery,
        props.hiddenNativeModelKeys,
        props.nativeModels,
        canConfirmExperimental,
        props.providerGroups,
        props.providerProtocols,
        props.providerProjectionAuthoritative,
        props.selected,
        props.selectedTeamCredentialModel,
        props.teamCredentialResources,
        props.teamCredentialDisplayNames,
        props.teamNameById,
        props.homeNameByTeamId,
        props.teamCredentialResourceStatusByKey,
        props.onRecoverTeamCredentialResource,
    ]);
    const reportedModelPresentation = React.useMemo(() => {
        const reportedModel = props.reportedModel;
        if (!reportedModel) {
            return { sections: baseSections, label: null };
        }
        const reportedKey = sessionModelSelectionKey(reportedModel.ref);
        const reportedOption = baseSections
            .flatMap((section) => section.options)
            .find((option) => sessionModelSelectionKey(option.value) === reportedKey);
        const label = reportedOption?.label ?? reportedModel.label ?? reportedModel.ref.modelId;
        const summary = reportedModelSummary(reportedModel.status, label);
        // One mark per state (lab A2 review 4): the check marks the choice; "Running" lives in the header line
        // only. The running row still says so to assistive tech.
        return {
            label,
            sections: baseSections.map((section) => ({
                ...section,
                options: section.options.map((option) => (
                    sessionModelSelectionKey(option.value) === reportedKey
                        ? { ...option, accessibilityLabel: `${option.accessibilityLabel ?? option.label}. ${summary}` }
                        : option
                )),
            })),
        };
    }, [baseSections, props.reportedModel]);
    const sections = React.useMemo(() => {
        const favoriteEntries = props.favoriteEntries ?? [];
        if (favoriteEntries.length === 0) return reportedModelPresentation.sections;

        const optionByKey = new Map(reportedModelPresentation.sections.flatMap((section) => (
            section.options.flatMap(option => section.id === 'current-selection-recovery' && isTeamCredentialProviderModelPickerValue(option.value)
                ? [] : [[favoriteModelPickerKey(option.value), option] as const])
        )));
        const favoriteKeys = new Set<string>();
        const favoriteOptions = favoriteEntries.flatMap((entry) => {
            const value = sessionModelPickerValueFromRef(entry.ref);
            const key = favoriteModelPickerKey(value);
            if (favoriteKeys.has(key)) return [];
            favoriteKeys.add(key);
            // A favourite names the Thinking it was saved with after its name ("Opus 5.5 High", lab r4).
            const effort = entry.reasoningEffort ? formatReasoningEffortTierLabel(entry.reasoningEffort) : undefined;
            const projected = optionByKey.get(key);
            if (projected) return [effort ? { ...projected, labelSuffix: effort } : projected];
            const unavailableReason = 'source' in entry.ref && entry.ref.source === 'team_resource'
                ? retainedTeamModelUnavailableReason(entry.ref, props)
                : undefined;
            return [{
                ...(effort ? { labelSuffix: effort } : {}),
                value,
                label: entry.label ?? entry.ref.modelId,
                searchText: entry.ref.modelId,
                description: unavailableReason ?? entry.description,
                accessibilityLabel: joinHappierFacts(entry.accessibilityLabel ?? entry.label ?? entry.ref.modelId, unavailableReason),
                disabled: true,
            }];
        });
        return [
            {
                id: 'favorites',
                title: t('profiles.groups.favorites'),
                options: favoriteOptions,
            },
            ...reportedModelPresentation.sections.flatMap((section) => {
                const options = section.options.filter((option) => (
                    !favoriteKeys.has(favoriteModelPickerKey(option.value))
                ));
                return options.length > 0 ? [{ ...section, options }] : [];
            }),
        ];
    }, [props.favoriteEntries, props.teamCredentialResources, props.teamCredentialResourceStatusByKey, reportedModelPresentation.sections]);
    // "Built-in" only tells the agent's own models apart from provider and team groups; over the
    // only group it is noise (0.2 had none). A selected account/pool is identity and stays visible.
    // Browsing one source, the scope bar already names it, so
    // its lone group goes unheaded too. A lone Favorites group keeps its label: it still says what
    // the list is.
    const browsing = props.scope !== undefined;
    // With no preference-clear row, the ordinary Session picker still displays null as Automatic.
    const selectedValue = React.useMemo(() => props.selectedTeamCredentialModel ?? props.selected
        ?? (props.clearOption ? null : { agentTargetKey: props.agentTargetKey, providerConnectionId: null, modelId: 'default' }),
    [props.agentTargetKey, props.clearOption, props.selected, props.selectedTeamCredentialModel]);
    const selectedKey = sessionModelSelectionKey(selectedValue);
    const labeledSections = React.useMemo((): ReadonlyArray<SessionModelPickerSection> => {
        // What can run reads first; every model that can't sits in one "Unavailable (n)" group last, each
        // row naming its source and a few words of why (the full reason stays its accessible label). A reason
        // several rows share ("Broker offline") heads their own group instead, said once.
        const folded = foldUnavailableRows<SessionModelPickerOption, SessionModelPickerSection>({
            sections,
            isUnavailable: (option) => option.availability === 'unavailable',
            reason: (option) => option.unavailableReason,
            group: (options, title, reason): SessionModelPickerSection => ({
                // One closed disclosure row each (owner 11-16): what can run stays the list.
                id: reason === null ? 'unavailable' : `unavailable:${reason}`, title, options, collapsible: true }),
            title: t('common.unavailable'),
            present: (option, _section, sharedReason) => ({
                ...option,
                description: sharedReason
                    ? option.source?.label
                    : joinHappierFacts(option.source?.label, option.unavailableReason) || option.description,
                descriptionLines: undefined,
                ...(option.source ? { source: { ...option.source, inDescription: true } } : {}),
            }),
        });
        const suffixed = withSessionModelSourceSuffixes(folded, 'favorites', selectedKey);
        return suffixed.length === 1 && !isSessionModelGatewaySlotSection(suffixed[0]!)
            && ((suffixed[0]!.id === 'native' && !nativeSourceLabel) || browsing)
            ? [{ ...suffixed[0]!, title: undefined }]
            : suffixed;
    }, [browsing, nativeSourceLabel, sections, selectedKey]);
    // The pane's failure line says why the current selection could not be listed; its row does not repeat it.
    const paneSaysUnavailable = props.probe?.failed === true || (props.notes ?? []).includes(t('agentInput.model.unavailable'));
    const selectedAttribution = props.selectedAttribution ?? null;
    // The header names the model the next message uses when it is not the one running (lab A2 review 10).
    const nextModelLabel = props.reportedModel && selectedKey !== sessionModelSelectionKey(props.reportedModel.ref)
        ? baseSections.flatMap(section => section.options)
            .find(option => sessionModelSelectionKey(option.value) === selectedKey)?.label ?? null
        : null;
    const presentedSections = React.useMemo((): ReadonlyArray<SessionModelPickerSection> => {
        const unavailable = t('agentInput.model.unavailable');
        if (!paneSaysUnavailable && selectedAttribution === null) return labeledSections;
        return labeledSections.map((section) => ({ ...section, options: section.options.map((option) => {
            const quiet = paneSaysUnavailable && section.id === 'current-selection-recovery' && option.description === unavailable
                ? { ...option, description: undefined } : option;
            // Provenance lives on the selected picker row only (owner ruling 2026-11-16), never on the chip.
            return selectedAttribution !== null && sessionModelSelectionKey(option.value) === selectedKey
                ? { ...quiet, attribution: selectedAttribution } : quiet;
        }) }));
    }, [labeledSections, paneSaysUnavailable, selectedAttribution, selectedKey]);
    const hiddenSources = props.hiddenSources ?? [];
    const favoriteSlots = React.useMemo(() => assignFavoriteModelSlots(props.favoriteKeys ?? []), [props.favoriteKeys]);
    const favoriteOptions = React.useMemo<OptionPickerFavoriteOptions<SessionModelPickerOptionValue> | undefined>(() => {
        if (!props.favoriteKeys || !props.onToggleFavorite) return undefined;
        const favorites = props.favoriteKeys;
        return {
            values: new Set(presentedSections.flatMap(section => section.options.flatMap(option =>
                favorites.has(favoriteModelPickerKey(option.value)) ? [sessionModelSelectionKey(option.value)] : [],
            ))),
            isFavoritable: (option) => {
                const ref = favoriteModelRefFromPickerValue(option.value);
                return ref !== null && isFavoriteModelRefSelectable(ref);
            },
            onToggle: (option) => {
                const ref = favoriteModelRefFromPickerValue(option.value);
                if (!ref) return;
                const effort = sessionModelSelectionKey(option.value) === selectedKey
                    ? selectedOptionControls?.find(control => control.option.id === PROVIDER_REASONING_EFFORT_OPTION_ID)?.effectiveValue
                    : undefined;
                if ('source' in ref && ref.source === 'team_resource') {
                    props.onToggleFavorite?.(ref, undefined, option.label);
                } else if (typeof effort === 'string') props.onToggleFavorite?.(ref, effort);
                else props.onToggleFavorite?.(ref);
            },
        };
    }, [presentedSections, props.favoriteKeys, props.onToggleFavorite, selectedKey, selectedOptionControls]);
    const customTarget = React.useMemo(() => {
        if (props.canEnterCustomValue === false || (props.selected && 'source' in props.selected)) return null;
        const selectedConnectionId = props.selected?.providerConnectionId ?? null;
        const selectedConnection = selectedConnectionId
            ? props.providerGroups.find((group) => group.connectionId === selectedConnectionId) ?? null
            : null;
        if (selectedConnection?.authorization.authorized
            && providerCatalogPermitsUnlistedModelIdV1({
                manualModelPolicy: selectedConnection.manualModelPolicy,
                agentSupportsFreeformModelIds: selectedConnection.supportsFreeformModelIds,
            })) {
            return {
                kind: 'connection' as const,
                connectionId: selectedConnection.connectionId,
                label: sessionModelConnectionTitle(selectedConnection),
            };
        }
        if (props.canEnterCustomNativeValue) {
            // The Agent's own source names where the id goes; without one, say what the entry does.
            // "Built-in" is only a heading that tells native models apart from provider groups.
            return { kind: 'native' as const, label: nativeSourceLabel || t('agentInput.model.customDescription') };
        }
        const eligibleConnections = props.providerGroups.filter((group) => (
            group.authorization.authorized
            && providerCatalogPermitsUnlistedModelIdV1({
                manualModelPolicy: group.manualModelPolicy,
                agentSupportsFreeformModelIds: group.supportsFreeformModelIds,
            })
        ));
        const onlyEligibleConnection = eligibleConnections.length === 1 ? eligibleConnections[0] : null;
        return onlyEligibleConnection ? {
            kind: 'connection' as const,
            connectionId: onlyEligibleConnection.connectionId,
            label: sessionModelConnectionTitle(onlyEligibleConnection),
        } : null;
    }, [nativeSourceLabel, props.canEnterCustomNativeValue, props.canEnterCustomValue, props.providerGroups, props.selected]);
    // A discovery failure already has its own line (what failed + retry). The generic "discovery
    // is unavailable" note would say the same thing a second time, so it yields to the error line.
    const hasDiscoveryErrorLine = Boolean(props.projectionError) || (props.projectionFailures?.length ?? 0) > 0;
    const unavailableNote = t('agentInput.model.unavailable');
    const notes = React.useMemo(() => {
        const ownNotes = [...(props.notes ?? []), ...(hostApplyTiming?.notes ?? [])];
        return buildSessionModelPickerNotes({
            notes: hasDiscoveryErrorLine
                ? ownNotes.filter((note) => note !== unavailableNote)
                : ownNotes,
            groups: props.providerGroups,
            selected: props.selected,
            suppressionNote: t('settingsProviders.models.connectedServiceSuppressed'),
        });
    }, [hasDiscoveryErrorLine, hostApplyTiming?.notes, props.notes, props.providerGroups, props.selected, unavailableNote]);
    const readConnectedAccountBinding = React.useCallback((ref: Extract<PersonalSessionModelRef, { source: 'connected_account' }>) => {
        const purposeKey = qualifiedPurposeKey(ref.purpose);
        const row = findSessionModelProjectionRow(props.providerGroups, sessionModelSelectionKey(ref));
        return row?.gatewaySlots?.find(slot => qualifiedPurposeKey(slot.purpose) === purposeKey);
    }, [props.providerGroups]);
    const commitSelection = React.useCallback((ref: SessionModelPickerOptionValue) => {
        props.experimentalConfirmation?.clear();
        if (isTeamCredentialProviderModelPickerValue(ref)) {
            return props.onSelectTeamCredentialModel?.(ref);
        }
        if (ref && 'source' in ref) {
            const binding = readConnectedAccountBinding(ref);
            if (binding) return props.onSelect(ref, binding);
            return;
        }
        if (ref && ref.providerConnectionId === null) {
            const row = findSessionModelProjectionRow(props.providerGroups, sessionModelSelectionKey(ref));
            const binding = row?.gatewaySlots?.[0];
            if (binding) return props.onSelect(ref, binding);
        }
        return props.onSelect(!props.clearOption && ref && isNativeAutomaticModelSelectionInputV1(ref) ? null : ref);
    }, [props.clearOption, props.experimentalConfirmation, props.onSelect, props.onSelectTeamCredentialModel, props.providerGroups, readConnectedAccountBinding]);
    // Both a card press and a favorite shortcut use the same confirmation.
    const selectModel = (ref: SessionModelPickerOptionValue, commit = () => commitSelection(ref)) => {
        const resolution = resolveSessionModelPickerSelection({ purpose: props.purpose, groups: props.providerGroups, ref });
        if (resolution.kind === 'select') {
            commit();
            return;
        }
        // One confirmation at a time: while it waits (on its approval too) the row stays put.
        if (props.experimentalConfirmation?.pending) return;
        void props.experimentalConfirmation?.confirm(resolution, commit);
    };
    const hostClose = React.useContext(AgentInputChipPickerCloseContext);
    const close = props.onRequestClose ?? hostClose;
    const selectFavoriteModel = props.onSelectFavoriteModel;
    const favoriteEfforts = props.favoriteReasoningEffortByKey;
    const chooseFavorite = useEventCallback((ref: NonNullable<SessionModelPickerOptionValue>, effort: string | undefined) => {
        if (isTeamCredentialProviderModelPickerValue(ref)) {
            void Promise.resolve(commitSelection(ref)).then(selected => { if (selected !== false) close?.(); });
            return;
        }
        selectModel(ref, () => {
            props.experimentalConfirmation?.clear();
            const binding = 'source' in ref ? readConnectedAccountBinding(ref) : undefined;
            const result = binding
                ? selectFavoriteModel?.(ref, effort, binding)
                : selectFavoriteModel?.(ref, effort);
            void Promise.resolve(result).then((selected) => {
                if (selected) close?.();
            });
        });
    });
    const favoriteBindings = React.useMemo(() => {
        if (!close || favoriteSlots.size === 0) return undefined;
        const options = presentedSections.flatMap(section => section.options);
        const seen = new Set<string>();
        return options.flatMap(option => {
            const ref = option.value;
            if (!ref || option.disabled || option.availability === 'unavailable') return [];
            if (isTeamCredentialProviderModelPickerValue(ref) ? !props.onSelectTeamCredentialModel : !selectFavoriteModel) return [];
            const key = favoriteModelPickerKey(ref);
            const digit = favoriteSlots.get(key);
            if (digit === undefined || seen.has(key)) return [];
            seen.add(key);
            return [{ key, ref, digit }];
        });
    }, [close, favoriteSlots, presentedSections, props.onSelectTeamCredentialModel, selectFavoriteModel]);
    const favoriteSlotByKey = React.useMemo(
        () => favoriteBindings && new Map(favoriteBindings.map(({ ref, digit }) => [sessionModelSelectionKey(ref), digit])),
        [favoriteBindings],
    );
    const quickActionShortcuts = React.useMemo<readonly SelectionListQuickActionShortcut[] | undefined>(
        () => favoriteBindings?.map(({ key, ref, digit }) => ({
            shortcut: `cmd+${digit}`,
            onActivate: () => chooseFavorite(ref, favoriteEfforts?.get(key)),
        })),
        [chooseFavorite, favoriteBindings, favoriteEfforts],
    );
    // Keys only, shown by SelectionList's footer with a hardware keyboard (lab r4-cmd). ⌘1–9 is named only while
    // favourites are bound to digits.
    const bindsFavoriteDigits = Boolean(quickActionShortcuts?.length);
    const footerHints = React.useMemo<readonly SelectionListKeyboardHint[]>(() => [
        { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
        { id: 'choose', label: '↵', description: t('agentInput.model.keyHintChoose') },
        ...(bindsFavoriteDigits ? [{
            id: 'favorite',
            label: `${resolveModModifier(resolveKeyboardPlatform()) === 'meta' ? '⌘' : 'Ctrl+'}1–9`,
            description: t('agentInput.model.keyHintFavorite'),
        }] : []),
        { id: 'close', label: 'esc', description: t('commandPalette.hints.close') },
    ], [bindsFavoriteDigits]);
    const pickSource = useEventCallback((source: SessionModelPickerSource, label: string) => {
        const option = source.state === 'ready'
            ? source.options.find(candidate => candidate.disabled !== true && candidate.availability !== 'unavailable')
            : undefined;
        if (option) return selectModel(option.value);
        if (source.providerConnectionId === null) return;
        // A hidden source offers this model only through browsing it; one that needs sign-in or a key opens its recovery.
        if (source.state === 'ready' && props.onBrowseSource) {
            props.onBrowseSource({ connectionId: source.providerConnectionId, label });
            return;
        }
        router.pushRetainingCurrent(providerConnectionDetailRoute(source.providerConnectionId) as never);
    });
    const updateFavoriteEffort = useEventCallback((ref: PersonalSessionModelRef, effort: string) => {
        props.onUpdateFavoriteModelReasoningEffort?.(ref, effort);
    });
    const selectedRef = props.selectedTeamCredentialModel ?? props.selected;
    const effortControl = selectedOptionControls?.find(control => control.option.id === PROVIDER_REASONING_EFFORT_OPTION_ID);
    const favoriteEffort = props.favoriteReasoningEffortByKey?.get(selectedKey);
    const sessionEffort = typeof effortControl?.effectiveValue === 'string' ? effortControl.effectiveValue : undefined;
    const favoriteSlot = favoriteSlots.get(selectedKey) ?? 0;
    const favoriteEffortLabel = favoriteEffort
        ? effortControl?.option.options?.find(choice => choice.value === favoriteEffort)?.name ?? favoriteEffort
        : null;
    const canUpdateFavorite = Boolean(props.onUpdateFavoriteModelReasoningEffort) && selectedRef !== null
        && !isTeamCredentialProviderModelPickerValue(selectedRef);
    // The selected model's sources, decided once by the grouping selector (PICKER-DATA-1118).
    const projectedSourceGroup = React.useMemo(() => selectSessionModelPickerSourceGroups(presentedSections,
        { agentTargetKey: props.agentTargetKey, hiddenSources: props.hiddenSources ?? [] })
        .find(candidate => candidate.sources.some(source => source.options.some(option => (
            option.source !== undefined && sessionModelSelectionKey(option.value) === selectedKey)))),
    [presentedSections, props.agentTargetKey, props.hiddenSources, selectedKey]);
    const sourceScope = JSON.stringify([props.sourceBrowse?.serverId, props.sourceBrowse?.machineId, selectedKey]);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const settledSource = React.useRef<{
        scope: string;
        accountLifetime: typeof accountLifetime;
        group: typeof projectedSourceGroup;
    } | null>(null);
    const sourceResolving = props.providerProjectionResolving === true;
    React.useLayoutEffect(() => {
        if (!sourceResolving) settledSource.current = { scope: sourceScope, accountLifetime, group: projectedSourceGroup };
    }, [accountLifetime, projectedSourceGroup, sourceResolving, sourceScope]);
    const previousSource = settledSource.current;
    const selectedSourceGroup = sourceResolving
        ? previousSource?.scope === sourceScope && previousSource.accountLifetime === accountLifetime
            ? previousSource.group
            : undefined
        : projectedSourceGroup;
    // A failure line names the source it is about, so two unreachable sources never read as one anonymous line.
    // A failed source has no model group; its name comes from the same connection read the route sources use.
    const failedConnectionIds = [props.projectionError?.connectionId, ...(props.projectionFailures ?? []).map((failure) => failure.connectionId)]
        .filter((id) => id !== undefined);
    const unnamedFailure = failedConnectionIds.some((id) => !props.providerGroups.some((group) => group.connectionId === id));
    // The same connection read names the band's Provider sources through the Runs-through content model.
    const bandListsProviderSources = selectedSourceGroup?.sources.some(source => source.providerConnectionId !== null) === true;
    const sourceConnections = useProviderConnections({
        enabled: (unnamedFailure || bandListsProviderSources) && props.sourceBrowse !== undefined,
        machineId: props.sourceBrowse?.machineId ?? null,
        serverId: props.sourceBrowse?.serverId ?? null,
    });
    const sourceConnectionViews = sourceConnections.data?.connections;
    const routeRows = React.useMemo(() => {
        if (!sourceConnectionViews || !bandListsProviderSources) return undefined;
        const rows = buildSessionRouteSourceRows({ declarationContext: sourceConnections.declarationContext,
            agentTargetKey: props.agentTargetKey, views: sourceConnectionViews, isGateway: () => false,
            shownSources: props.providerGroups, hiddenSources: props.hiddenSources ?? [] });
        return [...rows.gateways, ...rows.providers];
    }, [bandListsProviderSources, props.agentTargetKey, props.hiddenSources, props.providerGroups,
        sourceConnectionViews, sourceConnections.declarationContext]);
    const sourceBrowse = props.sourceBrowse;
    const renderSourceUsage = React.useCallback((source: SessionModelPickerSource) => (
        source.providerConnectionId !== null && sourceBrowse ? (
            <SessionModelBandSourceUsage connectionId={source.providerConnectionId} sourceBrowse={sourceBrowse}
                declarationContext={declarationContext} />
        ) : null
    ), [declarationContext, sourceBrowse]);
    const selectedOptionBand = React.useMemo<OptionPickerSelectedBand | undefined>(() => {
        const group = selectedSourceGroup;
        const sourceLabel = (source: SessionModelPickerSource) => {
            const listed = source.options.find(option => option.source)?.source?.label;
            if (listed) return listed;
            const hidden = props.hiddenSources?.find(candidate => candidate.connectionId === source.providerConnectionId);
            return hidden ? providerConnectionSourceLabel(hidden) : t('settingsProviders.models.builtIn');
        };
        const rows = group ? (
            <SessionModelRunsThrough group={group} selectedKey={selectedKey} sourceLabel={sourceLabel}
                routeRows={routeRows} renderUsage={renderSourceUsage}
                onPick={(source) => { if (!sourceResolving) pickSource(source, sourceLabel(source)); }} />
        ) : undefined;
        const note = favoriteSlot > 0 && favoriteEffortLabel && sessionEffort && favoriteEffort !== sessionEffort
            && canUpdateFavorite && selectedRef !== null && !isTeamCredentialProviderModelPickerValue(selectedRef) ? (
                <SessionModelFavoriteEffortNote slot={favoriteSlot} effortLabel={favoriteEffortLabel}
                    onUpdate={() => updateFavoriteEffort(selectedRef, sessionEffort)} />
            ) : undefined;
        if (!rows && !note) return undefined;
        return { rows, ...(note ? { controlNotes: { [PROVIDER_REASONING_EFFORT_OPTION_ID]: note } } : {}) };
    }, [canUpdateFavorite, favoriteEffort, favoriteEffortLabel, favoriteSlot, pickSource, props.hiddenSources,
        renderSourceUsage, routeRows, selectedKey, selectedRef, selectedSourceGroup, sourceResolving, sessionEffort, updateFavoriteEffort]);
    const failureSubject = (connectionId: string | undefined): string | null => {
        if (!connectionId) return null;
        const group = props.providerGroups.find((candidate) => candidate.connectionId === connectionId);
        if (group) return sessionModelConnectionTitle(group);
        const view = sourceConnectionViews?.find((candidate) => candidate.connectionId === connectionId);
        return view
            ? providerConnectionSourceLabel({ providerName: view.providerName, connectionName: view.displayName,
                connectionRole: view.role, connectionDisplayNameMode: view.displayNameMode })
            : null;
    };
    // The header refresh re-runs this same projection; the error line then only says what failed.
    const projectionLineRetry = props.retryProjection && !props.probe?.onRefresh
        ? async () => { await props.retryProjection?.(); }
        : undefined;
    // Source status closes the pane with the hidden sources (lab rpicker-MP1 footer): an unreachable source
    // is a fact about where models come from, so it never pushes the search and the cards down.
    // Sources failing the same way with the same source-independent recovery (retry) read as one line naming
    // them all; a recovery that opens one source keeps that source's own line.
    const sourceFailureLines: { key: string; error: ProviderErrorV1; subjects: string[] }[] = [];
    for (const failure of [
        ...(props.projectionError ? [{ connectionId: props.projectionError.connectionId, error: props.projectionError }] : []),
        ...(props.projectionFailures ?? []),
    ]) {
        const subject = failureSubject(failure.connectionId);
        const sharedRecovery = failure.error.action === 'retry' || failure.error.action === 'restart_probe';
        const key = sharedRecovery ? `${failure.error.code}:${failure.error.action}` : `source:${failure.connectionId ?? ''}:${failure.error.code}`;
        const line = sourceFailureLines.find((candidate) => candidate.key === key);
        if (line) { if (subject && !line.subjects.includes(subject)) line.subjects.push(subject); }
        else sourceFailureLines.push({ key, error: failure.error, subjects: subject ? [subject] : [] });
    }
    const hiddenSourcesLine = !props.scope && props.onBrowseSource && hiddenSources.length > 0
        ? <SessionModelHiddenSources sources={hiddenSources} onBrowse={props.onBrowseSource} />
        : null;
    const emptyFailureContent = props.scope && !presentedSections.some(section => section.options.length > 0)
        && sourceFailureLines.length > 0 ? <>
            {sourceFailureLines.map(line => <ProviderErrorItems key={line.key} error={line.error}
                size="line" retry={projectionLineRetry} />)}
        </> : undefined;
    const footerContent = hasDiscoveryErrorLine || hiddenSourcesLine ? (
        <>
            {sourceFailureLines.length > 0 && !emptyFailureContent ? (
                <View style={styles.failureLines}>
                    {sourceFailureLines.map((line) => (
                        <ProviderErrorItems
                            presentation="line"
                            key={line.key}
                            error={line.error}
                            subject={line.subjects.length > 0 ? line.subjects.join(', ') : null}
                            retry={projectionLineRetry}
                        />
                    ))}
                </View>
            ) : null}
            {hiddenSourcesLine}
        </>
    ) : undefined;
    const currentSelectionRecovery = props.currentSelectionRecovery
        && sessionModelSelectionKey(props.currentSelectionRecovery.ref) === sessionModelSelectionKey(props.selected)
        ? props.currentSelectionRecovery
        : null;

    return (
        <OptionPickerOverlay<SessionModelPickerOptionValue>
            themeSurface={MODEL_PICKER_THEME_SURFACE}
            selectedOptionControlsSurface={MODEL_PICKER_EFFORT_SURFACE}
            fillAvailableSpace={props.fillAvailableSpace}
            showTitle={props.showTitle}
            maxHeight={props.maxHeight}
            heightBehavior={props.heightBehavior}
            autoFocusInputOnWeb={props.autoFocusInputOnWeb ?? Boolean(quickActionShortcuts?.length)}
            onRequestClose={props.onRequestClose}
            quickActionShortcuts={quickActionShortcuts}
            footerHints={footerHints}
            favoriteActionVisibility={props.favoriteActionVisibility}
            multiColumn={props.multiColumn}
            title={props.scope ? props.scope.scope.label : t('agentInput.model.title')}
            titleLeading={props.scope ? <SessionModelSourceBack onExit={props.scope.onExit} /> : undefined}
            notes={notes}
            options={[]}
            sections={presentedSections}
            selectedValue={selectedValue}
            nothingSelected={props.mixedSelection !== undefined}
            getValueKey={sessionModelSelectionKey}
            emptyText={t('settingsProviders.models.empty')}
            emptyContent={emptyFailureContent}
            headerAccessory={props.headerAccessory}
            footerContent={footerContent}
            {...(customTarget ? {
                canEnterCustomValue: true as const,
                customLabel: t('modelPickerOverlay.customTitle'),
                customDescription: customTarget.label,
                getCustomValue: (value: SessionModelPickerOptionValue) => value?.modelId ?? null,
                onSubmitCustomValue: (modelId: string) => commitSelection({
                    agentTargetKey: props.agentTargetKey,
                    providerConnectionId: customTarget.kind === 'connection' ? customTarget.connectionId : null,
                    modelId,
                }),
            } : { canEnterCustomValue: false as const })}
            favoriteOptions={favoriteOptions && { ...favoriteOptions, shortcutSlotByKey: favoriteSlotByKey }}
            probe={hasDiscoveryErrorLine && props.probe?.failed && !props.probe.failureCause
                ? { ...props.probe, failed: false } : props.probe}
            // Keep the handler stable even when a source declares no controls:
            // it owns the popup's ARIA pattern, independently of the selected row.
            selectedOptionControls={selectedOptionControls}
            onSelectOptionControlValue={props.onSelectOptionControlValue}
            selectedOptionBand={selectedOptionBand}
            summary={reportedModelPresentation.label
                || props.mixedSelection
                || currentSelectionRecovery
                || (props.scope && props.sourceUsage)
                || projectionApprovalOpen
                || experimentalApproval
                || props.experimentalConfirmation?.error ? (
                <>
                    {props.mixedSelection ? (
                        <ReportedModelSummary
                            status="running"
                            modelLabel={props.mixedSelection.label}
                            applyTiming={props.mixedSelection.applyTiming ?? hostApplyTiming?.timing}
                        />
                    ) : props.reportedModel && reportedModelPresentation.label ? (
                        <ReportedModelSummary
                            status={props.reportedModel.status}
                            modelLabel={reportedModelPresentation.label}
                            nextModelLabel={nextModelLabel}
                            applyTiming={hostApplyTiming?.timing}
                        />
                    ) : null}
                    {currentSelectionRecovery ? (
                        <ProviderErrorItems presentation="line" error={currentSelectionRecovery.error} />
                    ) : null}
                    {projectionApprovalOpen ? (
                        <ActionApprovalPendingNotice
                            testID="model-picker-projection-approval"
                            presentation="line"
                            message={t('settingsProvidersCollection.approvalPendingTitle')}
                            openLabel={t('settingsProvidersCollection.openApproval')}
                            onOpenApproval={projectionApprovalOpen}
                        />
                    ) : null}
                    {experimentalApproval ? (
                        <ActionApprovalPendingNotice
                            testID="model-picker-experimental-approval"
                            presentation="line"
                            summary={experimentalApproval.modelName}
                            message={t('settingsProvidersCollection.approvalPendingTitle')}
                            openLabel={t('settingsProvidersCollection.openApproval')}
                            onOpenApproval={experimentalApproval.onOpen}
                        />
                    ) : null}
                    {props.experimentalConfirmation?.error ? (
                        <ProviderErrorItems
                            presentation="line"
                            error={props.experimentalConfirmation.error}
                            retry={props.experimentalConfirmation.retry
                                ? async () => { await props.experimentalConfirmation?.retry?.(); }
                                : undefined}
                        />
                    ) : null}
                    {props.scope && props.sourceUsage && props.scope.scope.connectionId !== null ? (
                        <SessionModelSourceUsage
                            usage={props.sourceUsage}
                            onOpenApproval={sourceUsageApprovalOpen}
                            onOpenConnection={() => router.pushRetainingCurrent(
                                providerConnectionDetailRoute(props.scope!.scope.connectionId!) as never,
                            )}
                        />
                    ) : null}
                </>
            ) : undefined}
            onSelect={(ref) => selectModel(ref)}
        />
    );
}

/** The chosen Provider source's usage line in the band: the existing per-source read, mounted only while shown. */
function SessionModelBandSourceUsage(props: Readonly<{
    connectionId: string;
    sourceBrowse: NonNullable<SessionModelPickerProps['sourceBrowse']>;
    declarationContext?: ProviderDeclarationContext;
}>) {
    const router = useRouter();
    const usage = useProviderConnectionUsageForSource({ ...props.sourceBrowse, connectionId: props.connectionId,
        declarationContext: props.declarationContext, active: true });
    const approvalHref = usage.pendingApproval?.href ?? null;
    const openApproval = React.useMemo(() => approvalHref
        ? () => router.pushRetainingCurrent(approvalHref as never) : null, [approvalHref, router]);
    const openConnection = React.useCallback(() => router.pushRetainingCurrent(
        providerConnectionDetailRoute(props.connectionId) as never), [props.connectionId, router]);
    return <SessionModelSourceUsage usage={usage} onOpenApproval={openApproval} onOpenConnection={openConnection} />;
}

const styles = StyleSheet.create(() => ({
    /** Status lines stand on the cards' text edge, inside the pane's scrolling end. */
    failureLines: { paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX },
}));
