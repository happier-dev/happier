import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    AutomationSettingsForm,
    type AutomationSettingsValue,
} from '@/components/automations/editor/AutomationSettingsForm';

type Props = Readonly<{
    value: AutomationSettingsValue;
    onChange: (next: AutomationSettingsValue) => void;
}>;

export function AutomationSettingsPopoverContent(props: Props) {
    return (
        <View
            style={styles.container}
        >
            <View style={styles.contentContainer}>
                <AutomationSettingsForm
                    variant="new-session"
                    value={props.value}
                    onChange={props.onChange}
                    showEnabledToggle={true}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: '100%',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        paddingTop: 16,
        paddingBottom: 16,
    },
}));
