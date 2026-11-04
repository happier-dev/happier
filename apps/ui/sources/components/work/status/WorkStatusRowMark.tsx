import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useSetting } from '@/sync/domains/state/storage';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';

import { useCollectionRowNeedsYouHighlight, type CollectionRowNeedsYouFacts } from '@/components/ui/lists/collection/CollectionRowNeedsYouHighlight';

import { resolveWorkStatusRowMark, resolveWorkStatusRowWord } from './workStatusRowMark';

/** The row's status slot (one 14 px column, so marks, words and ages share one right edge). */
const STATUS_SLOT_SIZE = 14;
const WORKING_SPINNER_SIZE = 12;
/** News is the smallest mark; needs you and failure are a step larger so their colour reads at a glance. */
const NEWS_DOT_SIZE = 6;
const STATE_DOT_SIZE = 7;
const UNREAD_CENTER_SIZE = 3;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: STATUS_SLOT_SIZE,
        height: STATUS_SLOT_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unreadCenter: {
        position: 'absolute',
        left: (STATUS_SLOT_SIZE - UNREAD_CENTER_SIZE) / 2,
        top: (STATUS_SLOT_SIZE - UNREAD_CENTER_SIZE) / 2,
        width: UNREAD_CENTER_SIZE,
        height: UNREAD_CENTER_SIZE,
        borderRadius: UNREAD_CENTER_SIZE / 2,
        backgroundColor: theme.colors.text.primary,
    },
}));

/**
 * A work list row's calm status mark (owner ruling 2026-11-01, 0.2's one-slot principle): the spinner while work
 * runs, a small ink dot for news, the amber dot when it needs you, the rose dot when it failed, and nothing for a
 * calm row (its age takes the slot). `resolveWorkStatusRowMark` decides; this draws. Session, Run, Workflow and
 * Discussion rows use it; the Bot rail follows through `SessionItem`.
 */
export const WorkStatusRowMark = React.memo(function WorkStatusRowMark(props: Readonly<{
    status: WorkStatusPresentation;
    /** Suffix of the slot's test ids (`session-row-attention-indicator-<suffix>`, kept for existing selectors). */
    testIDSuffix: string;
    hasUnreadMessages?: boolean;
    animationEnabled?: boolean;
    /**
     * A row that needs the person outside the Needs you shelf: the opt-in highlight "Pulse" lets its amber dot
     * breathe (the shared status-dot pulse) until it is opened. Omitted on every other row, so calm rows never
     * read the preference.
     */
    needsYouHighlight?: CollectionRowNeedsYouFacts | null;
}>) {
    const { theme } = useUnistyles();
    const mark = resolveWorkStatusRowMark(props.status);
    if (mark === 'none') return null;

    const dotTestID = `session-row-attention-indicator-dot-${props.testIDSuffix}`;
    return (
        <View
            testID={`session-row-attention-indicator-${props.testIDSuffix}`}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={stylesheet.container}
        >
            <View testID={`session-list-attention-indicator-${props.testIDSuffix}-${props.status.state}`} style={stylesheet.container}>
                {mark === 'working' ? (
                    <WorkingRowMark testIDSuffix={props.testIDSuffix} color={workStatusGlyphColor(theme.colors, 'neutral')}
                        animationEnabled={props.animationEnabled !== false} />
                ) : mark === 'attention' && props.needsYouHighlight ? (
                    <HighlightedAttentionDot testID={dotTestID} facts={props.needsYouHighlight}
                        color={workStatusGlyphColor(theme.colors, 'attention')} />
                ) : (
                    <StatusDot
                        testID={dotTestID}
                        color={mark === 'news' ? theme.colors.text.primary : workStatusGlyphColor(theme.colors, mark === 'danger' ? 'danger' : 'attention')}
                        size={mark === 'news' ? NEWS_DOT_SIZE : STATE_DOT_SIZE}
                        animationEnabled={props.animationEnabled !== false}
                    />
                )}
                {mark === 'working' && props.hasUnreadMessages ? (
                    <View testID={`session-row-unread-center-${props.testIDSuffix}`} pointerEvents="none" accessible={false}
                        style={stylesheet.unreadCenter} />
                ) : null}
            </View>
        </View>
    );
});

/** The facts already gate visibility and opening; the status dot owner adds reduced motion and hidden windows. */
function HighlightedAttentionDot(props: Readonly<{ testID: string; facts: CollectionRowNeedsYouFacts; color: string }>) {
    const highlight = useCollectionRowNeedsYouHighlight(props.facts);
    return <StatusDot testID={props.testID} color={props.color} size={STATE_DOT_SIZE} isPulsing={highlight.pulse} />;
}

/**
 * The working mark in the Account's restored 0.2 style (owner amendment 2026-11-01): the spinner, or a pulsing dot
 * through the shared status-dot pulse (CSS on the web, the native driver elsewhere). Only working rows read it.
 */
function WorkingRowMark(props: Readonly<{ testIDSuffix: string; color: string; animationEnabled: boolean }>) {
    const style = useSetting('sessionListNarrowWorkingIndicatorStyle');
    if (style === 'pulse') {
        return <StatusDot testID={`session-row-attention-indicator-pulse-${props.testIDSuffix}`} color={props.color}
            size={NEWS_DOT_SIZE} isPulsing animationEnabled={props.animationEnabled} />;
    }
    return <ActivitySpinner testID={`session-row-attention-indicator-spinner-${props.testIDSuffix}`} size={WORKING_SPINNER_SIZE}
        color={props.color} animationEnabled={props.animationEnabled} />;
}

/**
 * A Session row's status word for the status-words option: plain, or a playful verb while it works when the Account
 * keeps 0.2's animated working text on (0.2 animated Session rows only; a Run's "Stopping" stays informative).
 * Mounted only where a word is drawn, so other rows never read the preference.
 */
export function WorkStatusRowWord(props: Readonly<{ status: WorkStatusPresentation; seed: string; children: (word: string) => React.ReactNode }>) {
    const animatedWorkingText = useSetting('sessionListWorkingStatusAnimatedTextEnabled') !== false;
    return <>{props.children(resolveWorkStatusRowWord(props.status, { animatedWorkingText, seed: props.seed }))}</>;
}
