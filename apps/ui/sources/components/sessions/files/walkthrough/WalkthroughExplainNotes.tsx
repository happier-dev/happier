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
import { WalkthroughCaptionLetters, WalkthroughCaptionList, WalkthroughStopCaptionsSheet, type WalkthroughCaptionFocus } from './WalkthroughCaptions';
import type { WalkthroughLetteredCaption, WalkthroughReading, WalkthroughStop } from './walkthroughReading';

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
 * file order, with the person's marks. A stop's note is written out once, at its first hunk; later files
 * and a hunk's second stop carry its title only. A hunk no stop explains says so. No second store: this projects the same {@link WalkthroughReading}.
 */
export const WalkthroughExplainNotes = React.memo(function WalkthroughExplainNotes(props: Readonly<{
    reading: WalkthroughReading;
    path: string;
    hunkIndex: number;
    placement: 'column' | 'inline';
    onReadInWalkthrough?: (stopId: string) => void;
    /** Explain's caption pairing for this comparison; absent, captions are not drawn. */
    captionFocus?: WalkthroughCaptionFocus | null;
}>) {
    const { theme } = useUnistyles();
    const notes = props.reading.explainNotesByHunk.get(props.path)?.[props.hunkIndex];
    const fileCaptions = props.captionFocus ? props.reading.captionsByPath.get(props.path) : undefined;
    if (!notes || notes.length === 0) return null;
    const inline = props.placement === 'inline';
    return (
        <View testID={`walkthrough-explain-${props.path}`} style={inline ? styles.inline : styles.column}>
            {notes.map((note, index) => {
                if (!note.stop) {
                    return <Text key={note.key} style={[styles.none, inline ? styles.noneInline : null]}>{t('walkthrough.explain.notInStory')}</Text>;
                }
                const stop = note.stop;
                const captions = fileCaptions ? captionsOfStop(fileCaptions, stop.id) : NO_CAPTIONS;
                if (inline && captions.length > 0 && props.captionFocus) {
                    return <InlineStopWithCaptions key={note.key} path={props.path} stop={stop} captions={captions}
                        focus={props.captionFocus} onReadInWalkthrough={props.onReadInWalkthrough} />;
                }
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
                    <View key={note.key} style={[styles.note, index > 0 ? styles.noteDivided : null, note.secondary && index === notes.length - 1 ? styles.noteTitleOnly : null]}>
                        <View style={styles.noteHeader}>
                            <WalkthroughStopNumber number={stop.number} reviewed={stop.reviewed} />
                            <Text style={[styles.noteTitle, note.secondary ? styles.noteTitleSecondary : null]}>{stop.title}</Text>
                        </View>
                        {note.secondary ? null : <Text style={styles.noteBody}>{firstSentence(stop.explanationMarkdown)}</Text>}
                        {captions.length > 0 && props.captionFocus ? (
                            <View style={styles.captions}>
                                <WalkthroughCaptionList path={props.path} captions={captions} focus={props.captionFocus} />
                            </View>
                        ) : null}
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

const NO_CAPTIONS: readonly WalkthroughLetteredCaption[] = [];

function captionsOfStop(captions: readonly WalkthroughLetteredCaption[], stopId: string): readonly WalkthroughLetteredCaption[] {
    const own = captions.filter((caption) => caption.stopId === stopId);
    return own.length > 0 ? own : NO_CAPTIONS;
}

/** Phone (lab 390): the stop header carries its captions' letters; tapping it lists them in a sheet. */
function InlineStopWithCaptions(props: Readonly<{
    path: string;
    stop: WalkthroughStop;
    captions: readonly WalkthroughLetteredCaption[];
    focus: WalkthroughCaptionFocus;
    onReadInWalkthrough?: (stopId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    return (
        <View ref={anchorRef} collapsable={false}>
            <HappierPressable
                testID={`walkthrough-stop-captions-${props.stop.number}`}
                accessibilityRole="button"
                hasPopup="dialog"
                expanded={open}
                accessibilityLabel={`${t('walkthrough.stopA11y', { number: props.stop.number, title: props.stop.title })}, ${t('walkthrough.explain.stopCaptions', { number: props.stop.number, count: props.captions.length })}`}
                onPress={() => setOpen(true)}
                style={styles.inlineRow}
            >
                <WalkthroughStopNumber number={props.stop.number} reviewed={props.stop.reviewed} size="rail" />
                <Text style={styles.inlineTitleShrink} numberOfLines={1}>{props.stop.title}</Text>
                <WalkthroughCaptionLetters captions={props.captions} />
                <View style={styles.inlineSpacer} />
                <Icon name="caret-right" size={12} color={theme.colors.text.tertiary} />
            </HappierPressable>
            <WalkthroughStopCaptionsSheet anchorRef={anchorRef} open={open} onClose={close} path={props.path} stop={props.stop}
                captions={props.captions} focus={props.focus} onReadInWalkthrough={props.onReadInWalkthrough} />
        </View>
    );
}

/**
 * Files' Explain in the file list (lab WT8-F2): the stops that explain this file, once each, in reading
 * order, with the person's marks. Projected from the same notes as the hunks; a file no stop explains
 * draws nothing.
 */
export const WalkthroughFileStops = React.memo(function WalkthroughFileStops(props: Readonly<{ reading: WalkthroughReading; path: string }>) {
    const stops = React.useMemo(() => {
        const byId = new Map<string, NonNullable<WalkthroughReading['stops'][number]>>();
        for (const hunk of props.reading.explainNotesByHunk.get(props.path) ?? []) {
            for (const note of hunk) if (note.stop && !byId.has(note.stop.id)) byId.set(note.stop.id, note.stop);
        }
        return [...byId.values()].sort((a, b) => a.number - b.number);
    }, [props.path, props.reading.explainNotesByHunk]);
    if (stops.length === 0) return null;
    return (
        <View
            testID={`walkthrough-file-stops-${props.path}`}
            accessibilityLabel={stops.map((stop) => t('walkthrough.stopA11y', { number: stop.number, title: stop.title })).join(', ')}
            style={styles.fileStops}
        >
            {stops.map((stop) => <WalkthroughStopNumber key={stop.id} number={stop.number} reviewed={stop.reviewed} size="rail" />)}
        </View>
    );
});

/** Files' Explain column width (lab WT8-F2: a narrow margin of notes beside the code). */
export const WALKTHROUGH_EXPLAIN_COLUMN_WIDTH_PX = 320;

const styles = StyleSheet.create((theme) => ({
    // The diff block's notes column owns the frame (its hairline and the hunk alignment); a note is its words.
    column: { paddingHorizontal: theme.space.s16 },
    inline: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s6, gap: theme.space.s2, backgroundColor: theme.colors.surface.inset },
    note: { paddingBottom: 14 },
    // A title-only note (a stop already explained above, or a hunk's second stop) leaves no blank tail under one-line code.
    noteTitleOnly: { paddingBottom: theme.space.s4 },
    noteDivided: { paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    noteHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
    noteTitle: { flex: 1, ...Typography.variant('label', 'semiBold'),  color: theme.colors.text.primary,  },
    noteTitleSecondary: { ...Typography.variant('body', 'semiBold'), color: theme.colors.text.secondary },
    noteBody: { marginTop: theme.space.s4, marginLeft: 30, ...Typography.variant('body'),  color: theme.colors.text.secondary,  },
    read: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, marginTop: theme.space.s6, marginLeft: 30 },
    readText: { ...Typography.variant('body', 'medium'), color: theme.colors.text.secondary,  },
    none: { ...Typography.variant('body'), color: theme.colors.text.tertiary, paddingBottom: theme.space.s12,  },
    noneInline: { paddingBottom: 0, paddingVertical: theme.space.s4 },
    inlineRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minHeight: 32 },
    inlineTitle: { flex: 1, ...Typography.variant('body', 'semiBold'), color: theme.colors.text.primary,  },
    inlineTitleShrink: { flexShrink: 1, ...Typography.variant('body', 'semiBold'), color: theme.colors.text.primary },
    inlineSpacer: { flex: 1 },
    captions: { marginLeft: 22 },
    fileStops: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 },
}));
