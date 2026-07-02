import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

const stylesheet = StyleSheet.create((theme) => ({
    facts: {
        gap: 2,
    },
    fact: {
        color: theme.colors.text.secondary,
    },
}));

export function LocalServiceFactList(props: Readonly<{
    lines: readonly string[];
    testID: string;
}>): React.ReactElement | null {
    const styles = stylesheet;
    if (props.lines.length === 0) {
        return null;
    }

    return (
        <View testID={props.testID} style={styles.facts}>
            {props.lines.map((line) => (
                <Text key={line} style={styles.fact}>
                    {line}
                </Text>
            ))}
        </View>
    );
}
