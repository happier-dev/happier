import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useInstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { arePluginMachineMaterializationRefsEqual } from '@/components/automations/pluginEventAutomationCurrentness';
import { isPluginMachineExecutionOriginCandidateSelectable } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import {
    SelectionList,
    type SelectionListOption,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { Typography } from '@/constants/Typography';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';

import type {
    PluginEventAutomationComposerModel,
    PluginEventAutomationPluginPresentation,
} from './usePluginEventAutomationComposer';

type Props = Readonly<{
    model: PluginEventAutomationComposerModel;
}>;

type ExistingSessionOption = PluginEventAutomationComposerModel['existingSessionOptions'][number];

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

/**
 * The composer already renders inside the Automation popover, which can itself
 * sit in a modal. Its expanders must out-rank both so the first Escape only
 * collapses this composer's expanded pickers and the next one still reaches
 * that enclosing surface instead of discarding the draft.
 */
const pickerEscapePriority = ESCAPE_LAYER_PRIORITIES.modal + 1;

/**
 * One dismissal and focus-custody owner for every expander in this composer.
 * These pickers are in-flow disclosure lists, not floating menus, so they reuse
 * the host Escape stack and the canonical focus-return helper rather than
 * growing a second overlay lifecycle — and every picker shares this owner
 * instead of repeating the latch five times.
 */
function useEventComposerPickerDisclosure(params: Readonly<{
    anyPickerOpen: boolean;
    collapseAllPickers: () => void;
}>) {
    const triggerNodesRef = React.useRef(new Map<string, FocusReturnTarget>());
    const triggerRefCallbacksRef = React.useRef(new Map<string, (node: FocusReturnTarget) => void>());
    const lastExpandedPickerKeyRef = React.useRef<string | null>(null);
    const pendingFocusReturnKeyRef = React.useRef<string | null>(null);
    const collapseAllPickersRef = React.useRef(params.collapseAllPickers);
    collapseAllPickersRef.current = params.collapseAllPickers;

    // A stable callback per picker keeps the trigger ref from detaching and
    // reattaching on every render of the surrounding form.
    const pickerTriggerRef = React.useCallback((pickerKey: string) => {
        const cached = triggerRefCallbacksRef.current.get(pickerKey);
        if (cached) return cached;
        const callback = (node: FocusReturnTarget) => {
            if (node === null || node === undefined) {
                triggerNodesRef.current.delete(pickerKey);
                return;
            }
            triggerNodesRef.current.set(pickerKey, node);
        };
        triggerRefCallbacksRef.current.set(pickerKey, callback);
        return callback;
    }, []);

    /**
     * Arms the return only for a collapse that takes the user's own focused
     * element away. A collateral collapse — another picker closing this one —
     * must not pull focus off the control the user is actually on.
     */
    const notePickerCollapsed = React.useCallback((pickerKey: string) => {
        pendingFocusReturnKeyRef.current = pickerKey;
    }, []);

    const notePickerTriggerPressed = React.useCallback((pickerKey: string, wasExpanded: boolean) => {
        if (wasExpanded) {
            pendingFocusReturnKeyRef.current = pickerKey;
            return;
        }
        lastExpandedPickerKeyRef.current = pickerKey;
    }, []);

    React.useEffect(() => {
        const pickerKey = pendingFocusReturnKeyRef.current;
        if (pickerKey === null) return;
        pendingFocusReturnKeyRef.current = null;
        restoreFocusToBestTarget({ current: triggerNodesRef.current.get(pickerKey) ?? null });
    });

    useEscapeLayer({
        enabled: Platform.OS === 'web' && params.anyPickerOpen,
        priority: pickerEscapePriority,
        onEscape: () => {
            const pickerKey = lastExpandedPickerKeyRef.current;
            lastExpandedPickerKeyRef.current = null;
            if (pickerKey !== null) pendingFocusReturnKeyRef.current = pickerKey;
            collapseAllPickersRef.current();
            return true;
        },
    });

    return { pickerTriggerRef, notePickerCollapsed, notePickerTriggerPressed };
}

function watcherKey(params: Readonly<{
    machineId: string;
    materializationId: string;
}>): string {
    return `${params.machineId}:${params.materializationId}`;
}

function watcherDisplayLabel(params: Readonly<{
    machineId: string;
    materializationId: string;
}>): string {
    return `${params.machineId} / ${params.materializationId}`;
}

function existingSessionOptionKey(option: ExistingSessionOption): string {
    return `${option.serverId ?? ''}\u0000${option.sessionId}`;
}

function EventPluginBrand(props: Readonly<{
    presentation: PluginEventAutomationPluginPresentation;
    testID: string;
}>) {
    const scope = React.useMemo(
        () => new AbortController(),
        [
            props.presentation.eventKey,
            props.presentation.expectedGeneration,
            props.presentation.machineId,
            props.presentation.serverId,
        ],
    );
    React.useEffect(() => () => scope.abort(), [scope]);
    const brand = useInstalledPluginBrandPresentation({
        installedPackage: props.presentation.installedPackage,
        machineId: props.presentation.machineId,
        serverId: props.presentation.serverId,
        expectedGeneration: props.presentation.expectedGeneration,
        signal: scope.signal,
        accountLifetime: props.presentation.accountLifetime,
        isCurrent: props.presentation.isCurrent,
    });
    return brand ? (
        <InstalledPluginBrandMark
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
    const { theme } = useUnistyles();
    const [eventPickerOpen, setEventPickerOpen] = React.useState(false);
    const [watcherPickerOpen, setWatcherPickerOpen] = React.useState(false);
    const [existingSessionPickerOpen, setExistingSessionPickerOpen] = React.useState(false);
    const [filterFieldPickerOpenFor, setFilterFieldPickerOpenFor] = React.useState<string | null>(null);
    const [filterOperatorPickerOpenFor, setFilterOperatorPickerOpenFor] = React.useState<string | null>(null);
    const collapseAllPickers = React.useCallback(() => {
        setEventPickerOpen(false);
        setWatcherPickerOpen(false);
        setExistingSessionPickerOpen(false);
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
            || existingSessionPickerOpen
            || filterFieldPickerOpenFor !== null
            || filterOperatorPickerOpenFor !== null,
        collapseAllPickers,
    });
    const selectedEvent = props.model.selectedEvent;
    const selectedWatcher = props.model.selectedWatcherOrigin;
    const selectedEventAvailability = selectedEvent
        ? props.model.getPluginPresentation(selectedEvent).availability
        : null;
    const selectedWatcherCurrent = selectedWatcher === null
        ? null
        : props.model.watcherCandidates.some((candidate) => (
            isPluginMachineExecutionOriginCandidateSelectable(candidate)
            && candidate.materialization.serverIdentityId === selectedWatcher.serverIdentityId
            && arePluginMachineMaterializationRefsEqual(candidate.materialization, selectedWatcher.materializationRef)
        ));
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
    const sourceUnavailable = props.model.sourceStatus === 'unavailable' || sourceCurrentnessUnavailable;
    const sourceSetupHint = sourceUnavailable
        ? t('automations.form.trigger.sourceUnavailable')
        : !props.model.filterValid
            ? t('automations.form.trigger.eventFilterInvalid')
            : !props.model.maximumObservationAgeMsValid
                ? t('automations.form.trigger.maximumObservationAgeInvalid')
                : undefined;
    const showSourceInstanceId = props.model.sourceStatus === 'configured'
        && !sourceCurrentnessUnavailable
        && props.model.sourceInstanceId !== null;
    const selectedExistingSession = props.model.existingSessionOptions.find((option) => (
        option.sessionId === props.model.selectedExistingSessionId
    )) ?? null;
    // The session-list index is the existing owner of eligible sessions. This
    // map only adapts its current options to the shared list's opaque row ids;
    // it neither caches nor decides eligibility itself.
    const existingSessionOptionByKey = React.useMemo(
        () => new Map(props.model.existingSessionOptions.map((option) => [existingSessionOptionKey(option), option])),
        [props.model.existingSessionOptions],
    );
    const existingSessionSelectionOptions = React.useMemo<ReadonlyArray<SelectionListOption>>(
        () => props.model.existingSessionOptions.map((option) => ({
            id: existingSessionOptionKey(option),
            label: option.label,
            testID: `automation-event-existing-session-option-${option.sessionId}`,
        })),
        [props.model.existingSessionOptions],
    );
    const existingSessionSelectionStep = React.useMemo<SelectionListStep>(() => ({
        id: 'existing-session',
        inputPlaceholder: t('sessionsList.searchSessionsPlaceholder'),
        sections: [{
            kind: 'static',
            id: 'existing-sessions',
            options: existingSessionSelectionOptions,
            // This picker can expose the full retained session index. Keep one
            // scroll owner from the first row rather than mounting an eager
            // mapped list until it crosses the primitive's threshold.
            virtualization: 'force',
        }],
    }), [existingSessionSelectionOptions]);
    const selectedExistingSessionOptionKey = selectedExistingSession
        ? existingSessionOptionKey(selectedExistingSession)
        : null;
    // The one-time secret is disclosed by the ensure that configured this
    // source. Keeping it tied to `configured` means a reconfiguration cannot
    // leave a stale credential on screen next to a new endpoint, and requiring
    // live source currentness means an out-of-date event/watcher binding — the
    // shape an Account or target change leaves behind — stops disclosing it.
    const webhookEndpoint = props.model.sourceStatus === 'configured'
        && !sourceCurrentnessUnavailable
        ? props.model.webhookEndpoint
        : null;
    const existingSessionUnavailable = props.model.targetKind === 'existingSession'
        && props.model.existingSessionAvailability !== null
        && props.model.existingSessionAvailability.kind !== 'ready';

    return (
        <View testID="automation-event-composer" style={styles.section}>
            <View style={styles.modeRow}>
                <Pressable
                    testID="automation-trigger-schedule"
                    accessibilityRole="button"
                    accessibilityState={{
                        selected: props.model.mode === 'schedule',
                        disabled: props.model.isEditingEvent,
                    }}
                    disabled={props.model.isEditingEvent}
                    onPress={() => props.model.setMode('schedule')}
                    style={({ pressed }) => [
                        styles.modeButton,
                        props.model.mode === 'schedule' ? styles.modeButtonSelected : null,
                        props.model.isEditingEvent ? styles.disabled : null,
                        pressed ? styles.pressed : null,
                    ]}
                >
                    <Icon name="repeat" size={14} color={theme.colors.text.secondary} />
                    <Text style={styles.modeButtonText}>{t('automations.form.trigger.schedule')}</Text>
                </Pressable>
                <Pressable
                    testID="automation-trigger-event"
                    accessibilityRole="button"
                    accessibilityState={{ selected: props.model.mode === 'event' }}
                    onPress={() => props.model.setMode('event')}
                    style={({ pressed }) => [
                        styles.modeButton,
                        props.model.mode === 'event' ? styles.modeButtonSelected : null,
                        pressed ? styles.pressed : null,
                    ]}
                >
                    <Icon name="lightning" size={14} color={theme.colors.text.secondary} />
                    <Text style={styles.modeButtonText}>{t('automations.form.trigger.event')}</Text>
                </Pressable>
            </View>

            {props.model.mode === 'event' ? (
                <View style={styles.eventFields}>
                    <Text style={styles.fieldLabel}>{t('automations.form.trigger.target')}</Text>
                    <View style={styles.targetRow}>
                        {([
                            ['newSession', 'automation-event-target-new-session', 'automations.form.trigger.targetNewSession'],
                            ['existingSession', 'automation-event-target-existing-session', 'automations.form.trigger.targetExistingSession'],
                            ['executionRun', 'automation-event-target-execution-run', 'automations.form.trigger.targetExecutionRun'],
                        ] as const).map(([kind, testID, label]) => {
                            const selected = props.model.targetKind === kind;
                            return (
                                <Pressable
                                    key={kind}
                                    testID={testID}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected }}
                                    onPress={() => {
                                        props.model.setTargetKind(kind);
                                        setExistingSessionPickerOpen(false);
                                    }}
                                    style={({ pressed }) => [
                                        styles.targetButton,
                                        selected ? styles.targetButtonSelected : null,
                                        pressed ? styles.pressed : null,
                                    ]}
                                >
                                    <Text numberOfLines={1} style={styles.targetButtonText}>{t(label)}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    {props.model.targetKind === 'existingSession' ? (
                        <>
                            <Pressable
                                testID="automation-event-existing-session-picker"
                                accessibilityRole="button"
                                accessibilityState={{
                                    expanded: existingSessionPickerOpen,
                                    disabled: props.model.existingSessionOptions.length === 0,
                                }}
                                disabled={props.model.existingSessionOptions.length === 0}
                                ref={pickerTriggerRef('existingSession')}
                                onPress={() => {
                                    notePickerTriggerPressed('existingSession', existingSessionPickerOpen);
                                    setExistingSessionPickerOpen((current) => !current);
                                }}
                                style={({ pressed }) => [
                                    styles.selectTrigger,
                                    props.model.existingSessionOptions.length === 0 ? styles.disabled : null,
                                    pressed ? styles.pressed : null,
                                ]}
                            >
                                <Text numberOfLines={1} style={styles.selectTriggerText}>
                                    {selectedExistingSession?.label ?? t('automations.form.trigger.chooseExistingSession')}
                                </Text>
                                <Icon
                                    name={existingSessionPickerOpen ? 'caret-up' : 'caret-down'}
                                    size={14}
                                    color={theme.colors.text.secondary}
                                />
                            </Pressable>
                            {existingSessionPickerOpen ? (
                                <View testID="automation-event-existing-session-picker-options" style={styles.optionList}>
                                    <SelectionList
                                        rootStep={existingSessionSelectionStep}
                                        listAccessibilityLabel={t('automations.form.trigger.targetExistingSession')}
                                        selectedOptionId={selectedExistingSessionOptionKey}
                                        onSelect={(optionKey) => {
                                            const option = existingSessionOptionByKey.get(optionKey);
                                            if (!option) return;
                                            props.model.selectExistingSession(option);
                                            notePickerCollapsed('existingSession');
                                            setExistingSessionPickerOpen(false);
                                        }}
                                        onRequestClose={() => {
                                            notePickerCollapsed('existingSession');
                                            setExistingSessionPickerOpen(false);
                                        }}
                                        keyboardHintsEnabled={false}
                                        autoFocusInputOnWeb
                                        disableTransitions
                                        maxHeight={300}
                                        testID="automation-event-existing-session-list"
                                        inputTestID="automation-event-existing-session-search"
                                    />
                                </View>
                            ) : null}
                            {props.model.existingSessionOptions.length === 0 ? (
                                <Text style={styles.unavailableText}>
                                    {t('automations.form.trigger.noEligibleExistingSessions')}
                                </Text>
                            ) : null}
                            {existingSessionUnavailable ? (
                                <Text
                                    testID="automation-event-existing-session-unavailable"
                                    accessibilityRole="alert"
                                    accessibilityLiveRegion="polite"
                                    style={styles.unavailableText}
                                >
                                    {t('automations.form.trigger.existingSessionUnavailable')}
                                </Text>
                            ) : null}
                        </>
                    ) : null}
                    {props.model.targetKind === 'executionRun' ? (
                        <>
                            <Text style={styles.fieldLabel}>{t('automations.form.trigger.executionPermissionMode')}</Text>
                            <View style={styles.targetRow}>
                                {([
                                    ['no_tools', 'automation-event-execution-permission-no-tools', 'automations.form.trigger.executionNoTools'],
                                    ['read_only', 'automation-event-execution-permission-read-only', 'automations.form.trigger.executionReadOnly'],
                                ] as const).map(([permissionMode, testID, label]) => (
                                    <Pressable
                                        key={permissionMode}
                                        testID={testID}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: props.model.executionPermissionMode === permissionMode }}
                                        onPress={() => props.model.setExecutionPermissionMode(permissionMode)}
                                        style={({ pressed }) => [
                                            styles.targetButton,
                                            props.model.executionPermissionMode === permissionMode
                                                ? styles.targetButtonSelected
                                                : null,
                                            pressed ? styles.pressed : null,
                                        ]}
                                    >
                                        <Text numberOfLines={1} style={styles.targetButtonText}>{t(label)}</Text>
                                    </Pressable>
                                ))}
                            </View>
                        </>
                    ) : null}
                    {props.model.eventCatalogStatus !== 'ready' ? (
                        <Text style={styles.unavailableText}>
                            {t('automations.form.trigger.eventCatalogUnavailable')}
                        </Text>
                    ) : (
                        <>
                            <Text style={styles.fieldLabel}>{t('automations.form.trigger.eventSource')}</Text>
                            <Pressable
                                testID="automation-event-picker"
                                accessibilityRole="button"
                                accessibilityState={{ expanded: eventPickerOpen }}
                                ref={pickerTriggerRef('event')}
                                onPress={() => {
                                    notePickerTriggerPressed('event', eventPickerOpen);
                                    setEventPickerOpen((current) => !current);
                                }}
                                style={({ pressed }) => [styles.selectTrigger, pressed ? styles.pressed : null]}
                            >
                                <Text numberOfLines={1} style={styles.selectTriggerText}>
                                    {selectedEvent?.event.title ?? t('automations.form.trigger.chooseEvent')}
                                </Text>
                                <Icon
                                    name={eventPickerOpen ? 'caret-up' : 'caret-down'}
                                    size={14}
                                    color={theme.colors.text.secondary}
                                />
                            </Pressable>
                            {eventPickerOpen ? (
                                <View testID="automation-event-picker-options" style={styles.optionList}>
                                    {props.model.eligibleEvents.length === 0 ? (
                                        <Text style={styles.unavailableText}>
                                            {t('automations.form.trigger.noEligibleEvents')}
                                        </Text>
                                    ) : props.model.eligibleEvents.map((event) => {
                                        const plugin = props.model.getPluginPresentation(event);
                                        const selected = selectedEvent?.event.id === event.event.id;
                                        return (
                                            <Pressable
                                                key={plugin.eventKey}
                                                testID={`automation-event-option-${event.event.id}`}
                                                accessibilityRole="button"
                                                accessibilityState={{ selected }}
                                                onPress={() => {
                                                    props.model.selectEvent(event);
                                                    notePickerCollapsed('event');
                                                    setEventPickerOpen(false);
                                                    setWatcherPickerOpen(false);
                                                }}
                                                style={({ pressed }) => [
                                                    styles.optionRow,
                                                    selected ? styles.optionRowSelected : null,
                                                    pressed ? styles.pressed : null,
                                                ]}
                                            >
                                                <View style={styles.eventOptionHeader}>
                                                    <EventPluginBrand
                                                        presentation={plugin}
                                                        testID={`automation-event-plugin-brand-${event.event.id}`}
                                                    />
                                                    <View style={styles.eventOptionCopy}>
                                                        <Text style={styles.optionTitle}>{event.event.title}</Text>
                                                        <Text style={styles.pluginTitle}>{plugin.displayName}</Text>
                                                    </View>
                                                    <Text style={plugin.availability === 'available'
                                                        ? styles.availableText
                                                        : styles.unavailableText}
                                                    >
                                                        {plugin.availability === 'available'
                                                            ? t('settingsPlugins.eventAutomationComposer.available')
                                                            : t('common.unavailable')}
                                                    </Text>
                                                </View>
                                                {event.event.description ? (
                                                    <Text numberOfLines={2} style={styles.optionDescription}>
                                                        {event.event.description}
                                                    </Text>
                                                ) : null}
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            ) : null}

                            {selectedEvent ? (
                                <>
                                    <Text style={styles.fieldLabel}>{t('automations.detail.event.watcherTitle')}</Text>
                                    <Pressable
                                        testID="automation-event-watcher-picker"
                                        accessibilityRole="button"
                                        accessibilityState={{ expanded: watcherPickerOpen }}
                                        ref={pickerTriggerRef('watcher')}
                                        onPress={() => {
                                            notePickerTriggerPressed('watcher', watcherPickerOpen);
                                            setWatcherPickerOpen((current) => !current);
                                        }}
                                        style={({ pressed }) => [styles.selectTrigger, pressed ? styles.pressed : null]}
                                    >
                                        <Text numberOfLines={1} style={styles.selectTriggerText}>
                                            {selectedWatcher
                                                ? watcherDisplayLabel(selectedWatcher.materializationRef)
                                                : t('automations.form.trigger.chooseWatcher')}
                                        </Text>
                                        <Icon
                                            name={watcherPickerOpen ? 'caret-up' : 'caret-down'}
                                            size={14}
                                            color={theme.colors.text.secondary}
                                        />
                                    </Pressable>
                                    {watcherPickerOpen ? (
                                        <View testID="automation-event-watcher-picker-options" style={styles.optionList}>
                                            {props.model.watcherCandidates.length === 0 ? (
                                                <Text style={styles.unavailableText}>
                                                    {t('automations.form.trigger.noEligibleWatchers')}
                                                </Text>
                                            ) : props.model.watcherCandidates.map((candidate) => {
                                                const key = watcherKey(candidate.materialization);
                                                const selected = selectedWatcher?.materializationRef.machineId
                                                    === candidate.materialization.machineId
                                                    && selectedWatcher.materializationRef.materializationId
                                                    === candidate.materialization.materializationId;
                                                const selectable = isPluginMachineExecutionOriginCandidateSelectable(candidate);
                                                return (
                                                    <Pressable
                                                        key={key}
                                                        testID={`automation-event-watcher-option-${key}`}
                                                        accessibilityRole="button"
                                                        accessibilityState={{ selected, disabled: !selectable }}
                                                        disabled={!selectable}
                                                        onPress={() => {
                                                            props.model.selectWatcher(candidate);
                                                            notePickerCollapsed('watcher');
                                                            setWatcherPickerOpen(false);
                                                        }}
                                                        style={({ pressed }) => [
                                                            styles.optionRow,
                                                            selected ? styles.optionRowSelected : null,
                                                            !selectable ? styles.disabled : null,
                                                            pressed ? styles.pressed : null,
                                                        ]}
                                                    >
                                                        <Text style={styles.optionTitle}>
                                                            {watcherDisplayLabel(candidate.materialization)}
                                                        </Text>
                                                        <Text style={styles.optionDescription}>
                                                            {candidate.materialization.version}
                                                        </Text>
                                                        {!selectable ? (
                                                            <Text style={styles.unavailableText}>
                                                                {t('common.unavailable')}
                                                            </Text>
                                                        ) : null}
                                                    </Pressable>
                                                );
                                            })}
                                        </View>
                                    ) : null}

                                    {props.model.availableObservationTransports.length > 1 ? (
                                        <>
                                            <Text style={styles.fieldLabel}>
                                                {t('automations.form.trigger.observationTransport')}
                                            </Text>
                                            <View testID="automation-event-observation-transport" style={styles.targetRow}>
                                                {props.model.availableObservationTransports.map((kind) => {
                                                    const selected = props.model.observationTransport === kind;
                                                    return (
                                                        <Pressable
                                                            key={kind}
                                                            testID={`automation-event-observation-${kind}`}
                                                            accessibilityRole="button"
                                                            accessibilityState={{ selected }}
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
                                                                    : t('automations.form.trigger.observationCheckpointedPull')}
                                                            </Text>
                                                        </Pressable>
                                                    );
                                                })}
                                            </View>
                                        </>
                                    ) : null}

                                    <Text style={styles.fieldLabel}>{t('automations.form.trigger.source')}</Text>
                                    <Pressable
                                        testID="automation-event-configure-source"
                                        accessibilityRole="button"
                                        accessibilityHint={sourceSetupHint}
                                        accessibilityState={{
                                            busy: props.model.sourceStatus === 'settingUp',
                                            disabled: sourceSetupDisabled,
                                        }}
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
                                    </Pressable>
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
                                                        <Pressable
                                                            testID="automation-event-webhook-endpoint-recheck"
                                                            accessibilityRole="button"
                                                            accessibilityState={{
                                                                busy: props.model.webhookEndpointRefreshing,
                                                                disabled: props.model.webhookEndpointRefreshing,
                                                            }}
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
                                                        </Pressable>
                                                    ) : null}
                                                </>
                                            )}
                                        </View>
                                    ) : null}

                                    <Text style={styles.fieldLabel}>{t('settingsPlugins.eventAutomationComposer.payloadFields')}</Text>
                                    <View testID="automation-event-payload-browser" style={styles.payloadBrowser}>
                                        {props.model.payloadBrowser.samplePayload === null ? null : (
                                            <>
                                                <Text style={styles.payloadSampleLabel}>
                                                    {t('settingsPlugins.eventAutomationComposer.payloadSample')}
                                                </Text>
                                                <Text testID="automation-event-payload-sample" style={styles.payloadSample}>
                                                    {formatPayloadSample(props.model.payloadBrowser.samplePayload)}
                                                </Text>
                                            </>
                                        )}
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
                                                        {field.pointer}
                                                    </Text>
                                                ))}
                                            </View>
                                        )}
                                    </View>

                                    <Text style={styles.fieldLabel}>{t('automations.form.trigger.eventFilter')}</Text>
                                    <View style={styles.filterBuilder}>
                                        <Pressable
                                            testID="automation-event-filter-add-clause"
                                            accessibilityRole="button"
                                            accessibilityState={{ disabled: props.model.payloadBrowser.fields.length === 0 }}
                                            disabled={props.model.payloadBrowser.fields.length === 0}
                                            onPress={props.model.addFilterClause}
                                            style={({ pressed }) => [
                                                styles.filterAddButton,
                                                props.model.payloadBrowser.fields.length === 0 ? styles.disabled : null,
                                                pressed ? styles.pressed : null,
                                            ]}
                                        >
                                            <Icon name="plus" size={14} color={theme.colors.text.secondary} />
                                            <Text style={styles.filterActionText}>
                                                {t('settingsPlugins.eventAutomationComposer.addFilterClause')}
                                            </Text>
                                        </Pressable>
                                        {props.model.filterClauses.map((clause) => (
                                            <View
                                                key={clause.id}
                                                testID={`automation-event-filter-clause-${clause.id}`}
                                                style={styles.filterClause}
                                            >
                                                <View style={styles.filterClauseControls}>
                                                    <Pressable
                                                        testID={`automation-event-filter-clause-${clause.id}-field-picker`}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('settingsPlugins.eventAutomationComposer.filterField')}
                                                        accessibilityState={{ expanded: filterFieldPickerOpenFor === clause.id }}
                                                        ref={pickerTriggerRef(`filterField:${clause.id}`)}
                                                        onPress={() => {
                                                            notePickerTriggerPressed(
                                                                `filterField:${clause.id}`,
                                                                filterFieldPickerOpenFor === clause.id,
                                                            );
                                                            setFilterFieldPickerOpenFor((current) => (
                                                                current === clause.id ? null : clause.id
                                                            ));
                                                            setFilterOperatorPickerOpenFor(null);
                                                        }}
                                                        style={({ pressed }) => [styles.filterPicker, pressed ? styles.pressed : null]}
                                                    >
                                                        <Text numberOfLines={1} style={styles.filterPickerText}>{clause.field}</Text>
                                                        <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
                                                    </Pressable>
                                                    <Pressable
                                                        testID={`automation-event-filter-clause-${clause.id}-operator-picker`}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('settingsPlugins.eventAutomationComposer.filterOperator')}
                                                        accessibilityState={{ expanded: filterOperatorPickerOpenFor === clause.id }}
                                                        ref={pickerTriggerRef(`filterOperator:${clause.id}`)}
                                                        onPress={() => {
                                                            notePickerTriggerPressed(
                                                                `filterOperator:${clause.id}`,
                                                                filterOperatorPickerOpenFor === clause.id,
                                                            );
                                                            setFilterOperatorPickerOpenFor((current) => (
                                                                current === clause.id ? null : clause.id
                                                            ));
                                                            setFilterFieldPickerOpenFor(null);
                                                        }}
                                                        style={({ pressed }) => [styles.filterPicker, pressed ? styles.pressed : null]}
                                                    >
                                                        <Text numberOfLines={1} style={styles.filterPickerText}>
                                                            {clause.op === 'eq'
                                                                ? t('settingsPlugins.eventAutomationComposer.filterEquals')
                                                                : t('settingsPlugins.eventAutomationComposer.filterOneOf')}
                                                        </Text>
                                                        <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
                                                    </Pressable>
                                                    <Pressable
                                                        testID={`automation-event-filter-clause-${clause.id}-remove`}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('common.remove')}
                                                        onPress={() => props.model.removeFilterClause(clause.id)}
                                                        style={({ pressed }) => [styles.filterRemoveButton, pressed ? styles.pressed : null]}
                                                    >
                                                        <Icon name="trash" size={14} color={theme.colors.text.secondary} />
                                                    </Pressable>
                                                </View>
                                                {filterFieldPickerOpenFor === clause.id ? (
                                                    <View
                                                        testID={`automation-event-filter-clause-${clause.id}-field-options`}
                                                        style={styles.filterOptionList}
                                                    >
                                                        {props.model.payloadBrowser.fields.map((field) => (
                                                            <Pressable
                                                                key={field.pointer}
                                                                testID={`automation-event-filter-clause-${clause.id}-field-option-${field.pointer}`}
                                                                accessibilityRole="button"
                                                                accessibilityState={{ selected: clause.field === field.pointer }}
                                                                onPress={() => {
                                                                    props.model.setFilterClauseField(clause.id, field.pointer);
                                                                    notePickerCollapsed(`filterField:${clause.id}`);
                                                                    setFilterFieldPickerOpenFor(null);
                                                                }}
                                                                style={({ pressed }) => [
                                                                    styles.filterOption,
                                                                    clause.field === field.pointer ? styles.optionRowSelected : null,
                                                                    pressed ? styles.pressed : null,
                                                                ]}
                                                            >
                                                                <Text style={styles.filterOptionText}>{field.pointer}</Text>
                                                            </Pressable>
                                                        ))}
                                                    </View>
                                                ) : null}
                                                {filterOperatorPickerOpenFor === clause.id ? (
                                                    <View
                                                        testID={`automation-event-filter-clause-${clause.id}-operator-options`}
                                                        style={styles.filterOptionList}
                                                    >
                                                        {(['eq', 'in'] as const).map((op) => (
                                                            <Pressable
                                                                key={op}
                                                                testID={`automation-event-filter-clause-${clause.id}-operator-option-${op}`}
                                                                accessibilityRole="button"
                                                                accessibilityState={{ selected: clause.op === op }}
                                                                onPress={() => {
                                                                    props.model.setFilterClauseOperator(clause.id, op);
                                                                    notePickerCollapsed(`filterOperator:${clause.id}`);
                                                                    setFilterOperatorPickerOpenFor(null);
                                                                }}
                                                                style={({ pressed }) => [
                                                                    styles.filterOption,
                                                                    clause.op === op ? styles.optionRowSelected : null,
                                                                    pressed ? styles.pressed : null,
                                                                ]}
                                                            >
                                                                <Text style={styles.filterOptionText}>
                                                                    {op === 'eq'
                                                                        ? t('settingsPlugins.eventAutomationComposer.filterEquals')
                                                                        : t('settingsPlugins.eventAutomationComposer.filterOneOf')}
                                                                </Text>
                                                            </Pressable>
                                                        ))}
                                                    </View>
                                                ) : null}
                                                <TextInput
                                                    testID={`automation-event-filter-clause-${clause.id}-value`}
                                                    accessibilityLabel={t('settingsPlugins.eventAutomationComposer.filterValue')}
                                                    accessibilityHint={!props.model.filterValid
                                                        ? t('automations.form.trigger.eventFilterInvalid')
                                                        : undefined}
                                                    style={[styles.textInput, props.model.filterValid ? null : styles.textInputInvalid]}
                                                    value={clause.valueText}
                                                    onChangeText={(valueText) => props.model.setFilterClauseValueText(clause.id, valueText)}
                                                    placeholder={t('settingsPlugins.eventAutomationComposer.filterValuePlaceholder')}
                                                    placeholderTextColor={theme.colors.input.placeholder}
                                                    autoCapitalize="none"
                                                    autoCorrect={false}
                                                />
                                            </View>
                                        ))}
                                    </View>
                                    {!props.model.filterValid ? (
                                        <Text
                                            accessibilityRole="alert"
                                            accessibilityLiveRegion="polite"
                                            style={styles.unavailableText}
                                        >
                                            {t('automations.form.trigger.eventFilterInvalid')}
                                        </Text>
                                    ) : null}

                                    <Text style={styles.fieldLabel}>{t('automations.form.trigger.maximumObservationAge')}</Text>
                                    <TextInput
                                        testID="automation-event-maximum-observation-age-input"
                                        accessibilityLabel={t('automations.form.trigger.maximumObservationAge')}
                                        accessibilityHint={!props.model.maximumObservationAgeMsValid
                                            ? t('automations.form.trigger.maximumObservationAgeInvalid')
                                            : undefined}
                                        style={[styles.textInput, props.model.maximumObservationAgeMsValid ? null : styles.textInputInvalid]}
                                        value={props.model.maximumObservationAgeMsText}
                                        onChangeText={props.model.setMaximumObservationAgeMsText}
                                        placeholder={t('automations.form.trigger.maximumObservationAgePlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        keyboardType="numeric"
                                        autoCapitalize="none"
                                        autoCorrect={false}
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
                        </>
                    )}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: {
        gap: 10,
    },
    modeRow: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        gap: 8,
    },
    modeButton: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 11,
        paddingVertical: 8,
    },
    modeButtonSelected: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surface.selected,
    },
    modeButtonText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    targetRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    targetButton: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 11,
        paddingVertical: 8,
    },
    targetButtonSelected: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surface.selected,
    },
    targetButtonText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    eventFields: {
        gap: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        paddingTop: 12,
    },
    fieldLabel: {
        ...Typography.eyebrow(),
        color: theme.colors.text.secondary,
        paddingTop: 2,
    },
    selectTrigger: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.input.background,
        paddingHorizontal: 12,
        paddingVertical: 9,
    },
    selectTriggerText: {
        ...Typography.rowTitle(),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    optionList: {
        gap: 2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.base,
        padding: 4,
    },
    optionRow: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        gap: 2,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    optionRowSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    eventOptionHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
    },
    eventOptionCopy: {
        flex: 1,
        gap: 1,
    },
    optionTitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    pluginTitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    optionDescription: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    availableText: {
        ...Typography.rowMeta(),
        color: theme.colors.state.success.foreground,
    },
    payloadBrowser: {
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.base,
        padding: 10,
    },
    webhookEndpoint: {
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.base,
        padding: 10,
    },
    webhookEndpointTitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    webhookEndpointInstructions: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    webhookEndpointValue: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    payloadSampleLabel: {
        ...Typography.eyebrow(),
        color: theme.colors.text.secondary,
    },
    payloadSample: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    payloadFieldList: {
        gap: 4,
    },
    payloadField: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    filterBuilder: {
        gap: 8,
    },
    filterAddButton: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        alignItems: 'center',
        alignSelf: 'flex-start',
        flexDirection: 'row',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 11,
        paddingVertical: 8,
    },
    filterActionText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    filterClause: {
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.base,
        padding: 8,
    },
    filterClauseControls: {
        flexDirection: 'row',
        gap: 6,
    },
    filterPicker: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        backgroundColor: theme.colors.input.background,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    filterPickerText: {
        ...Typography.rowMeta(),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    filterRemoveButton: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.base,
    },
    filterOptionList: {
        gap: 2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.base,
        padding: 4,
    },
    filterOption: {
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        justifyContent: 'center',
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    filterOptionText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    textInput: {
        ...Typography.mono(),
        minHeight: minimumInteractiveTargetSize,
        minWidth: minimumInteractiveTargetSize,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.text.primary,
        paddingHorizontal: 12,
        paddingVertical: 9,
    },
    textInputInvalid: {
        borderColor: theme.colors.state.danger.foreground,
    },
    unavailableText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    disabled: {
        opacity: 0.56,
    },
    pressed: {
        opacity: 0.72,
    },
}));
