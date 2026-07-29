import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { TranscriptNavigationPanel } from '@/components/sessions/transcript/navigation/TranscriptNavigationPanel';
import {
    awaitTranscriptNavigationJumpHandler,
    readTranscriptNavigationJumpHandler,
} from '@/components/sessions/transcript/navigation/transcriptNavigationPaneStore';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationEntryPressResult,
} from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { useSessionTranscriptNavigationEntries } from '@/components/sessions/transcript/navigation/useSessionTranscriptNavigationEntries';
import { useTranscriptNavigationCurrentAnchorId } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';

export type SessionTranscriptNavigationPaneProps = Readonly<{
    sessionId: string;
    /**
     * Reveals the transcript before the jump lands. Hosts that replace the transcript with
     * this pane (the mobile right-panel route, a separate screen from the transcript) pass
     * their reveal; hosts that render it beside a live transcript (the desktop right pane)
     * pass nothing.
     */
    onRevealTranscript?: () => void;
    onRequestClose?: () => void;
    testIDPrefix?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    pane: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
    },
}));

function defaultTestIDPrefix(prefix: string | undefined): string {
    return prefix && prefix.trim().length > 0 ? prefix.trim() : 'session-transcript-navigation';
}

const NOT_FOUND_OUTCOME = Object.freeze({ status: 'not-found' as const });

/**
 * Owns the navigation pane's data: it derives entries itself and reads the reader's current
 * position from the session's visibility store, so the pane is complete on a surface where
 * the transcript is unmounted or frozen. The transcript host stays the owner of the JUMP —
 * it is the only thing that can move a live viewport — and the pane reaches it through the
 * session's jump-handler registry at press time.
 */
export const SessionTranscriptNavigationPane = React.memo((props: SessionTranscriptNavigationPaneProps) => {
    const styles = stylesheet;
    const testIDPrefix = defaultTestIDPrefix(props.testIDPrefix);
    const sessionId = props.sessionId;
    const onRevealTranscript = props.onRevealTranscript;
    const { isLoaded, transcriptNavigationEntries } = useSessionTranscriptNavigationEntries(sessionId);
    const activeEntryId = useTranscriptNavigationCurrentAnchorId(sessionId);

    const handleEntryPress = React.useCallback((entry: TranscriptNavigationEntry): TranscriptNavigationEntryPressResult => {
        if (!onRevealTranscript) {
            const handler = readTranscriptNavigationJumpHandler(sessionId);
            return handler ? handler(entry) : NOT_FOUND_OUTCOME;
        }
        // Reveal FIRST: jumping while the transcript scene is still hidden scrolls a
        // viewport nobody can see, and on a frozen scene the host has torn its jump
        // handler down entirely. The awaiter yields the reveal a task and then takes the
        // handler the revealed host republishes.
        onRevealTranscript();
        return awaitTranscriptNavigationJumpHandler(sessionId).then((handler) => (
            handler ? Promise.resolve(handler(entry)) : NOT_FOUND_OUTCOME
        ));
    }, [onRevealTranscript, sessionId]);

    return (
        <View testID={`${testIDPrefix}-pane`} style={styles.pane}>
            <TranscriptNavigationPanel
                sessionId={sessionId}
                entries={transcriptNavigationEntries}
                activeEntryId={activeEntryId}
                onEntryPress={handleEntryPress}
                onRequestClose={props.onRequestClose}
                isLoading={!isLoaded}
                testIDPrefix={testIDPrefix}
            />
        </View>
    );
});
