import React from 'react';
import { Platform, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { usePopoverBoundaryRef } from '@/components/ui/popover';
import { TextInput } from '@/components/ui/text/Text';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { t } from '@/text';

export type AutomationSettingsValue = NewSessionAutomationDraft;

type Props = Readonly<{
    variant: 'new-session' | 'create' | 'edit';
    value: AutomationSettingsValue;
    onChange: (next: AutomationSettingsValue) => void;
    showEnabledToggle?: boolean;
    /** Visual density for group headers when embedding inside tight surfaces (e.g. popovers). */
    groupHeaderDensity?: 'default' | 'compact';
}>;

const stylesheet = StyleSheet.create((theme) => ({
    textInput: {
        ...SETTINGS_TEXT_INPUT_METRICS,
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
        color: theme.colors.text.primary,
    },
}));

function normalizeTimezone(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function clampEveryMinutes(value: number): number {
    return Math.min(Math.max(value, 1), 24 * 60);
}

export const AutomationSettingsForm = React.memo((props: Props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [scheduleMenuOpen, setScheduleMenuOpen] = React.useState(false);
    const popoverBoundaryRef = usePopoverBoundaryRef();

    const update = React.useCallback((patch: Partial<AutomationSettingsValue>) => {
        props.onChange({ ...props.value, ...patch });
    }, [props]);

    const isNewSessionVariant = props.variant === 'new-session';
    const enableTitle = isNewSessionVariant
        ? t('automations.form.toggleEnableTitle')
        : t('automations.form.toggleEnabledTitle');
    const enableSubtitle = isNewSessionVariant
        ? t('automations.form.toggleEnableSubtitle')
        : t('automations.form.toggleEnabledSubtitle');

    const showEnabledToggle = props.showEnabledToggle ?? true;
    const showDetailFields = !showEnabledToggle || props.value.enabled;
    const automationDetailsGroupTitle = showEnabledToggle
        ? t('common.details')
        : t('automations.form.groupAutomationTitle');
    const scheduleItems = React.useMemo((): DropdownMenuItem[] => ([
        {
            id: 'interval',
            title: t('automations.form.schedule.intervalTitle'),
            subtitle: t('automations.form.schedule.intervalSubtitle'),
            icon: <Ionicons name="repeat-outline" size={18} color={theme.colors.text.secondary} />,
        },
        {
            id: 'cron',
            title: t('automations.form.schedule.cronTitle'),
            subtitle: t('automations.form.schedule.cronSubtitle'),
            icon: <Ionicons name="calendar-outline" size={18} color={theme.colors.text.secondary} />,
        },
    ]), [theme.colors.text.secondary]);
    const selectedScheduleIcon = props.value.scheduleKind === 'cron'
        ? <Ionicons name="calendar-outline" size={18} color={theme.colors.text.secondary} />
        : <Ionicons name="repeat-outline" size={18} color={theme.colors.text.secondary} />;

    const compactHeaderStyle = React.useMemo<ViewStyle | undefined>(() => {
        if ((props.groupHeaderDensity ?? 'default') !== 'compact') return undefined;
        return {
            paddingTop: Platform.select({ ios: 18, default: 16 }),
            paddingBottom: Platform.select({ ios: 8, default: 8 }),
            paddingHorizontal: 16,
        };
    }, [props.groupHeaderDensity]);

    return (
        <>
            {showEnabledToggle ? (
                <ItemGroup title={t('automations.form.groupAutomationTitle')} headerStyle={compactHeaderStyle}>
                    <Item
                        title={enableTitle}
                        subtitle={enableSubtitle}
                        subtitleLines={0}
                        rightElement={(
                            <Switch
                                value={props.value.enabled}
                                onValueChange={(value) => update({ enabled: value })}
                            />
                        )}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {showDetailFields ? (
                <>
                    <ItemGroup title={automationDetailsGroupTitle} headerStyle={compactHeaderStyle}>
                        <ItemGroupColumns>
                            <ItemGroupColumn>
                                <FieldItem label={t('automations.form.labels.name')}>
                                    <TextInput
                                        style={styles.textInput}
                                        value={props.value.name}
                                        onChangeText={(value) => update({ name: value })}
                                        placeholder={t('automations.form.placeholders.name')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        autoCapitalize="words"
                                        autoCorrect={false}
                                    />
                                </FieldItem>
                            </ItemGroupColumn>
                            <ItemGroupColumn>
                                <FieldItem label={t('automations.form.labels.descriptionOptional')}>
                                    <TextInput
                                        style={styles.textInput}
                                        value={props.value.description}
                                        onChangeText={(value) => update({ description: value })}
                                        placeholder={t('automations.form.placeholders.description')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        autoCapitalize="sentences"
                                        autoCorrect={true}
                                    />
                                </FieldItem>
                            </ItemGroupColumn>
                        </ItemGroupColumns>
                    </ItemGroup>

                    <ItemGroup title={t('automations.form.groupScheduleTitle')} headerStyle={compactHeaderStyle}>
                        <DropdownMenu
                            open={scheduleMenuOpen}
                            onOpenChange={setScheduleMenuOpen}
                            selectedId={props.value.scheduleKind}
                            rowKind="item"
                            variant="selectable"
                            search={false}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            popoverBoundaryRef={popoverBoundaryRef}
                            popoverPortalWebTarget="body"
                            itemTrigger={{
                                title: t('automations.form.groupScheduleTitle'),
                                icon: selectedScheduleIcon,
                            }}
                            items={scheduleItems}
                            onSelect={(itemId) => {
                                update({ scheduleKind: itemId === 'cron' ? 'cron' : 'interval' });
                                setScheduleMenuOpen(false);
                            }}
                        />

                        <ItemGroupColumns paddingVertical={14} rowGap={18}>
                            {props.value.scheduleKind === 'interval' ? (
                                <>
                                    <ItemGroupColumn>
                                        <FieldItem label={t('automations.form.labels.everyMinutes')}>
                                            <TextInput
                                                style={styles.textInput}
                                                value={String(props.value.everyMinutes)}
                                                onChangeText={(value) => {
                                                    const parsed = Number.parseInt(value, 10);
                                                    if (!Number.isFinite(parsed)) return;
                                                    update({ everyMinutes: clampEveryMinutes(parsed) });
                                                }}
                                                placeholder={t('automations.form.placeholders.everyMinutes')}
                                                placeholderTextColor={theme.colors.input.placeholder}
                                                keyboardType="numeric"
                                                autoCapitalize="none"
                                                autoCorrect={false}
                                            />
                                        </FieldItem>
                                    </ItemGroupColumn>
                                    <ItemGroupColumn>
                                        <FieldItem label={t('automations.form.labels.timezoneOptional')}>
                                            <TextInput
                                                style={styles.textInput}
                                                value={props.value.timezone ?? ''}
                                                onChangeText={(value) => update({ timezone: normalizeTimezone(value) })}
                                                placeholder={t('automations.form.placeholders.timezone')}
                                                placeholderTextColor={theme.colors.input.placeholder}
                                                autoCapitalize="none"
                                                autoCorrect={false}
                                            />
                                        </FieldItem>
                                    </ItemGroupColumn>
                                </>
                            ) : (
                                <>
                                    <ItemGroupColumn>
                                        <FieldItem
                                            label={t('automations.form.labels.cronExpression')}
                                            supportingText={t('automations.form.schedule.cronHelpText')}
                                        >
                                            <TextInput
                                                style={styles.textInput}
                                                value={props.value.cronExpr}
                                                onChangeText={(value) => update({ cronExpr: value })}
                                                placeholder={t('automations.form.placeholders.cronExpression')}
                                                placeholderTextColor={theme.colors.input.placeholder}
                                                autoCapitalize="none"
                                                autoCorrect={false}
                                            />
                                        </FieldItem>
                                    </ItemGroupColumn>
                                    <ItemGroupColumn>
                                        <FieldItem label={t('automations.form.labels.timezoneOptional')}>
                                            <TextInput
                                                style={styles.textInput}
                                                value={props.value.timezone ?? ''}
                                                onChangeText={(value) => update({ timezone: normalizeTimezone(value) })}
                                                placeholder={t('automations.form.placeholders.timezone')}
                                                placeholderTextColor={theme.colors.input.placeholder}
                                                autoCapitalize="none"
                                                autoCorrect={false}
                                            />
                                        </FieldItem>
                                    </ItemGroupColumn>
                                </>
                            )}
                        </ItemGroupColumns>
                    </ItemGroup>
                </>
            ) : null}
        </>
    );
});
