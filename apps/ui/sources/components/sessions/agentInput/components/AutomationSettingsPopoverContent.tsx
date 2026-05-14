import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AutomationSettingsValue } from '@/components/automations/editor/AutomationSettingsForm';
import {
    applyAutomationIntervalUnit,
    applyAutomationIntervalUnitValue,
    applyAutomationCronPreset,
    applyAutomationIntervalPreset,
    AUTOMATION_CRON_PRESETS,
    AUTOMATION_INTERVAL_PRESET_MINUTES,
    AUTOMATION_INTERVAL_UNITS,
    deriveAutomationIntervalUnit,
    formatAutomationCronPresetLabel,
    formatAutomationScheduleTriggerLabel,
    formatIntervalPresetLabel,
    getAutomationIntervalUnitValue,
    type AutomationCronPresetId,
} from '@/components/automations/editor/automationScheduleSentenceModel';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { usePopoverBoundaryRef } from '@/components/ui/popover';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type Props = Readonly<{
    value: AutomationSettingsValue;
    onChange: (next: AutomationSettingsValue) => void;
}>;

const CRON_FIELD_GUIDE = [
    { id: 'minute', symbol: 'm', labelKey: 'automations.form.sentence.cronFieldGuide.minute' },
    { id: 'hour', symbol: 'h', labelKey: 'automations.form.sentence.cronFieldGuide.hour' },
    { id: 'dayOfMonth', symbol: 'dom', labelKey: 'automations.form.sentence.cronFieldGuide.dayOfMonth' },
    { id: 'month', symbol: 'mon', labelKey: 'automations.form.sentence.cronFieldGuide.month' },
    { id: 'weekday', symbol: 'dow', labelKey: 'automations.form.sentence.cronFieldGuide.weekday' },
] as const;

function updateCronExpr(value: AutomationSettingsValue, cronExpr: string): AutomationSettingsValue {
    return {
        ...value,
        scheduleKind: 'cron',
        cronExpr,
    };
}

function formatTimezoneHint(value: AutomationSettingsValue): string {
    const timezone = value.timezone?.trim();
    return timezone ? timezone : t('automations.form.sentence.localTimezone');
}

export function AutomationSettingsPopoverContent(props: Props) {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = usePopoverBoundaryRef();
    const [scheduleEditorOpen, setScheduleEditorOpen] = React.useState(false);
    const [intervalUnitMenuOpen, setIntervalUnitMenuOpen] = React.useState(false);
    const [notesOpen, setNotesOpen] = React.useState(() => props.value.description.trim().length > 0);
    const enableTitle = t('automations.form.toggleEnableTitle');
    const enableSubtitle = t('automations.form.toggleEnableSubtitle');
    const showDetails = props.value.enabled;
    const intervalUnit = deriveAutomationIntervalUnit(props.value.everyMinutes);
    const intervalValue = getAutomationIntervalUnitValue(props.value.everyMinutes, intervalUnit);
    const selectedIntervalUnit = AUTOMATION_INTERVAL_UNITS.find((unit) => unit.id === intervalUnit);
    const intervalUnitItems = AUTOMATION_INTERVAL_UNITS.map((unit) => ({
        id: unit.id,
        testID: `automation-interval-unit-${unit.id}`,
        title: t(unit.labelKey),
    }));

    return (
        <ItemList
            style={styles.container}
            // Avoid extra bottom whitespace when only the toggle row is visible.
            containerStyle={showDetails ? styles.contentContainerEnabled : styles.contentContainerDisabled}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.fullWidth}>
                <View style={[styles.headerSection, showDetails ? styles.headerSectionWithBorder : null]}>
                    <Item
                        testID="session-authoring-automation-toggle-label"
                        title={enableTitle}
                        subtitle={enableSubtitle}
                        subtitleLines={0}
                        rightElement={(
                            <Switch
                                value={props.value.enabled}
                                onValueChange={(value) => props.onChange({ ...props.value, enabled: value })}
                            />
                        )}
                        showChevron={false}
                        style={styles.enableItem}
                    />
                </View>

                {showDetails ? (
                    <View style={styles.bodySection}>
                        <View style={styles.sentenceSection}>
                            <View style={styles.sentenceRow}>
                                <Text style={styles.sentenceText}>
                                    {t('automations.form.sentence.run')}
                                </Text>
                                <TextInput
                                    testID="automation-sentence-name-input"
                                    style={styles.nameInput}
                                    value={props.value.name}
                                    onChangeText={(name) => props.onChange({ ...props.value, name })}
                                    placeholder={t('automations.form.placeholders.name')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    autoCapitalize="sentences"
                                    autoCorrect={false}
                                />
                                <Text style={styles.sentenceText}>
                                    {props.value.scheduleKind === 'cron'
                                        ? t('automations.form.sentence.onSchedule')
                                        : t('automations.form.sentence.every')}
                                </Text>
                                <Pressable
                                    testID="automation-sentence-schedule-trigger"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('automations.form.sentence.scheduleControlA11y')}
                                    onPress={() => setScheduleEditorOpen((current) => !current)}
                                    style={({ pressed }) => [
                                        styles.scheduleTrigger,
                                        scheduleEditorOpen ? styles.selectedScheduleTrigger : null,
                                        pressed ? styles.pressed : null,
                                    ]}
                                >
                                    <Text numberOfLines={1} style={styles.scheduleTriggerText}>
                                        {formatAutomationScheduleTriggerLabel(props.value)}
                                    </Text>
                                    <Ionicons name="chevron-down" size={16} color={theme.colors.text.secondary} />
                                </Pressable>
                                <Text style={styles.sentenceText}>.</Text>
                            </View>

                            {scheduleEditorOpen ? (
                                <View testID="automation-schedule-frequency-popover" style={styles.schedulePanel}>
                                    {props.value.scheduleKind === 'cron' ? (
                                        <View style={styles.scheduleEditorGrid}>
                                            <View style={styles.cronExpressionGroup}>
                                                <Text style={styles.panelLabel}>
                                                    {t('automations.form.labels.cronExpression')}
                                                </Text>
                                                <TextInput
                                                    testID="automation-cron-expression-input"
                                                    style={styles.cronInput}
                                                    value={props.value.cronExpr}
                                                    onChangeText={(cronExpr) => props.onChange(updateCronExpr(props.value, cronExpr))}
                                                    placeholder={t('automations.form.placeholders.cronExpression')}
                                                    placeholderTextColor={theme.colors.input.placeholder}
                                                    autoCapitalize="none"
                                                    autoCorrect={false}
                                                />
                                                <View
                                                    testID="automation-cron-field-guide"
                                                    style={styles.cronFieldGuide}
                                                >
                                                    {CRON_FIELD_GUIDE.map((field) => (
                                                        <View
                                                            key={field.id}
                                                            testID={`automation-cron-field-guide-item-${field.id}`}
                                                            style={styles.cronFieldGuideItem}
                                                        >
                                                            <Text style={styles.cronFieldGuideSymbol}>
                                                                {field.symbol}
                                                            </Text>
                                                            <Text style={styles.cronFieldGuideLabel}>
                                                                {t(field.labelKey)}
                                                            </Text>
                                                        </View>
                                                    ))}
                                                </View>
                                            </View>
                                            <View style={styles.cronPresetGroup}>
                                                <Text style={styles.panelLabel}>
                                                    {t('automations.form.sentence.presets')}
                                                </Text>
                                                <View style={styles.cronPresetList}>
                                                    {AUTOMATION_CRON_PRESETS.map((preset) => (
                                                        <Pressable
                                                            key={preset.id}
                                                            testID={`automation-cron-preset-${preset.id}`}
                                                            onPress={() => props.onChange(applyAutomationCronPreset(props.value, preset.id as AutomationCronPresetId))}
                                                            style={({ pressed }) => [
                                                                styles.cronPresetRow,
                                                                props.value.cronExpr.trim() === preset.expression ? styles.selectedPresetRow : null,
                                                                pressed ? styles.pressed : null,
                                                            ]}
                                                        >
                                                            <Text style={[
                                                                styles.cronPresetLabel,
                                                                props.value.cronExpr.trim() === preset.expression ? styles.selectedText : null,
                                                            ]}>
                                                                {formatAutomationCronPresetLabel(preset)}
                                                            </Text>
                                                            <Text style={styles.cronPresetExpression}>
                                                                {preset.expression}
                                                            </Text>
                                                        </Pressable>
                                                    ))}
                                                </View>
                                            </View>
                                        </View>
                                    ) : (
                                        <View style={styles.scheduleEditorGrid}>
                                            <View style={styles.intervalEditorGroup}>
                                                <Text style={styles.panelLabel}>
                                                    {t('automations.form.sentence.runEvery')}
                                                </Text>
                                                <View style={styles.intervalControlRow}>
                                                    <Pressable
                                                        testID="automation-schedule-decrement"
                                                        accessibilityRole="button"
                                                        onPress={() => props.onChange(applyAutomationIntervalUnitValue(props.value, intervalValue - 1, intervalUnit))}
                                                        style={({ pressed }) => [styles.stepButton, pressed ? styles.pressed : null]}
                                                    >
                                                        <Ionicons name="remove" size={15} color={theme.colors.text.secondary} />
                                                    </Pressable>
                                                    <TextInput
                                                        testID="automation-interval-minutes-input"
                                                        style={styles.intervalInput}
                                                        value={String(intervalValue)}
                                                        onChangeText={(value) => {
                                                            const parsed = Number.parseInt(value, 10);
                                                            if (!Number.isFinite(parsed)) return;
                                                            props.onChange(applyAutomationIntervalUnitValue(props.value, parsed, intervalUnit));
                                                        }}
                                                        keyboardType="numeric"
                                                        autoCapitalize="none"
                                                        autoCorrect={false}
                                                    />
                                                    <DropdownMenu
                                                        open={intervalUnitMenuOpen}
                                                        onOpenChange={setIntervalUnitMenuOpen}
                                                        selectedId={intervalUnit}
                                                        items={intervalUnitItems}
                                                        onSelect={(unitId) => {
                                                            const unit = AUTOMATION_INTERVAL_UNITS.find((item) => item.id === unitId);
                                                            if (!unit) return;
                                                            props.onChange(applyAutomationIntervalUnit(props.value, unit.id));
                                                        }}
                                                        rowKind="item"
                                                        variant="selectable"
                                                        matchTriggerWidth={true}
                                                        maxWidthCap={180}
                                                        placement="bottom"
                                                        connectToTrigger={true}
                                                        popoverBoundaryRef={popoverBoundaryRef}
                                                        trigger={({ open, toggle }) => (
                                                            <Pressable
                                                                testID="automation-interval-unit-trigger"
                                                                accessibilityRole="button"
                                                                onPress={toggle}
                                                                style={({ pressed }) => [
                                                                    styles.unitDropdownTrigger,
                                                                    open ? styles.selectedUnitDropdownTrigger : null,
                                                                    pressed ? styles.pressed : null,
                                                                ]}
                                                            >
                                                                <Text style={styles.unitDropdownText}>
                                                                    {t(selectedIntervalUnit?.labelKey ?? 'automations.form.sentence.intervalUnits.minutes')}
                                                                </Text>
                                                                <Ionicons
                                                                    name={open ? 'chevron-up' : 'chevron-down'}
                                                                    size={14}
                                                                    color={theme.colors.text.secondary}
                                                                />
                                                            </Pressable>
                                                        )}
                                                    />
                                                    <Pressable
                                                        testID="automation-schedule-increment"
                                                        accessibilityRole="button"
                                                        onPress={() => props.onChange(applyAutomationIntervalUnitValue(props.value, intervalValue + 1, intervalUnit))}
                                                        style={({ pressed }) => [styles.stepButton, pressed ? styles.pressed : null]}
                                                    >
                                                        <Ionicons name="add" size={15} color={theme.colors.text.secondary} />
                                                    </Pressable>
                                                </View>
                                            </View>
                                            <View style={styles.intervalPresetGroup}>
                                                <Text style={styles.panelLabel}>
                                                    {t('automations.form.sentence.presets')}
                                                </Text>
                                                <View style={styles.presetRow}>
                                                    {AUTOMATION_INTERVAL_PRESET_MINUTES.map((minutes) => (
                                                        <Pressable
                                                            key={minutes}
                                                            testID={`automation-schedule-preset-${minutes}`}
                                                            accessibilityRole="button"
                                                            onPress={() => props.onChange(applyAutomationIntervalPreset(props.value, minutes))}
                                                            style={({ pressed }) => [
                                                                styles.presetPill,
                                                                props.value.everyMinutes === minutes ? styles.selectedPresetPill : null,
                                                                pressed ? styles.pressed : null,
                                                            ]}
                                                        >
                                                            <Text style={[
                                                                styles.presetPillText,
                                                                props.value.everyMinutes === minutes ? styles.selectedText : null,
                                                            ]}>
                                                                {formatIntervalPresetLabel(minutes)}
                                                            </Text>
                                                        </Pressable>
                                                    ))}
                                                </View>
                                            </View>
                                        </View>
                                    )}
                                    <Pressable
                                        testID={props.value.scheduleKind === 'cron'
                                            ? 'automation-schedule-use-interval'
                                            : 'automation-schedule-use-cron'}
                                        accessibilityRole="button"
                                        onPress={() => props.onChange({
                                            ...props.value,
                                            scheduleKind: props.value.scheduleKind === 'cron' ? 'interval' : 'cron',
                                        })}
                                        style={({ pressed }) => [styles.modeSwitchButton, pressed ? styles.pressed : null]}
                                    >
                                        <Ionicons
                                            name={props.value.scheduleKind === 'cron' ? 'repeat-outline' : 'calendar-outline'}
                                            size={15}
                                            color={theme.colors.accent.blue}
                                        />
                                        <Text style={styles.modeSwitchText}>
                                            {props.value.scheduleKind === 'cron'
                                                ? t('automations.form.sentence.useInterval')
                                                : t('automations.form.sentence.useCron')}
                                        </Text>
                                    </Pressable>
                                </View>
                            ) : null}

                            <Text style={styles.timezoneHint}>
                                {t('automations.form.sentence.timezone', { timezone: formatTimezoneHint(props.value) })}
                            </Text>

                            {notesOpen || props.value.description.trim().length > 0 ? (
                                <View style={styles.notesSection}>
                                    <Text style={styles.panelLabel}>
                                        {t('automations.form.sentence.notes')}
                                    </Text>
                                    <TextInput
                                        testID="automation-sentence-notes-input"
                                        style={styles.notesInput}
                                        value={props.value.description}
                                        onChangeText={(description) => props.onChange({ ...props.value, description })}
                                        placeholder={t('automations.form.placeholders.description')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        multiline={true}
                                        autoCapitalize="sentences"
                                        autoCorrect={true}
                                    />
                                </View>
                            ) : (
                                <Pressable
                                    testID="automation-sentence-add-notes"
                                    onPress={() => setNotesOpen(true)}
                                    style={({ pressed }) => [styles.addNotesButton, pressed ? styles.pressed : null]}
                                >
                                    <Ionicons name="add" size={16} color={theme.colors.text.secondary} />
                                    <Text style={styles.addNotesText}>
                                        {t('automations.form.sentence.addNotes')}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </View>
                ) : null}
            </View>
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: '100%',
        paddingTop: 0,
        // Keep the toggle row on the "white" surface. Detail fields get their own grouped surface.
        backgroundColor: theme.colors.surface.base,
    },
    fullWidth: {
        width: '100%',
    },
    contentContainerEnabled: {
        paddingBottom: 12,
    },
    contentContainerDisabled: {
        paddingBottom: 0,
    },
    headerSection: {
        backgroundColor: theme.colors.surface.base,
    },
    headerSectionWithBorder: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    enableItem: {
        backgroundColor: theme.colors.surface.base,
    },
    bodySection: {
        backgroundColor: theme.colors.background.canvas,
        // Avoid double-padding: ItemGroup already carries its own insets; this is just a surface break.
        paddingVertical: 0,
    },
    sentenceSection: {
        gap: 12,
        paddingHorizontal: 18,
        paddingVertical: 14,
    },
    sentenceRow: {
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    sentenceText: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    nameInput: {
        ...Typography.rowTitle(),
        minWidth: 240,
        maxWidth: 360,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 12,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.text.primary,
        paddingHorizontal: 14,
        paddingVertical: 9,
    },
    scheduleTrigger: {
        minHeight: 44,
        maxWidth: 280,
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 12,
        backgroundColor: theme.colors.input.background,
        paddingHorizontal: 14,
        paddingVertical: 9,
    },
    selectedScheduleTrigger: {
        borderColor: theme.colors.accent.blue,
    },
    scheduleTriggerText: {
        ...Typography.rowTitle(),
        ...Typography.tabular(),
        color: theme.colors.text.primary,
    },
    schedulePanel: {
        alignSelf: 'stretch',
        gap: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        padding: 12,
    },
    panelLabel: {
        ...Typography.eyebrow(),
        color: theme.colors.text.secondary,
    },
    intervalControlRow: {
        minHeight: 42,
        alignSelf: 'flex-start',
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.input.background,
        paddingHorizontal: 6,
        paddingVertical: 3,
    },
    stepButton: {
        minWidth: 34,
        minHeight: 34,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    intervalInput: {
        ...Typography.rowTitle(),
        ...Typography.tabular(),
        width: 42,
        textAlign: 'center',
        color: theme.colors.text.primary,
        paddingHorizontal: 4,
        paddingVertical: 5,
    },
    unitDropdownTrigger: {
        minHeight: 34,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 4,
        borderRadius: 8,
        paddingHorizontal: 8,
    },
    selectedUnitDropdownTrigger: {
        backgroundColor: theme.colors.surface.selected,
    },
    unitDropdownText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    scheduleEditorGrid: {
        alignItems: 'flex-start',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
    },
    intervalEditorGroup: {
        flexGrow: 0,
        flexShrink: 0,
        gap: 8,
    },
    intervalPresetGroup: {
        flexBasis: 260,
        flexGrow: 1,
        flexShrink: 1,
        gap: 8,
    },
    presetRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    presetPill: {
        minHeight: 30,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 15,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
    },
    selectedPresetPill: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surface.selected,
    },
    presetPillText: {
        ...Typography.pillLabel(),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    selectedText: {
        color: theme.colors.accent.blue,
    },
    cronInput: {
        ...Typography.mono(),
        ...Typography.tabular(),
        minWidth: 180,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.text.primary,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    cronExpressionGroup: {
        flexBasis: 220,
        flexGrow: 1,
        flexShrink: 1,
        gap: 8,
    },
    cronFieldGuide: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        paddingTop: 2,
    },
    cronFieldGuideItem: {
        minHeight: 30,
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 8,
        paddingVertical: 5,
    },
    cronFieldGuideSymbol: {
        ...Typography.mono(),
        ...Typography.tabular(),
        minWidth: 26,
        color: theme.colors.text.primary,
    },
    cronFieldGuideLabel: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    cronPresetGroup: {
        flexBasis: 260,
        flexGrow: 1,
        flexShrink: 1,
        gap: 8,
    },
    cronPresetList: {
        gap: 2,
    },
    cronPresetRow: {
        minHeight: 34,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 10,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    selectedPresetRow: {
        backgroundColor: theme.colors.surface.selected,
    },
    cronPresetLabel: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    cronPresetExpression: {
        ...Typography.mono(),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    modeSwitchButton: {
        minHeight: 36,
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        paddingTop: 10,
    },
    modeSwitchText: {
        ...Typography.rowMeta(),
        color: theme.colors.accent.blue,
    },
    timezoneHint: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    notesSection: {
        gap: 8,
    },
    notesInput: {
        ...Typography.rowMeta(),
        minHeight: 68,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.text.primary,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    addNotesButton: {
        minHeight: 40,
        alignSelf: 'flex-start',
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        paddingHorizontal: 12,
    },
    addNotesText: {
        ...Typography.rowTitle(),
        color: theme.colors.text.secondary,
    },
    pressed: {
        opacity: 0.72,
    },
}));
