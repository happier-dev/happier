import * as React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export interface ActionCardProps {
    title: string;
    description?: string;
    primaryAction: { label: string; onPress: () => void | Promise<void> };
    secondaryAction?: { label: string; onPress: () => void };
    icon?: React.ReactNode;
    loading?: boolean;
    disabled?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}

export const ActionCard = React.memo<ActionCardProps>(
    ({ title, description, primaryAction, secondaryAction, icon, loading, disabled, testID, style }) => {
        const { theme } = useUnistyles();
        const styles = stylesheet;

        return (
            <View
                testID={testID}
                style={[
                    styles.container,
                    {
                        backgroundColor: theme.colors.surfaceHigh,
                        borderColor: theme.colors.divider,
                    },
                    style,
                ]}
            >
                {icon ? <View style={styles.iconRow}>{icon}</View> : null}
                <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
                {description ? (
                    <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
                        {description}
                    </Text>
                ) : null}
                <View style={styles.buttonRow}>
                    <RoundButton
                        title={primaryAction.label}
                        onPress={loading ? undefined : primaryAction.onPress}
                        disabled={disabled || loading}
                        testID={testID ? `${testID}-primary` : undefined}
                    />
                    {secondaryAction ? (
                        <RoundButton
                            title={secondaryAction.label}
                            display="inverted"
                            onPress={secondaryAction.onPress}
                            disabled={disabled || loading}
                            testID={testID ? `${testID}-secondary` : undefined}
                        />
                    ) : null}
                </View>
            </View>
        );
    },
);

const stylesheet = StyleSheet.create(() => ({
    container: {
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
    },
    iconRow: {
        marginBottom: 12,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
    },
    description: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        marginTop: 4,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 16,
    },
}));
