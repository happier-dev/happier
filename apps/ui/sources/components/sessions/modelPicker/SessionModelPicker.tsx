import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from '@/components/ui/selectionList/_constants';
import { providerDeclarationContext, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { providerCatalogPermitsUnlistedModelIdV1 } from '@happier-dev/protocol/providers/catalog/merge';
import type { ProviderBoundModelRef, ProviderErrorV1 } from '@happier-dev/protocol';
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
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { useProviderConnectionUsageForSource } from '@/providers/hooks/useProviderConnectionUsageForSource';
import { providerConnectionSourceLabel } from '@/providers/session/resolveSessionRoutePresentation';
import {
    OptionPickerOverlay,
    type OptionPickerFavoriteOptions,
    type OptionPickerProbeState,
} from '@/components/sessions/pickers/OptionPickerOverlay';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { computeAcpConfigOptionControlsForProvider } from '@/sync/domains/sessionControl/configOptionsControl';
import type { SelectionListHeightBehavior } from '@/components/ui/selectionList';
import { t } from '@/text';
import {
    buildSessionModelPickerSections,
    resolveSessionModelSourceDescriptor,
    isSessionModelGatewaySlotSection,
    sessionModelConnectionTitle,
    withSessionModelSourceSuffixes,
    type SessionModelPickerSection,
    type SessionModelGatewaySlot,
    type SessionModelProjectionGroup,
    type SessionNativeModelOption,
} from './buildSessionModelPickerSections';
import { useGatewaySlotTitle } from './useGatewaySlotTitle';
import { SessionModelSourceUsage } from './SessionModelSourceUsage';
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
    sessionModelSelectionKey,
    type SessionModelPickerOptionValue,
    type SessionModelPickerValue,
} from './sessionModelSelectionKey';
import {
    ReportedModelStatusIcon,
    ReportedModelSummary,
    reportedModelSummary,
    type ReportedModelStatus,
} from './reportedModelPresentation';

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
    ref: ProviderBoundModelRef;
    label?: string;
    description?: string;
    accessibilityLabel?: string;
}>;

export function buildSessionModelPickerNotes(input: Readonly<{
    notes: readonly string[];
    groups: readonly Pick<SessionModelProjectionGroup, 'connectionId' | 'suppressedConnectedServiceIds'>[];
    selected: SessionModelPickerValue;
    suppressionNote: string;
}>): readonly string[] {
    const selectedConnectionId = input.selected?.providerConnectionId ?? null;
    const suppressesConnectedServices = selectedConnectionId !== null && input.groups.some(
        (group) => group.connectionId === selectedConnectionId && group.suppressedConnectedServiceIds.length > 0,
    );
    return suppressesConnectedServices
        ? [...input.notes, input.suppressionNote]
        : input.notes;
}

export function resolveSessionModelPickerSelection(input: Readonly<{
    groups: readonly SessionModelProjectionGroup[];
    ref: SessionModelPickerOptionValue;
}>): SessionModelPickerExperimentalConfirmation | Readonly<{ kind: 'select'; ref: SessionModelPickerOptionValue }> {
    if (input.ref === null) return { kind: 'select', ref: null };
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
                modelId: row.compatibility.result.confirmationScope.kind === 'model' ? row.ref.modelId : null,
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
    agentTargetKey: string;
    declarationContext?: ProviderDeclarationContext;
    nativeModels: readonly SessionNativeModelOption[];
    providerGroups: readonly SessionModelProjectionGroup[];
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamNameById?: Readonly<Record<string, string>>;
    homeNameByTeamId?: Readonly<Record<string, string>>;
    currentTeamCredentialResourceKeys?: ReadonlySet<string>;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    providerProjectionAuthoritative: boolean;
    projectionError?: ProviderErrorV1 | null;
    projectionFailures?: readonly DaemonProviderModelProjectionRefreshFailureV1[];
    retryProjection?: (() => Promise<void> | void) | null;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys?: ReadonlySet<string>;
    /** Default `true`; `false` drops the automatic option (a model-restricted embed). */
    allowAutomatic?: boolean;
    selected: SessionModelPickerValue;
    reportedModel?: Readonly<{
        ref: NonNullable<SessionModelPickerOptionValue>;
        label?: string;
        status: ReportedModelStatus;
    }> | null;
    canEnterCustomNativeValue?: boolean;
    /** `false` removes custom entry for both native and Provider models in a restricted presentation. */
    canEnterCustomValue?: boolean;
    notes?: readonly string[];
    probe?: OptionPickerProbeState;
    headerAccessory?: React.ReactNode;
    favoriteEntries?: readonly SessionModelPickerFavoriteEntry[];
    favoriteKeys?: ReadonlySet<string>;
    onToggleFavorite?: (ref: ProviderBoundModelRef) => void;
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
    onSelect: (ref: SessionModelPickerValue) => void;
    onSelectTeamCredentialModel?: (selection: TeamCredentialProviderModelSelectionV1) => void;
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
export function SessionModelPicker(props: SessionModelPickerProps) {
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
                favoriteEntries={props.favoriteEntries?.filter(entry => entry.ref.providerConnectionId === null)}
                scope={scope}
            />;
        }
        if (props.sourceBrowse) return <SessionModelSourceBrowse picker={props} sourceBrowse={props.sourceBrowse}
            scope={browseScope} onExit={exitBrowse} />;
    }
    // A global, non-authoritative Provider projection cannot declare the Agent's discovered native
    // catalog unavailable. Keep connection-specific failures and Provider-selection recovery intact.
    const projectionError = !props.providerProjectionAuthoritative
        && props.projectionError?.code === 'provider_catalog_unavailable'
        && !props.projectionError.connectionId
        && !props.selected?.providerConnectionId
        && !props.selectedTeamCredentialModel
        && props.nativeModels.some((model) => model.value !== 'default')
        ? null
        : props.projectionError;
    return <SessionModelPickerPane {...props} projectionError={projectionError}
        onBrowseSource={props.sourceBrowse ? setBrowseScope : undefined} />;
}

/** One source, in the same pane: its models, the scope bar, nothing committed until a card is picked. */
function SessionModelSourceBrowse(props: Readonly<{
    picker: SessionModelPickerProps;
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
    return (
        <SessionModelPickerPane
            agentTargetKey={picker.agentTargetKey}
            declarationContext={picker.declarationContext}
            sourceBrowse={picker.sourceBrowse}
            nativeModels={EMPTY_NATIVE_MODELS}
            providerGroups={projection.data?.groups ?? EMPTY_PROJECTION_GROUPS}
            providerProjectionAuthoritative={projection.status === 'success'}
            projectionError={projection.error}
            projectionFailures={projection.refreshFailures}
            retryProjection={projection.refresh}
            allowAutomatic={false}
            canEnterCustomValue={false}
            selected={picker.selected}
            reportedModel={picker.reportedModel}
            favoriteKeys={picker.favoriteKeys}
            onToggleFavorite={picker.onToggleFavorite}
            favoriteActionVisibility={picker.favoriteActionVisibility}
            notes={notes}
            // One refresh for the whole source: its models and its balance.
            probe={projection.loading || sourceUsage.refreshing
                ? { phase: 'loading' }
                : { phase: 'idle', onRefresh: () => { void projection.refresh(); void sourceUsage.refresh?.(); } }}
            experimentalConfirmation={picker.experimentalConfirmation}
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

function SessionModelPickerPane(props: SessionModelPickerProps & Readonly<{
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
        // Native controls may include runtime-applied/pending state. Source-backed
        // choices instead use their exact catalog descriptor, never a same-id native row.
        if (!isTeamCredentialProviderModelPickerValue(selected) && !selected.providerConnectionId) {
            return props.selectedOptionControls;
        }
        // A surface must supply editable intent before these declaration-only
        // controls can reflect changes. Runtime native controls retain their own state above.
        if (!props.onSelectOptionControlValue || props.modelOptionOverrides === undefined) return undefined;
        const descriptor = resolveSessionModelSourceDescriptor({
            selected, providerGroups: props.providerGroups, teamCredentialResources: props.teamCredentialResources,
        });
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
    const hostNativeSourceLabel = React.useContext(SessionModelNativeSourceLabelContext);
    const hostApplyTiming = React.useContext(SessionModelApplyTimingContext);
    const nativeSourceLabel = props.nativeSourceLabel ?? hostNativeSourceLabel;
    const baseSections = React.useMemo(() => buildSessionModelPickerSections({
        agentTargetKey: props.agentTargetKey,
        declarationContext,
        nativeModels: props.nativeModels,
        providerGroups: props.providerGroups,
        hiddenNativeModelKeys: props.hiddenNativeModelKeys ?? new Set<string>(),
        canConfirmExperimental,
        providerProjectionAuthoritative: props.providerProjectionAuthoritative,
        selected: props.selected,
        allowAutomatic: props.allowAutomatic,
        selectedTeamCredentialModel: props.selectedTeamCredentialModel ?? undefined,
        currentSelectionRecovery: props.currentSelectionRecovery,
        teamCredentialResources: props.teamCredentialResources,
        teamNameById: props.teamNameById,
        homeNameByTeamId: props.homeNameByTeamId,
        currentTeamCredentialResourceKeys: props.currentTeamCredentialResourceKeys,
        onRecoverTeamCredentialResource: props.onRecoverTeamCredentialResource,
        nativeSourceLabel,
        recoverMissingSelection: props.scope === undefined,
        gatewaySlotTitle: props.gatewaySlotTitle,
    }), [
        props.agentTargetKey,
        declarationContext,
        props.allowAutomatic,
        nativeSourceLabel,
        props.scope,
        props.gatewaySlotTitle,
        props.currentSelectionRecovery,
        props.hiddenNativeModelKeys,
        props.nativeModels,
        canConfirmExperimental,
        props.providerGroups,
        props.providerProjectionAuthoritative,
        props.selected,
        props.selectedTeamCredentialModel,
        props.teamCredentialResources,
        props.teamNameById,
        props.homeNameByTeamId,
        props.currentTeamCredentialResourceKeys,
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
        return {
            label,
            sections: baseSections.map((section) => ({
                ...section,
                options: section.options.map((option) => (
                    sessionModelSelectionKey(option.value) === reportedKey
                        ? {
                            ...option,
                            trailingStatusIcon: (
                                <ReportedModelStatusIcon
                                    status={reportedModel.status}
                                />
                            ),
                            accessibilityLabel: `${option.accessibilityLabel ?? option.label}. ${summary}`,
                        }
                        : option
                )),
            })),
        };
    }, [baseSections, props.reportedModel]);
    const sections = React.useMemo(() => {
        const favoriteEntries = props.favoriteEntries ?? [];
        if (favoriteEntries.length === 0) return reportedModelPresentation.sections;

        const optionByKey = new Map(reportedModelPresentation.sections.flatMap((section) => (
            section.options.map((option) => [sessionModelSelectionKey(option.value), option] as const)
        )));
        const favoriteKeys = new Set<string>();
        const favoriteOptions = favoriteEntries.flatMap((entry) => {
            const key = sessionModelSelectionKey(entry.ref);
            if (favoriteKeys.has(key)) return [];
            favoriteKeys.add(key);
            const projected = optionByKey.get(key);
            return [{
                value: entry.ref,
                source: projected?.source,
                label: projected?.label ?? entry.label ?? entry.ref.modelId,
                searchText: projected?.searchText ?? entry.ref.modelId,
                description: projected?.description ?? entry.description,
                accessibilityLabel: projected?.accessibilityLabel ?? entry.accessibilityLabel,
                disabled: projected ? projected.disabled : true,
                trailingStatusIcon: projected?.trailingStatusIcon,
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
                    !favoriteKeys.has(sessionModelSelectionKey(option.value))
                ));
                return options.length > 0 ? [{ ...section, options }] : [];
            }),
        ];
    }, [props.favoriteEntries, reportedModelPresentation.sections]);
    // "Built-in" only tells the agent's own models apart from provider and team groups; over the
    // only group it is noise (0.2 had none). A selected account/pool is identity and stays visible.
    // Browsing one source, the scope bar already names it, so
    // its lone group goes unheaded too. A lone Favorites group keeps its label: it still says what
    // the list is.
    const browsing = props.scope !== undefined;
    const labeledSections = React.useMemo((): ReadonlyArray<SessionModelPickerSection> => {
        const suffixed = withSessionModelSourceSuffixes(sections, 'favorites');
        return suffixed.length === 1 && !isSessionModelGatewaySlotSection(suffixed[0]!)
            && ((suffixed[0]!.id === 'native' && !nativeSourceLabel) || browsing)
            ? [{ ...suffixed[0]!, title: undefined }]
            : suffixed;
    }, [browsing, nativeSourceLabel, sections]);
    // The pane's failure line says why the current selection could not be listed; its row does not repeat it.
    const paneSaysUnavailable = props.probe?.failed === true || (props.notes ?? []).includes(t('agentInput.model.unavailable'));
    const presentedSections = React.useMemo((): ReadonlyArray<SessionModelPickerSection> => {
        if (!paneSaysUnavailable) return labeledSections;
        const unavailable = t('agentInput.model.unavailable');
        return labeledSections.map((section) => section.id === 'current-selection-recovery'
            ? { ...section, options: section.options.map((option) => option.description === unavailable
                ? { ...option, description: undefined }
                : option) }
            : section);
    }, [labeledSections, paneSaysUnavailable]);
    const hiddenSources = props.hiddenSources ?? [];
    const favoriteOptions = React.useMemo<OptionPickerFavoriteOptions<SessionModelPickerOptionValue> | undefined>(() => {
        if (!props.favoriteKeys || !props.onToggleFavorite) return undefined;
        return {
            values: props.favoriteKeys,
            isFavoritable: (option) => option.value !== null && !isTeamCredentialProviderModelPickerValue(option.value),
            onToggle: (option) => {
                if (option.value && !isTeamCredentialProviderModelPickerValue(option.value)) props.onToggleFavorite?.(option.value);
            },
        };
    }, [props.favoriteKeys, props.onToggleFavorite]);
    const customTarget = React.useMemo(() => {
        if (props.canEnterCustomValue === false) return null;
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
    const commitSelection = React.useCallback((ref: SessionModelPickerOptionValue) => {
        props.experimentalConfirmation?.clear();
        if (isTeamCredentialProviderModelPickerValue(ref)) {
            props.onSelectTeamCredentialModel?.(ref);
            return;
        }
        props.onSelect(ref);
    }, [props.experimentalConfirmation, props.onSelect, props.onSelectTeamCredentialModel]);
    // A failure line names the source it is about, so two unreachable sources never read as one anonymous line.
    // A failed source has no model group; its name comes from the same connection read the route sources use.
    const failedConnectionIds = [props.projectionError?.connectionId, ...(props.projectionFailures ?? []).map((failure) => failure.connectionId)]
        .filter((id) => id !== undefined);
    const unnamedFailure = failedConnectionIds.some((id) => !props.providerGroups.some((group) => group.connectionId === id));
    const failedSourceConnections = useProviderConnections({
        enabled: unnamedFailure && props.sourceBrowse !== undefined,
        machineId: props.sourceBrowse?.machineId ?? null,
        serverId: props.sourceBrowse?.serverId ?? null,
    });
    const failureSubject = (connectionId: string | undefined): string | null => {
        if (!connectionId) return null;
        const group = props.providerGroups.find((candidate) => candidate.connectionId === connectionId);
        if (group) return sessionModelConnectionTitle(group);
        const view = failedSourceConnections.data?.connections.find((candidate) => candidate.connectionId === connectionId);
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
    const footerContent = hasDiscoveryErrorLine || hiddenSourcesLine ? (
        <>
            {sourceFailureLines.length > 0 ? (
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
            fillAvailableSpace={props.fillAvailableSpace}
            showTitle={props.showTitle}
            maxHeight={props.maxHeight}
            heightBehavior={props.heightBehavior}
            autoFocusInputOnWeb={props.autoFocusInputOnWeb}
            onRequestClose={props.onRequestClose}
            favoriteActionVisibility={props.favoriteActionVisibility}
            multiColumn={props.multiColumn}
            title={props.scope ? props.scope.scope.label : t('agentInput.model.title')}
            titleLeading={props.scope ? <SessionModelSourceBack onExit={props.scope.onExit} /> : undefined}
            notes={notes}
            options={[]}
            sections={presentedSections}
            selectedValue={props.selectedTeamCredentialModel ?? props.selected}
            getValueKey={sessionModelSelectionKey}
            emptyText={t('settingsProviders.models.empty')}
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
            favoriteOptions={favoriteOptions}
            probe={hasDiscoveryErrorLine && props.probe?.failed ? { ...props.probe, failed: false } : props.probe}
            // Keep the handler stable even when a source declares no controls:
            // it owns the popup's ARIA pattern, independently of the selected row.
            selectedOptionControls={selectedOptionControls}
            onSelectOptionControlValue={props.onSelectOptionControlValue}
            summary={reportedModelPresentation.label
                || currentSelectionRecovery
                || (props.scope && props.sourceUsage)
                || experimentalApproval
                || props.experimentalConfirmation?.error ? (
                <>
                    {props.reportedModel && reportedModelPresentation.label ? (
                        <ReportedModelSummary
                            status={props.reportedModel.status}
                            modelLabel={reportedModelPresentation.label}
                            applyTiming={hostApplyTiming?.timing}
                        />
                    ) : null}
                    {currentSelectionRecovery ? (
                        <ProviderErrorItems presentation="line" error={currentSelectionRecovery.error} />
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
            onSelect={(ref) => {
                const resolution = resolveSessionModelPickerSelection({ groups: props.providerGroups, ref });
                if (resolution.kind === 'select') {
                    commitSelection(resolution.ref);
                    return;
                }
                // One confirmation at a time: while it waits (on its approval too) the row stays put.
                if (props.experimentalConfirmation?.pending) return;
                void props.experimentalConfirmation?.confirm(resolution, () => commitSelection(ref));
            }}
        />
    );
}

const styles = StyleSheet.create(() => ({
    /** Status lines stand on the cards' text edge, inside the pane's scrolling end. */
    failureLines: { paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX },
}));
