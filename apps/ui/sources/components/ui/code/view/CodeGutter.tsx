import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Text } from '@/components/ui/text/Text';
import { resolveCodeMonoFontFamily } from '@/components/ui/code/codeTypography';
import { CODE_EDITOR_BASE_FONT_SIZE, CODE_EDITOR_BASE_LINE_HEIGHT, CODE_GUTTER_METRICS } from '../editor/codeEditorFontMetrics';

function NumberColumn(props: { value: string; digits: number; current?: boolean }) {
    return <View style={stylesheet.numberColumn}>
        <Text accessible={false} aria-hidden importantForAccessibility="no-hide-descendants" style={stylesheet.measureText}>{'0'.repeat(props.digits)}</Text>
        <Text style={[stylesheet.gutterText, props.current ? stylesheet.gutterTextCurrent : null]}>{props.value}</Text>
    </View>;
}

/** `current`: the line carries the current-line band, so its number reads in ink (files lab `.ln.cur .n`). */
export function CodeGutter(props: { line: CodeLine; showLineNumbers?: boolean; lineNumberDigits?: number; current?: boolean }) {
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
    const digits = Math.max(props.lineNumberDigits ?? 1, left.length, right.length);

    // Diff lines keep two right-aligned number columns (old, new) so "7 8" never reads as "78";
    // a file view has only its own line number.
    return (
        <View style={styles.gutter}>
            {line.kind === 'file' ? null : <NumberColumn value={left} digits={digits} current={props.current} />}
            <NumberColumn value={right} digits={digits} current={props.current} />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    gutter: {
        flexDirection: 'row',
        columnGap: CODE_GUTTER_METRICS.columnGap,
        paddingRight: CODE_GUTTER_METRICS.numberPaddingRight,
        paddingLeft: CODE_GUTTER_METRICS.numberPaddingLeft,
    },
    numberColumn: { minWidth: CODE_GUTTER_METRICS.numberMinWidth },
    measureText: { fontFamily: resolveCodeMonoFontFamily(), fontSize: CODE_EDITOR_BASE_FONT_SIZE, lineHeight: CODE_EDITOR_BASE_LINE_HEIGHT, opacity: 0 },
    gutterText: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: CODE_GUTTER_METRICS.numberFontSize,
        // The code line's own line box, so the smaller number sits on the line's centre, not its top.
        lineHeight: CODE_EDITOR_BASE_LINE_HEIGHT,
        position: 'absolute',
        top: 0,
        right: 0,
        textAlign: 'right',
        fontVariant: ['tabular-nums'],
        color: theme.colors.text.secondary,
    },
    gutterTextCurrent: { color: theme.colors.text.primary },
}));
