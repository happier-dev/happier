import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol/browser/recording/v1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RecordingElapsed } from '@/components/ui/media/recording/RecordingElapsed';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    capsule: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 30,
        paddingLeft: theme.space.s10,
        paddingRight: theme.space.s2,
        borderRadius: 15,
        backgroundColor: theme.colors.state.danger.background,
    },
}));

/**
 * A running recording, docked in the chrome row: "● 0:42 · Stop" (lab `browser` Q notes). The one
 * place red speaks in the browser chrome, and only while something is being recorded; an idle
 * recorder lives in the `⋯` menu. The elapsed time ticks in this leaf, so the second hand never
 * re-renders the shell. Discarding the recording is the menu's job, beside Record.
 */
export function BrowserRecordingCapsule<R extends Pick<BrowserRecordingSessionV1, 'status' | 'startedAtMs' | 'durationMs'>>(props: Readonly<{
    recording: R;
    onStop?: (recording: R) => void;
    testID: string;
}>): React.ReactElement {
    const running = props.recording.status === 'recording';
    const tickingSeconds = useElapsedTime(running ? props.recording.startedAtMs : null);
    const seconds = running ? tickingSeconds : Math.floor(props.recording.durationMs / 1_000);
    const elapsed = formatPlaybackTime(seconds);
    const { onStop, recording } = props;
    return (
        <View
            testID={`${props.testID}-status-recording`}
            style={stylesheet.capsule}
            accessibilityLabel={t('browserPresence.recording.elapsedA11y', { elapsed })}
        >
            <RecordingElapsed seconds={seconds} size="capsule" />
            <IconButton
                testID={`${props.testID}-stop`}
                iconName="stop"
                variant="plain"
                accessibilityLabel={t('browserRecording.actions.stop')}
                tooltip={t('browserRecording.actions.stop')}
                size={26}
                interactiveTargetGapPx={8}
                disabled={!onStop}
                onPress={() => onStop?.(recording)}
            />
        </View>
    );
}
