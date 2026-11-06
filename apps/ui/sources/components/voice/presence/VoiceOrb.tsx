import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isHappierFocusVisible } from '@happier-dev/plugin-ui/presentation';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { CompanionNoDragRegion } from '@/components/companion/interaction/CompanionNoDragRegion';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { VoiceMark } from './VoiceMark';
import { VOICE_PRESENCE_NO_DRAG_PROPS } from './VoicePresenceFloat';
import { readVoiceElapsedStartedAt, VoiceElapsed, VoiceStatusLine } from './VoiceStatusLine';
import { VoiceTargetIdentity } from './VoiceTargetIdentity';
import { VoiceReadAloudStatus, type VoiceReadAloud } from './VoiceReadAloud';
import { resolveVoicePresenceReadAloud } from './resolveVoicePresenceReadAloud';
import { Icon } from '@/components/ui/icons/Icon';

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
    /** Read-aloud outside a call: the caption says so and the Orb itself is Stop. */
    readAloud?: VoiceReadAloud;
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
    const readAloud = resolveVoicePresenceReadAloud(voice, props.readAloud);
    const readingOnly = readAloud !== null;
    const showOptions = voice.live || Boolean(voice.ended) || readingOnly;
    const width = resolveVoiceOrbContainerWidth(Platform.OS, showOptions);
    const captionInset = (width - VOICE_ORB_BODY_SIZE) / 2 + VOICE_ORB_BODY_SIZE + VOICE_ORB_OPTIONS_GAP;
    // Each side releases the other edge explicitly: on web the first side's offsets become the
    // slot's static class, and an unset edge would keep it (both edges pinned, the left one wins).
    const captionSide = useAnimatedStyle(() => (
        translateX.get() + VOICE_ORB_BODY_SIZE / 2 > hostWidth / 2
            ? { right: captionInset, left: 'auto' as const, justifyContent: 'flex-end' as const }
            : { left: captionInset, right: 'auto' as const, justifyContent: 'flex-start' as const }
    ));

    const stopReading = readingOnly ? readAloud.stop : null;
    const onPress = React.useCallback(() => {
        if (suppress()) return;
        if (stopReading) stopReading();
        else voice.onPrimaryAction();
    }, [stopReading, suppress, voice]);
    const openSection = React.useCallback(() => {
        if (suppress()) return;
        onOpenSection();
    }, [onOpenSection, suppress]);
    const accessibilityActions = React.useMemo(() => [
        { name: 'activate', label: stopReading ? t('voicePresence.readAloud.stop') : voice.primaryActionLabel ?? t('voicePresence.talkWithVoice') },
        { name: 'options', label: t('voicePresence.options') },
    ], [stopReading, voice.primaryActionLabel]);
    const onAccessibilityAction = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ actionName: string }> }>) => {
        if (event.nativeEvent.actionName === 'activate') onPress();
        else if (event.nativeEvent.actionName === 'options') onOpenSection();
    }, [onOpenSection, onPress]);
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
                    <CompanionNoDragRegion style={styles.noDrag} {...VOICE_PRESENCE_NO_DRAG_PROPS}>
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
                            {readingOnly ? <VoiceReadAloudStatus phase={readAloud.phase} size="pill" /> : voice.targetSessionAddress ? (
                                // The same admitted name remains after End, with the ended status in place of a live clock.
                                <View style={voice.live ? styles.targetCaption : styles.endedTargetCaption}>
                                    <View style={styles.targetName}>
                                        <VoiceTargetIdentity address={voice.targetSessionAddress} size="pill" testID="voice-orb-target" />
                                    </View>
                                    {!voice.live ? <VoiceStatusLine voice={voice} size="pill" /> : readVoiceElapsedStartedAt(voice) !== null ? (
                                        <VoiceElapsed startedAt={readVoiceElapsedStartedAt(voice)!} fontSize={12.5} lineHeight={16} />
                                    ) : null}
                                </View>
                            ) : <VoiceStatusLine voice={voice} size="pill" />}
                        </GlassPanel>
                    </Pressable>
                    </CompanionNoDragRegion>
                </Animated.View>
            ) : null}
            <Pressable
                testID={`${testID}-body`}
                accessibilityRole="button"
                accessibilityLabel={readingOnly
                    ? t('voicePresence.readAloud.stop')
                    : voice.live
                    ? t('voicePresence.containerA11y', { status: voice.statusLabel })
                    : voice.primaryActionLabel ?? t('voicePresence.talkWithVoice')}
                accessibilityHint={voice.primaryActionHint ?? undefined}
                aria-expanded={props.sectionOpen}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                onPress={onPress}
                onLongPress={openSection}
                // The ring is for keyboard focus only; a click focuses the orb too.
                onFocus={(event) => setFocused(isHappierFocusVisible(event?.target))}
                onBlur={() => setFocused(false)}
                {...(Platform.OS === 'web' ? { onKeyDown, 'aria-keyshortcuts': OPTIONS_KEYS } : {})}
                style={[
                    styles.body,
                    focusRingStyle({ focused, color: theme.colors.border.focus }),
                ]}
            >
                {readingOnly
                    // The Orb is Stop while it reads: the same floating glass as its caption, a stop glyph inside.
                    ? <GlassPanel radius={VOICE_ORB_BODY_SIZE / 2} shadowLevel={2} innerShadow={false}
                        frameStyle={styles.readAloudBody} style={styles.readAloudBodyContent}>
                        <Icon name="stop" size={Math.round(VOICE_ORB_MARK_SIZE * 0.6)} color={theme.colors.text.primary} />
                    </GlassPanel>
                    : <VoiceMark voice={voice} size={VOICE_ORB_MARK_SIZE} />}
            </Pressable>
        </VoiceOrbAnatomy>
    );
});

const stylesheet = StyleSheet.create({
    captionSlot: { position: 'absolute', top: 0, width: VOICE_ORB_CAPTION_WIDTH, flexDirection: 'row' },
    // The caption slot is a fixed 168 px: the chip shrinks inside it so a long name ellipsizes.
    noDrag: { flexShrink: 1, minWidth: 0 },
    options: { minHeight: VOICE_ORB_BODY_SIZE, minWidth: 0, flexShrink: 1, justifyContent: 'center' },
    caption: { height: 26, paddingHorizontal: 10, justifyContent: 'center', flexShrink: 1, minWidth: 0 },
    targetCaption: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0, flexShrink: 1 },
    // Ended: the name leads and the status follows only when it fits whole. The one-line box wraps the
    // status out of view rather than squeezing the name down to an initial and a dot.
    endedTargetCaption: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 7, height: 16, overflow: 'hidden', minWidth: 0, flexShrink: 1 },
    targetName: { maxWidth: '100%', minWidth: 0, flexShrink: 1 },
    readAloudBody: { width: VOICE_ORB_BODY_SIZE, height: VOICE_ORB_BODY_SIZE },
    readAloudBodyContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    body: {
        width: VOICE_ORB_BODY_SIZE,
        height: VOICE_ORB_BODY_SIZE,
        borderRadius: VOICE_ORB_BODY_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
