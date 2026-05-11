import * as React from 'react';
import { View } from 'react-native';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { SourceControlUpdateTheme } from './SourceControlUpdateControls';

export function SourceControlUpdateSwitchRow(props: Readonly<{
    theme: SourceControlUpdateTheme;
    testID: string;
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
}>) {
    return (
        <View
            testID={props.testID}
            style={{
                minHeight: 38,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
            }}
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.text.primary, ...Typography.default('semiBold') }}>
                {props.label}
            </Text>
            <Switch
                compact
                value={props.value}
                disabled={props.disabled}
                onValueChange={props.onValueChange}
            />
        </View>
    );
}
