import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
    AutomationPluginEventDefinitionTriggerInput,
    AutomationSessionLifecycleTriggerInput,
    AutomationTriggerDefinitionInput,
} from '@happier-dev/protocol';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { usePopoverBoundaryRef } from '@/components/ui/popover';
import {
    SelectionList,
    type SelectionListOption,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import {
    createAutomationEditorTriggerClientId,
    createAutomationEditorSourceSelectorId,
    getAutomationEditorTriggerEnabled,
    getAutomationEditorTriggerKind,
    type AutomationEditorDraft,
    type AutomationTriggerEditorValue,
    type AutomationEditorTriggerDraft,
} from '@/sync/domains/automations/automationEditorDraft';
import { clampAutomationIntervalMinutes } from '@/sync/domains/automations/automationDraft';
import { t } from '@/text';
import { AutomationRecipeComposer } from './AutomationRecipeComposer';

type ScheduleTriggerDefinition = Extract<AutomationTriggerDefinitionInput, Readonly<{ kind: 'schedule' }>>;

export type AutomationEditorSessionOption = Readonly<{
    sessionId: string;
    label: string;
    subtitle?: string;
    currentParentTurnId: string | null;
    selectable?: boolean;
}>;

export type AutomationPluginEventEditorRender = (props: Readonly<{
    clientId: string;
    value: AutomationPluginEventDefinitionTriggerInput | null;
    onComplete: (definition: AutomationPluginEventDefinitionTriggerInput) => void;
    onCancel: () => void;
}>) => React.ReactNode;

type AutomationTriggerEditorSharedProps = Readonly<{
    sessionOptions?: ReadonlyArray<AutomationEditorSessionOption>;
    /**
     * Re-resolves the Session owner's current exact parent turn at activation.
     * The editor compares it with the rendered row and never silently retargets
     * a stale selection. Hosts refresh their canonical Session projection and
     * let the user choose the new turn explicitly.
     */
    resolveCurrentSessionTurn?: (sessionId: string) => Readonly<{
        sourceSessionId: string;
        sourceTurnId: string;
    }> | null;
    onSessionSelectionStale?: () => void;
    renderPluginEventEditor?: AutomationPluginEventEditorRender;
    onSubmit?: () => void;
    onCancel?: () => void;
    submitting?: boolean;
    submitDisabled?: boolean;
}>;

export type AutomationPluralEditorScreenProps = AutomationTriggerEditorSharedProps & Readonly<{
    value: AutomationEditorDraft;
    onChange: (next: AutomationEditorDraft) => void;
    variant: 'create' | 'edit';
}>;

export type AutomationTriggerEditorProps = AutomationTriggerEditorSharedProps & Readonly<{
    value: AutomationTriggerEditorValue;
    onChange: (next: AutomationTriggerEditorValue) => void;
}>;

type AutomationTriggerEditorContentsProps = AutomationTriggerEditorSharedProps & Readonly<{
    value: AutomationTriggerEditorValue;
    onChange: (next: AutomationTriggerEditorValue) => void;
    variant: 'create' | 'edit' | 'embedded';
    recipeEditor?: React.ReactNode;
}>;

type EditorState =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'chooseKind' }>
    | Readonly<{ kind: 'schedule'; clientId: string }>
    | Readonly<{ kind: 'pluginEvent'; clientId: string | null }>
    | Readonly<{ kind: 'sessionLifecycle'; clientId: string | null }>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
    },
    input: {
        ...SETTINGS_TEXT_INPUT_METRICS,
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
        color: theme.colors.text.primary,
    },
    sectionLead: {
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 6,
        paddingBottom: 2,
    },
    sectionLeadText: {
        color: theme.colors.text.secondary,
    },
    kindGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 10,
    },
    kindButton: {
        minHeight: Platform.select({ ios: 44, android: 48, default: 44 }),
        flexGrow: 1,
        minWidth: 144,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 16,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
    },
    kindButtonPressed: {
        opacity: 0.72,
        transform: [{ scale: 0.99 }],
    },
    kindButtonText: {
        color: theme.colors.text.primary,
    },
    pickerFrame: {
        marginHorizontal: Platform.select({ ios: 16, default: 24 }),
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 24,
        paddingBottom: 10,
    },
    actionButton: {
        minHeight: Platform.select({ ios: 44, android: 48, default: 44 }),
        minWidth: 112,
        paddingHorizontal: 18,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
    },
    primaryAction: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    primaryActionText: {
        color: theme.colors.button.primary.tint,
    },
    disabled: {
        opacity: 0.45,
    },
}));

function formatSchedule(definition: ScheduleTriggerDefinition): string {
    if (definition.schedule.kind === 'cron') {
        return t('automations.pluralEditor.scheduleCron', {
            expression: definition.schedule.scheduleExpr,
            timezone: definition.schedule.timezone,
        });
    }
    return t('automations.pluralEditor.scheduleInterval', {
        minutes: Math.max(1, Math.round(definition.schedule.everyMs / 60_000)),
        timezone: definition.schedule.timezone,
    });
}

function triggerTitle(trigger: AutomationEditorTriggerDraft): string {
    switch (getAutomationEditorTriggerKind(trigger)) {
        case 'schedule':
            return t('automations.pluralEditor.scheduleTitle');
        case 'pluginEvent':
            return trigger.definition?.kind === 'pluginEvent' && 'displayLabel' in trigger.definition
                ? trigger.definition.displayLabel
                : trigger.retainedEvent?.displayLabel ?? t('automations.pluralEditor.eventTitle');
        case 'sessionLifecycle':
            return t('automations.pluralEditor.turnCompletedTitle');
    }
}

function triggerSubtitle(
    trigger: AutomationEditorTriggerDraft,
    sessionOptions: ReadonlyArray<AutomationEditorSessionOption>,
    lifecycleOrdinal: number,
): string {
    const definition = trigger.definition;
    if (!definition) {
        return t('automations.pluralEditor.eventSubtitle', {
            pluginId: trigger.retainedEvent?.eventRef.pluginId ?? '',
            eventId: trigger.retainedEvent?.eventRef.localId ?? '',
        });
    }
    switch (definition.kind) {
        case 'schedule':
            return formatSchedule(definition);
        case 'pluginEvent':
            return t('automations.pluralEditor.eventSubtitle', {
                pluginId: definition.eventRef.pluginId,
                eventId: definition.eventRef.localId,
            });
        case 'sessionLifecycle':
            return t('automations.pluralEditor.turnCompletedSource', {
                session: sessionOptions.find((option) => (
                    option.sessionId === definition.scope.sourceSessionId
                ))?.label ?? t('automations.pluralEditor.selectedSession'),
                ordinal: lifecycleOrdinal,
            });
    }
}

function replaceTrigger(
    draft: AutomationTriggerEditorValue,
    clientId: string,
    definition: AutomationTriggerDefinitionInput,
): AutomationTriggerEditorValue {
    return {
        ...draft,
        triggers: draft.triggers.map((trigger) => (
            trigger.clientId === clientId
                ? {
                    ...trigger,
                    definition,
                    retainedEvent: undefined,
                    retainedEventPrivateDefinition: undefined,
                    ...(definition.kind === 'pluginEvent' && 'sourceInstanceId' in definition ? {
                        eventSourceBinding: trigger.eventSourceBinding?.sourceInstanceId === definition.sourceInstanceId
                            ? trigger.eventSourceBinding
                            : {
                                sourceSelectorId: createAutomationEditorSourceSelectorId(),
                                sourceInstanceId: definition.sourceInstanceId,
                            },
                    } : { eventSourceBinding: undefined }),
                    // Persisted rows are reconciled only when the editor
                    // actually changed them. This preserves schedule runtime
                    // state and Event source identity for untouched rows.
                    isDirty: trigger.persisted !== null || trigger.isDirty === true,
                }
                : trigger
        )),
    };
}

function appendTrigger(
    draft: AutomationTriggerEditorValue,
    definition: AutomationTriggerDefinitionInput,
): Readonly<{ draft: AutomationTriggerEditorValue; clientId: string }> {
    const clientId = createAutomationEditorTriggerClientId();
    return {
        clientId,
        draft: {
            ...draft,
            triggers: [...draft.triggers, {
                clientId,
                persisted: null,
                definition,
                ...(definition.kind === 'pluginEvent' && 'sourceInstanceId' in definition ? {
                    eventSourceBinding: {
                        sourceSelectorId: createAutomationEditorSourceSelectorId(clientId),
                        sourceInstanceId: definition.sourceInstanceId,
                    },
                } : {}),
            }],
        },
    };
}

function createDefaultSchedule(): ScheduleTriggerDefinition {
    return {
        kind: 'schedule',
        enabled: true,
        schedule: {
            kind: 'interval',
            scheduleExpr: null,
            everyMs: 60 * 60_000,
            timezone: null,
        },
    };
}

function ScheduleEditor(props: Readonly<{
    value: ScheduleTriggerDefinition;
    onChange: (value: ScheduleTriggerDefinition) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const boundaryRef = usePopoverBoundaryRef();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const scheduleItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => [
        {
            id: 'interval',
            title: t('automations.form.schedule.intervalTitle'),
            subtitle: t('automations.form.schedule.intervalSubtitle'),
            icon: <Icon name="repeat" size={16} color={theme.colors.text.secondary} />,
        },
        {
            id: 'cron',
            title: t('automations.form.schedule.cronTitle'),
            subtitle: t('automations.form.schedule.cronSubtitle'),
            icon: <Icon name="calendar" size={16} color={theme.colors.text.secondary} />,
        },
    ], [theme.colors.text.secondary]);

    const updateTimezone = React.useCallback((raw: string) => {
        const timezone = raw.trim().length > 0 ? raw : null;
        props.onChange({
            ...props.value,
            schedule: { ...props.value.schedule, timezone },
        } as ScheduleTriggerDefinition);
    }, [props]);

    return (
        <ItemGroup title={t('automations.pluralEditor.editScheduleTitle')}>
            <DropdownMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                selectedId={props.value.schedule.kind}
                rowKind="item"
                variant="selectable"
                search={false}
                showCategoryTitles={false}
                matchTriggerWidth
                connectToTrigger
                popoverBoundaryRef={boundaryRef}
                popoverPortalWebTarget="body"
                itemTrigger={{
                    title: t('automations.pluralEditor.scheduleType'),
                    icon: <Icon
                        name={props.value.schedule.kind === 'cron' ? 'calendar' : 'repeat'}
                        size={16}
                        color={theme.colors.text.secondary}
                    />,
                }}
                items={scheduleItems}
                onSelect={(id) => {
                    props.onChange(id === 'cron'
                        ? {
                            ...props.value,
                            schedule: {
                                kind: 'cron',
                                scheduleExpr: '0 * * * *',
                                everyMs: null,
                                timezone: props.value.schedule.timezone,
                            },
                        }
                        : {
                            ...props.value,
                            schedule: {
                                kind: 'interval',
                                scheduleExpr: null,
                                everyMs: 60 * 60_000,
                                timezone: props.value.schedule.timezone,
                            },
                        });
                    setMenuOpen(false);
                }}
            />
            <ItemGroupColumns paddingVertical={14} rowGap={18}>
                <ItemGroupColumn>
                    {props.value.schedule.kind === 'interval' ? (
                        <FieldItem label={t('automations.form.labels.everyMinutes')}>
                            <TextInput
                                testID="automation-trigger-interval-minutes"
                                style={styles.input}
                                value={String(Math.max(1, Math.round(props.value.schedule.everyMs / 60_000)))}
                                onChangeText={(raw) => {
                                    const minutes = Number.parseInt(raw, 10);
                                    if (!Number.isSafeInteger(minutes) || minutes < 1) return;
                                    props.onChange({
                                        ...props.value,
                                        schedule: {
                                            kind: 'interval',
                                            scheduleExpr: null,
                                            everyMs: clampAutomationIntervalMinutes(minutes) * 60_000,
                                            timezone: props.value.schedule.timezone,
                                        },
                                    });
                                }}
                                keyboardType="numeric"
                                accessibilityLabel={t('automations.form.labels.everyMinutes')}
                                autoCorrect={false}
                                autoCapitalize="none"
                            />
                        </FieldItem>
                    ) : (
                        <FieldItem
                            label={t('automations.form.labels.cronExpression')}
                            supportingText={t('automations.form.schedule.cronHelpText')}
                        >
                            <TextInput
                                testID="automation-trigger-cron-expression"
                                style={styles.input}
                                value={props.value.schedule.scheduleExpr}
                                onChangeText={(scheduleExpr) => props.onChange({
                                    ...props.value,
                                    schedule: {
                                        kind: 'cron',
                                        scheduleExpr,
                                        everyMs: null,
                                        timezone: props.value.schedule.timezone,
                                    },
                                })}
                                autoCorrect={false}
                                autoCapitalize="none"
                                accessibilityLabel={t('automations.form.labels.cronExpression')}
                            />
                        </FieldItem>
                    )}
                </ItemGroupColumn>
                <ItemGroupColumn>
                    <FieldItem label={t('automations.form.labels.timezoneOptional')}>
                        <TextInput
                            testID="automation-trigger-timezone"
                            style={styles.input}
                            value={props.value.schedule.timezone ?? ''}
                            onChangeText={updateTimezone}
                            placeholder={t('automations.form.placeholders.timezone')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCorrect={false}
                            autoCapitalize="none"
                            accessibilityLabel={t('automations.form.labels.timezoneOptional')}
                        />
                    </FieldItem>
                </ItemGroupColumn>
            </ItemGroupColumns>
        </ItemGroup>
    );
}

function EditorActions(props: Readonly<{
    onDone: () => void;
    onRemove?: () => void;
}>): React.ReactElement {
    return (
        <ItemGroup>
            {props.onRemove ? (
                <Item
                    testID="automation-trigger-remove"
                    title={t('common.remove')}
                    icon={<Icon name="trash" size={18} />}
                    onPress={props.onRemove}
                    destructive
                    showChevron={false}
                />
            ) : null}
            <Item
                testID="automation-trigger-editor-done"
                title={t('common.done')}
                onPress={props.onDone}
                showChevron={false}
            />
        </ItemGroup>
    );
}

const AutomationTriggerEditorContents = React.memo(function AutomationTriggerEditorContents(
    props: AutomationTriggerEditorContentsProps,
): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [editor, setEditor] = React.useState<EditorState>({ kind: 'none' });
    const [lifecycleSelectionStale, setLifecycleSelectionStale] = React.useState(false);

    const updateMetadata = React.useCallback((patch: Partial<AutomationTriggerEditorValue>) => {
        props.onChange({ ...props.value, ...patch });
    }, [props]);

    const removeTrigger = React.useCallback(async (clientId: string) => {
        const trigger = props.value.triggers.find((candidate) => candidate.clientId === clientId);
        if (!trigger) return;
        const confirmed = await Modal.confirm(
            t('automations.pluralEditor.removeTitle'),
            t('automations.pluralEditor.removeBody'),
            { destructive: true, confirmText: t('common.remove'), cancelText: t('common.cancel') },
        );
        if (!confirmed) return;
        props.onChange({
            ...props.value,
            triggers: props.value.triggers.filter((candidate) => candidate.clientId !== clientId),
            removedTriggers: trigger.persisted
                ? [...props.value.removedTriggers, trigger.persisted]
                : props.value.removedTriggers,
        });
        setEditor({ kind: 'none' });
    }, [props]);

    const lifecycleOptions = React.useMemo<ReadonlyArray<SelectionListOption>>(() => (
        (props.sessionOptions ?? []).map((option) => ({
            id: option.sessionId,
            label: option.label,
            subtitle: option.subtitle,
            disabled: option.selectable === false || option.currentParentTurnId === null,
            testID: `automation-lifecycle-session-${option.sessionId}`,
        }))
    ), [props.sessionOptions]);
    const lifecycleStep = React.useMemo<SelectionListStep>(() => ({
        id: 'automation-lifecycle-session',
        inputPlaceholder: t('sessionsList.searchSessionsPlaceholder'),
        sections: [{
            kind: 'static',
            id: 'sessions',
            options: lifecycleOptions,
            virtualization: 'force',
        }],
    }), [lifecycleOptions]);

    const selectedSchedule = editor.kind === 'schedule'
        ? props.value.triggers.find((trigger) => trigger.clientId === editor.clientId) ?? null
        : null;
    const selectedPluginEvent = editor.kind === 'pluginEvent' && editor.clientId
        ? props.value.triggers.find((trigger) => trigger.clientId === editor.clientId) ?? null
        : null;
    const lifecycleOrdinalByClientId = React.useMemo(() => {
        const ordinals = new Map<string, number>();
        let ordinal = 0;
        for (const trigger of props.value.triggers) {
            if (trigger.definition?.kind !== 'sessionLifecycle') continue;
            ordinal += 1;
            ordinals.set(trigger.clientId, ordinal);
        }
        return ordinals;
    }, [props.value.triggers]);

    const completePluginEvent = React.useCallback((definition: AutomationPluginEventDefinitionTriggerInput) => {
        if (editor.kind !== 'pluginEvent') return;
        if (editor.clientId) {
            const current = props.value.triggers.find((trigger) => trigger.clientId === editor.clientId);
            props.onChange(replaceTrigger(props.value, editor.clientId, {
                ...definition,
                // Setup edits do not own independent trigger enablement.
                enabled: current ? getAutomationEditorTriggerEnabled(current) : definition.enabled,
            }));
        } else {
            props.onChange(appendTrigger(props.value, definition).draft);
        }
        setEditor({ kind: 'none' });
    }, [editor, props]);

    const selectLifecycleSession = React.useCallback((sessionId: string) => {
        if (editor.kind !== 'sessionLifecycle') return;
        const option = (props.sessionOptions ?? []).find((candidate) => candidate.sessionId === sessionId);
        if (!option?.currentParentTurnId || option.selectable === false) return;
        const exactSource = props.resolveCurrentSessionTurn?.(sessionId) ?? null;
        if (
            !exactSource
            || exactSource.sourceSessionId !== sessionId
            || exactSource.sourceTurnId !== option.currentParentTurnId
        ) {
            setLifecycleSelectionStale(true);
            props.onSessionSelectionStale?.();
            return;
        }
        const definition: AutomationSessionLifecycleTriggerInput = {
            kind: 'sessionLifecycle',
            enabled: true,
            event: 'parentTurnCompleted',
            scope: {
                kind: 'exactTurn',
                sourceSessionId: exactSource.sourceSessionId,
                sourceTurnId: exactSource.sourceTurnId,
            },
            consumption: 'once',
        };
        if (editor.clientId) {
            const current = props.value.triggers.find((trigger) => trigger.clientId === editor.clientId);
            props.onChange(replaceTrigger(props.value, editor.clientId, {
                ...definition,
                enabled: current ? getAutomationEditorTriggerEnabled(current) : true,
            }));
        } else {
            props.onChange(appendTrigger(props.value, definition).draft);
        }
        setLifecycleSelectionStale(false);
        setEditor({ kind: 'none' });
    }, [editor, props]);

    return (
        <View testID="automation-plural-editor" style={styles.root}>
            <ItemGroup title={t('automations.form.groupAutomationTitle')}>
                <Item
                    title={t('automations.form.toggleEnabledTitle')}
                    subtitle={t('automations.pluralEditor.enabledSubtitle')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={(
                        <Switch
                            value={props.value.enabled}
                            onValueChange={(enabled) => updateMetadata({ enabled })}
                            accessibilityLabel={t('automations.form.toggleEnabledTitle')}
                            accessibilityHint={t('automations.pluralEditor.enabledSubtitle')}
                        />
                    )}
                    rightElementOutsidePressable
                />
                <ItemGroupColumns paddingVertical={14} rowGap={18}>
                    <ItemGroupColumn>
                        <FieldItem label={t('automations.form.labels.name')}>
                            <TextInput
                                testID="automation-name"
                                style={styles.input}
                                value={props.value.name}
                                onChangeText={(name) => updateMetadata({ name })}
                                placeholder={t('automations.form.placeholders.name')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="words"
                                accessibilityLabel={t('automations.form.labels.name')}
                            />
                        </FieldItem>
                    </ItemGroupColumn>
                    <ItemGroupColumn>
                        <FieldItem label={t('automations.form.labels.descriptionOptional')}>
                            <TextInput
                                testID="automation-description"
                                style={styles.input}
                                value={props.value.description ?? ''}
                                onChangeText={(description) => updateMetadata({
                                    description: description.length > 0 ? description : null,
                                })}
                                placeholder={t('automations.form.placeholders.description')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="sentences"
                                accessibilityLabel={t('automations.form.labels.descriptionOptional')}
                            />
                        </FieldItem>
                    </ItemGroupColumn>
                </ItemGroupColumns>
            </ItemGroup>

            {props.recipeEditor ?? null}

            <View style={styles.sectionLead}>
                <Text style={styles.sectionLeadText}>{t('automations.pluralEditor.orSemantics')}</Text>
            </View>
            <ItemGroup
                title={t('automations.pluralEditor.triggersTitle')}
                footer={props.value.triggers.length === 0
                    ? t('automations.pluralEditor.emptyBody')
                    : t('automations.pluralEditor.triggersFooter')}
            >
                {props.value.triggers.map((trigger) => {
                    const subtitle = triggerSubtitle(
                            trigger,
                        props.sessionOptions ?? [],
                        lifecycleOrdinalByClientId.get(trigger.clientId) ?? 0,
                    );
                    return (
                    <Item
                        key={trigger.clientId}
                        testID={`automation-trigger-row-${trigger.clientId}`}
                        title={triggerTitle(trigger)}
                        subtitle={subtitle}
                        subtitleLines={0}
                        icon={<Icon
                            name={getAutomationEditorTriggerKind(trigger) === 'schedule'
                                ? 'repeat'
                                : getAutomationEditorTriggerKind(trigger) === 'pluginEvent' ? 'radio' : 'timer'}
                            size={18}
                            color={theme.colors.text.secondary}
                        />}
                        onPress={() => setEditor(getAutomationEditorTriggerKind(trigger) === 'schedule'
                            ? { kind: 'schedule', clientId: trigger.clientId }
                            : getAutomationEditorTriggerKind(trigger) === 'pluginEvent'
                                ? { kind: 'pluginEvent', clientId: trigger.clientId }
                                : { kind: 'sessionLifecycle', clientId: trigger.clientId })}
                        rightElement={(
                            <Switch
                                testID={`automation-trigger-enabled-${trigger.clientId}`}
                                value={getAutomationEditorTriggerEnabled(trigger)}
                                onValueChange={(enabled) => props.onChange(trigger.definition
                                    ? replaceTrigger(props.value, trigger.clientId, {
                                        ...trigger.definition,
                                        enabled,
                                    })
                                    : {
                                        ...props.value,
                                        triggers: props.value.triggers.map((candidate) => (
                                            candidate.clientId === trigger.clientId
                                                ? {
                                                    ...candidate,
                                                    isDirty: true,
                                                    retainedEvent: candidate.retainedEvent
                                                        ? { ...candidate.retainedEvent, enabled }
                                                        : candidate.retainedEvent,
                                                }
                                                : candidate
                                        )),
                                    })}
                                accessibilityLabel={t('automations.pluralEditor.triggerEnabledLabel', {
                                    title: `${triggerTitle(trigger)} — ${subtitle}`,
                                })}
                            />
                        )}
                        rightElementOutsidePressable
                        keepChevronWithRightElement
                    />
                    );
                })}
                <Item
                    testID="automation-trigger-add"
                    title={t('automations.pluralEditor.addTrigger')}
                    subtitle={t('automations.pluralEditor.addTriggerSubtitle')}
                    icon={<Icon name="plus" size={18} color={theme.colors.text.secondary} />}
                    onPress={() => setEditor({ kind: 'chooseKind' })}
                />
            </ItemGroup>

            {editor.kind === 'chooseKind' ? (
                <View style={styles.kindGrid}>
                    {([
                        ['schedule', 'repeat', t('automations.pluralEditor.scheduleTitle')],
                        ['pluginEvent', 'radio', t('automations.pluralEditor.eventTitle')],
                        ['sessionLifecycle', 'timer', t('automations.pluralEditor.turnCompletedTitle')],
                    ] as const).map(([kind, icon, label]) => (
                        <Pressable
                            key={kind}
                            testID={`automation-trigger-kind-${kind}`}
                            accessibilityRole="button"
                            onPress={() => {
                                setLifecycleSelectionStale(false);
                                if (kind === 'schedule') {
                                    const appended = appendTrigger(props.value, createDefaultSchedule());
                                    props.onChange(appended.draft);
                                    setEditor({ kind: 'schedule', clientId: appended.clientId });
                                    return;
                                }
                                setEditor({ kind, clientId: null });
                            }}
                            style={({ pressed }) => [styles.kindButton, pressed ? styles.kindButtonPressed : null]}
                        >
                            <Icon name={icon} size={18} color={theme.colors.text.secondary} />
                            <Text style={styles.kindButtonText}>{label}</Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}

            {editor.kind === 'schedule' && selectedSchedule?.definition?.kind === 'schedule' ? (
                <>
                    <ScheduleEditor
                        value={selectedSchedule.definition}
                        onChange={(definition) => props.onChange(replaceTrigger(
                            props.value,
                            selectedSchedule.clientId,
                            definition,
                        ))}
                    />
                    <EditorActions
                        onDone={() => setEditor({ kind: 'none' })}
                        onRemove={() => { void removeTrigger(selectedSchedule.clientId); }}
                    />
                </>
            ) : null}

            {editor.kind === 'pluginEvent' ? (
                props.renderPluginEventEditor ? (
                    <>
                        {props.renderPluginEventEditor({
                            clientId: editor.clientId ?? 'new-plugin-event',
                            value: selectedPluginEvent?.definition?.kind === 'pluginEvent'
                                ? selectedPluginEvent.definition
                                : null,
                            onComplete: completePluginEvent,
                            onCancel: () => setEditor({ kind: 'none' }),
                        })}
                        {editor.clientId ? (
                            <EditorActions
                                onDone={() => setEditor({ kind: 'none' })}
                                onRemove={() => { void removeTrigger(editor.clientId!); }}
                            />
                        ) : null}
                    </>
                ) : (
                    <ItemGroup>
                        <Item
                            title={t('automations.pluralEditor.eventEditorUnavailable')}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            title={t('common.done')}
                            onPress={() => setEditor({ kind: 'none' })}
                            showChevron={false}
                        />
                    </ItemGroup>
                )
            ) : null}

            {editor.kind === 'sessionLifecycle' ? (
                <>
                    {lifecycleSelectionStale ? (
                        <ItemGroup>
                            <Item
                                testID="automation-lifecycle-selection-stale"
                                title={t('automations.exactTurn.staleTitle')}
                                subtitle={t('automations.exactTurn.staleBody')}
                                subtitleLines={0}
                                mode="info"
                                showChevron={false}
                                accessibilityRole="alert"
                                accessibilityLiveRegion="assertive"
                                webRole="alert"
                            />
                        </ItemGroup>
                    ) : null}
                    <View style={styles.pickerFrame}>
                        <SelectionList
                            testID="automation-lifecycle-session-picker"
                            rootStep={lifecycleStep}
                            listAccessibilityLabel={t('automations.pluralEditor.chooseSession')}
                            onSelect={(id) => selectLifecycleSession(id)}
                            onRequestClose={() => setEditor({ kind: 'none' })}
                            autoFocusInputOnWeb
                            maxHeight={360}
                            heightBehavior="stabilizedContentHeight"
                        />
                    </View>
                    {editor.clientId ? (
                        <EditorActions
                            onDone={() => setEditor({ kind: 'none' })}
                            onRemove={() => { void removeTrigger(editor.clientId!); }}
                        />
                    ) : null}
                </>
            ) : null}

            {props.onSubmit || props.onCancel ? (
                <View style={styles.actions}>
                    {props.onCancel ? (
                        <Pressable
                            testID="automation-editor-cancel"
                            accessibilityRole="button"
                            disabled={props.submitting}
                            onPress={props.onCancel}
                            style={({ pressed }) => [
                                styles.actionButton,
                                props.submitting ? styles.disabled : null,
                                pressed ? styles.kindButtonPressed : null,
                            ]}
                        >
                            <Text>{t('common.cancel')}</Text>
                        </Pressable>
                    ) : null}
                    {props.onSubmit ? (
                        <Pressable
                            testID="automation-editor-submit"
                            accessibilityRole="button"
                            accessibilityState={{
                                disabled: props.submitDisabled === true || props.submitting === true,
                                busy: props.submitting === true,
                            }}
                            disabled={props.submitDisabled === true || props.submitting === true}
                            onPress={props.onSubmit}
                            style={({ pressed }) => [
                                styles.actionButton,
                                styles.primaryAction,
                                props.submitDisabled || props.submitting ? styles.disabled : null,
                                pressed ? styles.kindButtonPressed : null,
                            ]}
                        >
                            <Text style={styles.primaryActionText}>
                                {props.submitting
                                    ? t('artifacts.saving')
                                    : props.variant === 'edit' ? t('common.save') : t('common.create')}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
});

/** Recipe-independent editor used by embedded authoring surfaces. */
export const AutomationTriggerEditor = React.memo(function AutomationTriggerEditor(
    props: AutomationTriggerEditorProps,
): React.ReactElement {
    return <AutomationTriggerEditorContents {...props} variant="embedded" />;
});

/** Full Automation editor composes the shared trigger editor with the canonical recipe owner. */
export const AutomationPluralEditorScreen = React.memo(function AutomationPluralEditorScreen(
    props: AutomationPluralEditorScreenProps,
): React.ReactElement {
    return (
        <AutomationTriggerEditorContents
            {...props}
            onChange={(next) => props.onChange({ ...props.value, ...next })}
            recipeEditor={<AutomationRecipeComposer value={props.value} onChange={props.onChange} />}
        />
    );
});
