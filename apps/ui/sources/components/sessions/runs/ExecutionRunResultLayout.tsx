import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** Below this width the foot stacks its note above the actions (phones, a narrow Details drawer). */
const NARROW_FOOT_WIDTH_PX = 480;

export type ExecutionRunResultPresentation = 'message' | 'page';

const stylesheet = StyleSheet.create((theme) => ({
    message: {
        gap: 14,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    page: {
        flex: 1,
        minHeight: 0,
    },
    pageScroll: {
        flex: 1,
        minHeight: 0,
    },
    pageContent: {
        gap: 18,
        paddingTop: 4,
        paddingBottom: 16,
    },
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footNarrow: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    footNote: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
        fontSize: 13,
        fontVariant: ['tabular-nums'],
    },
    footNoteBlock: {
        flex: 1,
        minWidth: 0,
    },
    footNoteStrong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        fontVariant: ['tabular-nums'],
    },
    dock: {
        paddingTop: 10,
    },
    footActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    footActionsWrap: {
        flexWrap: 'wrap',
    },
    footActionsNarrow: {
        justifyContent: 'flex-end',
    },
    messageFoot: {
        gap: 10,
    },
}));

/**
 * The frame every structured Run result (review findings, plan, delegation) shares, so the three
 * read the same on the Run page and in the transcript. In the transcript (`message`) the result is
 * one card with its actions at its end. On the Run page (`page`, agents lab RP1) the result is the
 * page: its body scrolls, the Run's own `after` row ("How it got there") closes the body, and the
 * foot — the one primary plus its quiet companion — stays pinned under it.
 */
export function ExecutionRunResultLayout(props: Readonly<{
    presentation: ExecutionRunResultPresentation;
    testID?: string;
    children: React.ReactNode;
    /** Page only: what closes the scrolling body (the Run's steps disclosure). */
    after?: React.ReactNode;
    /** A quiet present-tense note at the foot's start ("1 fix selected"). */
    footNote?: React.ReactNode;
    /** Page only: a second, quieter line under the note; the note then reads as the tray's title. */
    footDetail?: string | null;
    /** The foot's actions: at most one primary, then its quiet companions. */
    footActions?: React.ReactNode;
    /** Page only: what sits under the foot, pinned with it (the result's own follow-up field). */
    dock?: React.ReactNode;
    /** Message only: one line under the actions saying what the next action will do. */
    footHint?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const [narrow, setNarrow] = React.useState(false);
    const onFootLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width < NARROW_FOOT_WIDTH_PX;
        setNarrow((current) => (current === next ? current : next));
    }, []);
    const hasFoot = Boolean(props.footActions) || Boolean(props.footNote);

    if (props.presentation === 'message') {
        return (
            <View testID={props.testID} style={styles.message}>
                {props.children}
                {hasFoot ? (
                    <View style={styles.messageFoot}>
                        {props.footNote ? <Text style={styles.footNote}>{props.footNote}</Text> : null}
                        {props.footActions ? <View style={[styles.footActions, styles.footActionsWrap]}>{props.footActions}</View> : null}
                        {props.footHint ?? null}
                    </View>
                ) : null}
            </View>
        );
    }

    return (
        <View testID={props.testID} style={styles.page}>
            <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent}>
                {props.children}
                {props.after ?? null}
            </ScrollView>
            {hasFoot ? (
                <View onLayout={onFootLayout} style={[styles.foot, narrow ? styles.footNarrow : null]}>
                    {props.footNote && props.footDetail ? (
                        <View style={styles.footNoteBlock}>
                            <Text numberOfLines={1} style={styles.footNoteStrong}>{props.footNote}</Text>
                            <Text numberOfLines={1} style={styles.footNote}>{props.footDetail}</Text>
                        </View>
                    ) : props.footNote ? (
                        <Text numberOfLines={1} style={styles.footNote}>{props.footNote}</Text>
                    ) : <View style={{ flex: 1 }} />}
                    {props.footActions ? (
                        <View style={[styles.footActions, narrow ? styles.footActionsNarrow : null]}>{props.footActions}</View>
                    ) : null}
                </View>
            ) : null}
            {props.dock ? <View style={styles.dock}>{props.dock}</View> : null}
        </View>
    );
}
