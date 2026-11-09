import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';


export type HeaderTitleWithActionProps = {
    title: string;
    subtitle?: string;
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
            <View style={styles.titleBlock}>
                <Text
                    style={[styles.title, { color: resolvedTintColor }]}
                    numberOfLines={1}
                    accessibilityRole="header"
                >
                    {props.title}
                </Text>
                {props.subtitle ? <Text style={[styles.subtitle, { color: resolvedTintColor }]} numberOfLines={1}>{props.subtitle}</Text> : null}
            </View>
            <HappierPressable
                onPress={props.onActionPress}
                style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
                accessibilityRole="button"
                accessibilityLabel={props.actionLabel}
                disabled={props.actionDisabled === true}
            >
                {props.actionLoading === true
                    ? <ActivitySpinner size="small" color={resolvedActionColor} />
                    : <Icon name={props.actionIconName} size={16} color={resolvedActionColor} />}
            </HappierPressable>
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
        ...Typography.variant('heading'),
    },
    titleBlock: { flexShrink: 1, minWidth: 0 },
    subtitle: { ...Typography.variant('body'), marginTop: 2,  },
    actionButton: {
        padding: 2,
    },
    actionButtonPressed: {
        opacity: motionTokens.press.opacity,
    },
}));
