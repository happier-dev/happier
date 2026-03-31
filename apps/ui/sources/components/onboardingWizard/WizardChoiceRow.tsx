import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { WizardIconBox } from './WizardIconBox';

type WizardChoiceRowProps = Readonly<{
    testID: string;
    selected: boolean;
    disabled?: boolean;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    title: string;
    subtitle: string;
    badge?: string;
    secondaryAction?: Readonly<{
        testID: string;
        title: string;
        onPress: () => void;
    }>;
    onPress: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: theme.colors.surfacePressedOverlay,
        borderRadius: 999,
    },
    badgeText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    retryButton: {
        minWidth: 0,
    },
}));

export const WizardChoiceRow = React.memo(function WizardChoiceRow(props: WizardChoiceRowProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const iconColor = props.selected ? theme.colors.accent.blue : theme.colors.textSecondary;
    const rowDisabled = Boolean(props.disabled);
    const onPress = props.disabled ? (() => {}) : props.onPress;
    const disabledContainerStyle = Boolean(props.disabled) && props.secondaryAction
        ? ({ opacity: 0.5 } as const)
        : null;

    return (
        <SelectableRow
            testID={props.testID}
            variant="selectable"
            selected={props.selected}
            disabled={rowDisabled}
            onPress={onPress}
            containerStyle={disabledContainerStyle}
            left={<WizardIconBox icon={props.icon} selected={props.selected} boxSize={32} iconSize={18} />}
            title={props.title}
            subtitle={props.subtitle}
                right={(
                    <View style={styles.trailing}>
                        {props.badge ? (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>{props.badge}</Text>
                            </View>
                        ) : null}
                        {props.secondaryAction ? (
                            <RoundButton
                                testID={props.secondaryAction.testID}
                                size="small"
                                display="inverted"
                                style={styles.retryButton}
                                title={props.secondaryAction.title}
                                onPress={props.secondaryAction.onPress}
                            />
                        ) : null}
                        <Ionicons
                            name={props.selected ? 'checkmark-circle' : 'ellipse-outline'}
                            size={18}
                            color={iconColor}
                        />
                </View>
            )}
        />
    );
});
