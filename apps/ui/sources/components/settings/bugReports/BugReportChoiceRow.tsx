import React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';

import { bugReportComposerStyles } from './bugReportComposerStyles';

type BugReportChoiceRowProps<TValue extends string> = {
    value: TValue;
    onChange: (value: TValue) => void;
    options: Array<{ value: TValue; label: string }>;
};

export function BugReportChoiceRow<TValue extends string>(props: BugReportChoiceRowProps<TValue>) {
    return (
        <View style={bugReportComposerStyles.chips}>
            {props.options.map((option) => {
                const active = option.value === props.value;
                return (
                    <Pressable
                        key={option.value}
                        style={[bugReportComposerStyles.chip, active && bugReportComposerStyles.chipActive]}
                        onPress={() => props.onChange(option.value)}
                    >
                        <Text style={[bugReportComposerStyles.chipText, active && bugReportComposerStyles.chipTextActive]}>
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
