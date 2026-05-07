import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { SourceControlUpdateTheme } from './SourceControlUpdateControls';

export function SourceControlUpdateSwitchRow(props: Readonly<{
    theme: SourceControlUpdateTheme;
    label: string;
    testID: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
}>) {
    const disabled = props.disabled === true;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="switch"
            accessibilityLabel={props.label}
            accessibilityState={{ checked: props.value, disabled }}
            disabled={disabled}
            hitSlop={8}
            onPress={() => props.onValueChange(!props.value)}
            style={({ pressed }) => ({
                minHeight: 36,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: props.theme.colors.divider,
                backgroundColor: props.theme.colors.surfaceHigh,
                paddingHorizontal: 10,
                paddingVertical: 7,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                opacity: disabled ? 0.55 : pressed ? 0.82 : 1,
            })}
        >
            <Text
                numberOfLines={1}
                style={{
                    flex: 1,
                    fontSize: 12,
                    color: props.theme.colors.text,
                    ...Typography.default('semiBold'),
                }}
            >
                {props.label}
            </Text>
            <View pointerEvents="none">
                <Switch
                    compact
                    value={props.value}
                    disabled={disabled}
                    onValueChange={props.onValueChange}
                />
            </View>
        </Pressable>
    );
}
