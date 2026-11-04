import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { RecordingDocument } from './recordingDocument';

/**
 * What is sent (lab `rc` ED, D8), said in one line with the one change it allows. Blur turns the video off
 * by the shared rule, and the line says so; including it again goes through that rule's one warning.
 */
export function RecordingDeliveryNotice(props: Readonly<{
    agentName: string | null;
    frameCount: number;
    disclosure: RecordingDocument['videoDisclosure'];
    /** What failed under the open window (a frame's marks, or the video itself), said in the line with Retry. */
    failure: Readonly<{ line: string; onRetry: () => void }> | null;
    onToggle: (included: boolean) => void;
    onResolveWarning: (include: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const { disclosure } = props;
    const agent = props.agentName ?? t('screenCapture.recording.theAgent');
    const frames = t('screenCapture.recording.keyFrames', { agent, count: props.frameCount });
    const warned = disclosure.warning === 'pending';
    const blurred = !disclosure.included && disclosure.blurCount > 0;
    const failed = props.failure !== null;
    const line = props.failure ? props.failure.line
        : warned ? t('screenCapture.recording.includeBlurredQuestion')
        : disclosure.included ? `${frames}; ${t('screenCapture.recording.withVideo')}`
        : blurred ? `${frames}. ${t('screenCapture.recording.blurredVideo')}`
        : `${frames}. ${t('screenCapture.recording.withoutVideo')}`;
    return (
        <View style={styles.row} testID="recording-delivery-notice" accessibilityLiveRegion="polite">
            <Icon
                name={warned || failed ? 'warning' : blurred ? 'lock' : 'info'}
                size={14}
                color={warned || failed ? theme.colors.state.attention.foreground : theme.colors.text.tertiary}
            />
            <WordCrossFade wordKey={line} style={styles.line}>
                <Text variant="meta" style={styles.text} numberOfLines={1}>{line}</Text>
            </WordCrossFade>
            {props.failure ? (
                <TextLinkButton size="meta" verticalReach={0} label={t('common.retry')} onPress={props.failure.onRetry} testID="recording-commit-retry" />
            ) : warned ? (
                <View style={styles.actions}>
                    <TextLinkButton size="meta" verticalReach={0} label={t('screenCapture.recording.keepVideoOff')} onPress={() => props.onResolveWarning(false)} testID="recording-keep-video-off" />
                    <TextLinkButton size="meta" verticalReach={0} label={t('screenCapture.recording.includeAnyway')} onPress={() => props.onResolveWarning(true)} testID="recording-include-anyway" />
                </View>
            ) : (
                <TextLinkButton
                    size="meta"
                    verticalReach={0}
                    label={disclosure.included ? t('screenCapture.recording.leaveOut') : t('screenCapture.recording.includeVideo')}
                    onPress={() => props.onToggle(!disclosure.included)}
                    testID="recording-include-video"
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        paddingBottom: theme.space.s8,
    },
    line: {
        flex: 1,
        minWidth: 0,
    },
    text: {
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        gap: theme.space.s12,
    },
}));
