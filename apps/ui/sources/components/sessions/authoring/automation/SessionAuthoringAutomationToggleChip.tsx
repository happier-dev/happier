import React from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';

type Props = Readonly<{
    value: boolean;
    label: string;
    onValueChange: (next: boolean) => void;
    chipStyle: (pressed: boolean) => StyleProp<ViewStyle>;
    showLabel: boolean;
    textStyle: StyleProp<TextStyle>;
}>;

export function SessionAuthoringAutomationToggleChip(props: Props) {
    return (
        <View
            style={[
                props.chipStyle(false),
                {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                },
            ]}
        >
            <View style={{ transform: [{ scaleX: 0.6 }, { scaleY: 0.6 }] }}>
                <Switch value={props.value} onValueChange={props.onValueChange} />
            </View>
            {props.showLabel ? (
                <Pressable
                    testID="session-authoring-automation-toggle-label"
                    onPress={() => props.onValueChange(!props.value)}
                    style={{ minWidth: 0, flexShrink: 1 }}
                >
                    <Text numberOfLines={1} style={props.textStyle}>
                        {props.label}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}
