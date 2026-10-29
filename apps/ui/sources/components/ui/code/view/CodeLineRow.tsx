import React from 'react';
import { Pressable, View, Platform, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import type { GestureResponderEvent, TextLayoutEventData, TextStyle, ViewStyle } from 'react-native';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Typography } from '@/constants/Typography';
import { tokenizeSimpleSyntaxLine } from '@/components/ui/code/tokenization/simpleSyntaxTokenizer';
import { ReviewCommentLineAffordance } from '@/components/ui/code/reviewComments/ReviewCommentLineAffordance';

import { CodeGutter } from './CodeGutter';
import { Text } from '@/components/ui/text/Text';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { useContainingHappierMaterialRole, useHappierMaterialColorResolver, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { CODE_EDITOR_BASE_FONT_SIZE, CODE_LINE_BASE_HEIGHT, CODE_GUTTER_METRICS } from '../editor/codeEditorFontMetrics';

/** Shared base row metric for code display and pre-paint layout estimates. */
export { CODE_LINE_BASE_HEIGHT } from '../editor/codeEditorFontMetrics';

export type CodeLinePressEvent = GestureResponderEvent & Readonly<{
    shiftKey?: boolean;
    nativeEvent: GestureResponderEvent['nativeEvent'] & Readonly<{ shiftKey?: boolean; type?: string; button?: number; metaKey?: boolean; ctrlKey?: boolean; clientX?: number; clientY?: number }>;
}>;
type PreventableInteractionEvent = Readonly<{
    preventDefault?: () => void;
    nativeEvent?: Readonly<{ preventDefault?: () => void }>;
}>;

const WEB_RANGE_GESTURE_PRESSABLE_STYLE = {
    cursor: 'default',
    userSelect: 'none',
    WebkitUserSelect: 'none',
} as unknown as ViewStyle;

const resolveMonoTypography = (): TextStyle => (
    typeof Typography.mono === 'function'
        ? Typography.mono()
        : { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }
);

function mapTextOffsets<T>(values: readonly T[], text: (value: T) => string, render: (value: T, index: number, offset: number) => React.ReactNode) {
    let offset = 0;
    return values.map((value, index) => {
        const node = render(value, index, offset);
        offset += text(value).length;
        return node;
    });
}

/** A language server's problem on a line, in the line's UTF-16 offsets (P7 squiggles in View and Changes). */
export type CodeLineDiagnosticRange = Readonly<{ start: number; end: number; severity: 'error' | 'warning' | 'information' | 'hint' }>;
type DiagnosticSquiggleStyles = Readonly<Record<CodeLineDiagnosticRange['severity'], object | null>>;

function sliceDiagnostics(ranges: readonly CodeLineDiagnosticRange[] | undefined, start: number, length: number) {
    return ranges?.filter((range) => range.end > start && range.start < start + length)
        .map((range) => ({ start: Math.max(0, range.start - start), end: Math.min(length, range.end - start), severity: range.severity }));
}

function renderFindText(
    text: string,
    ranges?: readonly FindTextRange[],
    selectable?: boolean,
    diagnostics?: readonly CodeLineDiagnosticRange[],
    squiggles?: DiagnosticSquiggleStyles,
): React.ReactNode {
    if (!diagnostics?.length || !squiggles) {
        return ranges?.length ? <FindHighlightedText text={text} ranges={ranges} selectable={selectable} /> : text;
    }
    // Split at the problems' edges; each underlined piece keeps its own find highlights.
    const edges = [...new Set([0, text.length, ...diagnostics.flatMap((range) => [range.start, range.end])])]
        .filter((edge) => edge >= 0 && edge <= text.length).sort((a, b) => a - b);
    const pieces: React.ReactNode[] = [];
    for (let index = 0; index < edges.length - 1; index++) {
        const start = edges[index]!;
        const end = edges[index + 1]!;
        if (end <= start) continue;
        const piece = text.slice(start, end);
        const inner = renderFindText(piece, sliceFindRanges(ranges ? [...ranges] : undefined, start, end - start), selectable);
        const problem = diagnostics.find((range) => range.start <= start && range.end >= end);
        const style = problem ? squiggles[problem.severity] : null;
        pieces.push(style ? <Text key={start} useDefaultTypography={false} selectable={selectable} style={style}>{inner}</Text>
            : <React.Fragment key={start}>{inner}</React.Fragment>);
    }
    return pieces;
}

export function CodeLineRow(props: {
    line: CodeLine;
    lineNumberDigits?: number;
    reviewLaneWidth?: number;
    /** The view's leading lane cell for this line (Blame), outside the line's press target. */
    leadingLane?: React.ReactNode;
    selected: boolean;
    highlighted?: boolean;
    /** A kept review change: its add/remove tint lets go and a reviewed hairline stays at its edge. */
    reviewed?: boolean;
    /** A line an agent just wrote while you read: the add tint over the row, faded by the view's one clock. */
    liveTintOpacity?: SharedValue<number>;
    /** The block an agent is writing now (P5 Track): a quiet ink wash behind the row, until the write ends. */
    agentWash?: string;
    /** The agent's caret, drawn after this row's text (the last line of the written block). */
    agentCaret?: React.ReactNode;
    onPressLine?: (line: CodeLine, event?: CodeLinePressEvent) => void;
    onPressInLine?: (line: CodeLine, event?: PreventableInteractionEvent) => void;
    onHoverLine?: (line: CodeLine, event?: PreventableInteractionEvent) => void;
    onPressOutLine?: (line: CodeLine, event?: PreventableInteractionEvent) => void;
    pressLineWhenNotSelectable?: boolean;
    onPressAddComment?: (line: CodeLine) => void;
    commentActive?: boolean;
    showInactiveCommentAffordance?: boolean;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    syntaxHighlighting?: Readonly<{
        mode: 'off' | 'simple' | 'advanced';
        language: string | null;
        maxLineLength: number;
    }>;
    advancedTokens?: readonly Readonly<{ text: string; color: string }>[];
    findRanges?: readonly FindTextRange[];
    diagnostics?: readonly CodeLineDiagnosticRange[];
    onActivateToken?: (lineId: string, offset16: number) => boolean;
    onLongPressLine?: (line: CodeLine) => void;
}) {
    const { theme } = useUnistyles();
    const diagnostics = props.diagnostics;
    const squiggles = React.useMemo<DiagnosticSquiggleStyles | undefined>(() => diagnostics?.length ? {
        error: squiggleStyle(theme.colors.state.danger.foreground),
        warning: squiggleStyle(theme.colors.state.warning.foreground),
        information: null,
        hint: null,
    } : undefined, [diagnostics?.length, theme.colors.state.danger.foreground, theme.colors.state.warning.foreground]);
    const materialRole = useContainingHappierMaterialRole();
    const paintColor = useHappierMaterialColorResolver();
    const styles = stylesheet;
    const {
        line,
        selected,
        onPressLine,
        onPressInLine,
        onHoverLine,
        onPressOutLine,
        onPressAddComment,
        pressLineWhenNotSelectable,
    } = props;
    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const showPrefix = props.showPrefix ?? true;
    const isWeb = Platform.OS === 'web';
    const textLayoutsRef = React.useRef<TextLayoutEventData['lines']>([]);
    const longPressedRef = React.useRef(false);
    const canActivateToken = !isWeb && Boolean(props.onActivateToken) && !line.renderIsHeaderLine && line.newLine !== null && Boolean(line.renderCodeText.trim());
    const [isHovered, setIsHovered] = React.useState(false);
    const commentActive = props.commentActive === true;
    const highlighted = props.highlighted === true;
    const reviewed = props.reviewed === true && (props.line.kind === 'add' || props.line.kind === 'remove');
    const showInactiveCommentAffordance = props.showInactiveCommentAffordance !== false;
    const canShowCommentAffordance = Boolean(onPressAddComment)
        && !line.renderIsHeaderLine
        && (commentActive || showInactiveCommentAffordance);
    const commentAffordanceVisible = isWeb ? (isHovered || commentActive) : true;

    const intraLineSegments = (Array.isArray(line.renderIntraLineDiffSegments) && line.renderIntraLineDiffSegments.length > 0)
        ? line.renderIntraLineDiffSegments
        : null;

    const onPress = !line.renderIsHeaderLine && (line.selectable || pressLineWhenNotSelectable === true || (isWeb && props.onActivateToken)) && onPressLine
        ? (event: GestureResponderEvent) => onPressLine(line, event as CodeLinePressEvent)
        : undefined;
    // Web reading keeps code text selectable (copy, Ask about selection); a line-range gesture owns the drag instead.
    const textSelectable = isWeb && line.selectable && !line.renderIsHeaderLine && !(onPressInLine || onHoverLine || onPressOutLine);
    const longPressLine = onPressAddComment ?? props.onLongPressLine;
    const onLongPress = longPressLine && !line.renderIsHeaderLine ? () => {
        longPressedRef.current = true;
        longPressLine(line);
    } : undefined;
    const activateText = canActivateToken ? (event: GestureResponderEvent) => {
        if (longPressedRef.current) { longPressedRef.current = false; return; }
        const { locationX, locationY } = event.nativeEvent;
        const layouts = textLayoutsRef.current;
        const index = layouts.findIndex((layout) => locationY >= layout.y && locationY < layout.y + layout.height);
        const layout = layouts[index];
        if (!layout || layout.width <= 0 || locationX < layout.x || locationX >= layout.x + layout.width) return;
        const characters = Array.from(layout.text);
        if (!characters.length) return;
        const character = Math.floor((locationX - layout.x) / (layout.width / characters.length));
        const previousLength = layouts.slice(0, index).reduce((length, item) => length + item.text.length, 0);
        const foundStart = line.renderCodeText.indexOf(layout.text, previousLength);
        const offset = (foundStart < 0 ? previousLength : foundStart) + characters.slice(0, character).join('').length;
        event.stopPropagation?.();
        if (props.onActivateToken?.(line.id, offset) !== true) onPress?.(event);
    } : undefined;
    const onHoverIn = React.useCallback((event?: PreventableInteractionEvent) => {
        if (isWeb && onPressAddComment) setIsHovered(true);
        onHoverLine?.(line, event);
    }, [isWeb, line, onHoverLine, onPressAddComment]);
    const onHoverOut = React.useCallback(() => {
        if (isWeb && onPressAddComment) setIsHovered(false);
    }, [isWeb, onPressAddComment]);

    const backgroundColor = selected
        ? theme.colors.surface.inset
        : line.kind === 'add'
          ? theme.colors.diff.added.background
          : line.kind === 'remove'
            ? theme.colors.diff.removed.background
            : line.renderIsSeparatorLine
              // The "N unchanged lines" band is quiet context, not a coloured `@@` header (lab WT8, Pierre's band).
              ? theme.colors.diff.context.background
              : line.renderIsHeaderLine
                ? theme.colors.diff.hunk.background
                : 'transparent';

    const textColor = line.kind === 'add'
        ? theme.colors.diff.added.foreground
        : line.kind === 'remove'
          ? theme.colors.diff.removed.foreground
          : line.renderIsSeparatorLine
            ? theme.colors.text.tertiary
            : line.renderIsHeaderLine
            ? theme.colors.diff.hunk.foreground
            // A file's own text is the document, not a diff's unchanged context: it reads in the editor's
            // default ink, so View and Edit draw the same code in the same colours (files lab ED1).
            : line.kind === 'file'
              ? theme.colors.syntax.default
              : theme.colors.diff.context.foreground;

    const resolveTokenColorWithFallback = React.useCallback((fallback: string, tokenType: string): string => {
        if (tokenType === 'keyword') return theme.colors.syntax.keyword ?? fallback;
        if (tokenType === 'string') return theme.colors.syntax.string ?? fallback;
        if (tokenType === 'number') return theme.colors.syntax.number ?? fallback;
        if (tokenType === 'comment') return theme.colors.syntax.comment ?? fallback;
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
            style={[
                styles.row,
                reviewed && !highlighted ? [styles.rowReviewed, { borderLeftColor: theme.colors.border.strong }] : null,
                highlighted ? [
                    styles.rowHighlighted,
                    { borderLeftColor: theme.colors.text.link ?? theme.colors.text.secondary },
                ] : null,
                { backgroundColor: selected && materialRole !== undefined
                    ? paintColor(backgroundColor, theme.colors.surface.selected)
                    : glassSurfaceBackgroundColor(reviewed && !selected ? 'transparent' : backgroundColor, 'content') },
                selected ? [
                    styles.rowSelected,
                    { borderLeftColor: theme.colors.state.success.foreground },
                ] : null,
            ]}
        >
            {props.agentWash ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: props.agentWash }]} /> : null}
            {props.liveTintOpacity ? <CodeLineLiveTint opacity={props.liveTintOpacity} color={theme.colors.diff.added.background} /> : null}
            {props.leadingLane != null ? <View style={styles.leadingLane}>{props.leadingLane}</View> : null}
            <Pressable
                style={[
                    styles.rowPressable,
                    isWeb && (onPressInLine || onHoverLine || onPressOutLine)
                        ? WEB_RANGE_GESTURE_PRESSABLE_STYLE
                        : null,
                ]}
                onPress={onPress}
                onPressIn={onPressInLine ? (event) => onPressInLine(line, event as PreventableInteractionEvent) : undefined}
                onPressOut={onPressOutLine ? (event) => onPressOutLine(line, event as PreventableInteractionEvent) : undefined}
                onLongPress={onLongPress}
                onHoverIn={(isWeb && onPressAddComment) || onHoverLine ? (event) => onHoverIn(event as PreventableInteractionEvent) : undefined}
                onHoverOut={isWeb && onPressAddComment ? onHoverOut : undefined}
            >
                {(props.reviewLaneWidth ?? (canShowCommentAffordance ? CODE_GUTTER_METRICS.reviewLaneWidth : 0)) > 0 ? (
                    <View testID="review-comment-line-affordance-lane" style={[styles.commentButtonLane, props.reviewLaneWidth !== undefined ? { width: props.reviewLaneWidth } : null]}>
                        {canShowCommentAffordance && onPressAddComment ? <ReviewCommentLineAffordance
                            active={commentActive}
                            color={theme.colors.text.secondary}
                            onHoverIn={() => setIsHovered(true)}
                            onHoverOut={() => setIsHovered(false)}
                            onPress={() => onPressAddComment(line)}
                            visible={commentAffordanceVisible}
                        /> : null}
                    </View>
                ) : null}
                <CodeGutter line={line} showLineNumbers={showLineNumbers} lineNumberDigits={props.lineNumberDigits} />
                <View style={styles.codeContainer}>
                    {showPrefix && line.renderPrefixText ? (
                        <Text
                            numberOfLines={wrapLines ? undefined : 1}
                            ellipsizeMode={wrapLines ? undefined : 'clip'}
                            style={[styles.codeText, webWhitespaceStyle, { color: textColor }, !wrapLines ? styles.noWrap : null]}
                        >
                            {`${line.renderPrefixText} `}
                        </Text>
                    ) : null}
                    <Text
                        {...(isWeb ? { dataSet: { codeText: line.id } } : {})}
                        onTextLayout={canActivateToken ? (event) => { textLayoutsRef.current = event.nativeEvent.lines; } : undefined}
                        onPressIn={canActivateToken ? () => { longPressedRef.current = false; } : undefined}
                        onPress={activateText}
                        onLongPress={canActivateToken ? onLongPress : undefined}
                        selectable={textSelectable}
                        numberOfLines={wrapLines ? undefined : 1}
                        ellipsizeMode={wrapLines ? undefined : 'clip'}
                        style={[styles.codeText, webWhitespaceStyle, { color: textColor }, !wrapLines ? styles.noWrap : null]}
                    >
                        {(props.syntaxHighlighting?.mode === 'advanced' && props.advancedTokens && !line.renderIsHeaderLine)
                            ? mapTextOffsets(props.advancedTokens, (token) => token.text, (token, idx, offset) => (
                                <Text key={idx} useDefaultTypography={false} selectable={textSelectable} style={{ color: token.color }}>
                                    {renderFindText(token.text, sliceFindRanges(props.findRanges, offset, token.text.length), textSelectable, sliceDiagnostics(diagnostics, offset, token.text.length), squiggles)}
                                </Text>
                            ))
                            : intraLineTokensBySegment
                                ? mapTextOffsets(intraLineTokensBySegment, ({ segment }) => segment.text, ({ segment, tokens }, segIndex, segmentOffset) => {
                                    const segmentBg = segment.kind === 'added'
                                        ? theme.colors.diff.inlineAdded.background
                                        : segment.kind === 'removed'
                                            ? theme.colors.diff.inlineRemoved.background
                                            : 'transparent';

                                    const segmentFg = segment.kind === 'added'
                                        ? (theme.colors.diff.inlineAdded.foreground ?? textColor)
                                        : segment.kind === 'removed'
                                            ? (theme.colors.diff.inlineRemoved.foreground ?? textColor)
                                            : textColor;

                                    return (
                                        <Text
                                            key={segIndex}
                                            useDefaultTypography={false}
                                            selectable={textSelectable}
                                            style={segment.kind === 'context' ? null : { backgroundColor: glassSurfaceBackgroundColor(segmentBg, 'content'), borderRadius: 3 }}
                                        >
                                            {Array.isArray(tokens)
                                                ? mapTextOffsets(tokens, (token) => token.text, (tok, tokIndex, offset) => (
                                                    <Text
                                                        key={tokIndex}
                                                        useDefaultTypography={false}
                                                        selectable={textSelectable}
                                                        style={{
                                                            color: resolveTokenColorWithFallback(segmentFg, tok.type),
                                                            fontWeight: tok.type === 'keyword' ? '600' : '400',
                                                        }}
                                                    >
                                                        {renderFindText(tok.text, sliceFindRanges(props.findRanges, segmentOffset + offset, tok.text.length), undefined, sliceDiagnostics(diagnostics, segmentOffset + offset, tok.text.length), squiggles)}
                                                    </Text>
                                                ))
                                                : (
                                                    <Text useDefaultTypography={false} selectable={textSelectable} style={{ color: segmentFg }}>
                                                        {renderFindText(segment.text, sliceFindRanges(props.findRanges, segmentOffset, segment.text.length), undefined, sliceDiagnostics(diagnostics, segmentOffset, segment.text.length), squiggles)}
                                                    </Text>
                                                )}
                                        </Text>
                                    );
                                })
                            : simpleTokens
                                ? mapTextOffsets(simpleTokens, (token) => token.text, (token, idx, offset) => (
                                    <Text
                                        key={idx}
                                        useDefaultTypography={false}
                                        selectable={textSelectable}
                                        style={{
                                            color: renderTokenColor(token.type),
                                            fontWeight: token.type === 'keyword' ? '600' : '400',
                                        }}
                                    >
                                        {renderFindText(token.text, sliceFindRanges(props.findRanges, offset, token.text.length), textSelectable, sliceDiagnostics(diagnostics, offset, token.text.length), squiggles)}
                                    </Text>
                                ))
                                : renderFindText(line.renderCodeText || ' ', props.findRanges, textSelectable, diagnostics, squiggles)}
                    </Text>
                    {props.agentCaret}
                </View>
            </Pressable>
        </View>
    );
}

/** The live-edit tint (P3-R8): one compositor-only layer behind the line's text, driven by a shared clock. */
function CodeLineLiveTint(props: Readonly<{ opacity: SharedValue<number>; color: string }>) {
    const style = useAnimatedStyle(() => ({ opacity: props.opacity.value }));
    return <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: props.color }, style]} />;
}

const stylesheet = StyleSheet.create({
    row: {
        flexDirection: 'row',
        paddingVertical: 0,
        paddingHorizontal: CODE_GUTTER_METRICS.rowPadding,
        alignItems: 'flex-start',
    },
    rowHighlighted: {
        borderLeftWidth: 3,
        paddingLeft: 5,
    },
    rowSelected: {
        borderLeftWidth: 3,
        paddingLeft: 5,
    },
    rowReviewed: {
        borderLeftWidth: 2,
        paddingLeft: 6,
    },
    leadingLane: {
        alignSelf: 'stretch',
        flexShrink: 0,
    },
    rowPressable: {
        flexDirection: 'row',
        flex: 1,
        alignItems: 'flex-start',
    },
    commentButtonLane: {
        width: CODE_GUTTER_METRICS.reviewLaneWidth,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: CODE_LINE_BASE_HEIGHT,
    },
    codeContainer: {
        flexDirection: 'row',
        flex: 1,
    },
    codeText: {
        ...resolveMonoTypography(),
        fontSize: CODE_EDITOR_BASE_FONT_SIZE,
        lineHeight: CODE_LINE_BASE_HEIGHT,
    },
    noWrap: {
        flexShrink: 0,
    },
});

/** The problem underline: a wavy line in the state's colour under the name (ink stays the code's). */
function squiggleStyle(color: string): object {
    return Platform.OS === 'web'
        ? { textDecorationLine: 'underline', textDecorationStyle: 'wavy', textDecorationColor: color, textUnderlineOffset: 3 }
        : { textDecorationLine: 'underline', textDecorationStyle: 'dotted', textDecorationColor: color };
}
