import React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { TextStyle } from 'react-native';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Typography } from '@/constants/Typography';
import { tokenizeSimpleSyntaxLine } from '@/components/ui/code/tokenization/simpleSyntaxTokenizer';

import { CodeGutter } from './CodeGutter';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


export function CodeLineRow(props: {
    line: CodeLine;
    selected: boolean;
    highlighted?: boolean;
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
    advancedTokens?: readonly Readonly<{ text: string; color: string }>[];
}) {
    const { theme } = useUnistyles();
    const { line, selected, onPressLine, onPressAddComment } = props;
    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const showPrefix = props.showPrefix ?? true;
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const commentActive = props.commentActive === true;
    const highlighted = props.highlighted === true;

    const intraLineSegments = (Array.isArray(line.renderIntraLineDiffSegments) && line.renderIntraLineDiffSegments.length > 0)
        ? line.renderIntraLineDiffSegments
        : null;

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

    const resolveTokenColorWithFallback = React.useCallback((fallback: string, tokenType: string): string => {
        if (tokenType === 'keyword') return theme.colors.syntaxKeyword ?? fallback;
        if (tokenType === 'string') return theme.colors.syntaxString ?? fallback;
        if (tokenType === 'number') return theme.colors.syntaxNumber ?? fallback;
        if (tokenType === 'comment') return theme.colors.syntaxComment ?? fallback;
        return fallback;
    }, [theme.colors]);

    const simpleTokens = React.useMemo(() => {
        const mode = props.syntaxHighlighting?.mode ?? 'off';
        const language = props.syntaxHighlighting?.language ?? null;
        const maxLineLength = props.syntaxHighlighting?.maxLineLength ?? 0;

        // When advanced highlighting is requested but advanced tokens are not yet available (e.g. Shiki loading/failure),
        // fall back to the simple tokenizer so users still get some highlighting.
        if (mode !== 'simple' && mode !== 'advanced') return null;
        if (!language) return null;
        if (line.renderIsHeaderLine) return null;
        // Prefer intra-line diff rendering if segments are available.
        if (intraLineSegments) return null;
        if ((line.renderCodeText ?? '').length > maxLineLength) return null;

        return tokenizeSimpleSyntaxLine({ line: line.renderCodeText ?? '', language });
    }, [intraLineSegments, line.renderCodeText, line.renderIsHeaderLine, props.syntaxHighlighting?.language, props.syntaxHighlighting?.maxLineLength, props.syntaxHighlighting?.mode]);

    const renderTokenColor = React.useCallback((type: string): string => {
        return resolveTokenColorWithFallback(textColor, type);
    }, [resolveTokenColorWithFallback, textColor]);

    const intraLineTokensBySegment = React.useMemo(() => {
        const mode = props.syntaxHighlighting?.mode ?? 'off';
        const language = props.syntaxHighlighting?.language ?? null;
        const maxLineLength = props.syntaxHighlighting?.maxLineLength ?? 0;

        if (!intraLineSegments) return null;
        if (line.renderIsHeaderLine) return null;
        if (line.kind !== 'add' && line.kind !== 'remove') return null;

        // Advanced tokens should take precedence (web Pierre/modern Shiki path).
        if (mode === 'advanced' && props.advancedTokens && props.advancedTokens.length > 0) return null;

        const shouldTokenize = (mode === 'simple' || mode === 'advanced')
            && Boolean(language)
            && ((line.renderCodeText ?? '').length <= maxLineLength);

        return intraLineSegments.map((seg) => ({
            segment: seg,
            tokens: shouldTokenize && language ? tokenizeSimpleSyntaxLine({ line: seg.text, language }) : null,
        }));
    }, [
        intraLineSegments,
        line.kind,
        line.renderCodeText,
        line.renderIsHeaderLine,
        props.advancedTokens,
        props.syntaxHighlighting?.language,
        props.syntaxHighlighting?.maxLineLength,
        props.syntaxHighlighting?.mode,
    ]);

    const webWhitespaceStyle: TextStyle | null = React.useMemo(() => {
        if (!isWeb) return null;
        // React Native Web supports CSS `white-space` and `word-break`, but React Native's `TextStyle` typing does not.
        return ({
            whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
            wordBreak: 'break-word',
        } as unknown as TextStyle);
    }, [isWeb, wrapLines]);

    return (
        <View
            nativeID={line.id}
            style={[
            styles(theme).row,
            highlighted ? styles(theme).rowHighlighted : null,
            { backgroundColor },
            ]}
        >
            <Pressable
                style={styles(theme).rowPressable}
                onPress={onPress}
                onLongPress={onLongPress}
                onHoverIn={isWeb && onPressAddComment ? () => setIsHovered(true) : undefined}
                onHoverOut={isWeb && onPressAddComment ? () => setIsHovered(false) : undefined}
            >
                <CodeGutter line={line} showLineNumbers={showLineNumbers} />
                <View style={styles(theme).codeContainer}>
                    {showPrefix && line.renderPrefixText ? (
                        <Text
                            numberOfLines={wrapLines ? undefined : 1}
                            ellipsizeMode={wrapLines ? undefined : 'clip'}
                            style={[styles(theme).codeText, webWhitespaceStyle, { color: textColor }, !wrapLines ? styles(theme).noWrap : null]}
                        >
                            {line.renderPrefixText}
                        </Text>
                    ) : null}
                    <Text
                        numberOfLines={wrapLines ? undefined : 1}
                        ellipsizeMode={wrapLines ? undefined : 'clip'}
                        style={[styles(theme).codeText, webWhitespaceStyle, { color: textColor }, !wrapLines ? styles(theme).noWrap : null]}
                    >
                        {(props.syntaxHighlighting?.mode === 'advanced' && props.advancedTokens && !line.renderIsHeaderLine)
                            ? props.advancedTokens.map((token, idx) => (
                                <Text key={idx} style={{ color: token.color }}>
                                    {token.text}
                                </Text>
                            ))
                            : intraLineTokensBySegment
                                ? intraLineTokensBySegment.map(({ segment, tokens }, segIndex) => {
                                    const segmentBg = segment.kind === 'added'
                                        ? theme.colors.diff.inlineAddedBg
                                        : segment.kind === 'removed'
                                            ? theme.colors.diff.inlineRemovedBg
                                            : 'transparent';

                                    const segmentFg = segment.kind === 'added'
                                        ? (theme.colors.diff.inlineAddedText ?? textColor)
                                        : segment.kind === 'removed'
                                            ? (theme.colors.diff.inlineRemovedText ?? textColor)
                                            : textColor;

                                    return (
                                        <Text
                                            key={segIndex}
                                            selectable={line.selectable}
                                            style={segment.kind === 'context' ? null : { backgroundColor: segmentBg, borderRadius: 3 }}
                                        >
                                            {Array.isArray(tokens)
                                                ? tokens.map((tok, tokIndex) => (
                                                    <Text
                                                        key={tokIndex}
                                                        selectable={line.selectable}
                                                        style={{
                                                            color: resolveTokenColorWithFallback(segmentFg, tok.type),
                                                            fontWeight: tok.type === 'keyword' ? '600' : '400',
                                                        }}
                                                    >
                                                        {tok.text}
                                                    </Text>
                                                ))
                                                : (
                                                    <Text selectable={line.selectable} style={{ color: segmentFg }}>
                                                        {segment.text}
                                                    </Text>
                                                )}
                                        </Text>
                                    );
                                })
                            : simpleTokens
                                ? simpleTokens.map((token, idx) => (
                                    <Text
                                        key={idx}
                                        style={{
                                            color: renderTokenColor(token.type),
                                            fontWeight: token.type === 'keyword' ? '600' : '400',
                                        }}
                                    >
                                        {token.text}
                                    </Text>
                                ))
                                : (line.renderCodeText || ' ')}
                    </Text>
                </View>
            </Pressable>

            {isWeb && onPressAddComment && isHovered && !line.renderIsHeaderLine ? (
                <Pressable
                    onHoverIn={() => setIsHovered(true)}
                    onHoverOut={() => setIsHovered(false)}
                    onPress={() => onPressAddComment(line)}
                      hitSlop={8}
                      style={styles(theme).commentButton}
                      accessibilityRole="button"
                      accessibilityLabel={
                          commentActive ? t('files.reviewComments.closeCommentA11y') : t('files.reviewComments.addCommentA11y')
                      }
                  >
                    <Ionicons
                        name={commentActive ? 'close-circle-outline' : 'add-circle-outline'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            ) : null}
        </View>
    );
}

const styles = (theme: any) => StyleSheet.create({
    row: {
        flexDirection: 'row',
        paddingVertical: 1,
        paddingHorizontal: 8,
        alignItems: 'flex-start',
    },
    rowHighlighted: {
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.textLink ?? theme.colors.link ?? theme.colors.textSecondary,
        paddingLeft: 5,
    },
    rowPressable: {
        flexDirection: 'row',
        flex: 1,
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
