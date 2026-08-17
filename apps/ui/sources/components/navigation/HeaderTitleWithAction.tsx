import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';


export type HeaderTitleWithActionProps = {
    title: string;
    tintColor?: string;
    actionLabel: string;
    actionIconName: IconName;
    actionColor?: string;
    actionDisabled?: boolean;
    actionLoading?: boolean;
    onActionPress: () => void;
};

export const HeaderTitleWithAction = React.memo((props: HeaderTitleWithActionProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const resolvedTintColor = props.tintColor ?? theme.colors.text.primary;
    const resolvedActionColor = props.actionColor ?? resolvedTintColor;

    return (
        <View style={styles.container}>
            <Text
                style={[styles.title, { color: resolvedTintColor }]}
                numberOfLines={1}
                accessibilityRole="header"
            >
                {props.title}
            </Text>
            <Pressable
                onPress={props.onActionPress}
                hitSlop={10}
                style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
                accessibilityRole="button"
                accessibilityLabel={props.actionLabel}
                disabled={props.actionDisabled === true}
            >
                {props.actionLoading === true
                    ? <ActivitySpinner size="small" color={resolvedActionColor} />
                    : <Icon name={props.actionIconName} size={16} color={resolvedActionColor} />}
            </Pressable>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: '100%',
    },
    title: {
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    actionButton: {
        padding: 2,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
}));
