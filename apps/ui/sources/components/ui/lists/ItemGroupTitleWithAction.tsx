import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';


export type ItemGroupTitleAction = {
    testID?: string;
    accessibilityLabel: string;
    iconName: IconName;
    iconColor?: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
};

export type ItemGroupTitleWithActionProps = {
    title: string;
    titleStyle?: any;
    containerStyle?: any;
    action?: ItemGroupTitleAction;
};

export const ItemGroupTitleWithAction = React.memo((props: ItemGroupTitleWithActionProps) => {
    return (
        <View style={[{ flexDirection: 'row', alignItems: 'center' }, props.containerStyle]}>
            <Text style={props.titleStyle} numberOfLines={1}>
                {props.title}
            </Text>
            {props.action ? (
                <Pressable
                    testID={props.action.testID}
                    onPress={props.action.onPress}
                    hitSlop={10}
                    style={{ padding: 2, marginLeft: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={props.action.accessibilityLabel}
                    disabled={props.action.disabled === true}
                >
                    {props.action.loading === true
                        ? <ActivitySpinner size="small" color={props.action.iconColor} />
                        : <Icon name={props.action.iconName} size={16} color={props.action.iconColor} />}
                </Pressable>
            ) : null}
        </View>
    );
});
