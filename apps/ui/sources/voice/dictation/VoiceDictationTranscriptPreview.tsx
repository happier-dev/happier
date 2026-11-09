import * as React from 'react';

import { Text } from '@/components/ui/text/Text';

import { voiceDictationController } from './voiceDictationRuntime';

/** Provisional recognizer text stays outside the controlled draft and global state. */
export function VoiceDictationTranscriptPreview(props: Readonly<{ controlId: string }>): React.ReactElement | null {
    const subscribe = React.useCallback(
        (listener: () => void) => voiceDictationController.subscribePartialTranscript(props.controlId, listener),
        [props.controlId],
    );
    const getSnapshot = React.useCallback(
        () => voiceDictationController.getPartialTranscript(props.controlId),
        [props.controlId],
    );
    const transcript = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return transcript ? <Text variant="body" testID="voice-dictation-partial">{transcript}</Text> : null;
}
