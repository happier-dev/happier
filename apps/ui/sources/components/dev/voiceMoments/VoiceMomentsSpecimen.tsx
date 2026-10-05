import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { buildVoicePresenceSurfaceFixture } from '@/components/dev/voicePresence/voicePresenceFixtures';
import { VoiceGlance } from '@/components/voice/presence/VoiceGlance';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';

/**
 * Dev-only: the real Voice section at the continuation moment (lab C1 — this device let go because
 * the conversation continued on another device). `C1` names the other device; `CX` is an unnamed one.
 */
export function VoiceMomentsSpecimen(props: Readonly<{ frame: string }>): React.ReactElement {
    const model = React.useMemo((): VoiceSurfaceViewModel => {
        const base = buildVoicePresenceSurfaceFixture('ended');
        const ended = base.attemptControl.ended!;
        return {
            ...base,
            attemptControl: {
                ...base.attemptControl,
                ended: {
                    ...ended,
                    reason: {
                        kind: 'continued_elsewhere',
                        continuation: {
                            v: 1,
                            deviceId: 'dev-other-device',
                            deviceDisplayName: props.frame === 'CX' ? null : 'iPhone',
                            conversation: { serverId: 'dev', sessionId: 'dev-conversation' },
                        },
                    },
                },
            },
        };
    }, [props.frame]);
    return (
        <ScrollView style={styles.page} contentContainerStyle={styles.content}>
            <View style={styles.column}>
                <VoiceGlance model={model} presentation="companion" testID="dev-voice-moments" />
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.background.canvas },
    content: { padding: 24 },
    column: { width: '100%', maxWidth: 340 },
}));
