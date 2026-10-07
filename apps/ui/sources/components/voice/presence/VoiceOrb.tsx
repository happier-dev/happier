import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { CompanionNoDragRegion } from '@/components/companion/interaction/CompanionNoDragRegion';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { VoiceMark } from './VoiceMark';
import { VOICE_PRESENCE_NO_DRAG_PROPS } from './VoicePresenceFloat';
import { VoiceStatusLine } from './VoiceStatusLine';

import { VoiceOrbAnatomy, VOICE_ORB_BODY_SIZE, VOICE_ORB_MARK_SIZE, VOICE_ORB_CAPTION_WIDTH, VOICE_ORB_OPTIONS_GAP, resolveVoiceOrbContainerWidth } from './voicePresenceAnatomy';
export { VOICE_ORB_BODY_SIZE, VOICE_ORB_MARK_SIZE, VOICE_ORB_CAPTION_WIDTH } from './voicePresenceAnatomy';
const OPTIONS_KEYS = 'ArrowUp ContextMenu';

/**
 * The floating Orb (§4.3): the mark alone. A microphone at rest — the always-there entry point for
 * people who choose it — and the planet while live. Tap is always start/end. Its options (Mute,
 * Retry, End, the turns) open as the shared Voice section from an explicit, accessible affordance:
 * the caption chip, long-press, the screen-reader action, or ↑ / the context-menu key on web — never
 * hover alone.
 */
export const VoiceOrb = React.memo(function VoiceOrb(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    anchorRef: React.RefObject<View | null>;
    sectionOpen: boolean;
    onOpenSection: () => void;
    shouldSuppressPress: () => boolean;
    /** The orb's live x and its host width: the caption opens toward the window's centre. */
    translateX: SharedValue<number>;
    hostWidth: number;
    testID?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const reduced = useReducedMotionPreference();
    const { voice } = props;
    const testID = props.testID ?? 'voice-orb';
    const suppress = props.shouldSuppressPress;
    const onOpenSection = props.onOpenSection;
    const [focused, setFocused] = React.useState(false);
    const { translateX, hostWidth } = props;
    const showOptions = voice.live || Boolean(voice.ended);
    const width = resolveVoiceOrbContainerWidth(Platform.OS, showOptions);
    const captionInset = (width - VOICE_ORB_BODY_SIZE) / 2 + VOICE_ORB_BODY_SIZE + VOICE_ORB_OPTIONS_GAP;
    const captionSide = useAnimatedStyle(() => (
        translateX.get() + VOICE_ORB_BODY_SIZE / 2 > hostWidth / 2
            ? { right: captionInset, left: undefined, justifyContent: 'flex-end' as const }
            : { left: captionInset, right: undefined, justifyContent: 'flex-start' as const }
    ));

    const onPress = React.useCallback(() => {
        if (suppress()) return;
        voice.onPrimaryAction();
    }, [suppress, voice]);
    const openSection = React.useCallback(() => {
        if (suppress()) return;
        onOpenSection();
    }, [onOpenSection, suppress]);
    const accessibilityActions = React.useMemo(() => [
        { name: 'activate', label: voice.primaryActionLabel ?? t('voicePresence.talkWithVoice') },
        { name: 'options', label: t('voicePresence.options') },
    ], [voice.primaryActionLabel]);
    const onAccessibilityAction = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ actionName: string }> }>) => {
        if (event.nativeEvent.actionName === 'activate') voice.onPrimaryAction();
        else if (event.nativeEvent.actionName === 'options') onOpenSection();
    }, [onOpenSection, voice]);
    const onKeyDown = React.useCallback((event: unknown) => {
        const key = (event as { nativeEvent?: { key?: string }; key?: string }).nativeEvent?.key
            ?? (event as { key?: string }).key;
        if (key !== 'ArrowUp' && key !== 'ContextMenu') return;
        (event as { preventDefault?: () => void }).preventDefault?.();
        onOpenSection();
    }, [onOpenSection]);

    return (
        <VoiceOrbAnatomy anchorRef={props.anchorRef} testID={testID} width={width}>
            {showOptions ? (
                <Animated.View
                    testID={`${testID}-options-slot`}
                    pointerEvents={Platform.OS === 'web' ? 'auto' : 'box-none'}
                    entering={reduced ? undefined : FadeIn.duration(160)}
                    exiting={reduced ? undefined : FadeOut.duration(120)}
                    style={[styles.captionSlot, captionSide]}
                    {...VOICE_PRESENCE_NO_DRAG_PROPS}
                >
                    <CompanionNoDragRegion {...VOICE_PRESENCE_NO_DRAG_PROPS}>
                    <Pressable
                        testID={`${testID}-options`}
                        accessibilityRole="button"
                        accessibilityLabel={t('voicePresence.options')}
                        aria-expanded={props.sectionOpen}
                        onPress={openSection}
                        style={styles.options}
                    >
                        {/* The chip is the options target and keeps saying what the call is doing
                            (lab: "Speaking 2:14"); its accessible name is "Voice options". */}
                        <GlassPanel radius={13} shadowLevel={2} innerShadow={false} style={styles.caption}>
                            <VoiceStatusLine voice={voice} size="pill" />
                        </GlassPanel>
                    </Pressable>
                    </CompanionNoDragRegion>
                </Animated.View>
            ) : null}
            <Pressable
                testID={`${testID}-body`}
                accessibilityRole="button"
                accessibilityLabel={voice.live
                    ? t('voicePresence.containerA11y', { status: voice.statusLabel })
                    : voice.primaryActionLabel ?? t('voicePresence.talkWithVoice')}
                accessibilityHint={voice.primaryActionHint ?? undefined}
                aria-expanded={props.sectionOpen}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                onPress={onPress}
                onLongPress={openSection}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                {...(Platform.OS === 'web' ? { onKeyDown, 'aria-keyshortcuts': OPTIONS_KEYS } : {})}
                style={[
                    styles.body,
                    focusRingStyle({ focused, color: theme.colors.border.focus }),
                ]}
            >
                <VoiceMark voice={voice} size={VOICE_ORB_MARK_SIZE} />
            </Pressable>
        </VoiceOrbAnatomy>
    );
});

const stylesheet = StyleSheet.create({
    captionSlot: { position: 'absolute', top: 0, width: VOICE_ORB_CAPTION_WIDTH, flexDirection: 'row' },
    options: { minHeight: VOICE_ORB_BODY_SIZE, minWidth: VOICE_ORB_BODY_SIZE, justifyContent: 'center' },
    caption: { height: 26, paddingHorizontal: 10, justifyContent: 'center' },
    body: {
        width: VOICE_ORB_BODY_SIZE,
        height: VOICE_ORB_BODY_SIZE,
        borderRadius: VOICE_ORB_BODY_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
