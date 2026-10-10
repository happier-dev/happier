import * as React from 'react';
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
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import {
    OptionPickerOverlay,
    type OptionPickerFavoriteOptions,
    type OptionPickerProbeState,
} from '@/components/sessions/pickers/OptionPickerOverlay';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import type { SelectionListHeightBehavior } from '@/components/ui/selectionList';
import { t } from '@/text';
import {
    buildSessionModelPickerSections,
    sessionModelConnectionTitle,
    withSessionModelSourceSuffixes,
    type SessionModelPickerSection,
    type SessionModelProjectionGroup,
    type SessionNativeModelOption,
} from './buildSessionModelPickerSections';
import {
    SessionModelHiddenSourcesLine,
    SessionModelSourceScopeBar,
    type SessionModelBrowseScope,
    type SessionModelHiddenSource,
} from './SessionModelSourceScope';
import { SessionModelNativeSourceLabelContext, SessionModelSourceBrowseHandoffContext } from './SessionModelSourceBrowseHandoff';
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
    expectedConnectionRevision: number;
    agentTargetKey: string;
    modelId: string;
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
                expectedConnectionRevision: group.connectionRevision,
                agentTargetKey: row.ref.agentTargetKey,
                modelId: row.ref.modelId,
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
    effectiveLabel: string;
    reportedModel?: Readonly<{
        ref: ProviderBoundModelRef;
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
    const requested = props.sourceBrowse && handoff?.request?.agentTargetKey === props.agentTargetKey ? handoff.request : null;
    const requestedScopeRef = React.useRef(requested?.scope ?? null);
    requestedScopeRef.current = requested?.scope ?? null;
    const [browseScope, setBrowseScope] = React.useState<SessionModelBrowseScope | null>(requestedScopeRef.current);
    const requestKey = requested?.key ?? null;
    React.useEffect(() => {
        if (requestedScopeRef.current) setBrowseScope(requestedScopeRef.current);
    }, [requestKey]);
    const exitBrowse = React.useCallback(() => setBrowseScope(null), []);
    if (browseScope && props.sourceBrowse) {
        return <SessionModelSourceBrowse picker={props} sourceBrowse={props.sourceBrowse} scope={browseScope} onExit={exitBrowse} />;
    }
    return <SessionModelPickerPane {...props} onBrowseSource={props.sourceBrowse ? setBrowseScope : undefined} />;
}

/** One source, in the same pane: its models, the scope bar, nothing committed until a card is picked. */
function SessionModelSourceBrowse(props: Readonly<{
    picker: SessionModelPickerProps;
    sourceBrowse: NonNullable<SessionModelPickerProps['sourceBrowse']>;
    scope: SessionModelBrowseScope;
    onExit: () => void;
}>) {
    const { picker } = props;
    const projection = useProviderModelProjection({
        enabled: true,
        machineId: props.sourceBrowse.machineId,
        serverId: props.sourceBrowse.serverId,
        agentTargetKey: picker.agentTargetKey,
        sourceConnectionId: props.scope.connectionId,
        ...(picker.selected ? { currentSelection: picker.selected } : {}),
    });
    const scope = React.useMemo(() => ({ scope: props.scope, onExit: props.onExit }), [props.onExit, props.scope]);
    const notes = React.useMemo(() => [t('agentInput.model.nativeSubagentNote')], []);
    return (
        <SessionModelPickerPane
            agentTargetKey={picker.agentTargetKey}
            nativeModels={EMPTY_NATIVE_MODELS}
            providerGroups={projection.data?.groups ?? EMPTY_PROJECTION_GROUPS}
            providerProjectionAuthoritative={projection.status === 'success'}
            projectionError={projection.error}
            projectionFailures={projection.refreshFailures}
            retryProjection={projection.refresh}
            allowAutomatic={false}
            canEnterCustomValue={false}
            selected={picker.selected}
            effectiveLabel={picker.effectiveLabel}
            reportedModel={picker.reportedModel}
            notes={notes}
            probe={projection.loading
                ? { phase: 'loading' }
                : { phase: 'idle', onRefresh: () => { void projection.refresh(); } }}
            experimentalConfirmation={picker.experimentalConfirmation}
            fillAvailableSpace={picker.fillAvailableSpace}
            showTitle={picker.showTitle}
            maxHeight={picker.maxHeight}
            heightBehavior={picker.heightBehavior}
            autoFocusInputOnWeb={picker.autoFocusInputOnWeb}
            onRequestClose={picker.onRequestClose}
            multiColumn={picker.multiColumn}
            onSelect={picker.onSelect}
            scope={scope}
        />
    );
}

function SessionModelPickerPane(props: SessionModelPickerProps & Readonly<{
    onBrowseSource?: (scope: SessionModelBrowseScope) => void;
    /** Set while one source is browsed: the scope bar and its way back to every shown source. */
    scope?: Readonly<{ scope: SessionModelBrowseScope; onExit: () => void }>;
}>) {
    const canConfirmExperimental = Boolean(props.experimentalConfirmation);
    const hostNativeSourceLabel = React.useContext(SessionModelNativeSourceLabelContext);
    const nativeSourceLabel = props.nativeSourceLabel ?? hostNativeSourceLabel;
    const baseSections = React.useMemo(() => buildSessionModelPickerSections({
        agentTargetKey: props.agentTargetKey,
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
    }), [
        props.agentTargetKey,
        props.allowAutomatic,
        nativeSourceLabel,
        props.scope,
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
    // only group it is noise (0.2 had none). A lone Favorites group keeps its label: it still says
    // what the list is.
    const labeledSections = React.useMemo((): ReadonlyArray<SessionModelPickerSection> => {
        const suffixed = withSessionModelSourceSuffixes(sections, 'favorites');
        return suffixed.length === 1 && suffixed[0]!.id === 'native'
            ? [{ ...suffixed[0]!, title: undefined }]
            : suffixed;
    }, [sections]);
    const hiddenSources = props.hiddenSources ?? [];
    const footerContent = !props.scope && props.onBrowseSource && hiddenSources.length > 0 ? (
        <SessionModelHiddenSourcesLine sources={hiddenSources} onBrowse={props.onBrowseSource} />
    ) : undefined;
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
            return { kind: 'native' as const, label: t('settingsProviders.models.builtIn') };
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
    }, [props.canEnterCustomNativeValue, props.canEnterCustomValue, props.providerGroups, props.selected]);
    // A discovery failure already has its own line (what failed + retry). The generic "discovery
    // is unavailable" note would say the same thing a second time, so it yields to the error line.
    const hasDiscoveryErrorLine = Boolean(props.projectionError) || (props.projectionFailures?.length ?? 0) > 0;
    const unavailableNote = t('agentInput.model.unavailable');
    const notes = React.useMemo(() => buildSessionModelPickerNotes({
        notes: hasDiscoveryErrorLine
            ? (props.notes ?? []).filter((note) => note !== unavailableNote)
            : props.notes ?? [],
        groups: props.providerGroups,
        selected: props.selected,
        suppressionNote: t('settingsProviders.models.connectedServiceSuppressed'),
    }), [hasDiscoveryErrorLine, props.notes, props.providerGroups, props.selected, unavailableNote]);
    const commitSelection = React.useCallback((ref: SessionModelPickerOptionValue) => {
        props.experimentalConfirmation?.clear();
        if (isTeamCredentialProviderModelPickerValue(ref)) {
            props.onSelectTeamCredentialModel?.(ref);
            return;
        }
        props.onSelect(ref);
    }, [props.experimentalConfirmation, props.onSelect, props.onSelectTeamCredentialModel]);
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
            title={t('agentInput.model.title')}
            effectiveLabel={props.effectiveLabel}
            notes={notes}
            options={[]}
            sections={labeledSections}
            selectedValue={props.selectedTeamCredentialModel ?? props.selected}
            getValueKey={sessionModelSelectionKey}
            emptyText={t('settingsProviders.models.empty')}
            headerAccessory={props.headerAccessory}
            footerContent={footerContent}
            {...(props.scope ? { searchPlaceholder: t('agentInput.model.searchSource', { source: props.scope.scope.label }) } : {})}
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
            // A provider-connection model has no ACP config options, so the
            // CONTROL SET is withdrawn for it. That suppression lives here, on
            // the data, because "which options does this model expose" is a
            // fact about the selection.
            //
            // The HANDLER is not withdrawn with it. It states that this surface
            // is WIRED for inline row controls, which is a fact about the
            // surface and never about the current selection — and it is what
            // `OptionPickerOverlay` declares the popup's ARIA pattern from. A
            // handler that appeared and disappeared with the selection made
            // that declaration selection-derived, so picking a provider-
            // connection model flipped a live popup from `grid` to `listbox`.
            // With no controls to render, the handler is simply never called.
            selectedOptionControls={props.selected?.providerConnectionId
                ? undefined
                : props.selectedOptionControls}
            onSelectOptionControlValue={props.onSelectOptionControlValue}
            summary={reportedModelPresentation.label
                || currentSelectionRecovery
                || props.projectionError
                || (props.projectionFailures?.length ?? 0) > 0
                || props.scope
                || props.experimentalConfirmation?.error ? (
                <>
                    {props.reportedModel && reportedModelPresentation.label ? (
                        <ReportedModelSummary
                            status={props.reportedModel.status}
                            modelLabel={reportedModelPresentation.label}
                        />
                    ) : null}
                    {currentSelectionRecovery ? (
                        <ProviderErrorItems presentation="line" error={currentSelectionRecovery.error} />
                    ) : null}
                    {props.projectionError ? (
                        <ProviderErrorItems
                            presentation="line"
                            error={props.projectionError}
                            retry={props.retryProjection
                                ? async () => { await props.retryProjection?.(); }
                                : undefined}
                        />
                    ) : null}
                    {props.projectionFailures?.map((failure) => (
                        <ProviderErrorItems
                            presentation="line"
                            key={failure.connectionId}
                            error={failure.error}
                            retry={props.retryProjection
                                ? async () => { await props.retryProjection?.(); }
                                : undefined}
                        />
                    ))}
                    {props.experimentalConfirmation?.error ? (
                        <ProviderErrorItems
                            presentation="line"
                            error={props.experimentalConfirmation.error}
                            retry={props.experimentalConfirmation.retry
                                ? async () => { await props.experimentalConfirmation?.retry?.(); }
                                : undefined}
                        />
                    ) : null}
                    {props.scope ? <SessionModelSourceScopeBar scope={props.scope.scope} onExit={props.scope.onExit} /> : null}
                </>
            ) : undefined}
            onSelect={(ref) => {
                const resolution = resolveSessionModelPickerSelection({ groups: props.providerGroups, ref });
                if (resolution.kind === 'select') {
                    commitSelection(resolution.ref);
                    return;
                }
                void props.experimentalConfirmation?.confirm(resolution, () => commitSelection(ref));
            }}
        />
    );
}
