import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    AutomationSettingsForm,
    type AutomationSettingsValue,
} from '@/components/automations/editor/AutomationSettingsForm';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

type Props = Readonly<{
    value: AutomationSettingsValue;
    onChange: (next: AutomationSettingsValue) => void;
}>;

export function AutomationSettingsPopoverContent(props: Props) {
    const enableTitle = t('automations.form.toggleEnableTitle');
    const enableSubtitle = t('automations.form.toggleEnableSubtitle');
    const showDetails = props.value.enabled;

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
                        <AutomationSettingsForm
                            variant="new-session"
                            value={props.value}
                            onChange={props.onChange}
                            showEnabledToggle={false}
                            groupHeaderDensity="compact"
                        />
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
        backgroundColor: theme.colors.surface,
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
        backgroundColor: theme.colors.surface,
    },
    headerSectionWithBorder: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    enableItem: {
        backgroundColor: theme.colors.surface,
    },
    bodySection: {
        backgroundColor: theme.colors.groupped.background,
        // Avoid double-padding: ItemGroup already carries its own insets; this is just a surface break.
        paddingVertical: 0,
    },
}));
