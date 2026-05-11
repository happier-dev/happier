import * as React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SurfaceCard } from './SurfaceCard';

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
    tone?: 'surface' | 'muted';
}

export const ActionCard = React.memo<ActionCardProps>(
    ({ title, description, primaryAction, secondaryAction, icon, loading, disabled, testID, style, tone = 'surface' }) => {
        const styles = stylesheet;

        return (
            <SurfaceCard
                testID={testID}
                tone={tone}
                padding="md"
                style={style}
            >
                <View style={styles.container}>
                {icon ? <View style={styles.iconRow}>{icon}</View> : null}
                <Text style={styles.title}>{title}</Text>
                {description ? (
                    <Text style={styles.description}>
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
            </SurfaceCard>
        );
    },
);

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        minWidth: 0,
        gap: 0,
    },
    iconRow: {
        marginBottom: 12,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        marginTop: 4,
        color: theme.colors.text.secondary,
    },
    buttonRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        marginTop: 16,
    },
}));
