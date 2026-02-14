import React from 'react';
import { Pressable, Text, View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Typography } from '@/constants/Typography';
import { tokenizeSimpleSyntaxLine } from '@/components/ui/code/tokenization/simpleSyntaxTokenizer';

import { CodeGutter } from './CodeGutter';

export function CodeLineRow(props: {
    line: CodeLine;
    selected: boolean;
    onPressLine?: (line: CodeLine) => void;
    onPressAddComment?: (line: CodeLine) => void;
    commentActive?: boolean;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    syntaxHighlighting?: Readonly<{
        mode: 'off' | 'simple' | 'advanced';
        language: string | null;
        maxLineLength: number;
    }>;
}) {
    const { theme } = useUnistyles();
    const { line, selected, onPressLine, onPressAddComment } = props;
    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const showPrefix = props.showPrefix ?? true;
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const commentActive = props.commentActive === true;

    const onPress = line.selectable && onPressLine ? () => onPressLine(line) : undefined;
    const onLongPress = !isWeb && onPressAddComment && !line.renderIsHeaderLine ? () => onPressAddComment(line) : undefined;

    const backgroundColor = selected
        ? theme.colors.surfaceHigh
        : line.kind === 'add'
          ? theme.colors.diff.addedBg
          : line.kind === 'remove'
            ? theme.colors.diff.removedBg
            : line.renderIsHeaderLine
              ? theme.colors.diff.hunkHeaderBg
              : 'transparent';

    const textColor = line.kind === 'add'
        ? theme.colors.diff.addedText
        : line.kind === 'remove'
          ? theme.colors.diff.removedText
          : line.renderIsHeaderLine
            ? theme.colors.diff.hunkHeaderText
            : theme.colors.diff.contextText;

    const tokens = React.useMemo(() => {
        const mode = props.syntaxHighlighting?.mode ?? 'off';
        const language = props.syntaxHighlighting?.language ?? null;
        const maxLineLength = props.syntaxHighlighting?.maxLineLength ?? 0;

        if (mode !== 'simple') return null;
        if (!language) return null;
        if (line.renderIsHeaderLine) return null;
        if ((line.renderCodeText ?? '').length > maxLineLength) return null;

        return tokenizeSimpleSyntaxLine({ line: line.renderCodeText ?? '', language });
    }, [line.renderCodeText, line.renderIsHeaderLine, props.syntaxHighlighting?.language, props.syntaxHighlighting?.maxLineLength, props.syntaxHighlighting?.mode]);

    const renderTokenColor = React.useCallback((type: string): string => {
        if (type === 'keyword') return theme.colors.syntaxKeyword ?? textColor;
        if (type === 'string') return theme.colors.syntaxString ?? textColor;
        if (type === 'number') return theme.colors.syntaxNumber ?? textColor;
        if (type === 'comment') return theme.colors.syntaxComment ?? textColor;
        return textColor;
    }, [theme.colors, textColor]);

    return (
        <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            onHoverIn={isWeb && onPressAddComment ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb && onPressAddComment ? () => setIsHovered(false) : undefined}
            style={[styles(theme).row, { backgroundColor }]}
        >
            <CodeGutter line={line} showLineNumbers={showLineNumbers} />
            <View style={styles(theme).codeContainer}>
                {showPrefix && line.renderPrefixText ? (
                    <Text
                        numberOfLines={wrapLines ? undefined : 1}
                        ellipsizeMode={wrapLines ? undefined : 'clip'}
                        style={[styles(theme).codeText, { color: textColor }, !wrapLines ? styles(theme).noWrap : null]}
                    >
                        {line.renderPrefixText}
                    </Text>
                ) : null}
                <Text
                    numberOfLines={wrapLines ? undefined : 1}
                    ellipsizeMode={wrapLines ? undefined : 'clip'}
                    style={[styles(theme).codeText, { color: textColor }, !wrapLines ? styles(theme).noWrap : null]}
                >
                    {tokens
                        ? tokens.map((token, idx) => (
                            <Text key={idx} style={{ color: renderTokenColor(token.type) }}>
                                {token.text}
                            </Text>
                        ))
                        : (line.renderCodeText || ' ')}
                </Text>
            </View>
            {isWeb && onPressAddComment && isHovered && !line.renderIsHeaderLine ? (
                <Pressable
                    onPress={() => onPressAddComment(line)}
                    hitSlop={8}
                    style={styles(theme).commentButton}
                    accessibilityRole="button"
                    accessibilityLabel={commentActive ? 'Close comment' : 'Add comment'}
                >
                    <Ionicons
                        name={commentActive ? 'close-circle-outline' : 'add-circle-outline'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            ) : null}
        </Pressable>
    );
}

const styles = (theme: any) => StyleSheet.create({
    row: {
        flexDirection: 'row',
        paddingVertical: 1,
        paddingHorizontal: 8,
        alignItems: 'flex-start',
    },
    codeContainer: {
        flexDirection: 'row',
        flex: 1,
    },
    commentButton: {
        paddingLeft: 8,
        paddingTop: 2,
    },
    codeText: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 20,
    },
    noWrap: {
        flexShrink: 0,
    },
});
