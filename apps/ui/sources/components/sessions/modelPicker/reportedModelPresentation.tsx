import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type ReportedModelStatus = 'running' | 'last_used' | 'last_reported';

export function reportedModelIconName(
    status: ReportedModelStatus,
): React.ComponentProps<typeof Ionicons>['name'] {
    switch (status) {
        case 'running':
            return 'play-circle-outline';
        case 'last_used':
            return 'time-outline';
        case 'last_reported':
            return 'information-circle-outline';
    }
}

export function reportedModelSummary(status: ReportedModelStatus, modelLabel: string): string {
    switch (status) {
        case 'running':
            return t('agentInput.model.running', { model: modelLabel });
        case 'last_used':
            return t('agentInput.model.lastUsed', { model: modelLabel });
        case 'last_reported':
            return t('agentInput.model.lastReported', { model: modelLabel });
    }
}

export function ReportedModelSummary(props: Readonly<{
    status: ReportedModelStatus;
    modelLabel: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.container}>
            <Ionicons
                name={reportedModelIconName(props.status)}
                size={15}
                color={theme.colors.text.secondary}
            />
            <Text style={styles.label}>
                {reportedModelSummary(props.status, props.modelLabel)}
            </Text>
        </View>
    );
}

export function ReportedModelStatusIcon(props: Readonly<{
    status: ReportedModelStatus;
}>) {
    const { theme } = useUnistyles();
    return (
        <Ionicons
            name={reportedModelIconName(props.status)}
            size={16}
            color={theme.colors.text.secondary}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    label: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
}));
