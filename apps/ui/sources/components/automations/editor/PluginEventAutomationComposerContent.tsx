import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { useInstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { getPluginExecutionOriginCandidateOrigin, getPluginExecutionOriginCandidateVersion } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { PluginPresentedExecutionOriginProjectionDemand, readPluginPresentedExecutionOriginProjectionTargets } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';
import type { PluginEventAutomationWatcherFailure } from './pluginEventAutomationObservationBinding';
import { resolvePluginExecutionOriginReasonDetail as originReasonDetail } from '@/sync/domains/surfaces/copy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useMachineDisplayNamesById, useServerScopedMachineLabel } from '@/sync/store/hooks';
import { Text } from '@/components/ui/text/Text';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import {
    SelectionList,
    type SelectionListOption,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { t } from '@/text';

import type {
    PluginEventAutomationComposerModel,
    PluginEventAutomationPluginPresentation,
} from './usePluginEventAutomationComposer';
import { eventAutomationComposerStyles as styles } from './eventAutomationComposerStyles';
import { AutomationEventFilterFields, useEventComposerPickerDisclosure } from './AutomationEventFilterFields';

type Props = Readonly<{
    model: PluginEventAutomationComposerModel;
    watcherOnly?: boolean;
}>;

function watcherKey(origin: PluginMachineExecutionOriginV1): string {
    return 'materializationRef' in origin ? `${origin.materializationRef.machineId}:${origin.materializationRef.materializationId}`
        : JSON.stringify(origin);
}

/** The watcher's raw identity: support's words, shown only under Technical details. */
function watcherTechnicalId(origin: PluginMachineExecutionOriginV1): string {
    const ref = getPluginMachineExecutionOriginRef(origin);
    return `${ref.machineId} / ${'materializationRef' in origin ? origin.materializationRef.materializationId : ref.pluginId}`;
}

/** Why a watcher cannot observe the selected Event, in the Machines picker's words. */
function watcherFailureDetail(failure: PluginEventAutomationWatcherFailure): string {
    return failure.reason === 'observer_binding_unavailable'
        ? t('automations.form.trigger.watcherCannotObserve')
        : originReasonDetail(failure.reason);
}

/** A settings remedy is named by the page it opens, as the settings rail names it. */
function settingsRemedy(path: string): Readonly<{ id: string; path: string; title: string }> {
    const page = flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).find((node) => node.route === path);
    return { id: page?.id ?? path, path, title: page?.titleKey ? t(page.titleKey) : t('modals.openSettings') };
}

function EventPluginBrand(props: Readonly<{
    presentation: PluginEventAutomationPluginPresentation;
    testID: string;
}>) {
    const scope = React.useMemo(
        () => new AbortController(),
        [
            props.presentation.eventKey,
            props.presentation.expectedOccurrenceId,
            props.presentation.machineId,
            props.presentation.serverId,
        ],
    );
    React.useEffect(() => () => scope.abort(), [scope]);
    const brand = useInstalledPluginBrandPresentation({
        installedPackage: props.presentation.installedPackage,
        machineId: props.presentation.machineId,
        serverId: props.presentation.serverId,
        signal: scope.signal,
        accountLifetime: props.presentation.accountLifetime,
        isCurrent: props.presentation.isCurrent,
    });
    return brand ? (
        <HappierBrandMark
            brand={brand}
            externallyLabelled
            size="small"
            testID={props.testID}
        />
    ) : null;
}

function formatPayloadSample(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '';
    }
}

/**
 * The Event branch of the incumbent Automation popover. It owns only
 * transient control presentation; Event discovery, setup input, Action
 * dispatch, watcher freshness, and durable writes remain with their
 * canonical owners.
 */
export function PluginEventAutomationComposerContent(props: Props) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [eventPickerOpen, setEventPickerOpen] = React.useState(false);
    const [watcherPickerOpen, setWatcherPickerOpen] = React.useState(false);
    const [filterFieldPickerOpenFor, setFilterFieldPickerOpenFor] = React.useState<string | null>(null);
    const [filterOperatorPickerOpenFor, setFilterOperatorPickerOpenFor] = React.useState<string | null>(null);
    const collapseAllPickers = React.useCallback(() => {
        setEventPickerOpen(false);
        setWatcherPickerOpen(false);
        setFilterFieldPickerOpenFor(null);
        setFilterOperatorPickerOpenFor(null);
    }, []);
    const {
        pickerTriggerRef,
        notePickerCollapsed,
        notePickerTriggerPressed,
    } = useEventComposerPickerDisclosure({
        anyPickerOpen: eventPickerOpen
            || watcherPickerOpen
            || filterFieldPickerOpenFor !== null
            || filterOperatorPickerOpenFor !== null,
        collapseAllPickers,
    });
    const selectedEvent = props.model.selectedEvent;
    const catalogMachineLabel = useServerScopedMachineLabel(props.model.catalogServerId, props.model.catalogMachineId);
    const selectedWatcher = props.model.selectedWatcherOrigin;
    // A watcher is a Machine to the person: named as the Machine list names it (name · short suffix).
    const watcherMachineIds = React.useMemo(() => [
        ...props.model.watcherCandidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).machineId),
        ...(selectedWatcher ? [getPluginMachineExecutionOriginRef(selectedWatcher).machineId] : []),
    ], [props.model.watcherCandidates, selectedWatcher]);
    const watcherMachineNames = useMachineDisplayNamesById(watcherMachineIds,
        props.model.catalogServerId ? { serverId: props.model.catalogServerId } : {});
    const watcherDisplayLabel = React.useCallback((origin: PluginMachineExecutionOriginV1): string =>
        watcherMachineNames[getPluginMachineExecutionOriginRef(origin).machineId] ?? t('machine.unnamedMachine'), [watcherMachineNames]);
    const observationPlacementTitle = props.watcherOnly ? t('projects.deployments.services.checkFrom')
        : props.model.observationTransport === 'durablePush'
        ? t('automations.detail.event.observationPlacementTitle')
        : t('automations.detail.event.watcherTitle');
    const chooseObservationPlacement = props.watcherOnly ? t('projects.open.chooseMachine')
        : props.model.observationTransport === 'durablePush'
        ? t('automations.detail.event.observationPlacementTitle')
        : t('automations.form.trigger.chooseWatcher');
    const selectedEventAvailability = selectedEvent
        ? props.model.getPluginPresentation(selectedEvent).availability
        : null;
    // Index producer-supplied facts without deriving eligibility again. Full
    // origins keep equal Machine ids on different Homes distinct.
    const watcherFailureByOrigin = React.useMemo(() => new Map((props.model.watcherFailures ?? []).map(failure => [
        createCanonicalJsonSigningInput(failure.origin), failure,
    ])), [props.model.watcherFailures]);
    const selectedWatcherCurrent = selectedWatcher === null || props.model.eventCatalogStatus === 'loading'
        ? null
        : props.model.watcherCandidates.some((candidate) => {
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            return arePluginMachineExecutionOriginsEqual(origin, selectedWatcher)
                && !watcherFailureByOrigin.has(createCanonicalJsonSigningInput(origin));
        });
    const eventOptionByKey = React.useMemo(() => new Map(props.model.eligibleEvents.map((event) => {
        const presentation = props.model.getPluginPresentation(event);
        return [presentation.eventKey, event] as const;
    })), [props.model.eligibleEvents, props.model.getPluginPresentation]);
    const eventSelectionOptions = React.useMemo<ReadonlyArray<SelectionListOption>>(
        () => props.model.eligibleEvents.map((event) => {
            const plugin = props.model.getPluginPresentation(event);
            const presentation = props.model.getEventPresentation(event);
            return {
                id: plugin.eventKey,
                testID: `automation-event-option-${event.event.id}`,
                label: presentation.title,
                subtitle: [presentation.description, plugin.displayName].filter(Boolean).join(' · '),
                subtitleLines: 2,
                // The descriptor name leads; the raw Event id stays findable by search.
                searchText: event.event.id,
                exactSearchText: event.event.id,
                accessibilityLabel: [presentation.title, plugin.displayName].filter(Boolean).join(', '),
                icon: (
                    <EventPluginBrand
                        presentation={plugin}
                        testID={`automation-event-plugin-brand-${event.event.id}`}
                    />
                ),
                // Healthy is quiet: only a source that cannot be chosen says so.
                ...(plugin.availability === 'available' ? {} : { rightAccessory: t(plugin.availability === 'loading' ? 'common.loading' : 'common.unavailable') }),
                disabled: plugin.availability !== 'available',
            };
        }),
        [props.model.eligibleEvents, props.model.getPluginPresentation, props.model.getEventPresentation],
    );
    const eventSelectionStep = React.useMemo<SelectionListStep>(() => ({
        id: 'automation-events',
        inputPlaceholder: t('automations.form.trigger.searchEvents'),
        emptyStateLabel: t('automations.form.trigger.noEligibleEvents'),
        sections: [{
            kind: 'static',
            id: 'events',
            options: eventSelectionOptions,
            virtualization: 'force',
        }],
    }), [eventSelectionOptions]);
    const watcherOptionByKey = React.useMemo(
        () => new Map(props.model.watcherCandidates.map((candidate) => [
            watcherKey(getPluginExecutionOriginCandidateOrigin(candidate)),
            candidate,
        ])),
        [props.model.watcherCandidates],
    );
    const watcherProjectionTargets = React.useMemo(() => readPluginPresentedExecutionOriginProjectionTargets(props.model.watcherCandidates),
        [props.model.watcherCandidates]);
    const watcherSelectionOptions = React.useMemo<ReadonlyArray<SelectionListOption>>(
        // Machines that can watch lead; the ones that can't follow with their reason (PAGE-ACCEPT-176 R10-D3).
        () => props.model.watcherCandidates.map((candidate) => {
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            const key = watcherKey(origin);
            const version = getPluginExecutionOriginCandidateVersion(candidate);
            const failure = watcherFailureByOrigin.get(createCanonicalJsonSigningInput(origin)) ?? null;
            return {
                id: key,
                testID: `automation-event-watcher-option-${key}`,
                label: watcherDisplayLabel(origin),
                // The Machines picker's own reason words, ahead of the version they qualify.
                subtitle: props.watcherOnly ? (failure ? watcherFailureDetail(failure) : undefined)
                    : failure ? `${watcherFailureDetail(failure)} · ${version}` : version,
                subtitleLines: failure ? 2 : 1,
                disabled: failure !== null,
            };
        }).sort((left, right) => Number(left.disabled) - Number(right.disabled)),
        [props.model.watcherCandidates, props.watcherOnly, watcherFailureByOrigin, watcherDisplayLabel],
    );
    // An unavailable row cannot carry its own control (a disabled row disables its secondary
    // actions), so the settings pages that fix them follow the list, once per page. A transient
    // failure recovers on the pushed machine state and earns no control.
    const watcherSettingsRemedies = React.useMemo(() => {
        const paths = new Set<string>();
        for (const failure of watcherFailureByOrigin.values()) {
            if (failure.remediation.kind === 'openSettings') paths.add(failure.remediation.path);
        }
        return [...paths].map(settingsRemedy);
    }, [watcherFailureByOrigin]);
    const watcherSelectionStep = React.useMemo<SelectionListStep>(() => ({
        id: 'automation-event-watchers',
        inputPlaceholder: chooseObservationPlacement,
        emptyStateLabel: props.watcherOnly ? t('runs.noMachinesAvailable') : t('automations.form.trigger.noEligibleWatchers'),
        sections: [{
            kind: 'static',
            id: 'watchers',
            options: watcherSelectionOptions,
            virtualization: 'force',
        }],
    }), [chooseObservationPlacement, props.watcherOnly, watcherSelectionOptions]);
    // Preserve the selected draft so the user can recover by choosing a
    // replacement source or watcher, but never make an out-of-date binding
    // look actionable while the writer is correctly refusing it.
    const sourceCurrentnessUnavailable = selectedEventAvailability === 'unavailable'
        || selectedWatcherCurrent === false;
    const sourceSetupDisabled = props.model.sourceStatus === 'settingUp'
        || selectedWatcher === null
        || selectedEventAvailability !== 'available'
        || selectedWatcherCurrent !== true
        || !props.model.filterValid
        || !props.model.maximumObservationAgeMsValid;
    const sourceDisplayText = sourceCurrentnessUnavailable
        ? t('automations.form.trigger.sourceUnavailable')
        : props.model.sourceStatus === 'configured'
            ? props.model.sourceDisplayLabel ?? t('automations.form.trigger.sourceConfigured')
            : props.model.sourceStatus === 'settingUp'
                ? t('common.loading')
                : t('automations.form.trigger.configureSource');
    const sourceUnavailable = props.model.eventCatalogStatus !== 'loading'
        && (props.model.sourceStatus === 'unavailable' || sourceCurrentnessUnavailable);
    const sourceFailureDetails = sourceUnavailable && props.model.sourceFailure ? (
        <TechnicalDetailsDisclosure testID="automation-event-source-unavailable.details"
            title={t('workflows.run.technicalDetails')}
            lines={[
                { key: 'code', label: t('workflows.run.technical.failureCode'), value: props.model.sourceFailure.code },
                { key: 'reason', label: t('workflows.run.technical.failureCause'), value: props.model.sourceFailure.reason },
            ]} />
    ) : null;
    const sourceSettingsPath = props.model.sourceFailure?.remediation?.kind === 'openSettings'
        ? props.model.sourceFailure.remediation.path
        : null;
    const sourceSetupHint = sourceUnavailable
        ? t('automations.form.trigger.sourceUnavailable')
        : !props.model.filterValid
            ? t('automations.form.trigger.eventFilterInvalid')
            : !props.model.maximumObservationAgeMsValid
                ? t('automations.form.trigger.maximumObservationAgeInvalid')
                : undefined;
    const showSourceInstanceId = props.model.sourceStatus === 'configured'
        && selectedEventAvailability === 'available' && selectedWatcherCurrent === true
        && props.model.sourceInstanceId !== null;
    // The one-time secret is disclosed by the ensure that configured this
    // source. Keeping it tied to `configured` means a reconfiguration cannot
    // leave a stale credential on screen next to a new endpoint, and requiring
    // live source currentness means an out-of-date event/watcher binding — the
    // shape an Account or target change leaves behind — stops disclosing it.
    const webhookEndpoint = props.model.sourceStatus === 'configured'
        && selectedEventAvailability === 'available' && selectedWatcherCurrent === true
        ? props.model.webhookEndpoint
        : null;


    const watcherPicker = props.watcherOnly || (props.model.eventCatalogStatus === 'ready' && selectedEvent)
        || watcherPickerOpen
        || (props.model.pendingEventRef && props.model.watcherCandidates.length > 0) ? (
        <>
            {props.watcherOnly ? null : <Text style={styles.fieldLabel}>{observationPlacementTitle}</Text>}
            <HappierPressable
                testID="automation-event-watcher-picker"
                accessibilityRole="button"
                accessibilityLabel={observationPlacementTitle}
                expanded={watcherPickerOpen}
                controlRef={pickerTriggerRef('watcher')}
                onPress={() => {
                    notePickerTriggerPressed('watcher', watcherPickerOpen);
                    setWatcherPickerOpen((current) => !current);
                }}
                style={({ pressed }) => [styles.selectTrigger, pressed ? styles.pressed : null]}
            >
                <Text numberOfLines={1} style={styles.selectTriggerText}>
                    {selectedWatcher
                        ? watcherDisplayLabel(selectedWatcher)
                        : chooseObservationPlacement}
                </Text>
                <Icon
                    name={watcherPickerOpen ? 'caret-up' : 'caret-down'}
                    size={14}
                    color={theme.colors.text.secondary}
                />
            </HappierPressable>
            {watcherPickerOpen ? (
                <View testID="automation-event-watcher-picker-options" style={styles.optionList}>
                    <PluginPresentedExecutionOriginProjectionDemand
                        key={selectedEvent?.event.identity.pluginId ?? props.model.pendingEventRef?.pluginId}
                        targets={watcherProjectionTargets}
                    />
                    <SelectionList
                        rootStep={watcherSelectionStep}
                        listAccessibilityLabel={observationPlacementTitle}
                        selectedOptionId={selectedWatcher
                            ? watcherKey(selectedWatcher)
                            : null}
                        onSelect={(key) => {
                            const candidate = watcherOptionByKey.get(key);
                            if (!candidate) return;
                            props.model.selectWatcher(candidate);
                            notePickerCollapsed('watcher');
                            setWatcherPickerOpen(false);
                        }}
                        onRequestClose={() => {
                            notePickerCollapsed('watcher');
                            setWatcherPickerOpen(false);
                        }}
                        keyboardHintsEnabled={false}
                        autoFocusInputOnWeb
                        disableTransitions
                        maxHeight={300}
                        testID="automation-event-watcher-selection-list"
                        inputTestID="automation-event-watcher-search"
                    />
                    {watcherSettingsRemedies.length > 0 ? (
                        <View testID="automation-event-watcher-remedies" style={styles.watcherRemedies}>
                            <Text style={styles.optionDescription}>
                                {t('automations.form.trigger.fixUnavailableWatchers')}
                            </Text>
                            <View style={styles.watcherRemedyActions}>
                                {watcherSettingsRemedies.map((remedy) => (
                                    <RoundButton
                                        key={remedy.id}
                                        testID={`automation-event-watcher-remedy-${remedy.id}`}
                                        size="mini"
                                        display="secondary"
                                        title={remedy.title}
                                        trailing={<Icon name="caret-right" size={12} color={theme.colors.text.secondary} />}
                                        onPress={() => router.push(remedy.path as never)}
                                    />
                                ))}
                            </View>
                        </View>
                    ) : null}
                </View>
            ) : null}

        </>
    ) : null;
    if (props.watcherOnly) return watcherPicker;

    return (
        <View testID="automation-event-composer" style={styles.section}>
                <View style={styles.eventFields}>
                    {props.model.eventCatalogStatus !== 'ready' ? (
                        <Text testID="automation-event-catalog-status" style={styles.unavailableText}>
                            {props.model.eventCatalogStatus === 'idle'
                                // Only a saved push endpoint waits on placement; anything else waits on a Machine.
                                ? props.model.observationTransport === 'durablePush'
                                    ? chooseObservationPlacement
                                    : t('automations.form.trigger.eventCatalogNeedsMachine')
                                : t(props.model.eventCatalogStatus === 'loading'
                                    ? 'automations.form.trigger.eventCatalogLoading'
                                    : 'automations.form.trigger.eventCatalogUnavailable')}
                        </Text>
                    ) : props.model.eligibleEvents.length === 0 && !selectedEvent ? (
                        // The Machine's catalog is the owner's answer: name it and offer that Machine's Store, not an empty picker.
                        <View testID="automation-event-catalog-empty" style={styles.watcherRemedies}>
                            <Text style={styles.unavailableText}>
                                {catalogMachineLabel
                                    ? t('automations.form.trigger.noEventSourcesOnMachine', { machine: catalogMachineLabel })
                                    : t('automations.form.trigger.noEligibleEvents')}
                            </Text>
                            <View style={styles.watcherRemedyActions}>
                                <RoundButton
                                    testID="automation-event-add-from-store"
                                    size="mini"
                                    display="secondary"
                                    title={t('automations.form.trigger.addFromStore')}
                                    trailing={<Icon name="caret-right" size={12} color={theme.colors.text.secondary} />}
                                    onPress={() => router.push(buildPluginsHomeRoute('app', {
                                        machine: props.model.catalogMachineId && props.model.catalogServerId
                                            ? { serverId: props.model.catalogServerId, machineId: props.model.catalogMachineId } : null,
                                    }) as never)}
                                />
                            </View>
                        </View>
                    ) : (
                        <>
                            <Text style={styles.fieldLabel}>{t('automations.form.trigger.eventSource')}</Text>
                            <HappierPressable
                                testID="automation-event-picker"
                                accessibilityRole="button"
                                expanded={eventPickerOpen}
                                controlRef={pickerTriggerRef('event')}
                                onPress={() => {
                                    notePickerTriggerPressed('event', eventPickerOpen);
                                    setEventPickerOpen((current) => !current);
                                }}
                                style={({ pressed }) => [styles.selectTrigger, pressed ? styles.pressed : null]}
                            >
                                <Text numberOfLines={1} style={styles.selectTriggerText}>
                                    {selectedEvent ? props.model.getEventPresentation(selectedEvent).title : t('automations.form.trigger.chooseEvent')}
                                </Text>
                                <Icon
                                    name={eventPickerOpen ? 'caret-up' : 'caret-down'}
                                    size={14}
                                    color={theme.colors.text.secondary}
                                />
                            </HappierPressable>
                            {eventPickerOpen ? (
                                <View testID="automation-event-picker-options" style={styles.optionList}>
                                    <SelectionList
                                        rootStep={eventSelectionStep}
                                        listAccessibilityLabel={t('automations.form.trigger.eventSource')}
                                        selectedOptionId={selectedEvent
                                            ? props.model.getPluginPresentation(selectedEvent).eventKey
                                            : null}
                                        onSelect={(eventKey) => {
                                            const event = eventOptionByKey.get(eventKey);
                                            if (!event) return;
                                            props.model.selectEvent(event);
                                            notePickerCollapsed('event');
                                            setEventPickerOpen(false);
                                            setWatcherPickerOpen(false);
                                        }}
                                        onRequestClose={() => {
                                            notePickerCollapsed('event');
                                            setEventPickerOpen(false);
                                        }}
                                        keyboardHintsEnabled={false}
                                        autoFocusInputOnWeb
                                        disableTransitions
                                        maxHeight={320}
                                        testID="automation-event-selection-list"
                                        inputTestID="automation-event-search"
                                    />
                                </View>
                            ) : null}

                        </>
                    )}
                            {watcherPicker}
                            {props.model.eventCatalogStatus === 'ready' && selectedEvent ? (
                                <>
                                    {props.model.availableObservationTransports.length > 1 ? (
                                        <>
                                            <Text style={styles.fieldLabel}>
                                                {t('automations.form.trigger.observationTransport')}
                                            </Text>
                                            <View testID="automation-event-observation-transport" style={styles.targetRow}>
                                                {props.model.availableObservationTransports.map((kind) => {
                                                    const selected = props.model.observationTransport === kind;
                                                    return (
                                                        <HappierPressable
                                                            key={kind}
                                                            testID={`automation-event-observation-${kind}`}
                                                            accessibilityRole="button"
                                                            selected={selected}
                                                            onPress={() => props.model.setObservationTransport(kind)}
                                                            style={({ pressed }) => [
                                                                styles.targetButton,
                                                                selected ? styles.targetButtonSelected : null,
                                                                pressed ? styles.pressed : null,
                                                            ]}
                                                        >
                                                            <Text numberOfLines={1} style={styles.targetButtonText}>
                                                                {kind === 'durablePush'
                                                                    ? t('automations.form.trigger.observationDurablePush')
                                                                    : kind === 'socket'
                                                                        ? t('automations.form.trigger.observationSocket')
                                                                        : t('automations.form.trigger.observationCheckpointedPull')}
                                                            </Text>
                                                        </HappierPressable>
                                                    );
                                                })}
                                            </View>
                                        </>
                                    ) : null}

                                    <Text style={styles.fieldLabel}>{t('automations.form.trigger.source')}</Text>
                                    <HappierPressable
                                        testID="automation-event-configure-source"
                                        accessibilityRole="button"
                                        accessibilityHint={sourceSetupHint}
                                        busy={props.model.sourceStatus === 'settingUp'}
                                        disabled={sourceSetupDisabled}
                                        onPress={props.model.configureSource}
                                        style={({ pressed }) => [
                                            styles.selectTrigger,
                                            sourceSetupDisabled ? styles.disabled : null,
                                            pressed ? styles.pressed : null,
                                        ]}
                                    >
                                        <Text style={styles.selectTriggerText}>
                                            {sourceDisplayText}
                                        </Text>
                                        <Icon name="gear" size={14} color={theme.colors.text.secondary} />
                                    </HappierPressable>
                                    {sourceUnavailable ? (
                                        <Text
                                            testID="automation-event-source-unavailable"
                                            accessibilityRole="alert"
                                            accessibilityLiveRegion="polite"
                                            style={styles.unavailableText}
                                        >
                                            {t('automations.form.trigger.sourceUnavailable')}
                                        </Text>
                                    ) : null}
                                    {sourceFailureDetails}
                                    {sourceSettingsPath ? (
                                        <HappierPressable
                                            testID="automation-event-source-open-settings"
                                            accessibilityRole="button"
                                            onPress={() => router.push(sourceSettingsPath as never)}
                                            style={({ pressed }) => [
                                                styles.sourceRemediation,
                                                pressed ? styles.pressed : null,
                                            ]}
                                        >
                                            <Icon name="gear" size={14} color={theme.colors.accent.blue} />
                                            <Text style={styles.sourceRemediationText}>
                                                {t('modals.openSettings')}
                                            </Text>
                                        </HappierPressable>
                                    ) : null}
                                    {showSourceInstanceId ? (
                                        <Text numberOfLines={1} style={styles.optionDescription}>
                                            {props.model.sourceInstanceId}
                                        </Text>
                                    ) : null}
                                    {webhookEndpoint ? (
                                        <View testID="automation-event-webhook-endpoint" style={styles.webhookEndpoint}>
                                            <Text style={styles.webhookEndpointTitle}>
                                                {t('automations.form.trigger.webhookEndpointTitle')}
                                            </Text>
                                            <Text style={styles.webhookEndpointInstructions}>
                                                {t('automations.form.trigger.webhookEndpointInstructions')}
                                            </Text>
                                            {selectedWatcher ? (
                                                <>
                                                    <Text style={styles.fieldLabel}>
                                                        {t('automations.detail.event.observationPlacementTitle')}
                                                    </Text>
                                                    <Text
                                                        testID="automation-event-webhook-endpoint-placement"
                                                        selectable
                                                        style={styles.webhookEndpointValue}
                                                    >
                                                        {watcherDisplayLabel(selectedWatcher)}
                                                    </Text>
                                                </>
                                            ) : null}
                                            <Text style={styles.fieldLabel}>
                                                {t('automations.form.trigger.webhookEndpointUrl')}
                                            </Text>
                                            <Text
                                                testID="automation-event-webhook-endpoint-url"
                                                selectable
                                                style={styles.webhookEndpointValue}
                                            >
                                                {webhookEndpoint.publicUrl}
                                            </Text>
                                            {!webhookEndpoint.oneTimeGeneratedSecret
                                                && webhookEndpoint.readiness === 'ready' ? null : (
                                                    <>
                                                        <Text style={styles.fieldLabel}>
                                                            {t('automations.form.trigger.webhookEndpointSecret')}
                                                        </Text>
                                                        {webhookEndpoint.oneTimeGeneratedSecret ? (
                                                            <Text
                                                                testID="automation-event-webhook-endpoint-secret"
                                                                selectable
                                                                style={styles.webhookEndpointValue}
                                                            >
                                                                {webhookEndpoint.oneTimeGeneratedSecret}
                                                            </Text>
                                                        ) : (
                                                            <Text
                                                                testID="automation-event-webhook-endpoint-secret-lost"
                                                                style={styles.unavailableText}
                                                            >
                                                                {t('automations.form.trigger.webhookEndpointSecretLost')}
                                                            </Text>
                                                        )}
                                                    </>
                                                )}
                                            {webhookEndpoint.readiness === 'ready' ? null : (
                                                <>
                                                    <Text
                                                        testID="automation-event-webhook-endpoint-readiness"
                                                        accessibilityRole="alert"
                                                        accessibilityLiveRegion="polite"
                                                        style={styles.unavailableText}
                                                    >
                                                        {t('automations.form.trigger.webhookEndpointAwaitingConfirmation')}
                                                    </Text>
                                                    {props.model.refreshWebhookEndpoint ? (
                                                        <HappierPressable
                                                            testID="automation-event-webhook-endpoint-recheck"
                                                            accessibilityRole="button"
                                                            busy={props.model.webhookEndpointRefreshing}
                                                            disabled={props.model.webhookEndpointRefreshing}
                                                            onPress={props.model.refreshWebhookEndpoint}
                                                            style={({ pressed }) => [
                                                                styles.selectTrigger,
                                                                props.model.webhookEndpointRefreshing ? styles.disabled : null,
                                                                pressed ? styles.pressed : null,
                                                            ]}
                                                        >
                                                            <Text style={styles.selectTriggerText}>
                                                                {props.model.webhookEndpointRefreshing
                                                                    ? t('common.loading')
                                                                    : t('automations.form.trigger.webhookEndpointRecheck')}
                                                            </Text>
                                                            <Icon
                                                                name="arrows-clockwise"
                                                                size={14}
                                                                color={theme.colors.text.secondary}
                                                            />
                                                        </HappierPressable>
                                                    ) : null}
                                                </>
                                            )}
                                        </View>
                                    ) : null}

                                    <Text style={styles.fieldLabel}>{t('settingsPlugins.eventAutomationComposer.payloadFields')}</Text>
                                    <View testID="automation-event-payload-browser" style={styles.payloadBrowser}>
                                        {props.model.payloadBrowser.fields.length === 0 ? (
                                            <Text style={styles.unavailableText}>
                                                {t('settingsPlugins.eventAutomationComposer.noFilterableFields')}
                                            </Text>
                                        ) : (
                                            <View testID="automation-event-payload-fields" style={styles.payloadFieldList}>
                                                {props.model.payloadBrowser.fields.map((field, index) => (
                                                    <Text
                                                        key={field.pointer}
                                                        testID={`automation-event-payload-field-${index}`}
                                                        style={styles.payloadField}
                                                    >
                                                        {field.label}
                                                    </Text>
                                                ))}
                                            </View>
                                        )}
                                    </View>
                                    {/* Raw identities, pointers and the sample JSON are support's words: on request only. */}
                                    <TechnicalDetailsDisclosure
                                        testID="automation-event-technical-details"
                                        title={t('settingsPlugins.eventAutomationComposer.technicalDetails')}
                                        lines={[
                                            ...(selectedWatcher === null ? [] : [{ key: 'watcher', label: observationPlacementTitle,
                                                value: watcherTechnicalId(selectedWatcher) }]),
                                            ...props.model.payloadBrowser.fields.map((field) => ({ key: `field:${field.pointer}`,
                                                label: field.label, value: field.pointer })),
                                            ...(props.model.payloadBrowser.samplePayload === null ? [] : [{ key: 'sample',
                                                label: t('settingsPlugins.eventAutomationComposer.payloadSample'),
                                                value: formatPayloadSample(props.model.payloadBrowser.samplePayload) }]),
                                        ]}
                                    />

                                    <AutomationEventFilterFields model={props.model} disclosure={{
                                        filterFieldPickerOpenFor, filterOperatorPickerOpenFor,
                                        setFilterFieldPickerOpenFor, setFilterOperatorPickerOpenFor,
                                        pickerTriggerRef, notePickerCollapsed, notePickerTriggerPressed,
                                    }} />

                                    <Text style={styles.fieldLabel}>{t('automations.form.trigger.maximumObservationAge')}</Text>
                                    <FieldTextInput
                                        testID="automation-event-maximum-observation-age-input"
                                        accessibilityLabel={t('automations.form.trigger.maximumObservationAge')}
                                        accessibilityHint={!props.model.maximumObservationAgeMsValid
                                            ? t('automations.form.trigger.maximumObservationAgeInvalid')
                                            : undefined}
                                        invalid={!props.model.maximumObservationAgeMsValid}
                                        monospace
                                        style={styles.fieldInput}
                                        value={props.model.maximumObservationAgeMsText}
                                        onChangeText={props.model.setMaximumObservationAgeMsText}
                                        placeholder={t('automations.form.trigger.maximumObservationAgePlaceholder')}
                                        keyboardType="numeric"
                                    />
                                    {!props.model.maximumObservationAgeMsValid ? (
                                        <Text
                                            accessibilityRole="alert"
                                            accessibilityLiveRegion="polite"
                                            style={styles.unavailableText}
                                        >
                                            {t('automations.form.trigger.maximumObservationAgeInvalid')}
                                        </Text>
                                    ) : null}
                                </>
                            ) : null}
                </View>
        </View>
    );
}
