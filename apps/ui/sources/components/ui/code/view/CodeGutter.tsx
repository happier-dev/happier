import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';


export function CodeGutter(props: { line: CodeLine; showLineNumbers?: boolean }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { line } = props;
    const showLineNumbers = props.showLineNumbers ?? true;

    if (line.renderIsHeaderLine) {
        return <View style={styles.gutter} />;
    }
    if (!showLineNumbers) {
        return <View style={styles.gutter} />;
    }

    const left = line.oldLine ? String(line.oldLine) : '';
    const right = line.newLine ? String(line.newLine) : '';

    return (
        <View style={styles.gutter}>
            <Text style={styles.gutterText}>{left}</Text>
            <Text style={styles.gutterText}>{right}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    gutter: {
        width: 64,
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingRight: 8,
        paddingLeft: 4,
    },
    gutterText: {
        ...Typography.mono(),
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
}));
