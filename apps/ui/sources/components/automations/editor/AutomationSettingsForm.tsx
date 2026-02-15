import React from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/StyledText';

export type AutomationSettingsValue = Readonly<{
    enabled: boolean;
    name: string;
    description: string;
    scheduleKind: 'interval' | 'cron';
    everyMinutes: number;
    cronExpr: string;
    timezone: string | null;
}>;

type Props = Readonly<{
    variant: 'new-session' | 'edit';
    value: AutomationSettingsValue;
    onChange: (next: AutomationSettingsValue) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    contentContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    label: {
        fontSize: 12,
        fontWeight: '700',
        color: theme.colors.textSecondary,
        letterSpacing: 0.6,
        marginBottom: 6,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
        color: theme.colors.text,
    },
    helpText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 6,
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

    const update = React.useCallback((patch: Partial<AutomationSettingsValue>) => {
        props.onChange({ ...props.value, ...patch });
    }, [props]);

    const enableTitle = props.variant === 'new-session' ? 'Enable automation' : 'Enabled';
    const enableSubtitle = props.variant === 'new-session'
        ? 'Create this new session template as a scheduled automation instead of starting immediately.'
        : 'When disabled, no scheduled runs will be executed.';

    return (
        <>
            <ItemGroup title="Automation">
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

            <ItemGroup title="Details">
                <View style={styles.contentContainer}>
                    <Text style={styles.label}>NAME</Text>
                    <TextInput
                        style={styles.textInput}
                        value={props.value.name}
                        onChangeText={(value) => update({ name: value })}
                        placeholder="Scheduled Session"
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="words"
                        autoCorrect={false}
                    />
                    <Text style={styles.label}>DESCRIPTION (OPTIONAL)</Text>
                    <TextInput
                        style={styles.textInput}
                        value={props.value.description}
                        onChangeText={(value) => update({ description: value })}
                        placeholder="What should this automation do?"
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="sentences"
                        autoCorrect={true}
                    />
                </View>
            </ItemGroup>

            <ItemGroup title="Schedule">
                <Item
                    title="Interval"
                    subtitle="Run every N minutes."
                    selected={props.value.scheduleKind === 'interval'}
                    onPress={() => update({ scheduleKind: 'interval' })}
                    icon={<Ionicons name="repeat-outline" size={18} color={theme.colors.textSecondary} />}
                />
                <Item
                    title="Cron"
                    subtitle="Advanced schedule expression."
                    selected={props.value.scheduleKind === 'cron'}
                    onPress={() => update({ scheduleKind: 'cron' })}
                    icon={<Ionicons name="calendar-outline" size={18} color={theme.colors.textSecondary} />}
                />

                <View style={styles.contentContainer}>
                    {props.value.scheduleKind === 'interval' ? (
                        <>
                            <Text style={styles.label}>EVERY (MINUTES)</Text>
                            <TextInput
                                style={styles.textInput}
                                value={String(props.value.everyMinutes)}
                                onChangeText={(value) => {
                                    const parsed = Number.parseInt(value, 10);
                                    if (!Number.isFinite(parsed)) return;
                                    update({ everyMinutes: clampEveryMinutes(parsed) });
                                }}
                                placeholder="60"
                                placeholderTextColor={theme.colors.input.placeholder}
                                keyboardType="numeric"
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                        </>
                    ) : (
                        <>
                            <Text style={styles.label}>CRON EXPRESSION</Text>
                            <TextInput
                                style={styles.textInput}
                                value={props.value.cronExpr}
                                onChangeText={(value) => update({ cronExpr: value })}
                                placeholder="*/5 * * * *"
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            <Text style={styles.helpText}>
                                Standard 5-field cron: minute hour day-of-month month day-of-week.
                            </Text>
                        </>
                    )}

                    <Text style={styles.label}>TIMEZONE (OPTIONAL)</Text>
                    <TextInput
                        style={styles.textInput}
                        value={props.value.timezone ?? ''}
                        onChangeText={(value) => update({ timezone: normalizeTimezone(value) })}
                        placeholder="UTC or America/New_York"
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>
            </ItemGroup>
        </>
    );
});
