import { Ionicons, Octicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import type { VoiceDictationSnapshot } from '@/voice/dictation/VoiceDictationController';

export const AgentInputSubmitButton = React.memo(function AgentInputSubmitButton(props: Readonly<{
    testID: string;
    sessionId?: string;
    submitAccessibilityLabel?: string;
    disabled: boolean;
    isSending?: boolean;
    isStopping?: boolean;
    hasSendableContent: boolean;
    canStop?: boolean;
    dictationPressHandler?: (() => void) | undefined;
    dictationStatus: VoiceDictationSnapshot['status'];
    onSend: () => void;
    onStop?: () => void;
}>) {
    const { theme } = useUnistyles();
    const dictationActive = props.dictationStatus !== 'idle';
    const dictationTranscribing = props.dictationStatus === 'transcribing';
    const showDictation = Boolean(props.dictationPressHandler)
        && (!props.hasSendableContent || dictationActive);
    const showStopWhenEmpty = !props.hasSendableContent && !showDictation && props.canStop === true;

    return (
        <PrimaryCircleIconButton
            testID={props.testID}
            active={props.hasSendableContent || props.isSending || showDictation || showStopWhenEmpty}
            loading={props.isSending || dictationTranscribing || (showStopWhenEmpty && props.isStopping)}
            disabled={props.disabled}
            accessibilityLabel={
                dictationTranscribing
                    ? t('voiceAssistant.transcribing')
                    : dictationActive && showDictation
                    ? t('voiceAssistant.endDictation')
                    : props.hasSendableContent
                    ? (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                    : (
                        showDictation
                            ? t('voiceAssistant.startDictation')
                            : showStopWhenEmpty
                                ? t('agentInput.stopCodingTurn')
                            : (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                    )
            }
            accessibilityHint={
                (!props.hasSendableContent && !showDictation && !showStopWhenEmpty)
                    ? t('session.inputPlaceholder')
                    : undefined
            }
            accessibilityState={{
                busy: dictationTranscribing,
                disabled: Boolean(props.disabled),
            }}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                if (dictationTranscribing) return;
                hapticsLight();
                if (dictationActive && showDictation) {
                    props.dictationPressHandler?.();
                } else if (props.hasSendableContent) {
                    props.onSend();
                } else {
                    if (showDictation) {
                        props.dictationPressHandler?.();
                    } else if (showStopWhenEmpty) {
                        props.onStop?.();
                    }
                }
            }}
            style={{ marginLeft: 8, marginRight: 8 }}
        >
            {dictationActive && showDictation ? (
                <Ionicons name="stop-circle" size={22} color={theme.colors.button.primary.tint} />
            ) : props.hasSendableContent ? (
                <Octicons
                    name="arrow-up"
                    size={16}
                    color={theme.colors.button.primary.tint}
                    style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                />
            ) : showDictation ? (
                <Image
                    source={require('@/assets/images/icon-voice-white.png')}
                    style={{ width: 24, height: 24 }}
                    tintColor={theme.colors.button.primary.tint}
                />
            ) : showStopWhenEmpty ? (
                <Ionicons name="stop" size={18} color={theme.colors.button.primary.tint} />
            ) : (
                <Octicons
                    name="arrow-up"
                    size={16}
                    color={theme.colors.button.primary.tint}
                    style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                />
            )}
        </PrimaryCircleIconButton>
    );
});
