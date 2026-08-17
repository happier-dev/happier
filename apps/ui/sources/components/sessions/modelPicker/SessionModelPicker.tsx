import * as React from 'react';
import type { ProviderBoundModelRef, ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';

import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
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
    type SessionModelProjectionGroup,
    type SessionNativeModelOption,
} from './buildSessionModelPickerSections';
import {
    sessionModelSelectionKey,
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
    ref: SessionModelPickerValue;
}>): SessionModelPickerExperimentalConfirmation | Readonly<{ kind: 'select'; ref: SessionModelPickerValue }> {
    if (input.ref === null) return { kind: 'select', ref: null };
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

export function SessionModelPicker(props: Readonly<{
    agentTargetKey: string;
    nativeModels: readonly SessionNativeModelOption[];
    providerGroups: readonly SessionModelProjectionGroup[];
    providerProjectionAuthoritative: boolean;
    projectionError?: ProviderErrorV1 | null;
    retryProjection?: (() => Promise<void> | void) | null;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys?: ReadonlySet<string>;
    selected: SessionModelPickerValue;
    effectiveLabel: string;
    reportedModel?: Readonly<{
        ref: ProviderBoundModelRef;
        label?: string;
        status: ReportedModelStatus;
    }> | null;
    canEnterCustomNativeValue?: boolean;
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
}>) {
    const canConfirmExperimental = Boolean(props.experimentalConfirmation);
    const baseSections = React.useMemo(() => buildSessionModelPickerSections({
        agentTargetKey: props.agentTargetKey,
        nativeModels: props.nativeModels,
        providerGroups: props.providerGroups,
        hiddenNativeModelKeys: props.hiddenNativeModelKeys ?? new Set<string>(),
        canConfirmExperimental,
        providerProjectionAuthoritative: props.providerProjectionAuthoritative,
        selected: props.selected,
        currentSelectionRecovery: props.currentSelectionRecovery,
    }), [
        props.agentTargetKey,
        props.currentSelectionRecovery,
        props.hiddenNativeModelKeys,
        props.nativeModels,
        canConfirmExperimental,
        props.providerGroups,
        props.providerProjectionAuthoritative,
        props.selected,
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
    const favoriteOptions = React.useMemo<OptionPickerFavoriteOptions<SessionModelPickerValue> | undefined>(() => {
        if (!props.favoriteKeys || !props.onToggleFavorite) return undefined;
        return {
            values: props.favoriteKeys,
            isFavoritable: (option) => option.value !== null,
            onToggle: (option) => {
                if (option.value) props.onToggleFavorite?.(option.value);
            },
        };
    }, [props.favoriteKeys, props.onToggleFavorite]);
    const customTarget = React.useMemo(() => {
        const selectedConnectionId = props.selected?.providerConnectionId ?? null;
        const selectedConnection = selectedConnectionId
            ? props.providerGroups.find((group) => group.connectionId === selectedConnectionId) ?? null
            : null;
        if (selectedConnection?.authorization.authorized
            && selectedConnection.manualModelPolicy === 'allowed'
            && selectedConnection.supportsFreeformModelIds) {
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
            && group.manualModelPolicy === 'allowed'
            && group.supportsFreeformModelIds
        ));
        const onlyEligibleConnection = eligibleConnections.length === 1 ? eligibleConnections[0] : null;
        return onlyEligibleConnection ? {
            kind: 'connection' as const,
            connectionId: onlyEligibleConnection.connectionId,
            label: sessionModelConnectionTitle(onlyEligibleConnection),
        } : null;
    }, [props.canEnterCustomNativeValue, props.providerGroups, props.selected]);
    const notes = React.useMemo(() => buildSessionModelPickerNotes({
        notes: props.notes ?? [],
        groups: props.providerGroups,
        selected: props.selected,
        suppressionNote: t('settingsProviders.models.connectedServiceSuppressed'),
    }), [props.notes, props.providerGroups, props.selected]);
    const commitSelection = React.useCallback((ref: SessionModelPickerValue) => {
        props.experimentalConfirmation?.clear();
        props.onSelect(ref);
    }, [props.experimentalConfirmation, props.onSelect]);
    const currentSelectionRecovery = props.currentSelectionRecovery
        && sessionModelSelectionKey(props.currentSelectionRecovery.ref) === sessionModelSelectionKey(props.selected)
        ? props.currentSelectionRecovery
        : null;

    return (
        <OptionPickerOverlay<SessionModelPickerValue>
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
            sections={sections}
            selectedValue={props.selected}
            getValueKey={sessionModelSelectionKey}
            emptyText={t('settingsProviders.models.empty')}
            headerAccessory={props.headerAccessory}
            {...(customTarget ? {
                canEnterCustomValue: true as const,
                customLabel: t('modelPickerOverlay.customTitle'),
                customDescription: customTarget.label,
                getCustomValue: (value: SessionModelPickerValue) => value?.modelId ?? null,
                onSubmitCustomValue: (modelId: string) => commitSelection({
                    agentTargetKey: props.agentTargetKey,
                    providerConnectionId: customTarget.kind === 'connection' ? customTarget.connectionId : null,
                    modelId,
                }),
            } : { canEnterCustomValue: false as const })}
            favoriteOptions={favoriteOptions}
            probe={props.probe}
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
                || props.experimentalConfirmation?.error ? (
                <>
                    {props.reportedModel && reportedModelPresentation.label ? (
                        <ReportedModelSummary
                            status={props.reportedModel.status}
                            modelLabel={reportedModelPresentation.label}
                        />
                    ) : null}
                    {currentSelectionRecovery ? (
                        <ProviderErrorItems error={currentSelectionRecovery.error} />
                    ) : null}
                    {props.projectionError ? (
                        <ProviderErrorItems
                            error={props.projectionError}
                            retry={props.retryProjection
                                ? async () => { await props.retryProjection?.(); }
                                : undefined}
                        />
                    ) : null}
                    {props.experimentalConfirmation?.error ? (
                        <ProviderErrorItems
                            error={props.experimentalConfirmation.error}
                            retry={props.experimentalConfirmation.retry
                                ? async () => { await props.experimentalConfirmation?.retry?.(); }
                                : undefined}
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
                void props.experimentalConfirmation?.confirm(resolution, () => commitSelection(ref));
            }}
        />
    );
}
