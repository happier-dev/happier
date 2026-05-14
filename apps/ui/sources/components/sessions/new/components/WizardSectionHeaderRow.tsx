import * as React from 'react';
import { Pressable, View, type AccessibilityState } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';


export type WizardSectionHeaderRowAction = {
    accessibilityLabel: string;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    iconColor?: string;
    onPress?: () => void;
    disabled?: boolean;
    loading?: boolean;
    loadingAccessibilityLabel?: string;
    testID?: string;
};

export type WizardSectionHeaderRowProps = {
    rowStyle?: any;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    iconColor?: string;
    title: string;
    titleStyle?: any;
    action?: WizardSectionHeaderRowAction;
};

export const WizardSectionHeaderRow = React.memo((props: WizardSectionHeaderRowProps) => {
    const leadingIcon = normalizeNodeForView(
        <Ionicons name={props.iconName} size={18} color={props.iconColor} />,
    );
    const actionDisabled = props.action?.disabled === true || props.action?.loading === true || typeof props.action?.onPress !== 'function';
    const actionIcon = props.action && !props.action.loading
        ? normalizeNodeForView(
            <Ionicons
                name={props.action.iconName}
                size={18}
                color={props.action.iconColor}
            />,
        )
        : null;

    return (
        <View style={props.rowStyle}>
            {leadingIcon}
            <Text style={props.titleStyle}>{props.title}</Text>
            {props.action ? (
                <Pressable
                    testID={props.action.testID}
                    onPress={!actionDisabled ? props.action.onPress : undefined}
                    disabled={actionDisabled}
                    hitSlop={10}
                    style={{ padding: 2 }}
                    accessibilityRole="button"
                    accessibilityLabel={props.action.accessibilityLabel}
                    accessibilityState={{ disabled: actionDisabled } satisfies AccessibilityState}
                >
                    {props.action.loading ? (
                        <ActivitySpinner
                            size="small"
                            color={props.action.iconColor}
                            accessibilityLabel={props.action.loadingAccessibilityLabel}
                        />
                    ) : actionIcon}
                </Pressable>
            ) : null}
        </View>
    );
});
