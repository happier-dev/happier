import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { parseMarkdownSpans } from '@/components/markdown/parseMarkdownSpans';
import { t } from '@/text';

import { WalkthroughStopNumber } from './WalkthroughAtoms';
import type { WalkthroughReading } from './walkthroughReading';

function plainInlineText(markdown: string): string {
    return parseMarkdownSpans(markdown, false).map((span) => span.styles.includes('code') || span.text === markdown
        ? span.text : plainInlineText(span.text)).join('');
}

/** The note's one-line gist: inline labels, never citation destinations or formatting syntax. */
function firstSentence(markdown: string): string {
    const plain = plainInlineText(markdown).replace(/\s+/g, ' ').trim();
    const end = plain.search(/[.!?](\s|$)/);
    return end >= 0 ? plain.slice(0, end + 1) : plain;
}

/**
 * Files' Explain for one file (lab WT8-F2): the walkthrough's own stops beside the hunks they explain, in
 * file order, with the person's marks. A hunk two stops explain shows both, the second smaller; a hunk
 * no stop explains says so. No second store: this projects the same {@link WalkthroughReading}.
 */
export const WalkthroughExplainNotes = React.memo(function WalkthroughExplainNotes(props: Readonly<{
    reading: WalkthroughReading;
    path: string;
    hunkIndex: number;
    placement: 'column' | 'inline';
    onReadInWalkthrough?: (stopId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const notes = props.reading.explainNotesByHunk.get(props.path)?.[props.hunkIndex];
    if (!notes || notes.length === 0) return null;
    const inline = props.placement === 'inline';
    return (
        <View testID={`walkthrough-explain-${props.path}`} style={inline ? styles.inline : styles.column}>
            {notes.map((note, index) => {
                if (!note.stop) {
                    return <Text key={note.key} style={[styles.none, inline ? styles.noneInline : null]}>{t('walkthrough.explain.notInStory')}</Text>;
                }
                const stop = note.stop;
                if (inline) {
                    return (
                        <HappierPressable
                            key={note.key}
                            accessibilityRole="link"
                            accessibilityLabel={t('walkthrough.stopA11y', { number: stop.number, title: stop.title })}
                            onPress={() => props.onReadInWalkthrough?.(stop.id)}
                            style={styles.inlineRow}
                        >
                            <WalkthroughStopNumber number={stop.number} reviewed={stop.reviewed} size="rail" />
                            <Text style={styles.inlineTitle} numberOfLines={1}>{stop.title}</Text>
                            <Icon name="caret-right" size={12} color={theme.colors.text.tertiary} />
                        </HappierPressable>
                    );
                }
                return (
                    <View key={note.key} style={[styles.note, index > 0 ? styles.noteDivided : null]}>
                        <View style={styles.noteHeader}>
                            <WalkthroughStopNumber number={stop.number} reviewed={stop.reviewed} />
                            <Text style={[styles.noteTitle, note.secondary ? styles.noteTitleSecondary : null]}>{stop.title}</Text>
                        </View>
                        {note.secondary ? null : <Text style={styles.noteBody}>{firstSentence(stop.explanationMarkdown)}</Text>}
                        {!note.secondary && props.onReadInWalkthrough ? (
                            <HappierPressable
                                accessibilityRole="link"
                                accessibilityLabel={t('walkthrough.explain.readInWalkthrough')}
                                onPress={() => props.onReadInWalkthrough?.(stop.id)}
                                style={(state) => [styles.read, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                            >
                                <Text style={styles.readText}>{t('walkthrough.explain.readInWalkthrough')}</Text>
                                <Icon name="caret-right" size={12} color={theme.colors.text.tertiary} />
                            </HappierPressable>
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
});

/** Files' Explain column width (lab WT8-F2: a narrow margin of notes beside the code). */
export const WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX = 320;

const styles = StyleSheet.create((theme) => ({
    column: {
        width: WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX,
        paddingHorizontal: 16,
        paddingTop: 12,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    inline: { paddingHorizontal: 16, paddingVertical: 6, gap: 2, backgroundColor: theme.colors.surface.inset },
    note: { paddingBottom: 14 },
    noteDivided: { paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    noteHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    noteTitle: { flex: 1, fontSize: 14.5, lineHeight: 20, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    noteTitleSecondary: { fontSize: 13.5, color: theme.colors.text.secondary },
    noteBody: { marginTop: 4, marginLeft: 30, fontSize: 13.5, lineHeight: 20, color: theme.colors.text.secondary, ...Typography.default() },
    read: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, marginLeft: 30 },
    readText: { fontSize: 13, color: theme.colors.text.secondary, ...Typography.default('medium') },
    none: { fontSize: 13, color: theme.colors.text.tertiary, paddingBottom: 12, ...Typography.default() },
    noneInline: { paddingBottom: 0, paddingVertical: 4 },
    inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
    inlineTitle: { flex: 1, fontSize: 13.5, color: theme.colors.text.primary, ...Typography.default('semiBold') },
}));
