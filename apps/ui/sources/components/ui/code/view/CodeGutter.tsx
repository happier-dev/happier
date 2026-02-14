import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Typography } from '@/constants/Typography';

export function CodeGutter(props: { line: CodeLine; showLineNumbers?: boolean }) {
    const { theme } = useUnistyles();
    const { line } = props;
    const showLineNumbers = props.showLineNumbers ?? true;

    if (line.renderIsHeaderLine) {
        return <View style={styles(theme).gutter} />;
    }
    if (!showLineNumbers) {
        return <View style={styles(theme).gutter} />;
    }

    const left = line.oldLine ? String(line.oldLine) : '';
    const right = line.newLine ? String(line.newLine) : '';

    return (
        <View style={styles(theme).gutter}>
            <Text style={styles(theme).gutterText}>{left}</Text>
            <Text style={styles(theme).gutterText}>{right}</Text>
        </View>
    );
}

const styles = (theme: any) => StyleSheet.create({
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
});
