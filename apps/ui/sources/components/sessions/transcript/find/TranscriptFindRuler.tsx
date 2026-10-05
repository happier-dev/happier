import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { TranscriptFindModel } from './useTranscriptFind';
import { resolveTranscriptFindRulerTicks } from './transcriptFindRulerTicks';

export type TranscriptFindMessageLayout = (messageId: string) => Readonly<{ y: number; height: number }> | null;

/**
 * The overview ruler on the transcript's scroll edge (Find lab F1 `.fd-ruler`): one mark per matched
 * message where its row sits, the current one solid, and a dotted cap at the top while older messages
 * remain unsearched. Mounted only while Find is open; it subscribes to the model's overview alone.
 */
export const TranscriptFindRuler = React.memo(function TranscriptFindRuler(props: Readonly<{
    model: TranscriptFindModel;
    measureMessage: TranscriptFindMessageLayout;
    /** The list's content height; a change re-reads positions as rows are measured. */
    contentHeight: number;
    olderRemaining: boolean;
}>) {
    const overview = React.useSyncExternalStore(props.model.subscribe, props.model.getOverview, props.model.getOverview);
    const [trackHeight, setTrackHeight] = React.useState(0);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => setTrackHeight(event.nativeEvent.layout.height), []);
    const ticks = React.useMemo(() => resolveTranscriptFindRulerTicks({
        messageIds: overview.messageIds, currentMessageId: overview.currentMessageId,
        contentHeight: props.contentHeight, trackHeight, measure: props.measureMessage,
    }), [overview, props.contentHeight, trackHeight, props.measureMessage]);
    return <View testID="transcript-find-ruler" pointerEvents="none" aria-hidden style={styles.ruler} onLayout={onLayout}>
        {props.olderRemaining ? <View testID="transcript-find-ruler-older" style={styles.older}>
            <View style={styles.dot} /><View style={styles.dot} />
        </View> : null}
        {ticks.map((tick) => <View key={tick.key} testID={tick.current ? 'transcript-find-ruler-current' : undefined}
            style={[styles.tick, tick.current ? styles.current : null, { top: tick.top }]} />)}
    </View>;
});

const styles = StyleSheet.create((theme) => ({
    // On the scroll track: inset from the pane edge and its ends, never taking a pointer.
    ruler: { position: 'absolute', top: 6, bottom: 6, right: 3, width: 6 },
    tick: { position: 'absolute', left: 0, right: 0, height: 3, marginTop: -1.5, borderRadius: 2,
        backgroundColor: theme.colors.find.overviewMark, opacity: 0.55 },
    // The current mark is 4 px of solid ink inside a 1 px paper ring (lab `box-shadow: 0 0 0 1px paper`).
    current: { height: 6, marginTop: -3, left: -1, right: -1, borderRadius: 3, opacity: 1,
        borderWidth: 1, borderColor: theme.colors.surface.base },
    older: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', opacity: 0.8 },
    dot: { width: 2, height: 2, borderRadius: 1, backgroundColor: theme.colors.find.overviewMark },
}));
