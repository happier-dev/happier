import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CompanionNoDragRegion } from '@/components/companion/interaction/CompanionNoDragRegion';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { t } from '@/text';

import { VoiceCompactTranscript } from './VoiceCompactTranscript';
import { VoiceMark } from './VoiceMark';
import { VOICE_PRESENCE_NO_DRAG_PROPS } from './VoicePresenceFloat';
import { VoiceStatusLine } from './VoiceStatusLine';
import { VoiceTransport } from './VoiceTransport';

import { VoiceIslandAnatomy, VOICE_ISLAND_DESKTOP, VOICE_ISLAND_PHONE } from './voicePresenceAnatomy';
export { VOICE_ISLAND_DESKTOP, VOICE_ISLAND_PHONE } from './voicePresenceAnatomy';

/**
 * The floating island (§4.3): Mark · Status line · the last line said · Transport, on the floating
 * chrome material. It owns placement-free content only — the shared float host moves it.
 *
 * - The **mark** is the call's toggle: a tap ends it (the dots regather into the microphone).
 * - The **middle** opens the Voice section anchored to the island.
 * - **Mute** and **End** are their own controls; a drag never starts on them.
 */
export const VoiceIsland = React.memo(function VoiceIsland(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    phone: boolean;
    width: number;
    /** The open Voice section's anchor, and whether it is showing. */
    anchorRef: React.RefObject<View | null>;
    sectionOpen: boolean;
    onOpenSection: () => void;
    shouldSuppressPress: () => boolean;
    testID?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { voice } = props;
    const height = props.phone ? VOICE_ISLAND_PHONE.height : VOICE_ISLAND_DESKTOP.height;
    const markSize = props.phone ? VOICE_ISLAND_PHONE.mark : VOICE_ISLAND_DESKTOP.mark;
    const markTarget = Math.max(40, resolveMinimumInteractiveTargetSize(Platform.OS));
    const testID = props.testID ?? 'voice-island';
    const suppress = props.shouldSuppressPress;
    const onMark = React.useCallback(() => {
        if (suppress()) return;
        voice.onPrimaryAction();
    }, [suppress, voice]);
    const onOpenSection = props.onOpenSection;
    const onBody = React.useCallback(() => {
        if (suppress()) return;
        onOpenSection();
    }, [onOpenSection, suppress]);
    return (
        <View ref={props.anchorRef} collapsable={false} style={{ width: props.width, height }}>
            <VoiceIslandAnatomy
                testID={testID}
                width={props.width}
                height={height}
                mark={<Pressable
                    testID={`${testID}-mark`}
                    accessibilityRole="button"
                    accessibilityLabel={voice.primaryActionLabel ?? t('voicePresence.talkWithVoice')}
                    accessibilityHint={voice.primaryActionHint ?? undefined}
                    onPress={onMark}
                    style={[styles.mark, { width: markTarget, height: markTarget, marginVertical: (height - markTarget) / 2 }]}
                >
                    <VoiceMark voice={voice} size={markSize} />
                </Pressable>}
                body={<Pressable
                    testID={`${testID}-body`}
                    accessibilityRole="button"
                    accessibilityLabel={t('voicePresence.containerA11y', { status: voice.micStateLabel })}
                    accessibilityHint={t('voicePresence.showConversation')}
                    aria-expanded={props.sectionOpen}
                    onPress={onBody}
                    style={styles.body}
                >
                    <VoiceStatusLine voice={voice} size="island" />
                    <VoiceCompactTranscript voice={voice} />
                </Pressable>}
                transport={<CompanionNoDragRegion {...VOICE_PRESENCE_NO_DRAG_PROPS}>
                    <VoiceTransport voice={voice} size={props.phone ? 'touch' : 'island'} testID={`${testID}-transport`} />
                </CompanionNoDragRegion>}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create({
    mark: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    body: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
        gap: 1,
        alignSelf: 'stretch',
    },
});
