import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { useVoiceSurfaceLatestTranscriptText } from '@/components/voice/surface/useVoiceSurfaceConversationState';
import { useSetting } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { resolveVoicePresentedProviderId } from '@/voice/settings/resolveVoiceProviderId';

import { resolveVoiceCompactLine, resolveVoiceTranscriptTail } from './resolveVoicePresenceCaption';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/**
 * The quiet second line of the island and the phone pill (§4.1, lab `voice-presence` STp): what the
 * call needs while it is muted, opening, reconnecting, blocked or failed, otherwise the latest words
 * said, either side.
 * It is a glimpse — the full turns live in the Voice section and the conversation — and it never
 * stands in placeholder speech.
 */
export const VoiceCompactTranscript = React.memo(function VoiceCompactTranscript(props: Readonly<{
    voice: Pick<VoiceAttemptControlProjection, 'sessionId' | 'live' | 'muted' | 'surfaceState' | 'captionLabel'>;
    testID?: string;
}>): React.ReactElement | null {
    const voiceSettings = useSetting('voice');
    const canonicalVoice = React.useMemo(() => voiceSettingsParse(voiceSettings), [voiceSettings]);
    const snapshot = useVoiceSessionSnapshot();
    useVoiceProviderRegistryRevision(voiceProviderRegistry);
    const providerId = resolveVoicePresentedProviderId(snapshot, canonicalVoice, voiceProviderRegistry) ?? 'off';
    const latestText = useVoiceSurfaceLatestTranscriptText({
        providerId,
        activeControlSessionId: props.voice.sessionId,
        surfaceSessionId: null,
        transcriptEnabled: canonicalVoice.ui.activityFeedEnabled === true && props.voice.live,
        voiceSettings,
    });
    const line = resolveVoiceCompactLine(props.voice, latestText);
    if (!line) return null;
    if (line.kind === 'caption') {
        return <Text testID={props.testID ?? 'voice-compact-transcript'} numberOfLines={1} style={styles.line}>{line.text}</Text>;
    }
    // The newest words stay in view: native ellipsizes the head of the line; web, which cannot,
    // shows the latest sentence marked as a tail. Either way the closing quote survives.
    const web = Platform.OS === 'web';
    const shown = web ? resolveVoiceTranscriptTail(line.text) : { text: line.text, tail: false };
    return (
        <Text
            testID={props.testID ?? 'voice-compact-transcript'}
            numberOfLines={1}
            ellipsizeMode={web ? 'tail' : 'head'}
            style={styles.line}
        >
            {`“${shown.tail ? '…' : ''}${shown.text}”`}
        </Text>
    );
});

const styles = StyleSheet.create((theme) => ({
    line: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
}));
