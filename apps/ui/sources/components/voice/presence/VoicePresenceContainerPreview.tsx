import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { VoiceMarkArt } from './VoiceMark';
import type { VoicePresenceContainer } from './useVoicePresenceContainer';
import { VoiceIslandAnatomy, VoiceTopBarAnatomy, VoiceOrbAnatomy, VOICE_ISLAND_DESKTOP, VOICE_ORB_MARK_SIZE, VOICE_TOP_BAR_PILL_HEIGHT } from './voicePresenceAnatomy';
import { VoiceStatusLine } from './VoiceStatusLine';
import { VoiceTransport } from './VoiceTransport';
import { resolveVoiceAttemptControl } from '../attempt/resolveVoiceAttemptControl';
import type { VoiceAttemptControlProjection } from '../attempt/useVoiceAttemptControl';
import { t } from '@/text';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';

/** A live planet at rest pose for the miniature: lit, still, no subscriptions. */
const LIVE_PREVIEW = Object.freeze({ morph: 1, energy: 0.5, flow: 1 });
const NO_ACTION = () => {};

function setPreviewInert(host: unknown): void {
    // The web View ref is an HTMLElement. Native already hides the decorative subtree below.
    // Browser inert suppresses keyboard focus as well as pointer interaction without changing the art.
    if (Platform.OS === 'web' && typeof host === 'object' && host !== null && 'inert' in host) host.inert = true;
}

function staticVoice(): VoiceAttemptControlProjection {
    return {
        ...resolveVoiceAttemptControl({ surfaceState: 'listening', tone: 'active', status: 'connected',
            sessionId: null, canStop: true, muted: false, capturing: true, startAdmitted: true, hasRecovery: false }),
        statusWord: t('voiceAssistant.listening'), statusLabel: t('voiceAssistant.listening'),
        elapsedStartedAt: null, canHoldToTalk: false, beginHoldToTalk: () => null,
        primaryActionLabel: null, primaryActionHint: null, recoveryLabel: null, recoveryShortLabel: null,
        micStateLabel: '', captionLabel: '', onPrimaryAction: NO_ACTION, onToggle: NO_ACTION,
        onToggleMute: NO_ACTION, onRecover: NO_ACTION, openConversationSessionId: null,
        openConversationSessionAddress: null, canOpenConversation: false, onOpenConversation: NO_ACTION,
    };
}

/**
 * The "Show live Voice as" tile art (lab K): a miniature window with the chosen container where it
 * lives — the Top bar's pill in the title strip, the floating Island, the Orb. It draws the real
 * mark at static values; it has no Voice lifecycle/media subscription and acquires no runtime.
 */
export const VoicePresenceContainerPreview = React.memo(function VoicePresenceContainerPreview(props: Readonly<{
    container: VoicePresenceContainer;
    testID?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const voice = staticVoice();
    const mark = <VoiceMarkArt pose="ready" size={props.container === 'orb' ? VOICE_ORB_MARK_SIZE : props.container === 'island' ? VOICE_ISLAND_DESKTOP.mark : 20} preview={LIVE_PREVIEW} />;
    return (
        <View ref={setPreviewInert} testID={props.testID} style={styles.window} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {props.container === 'top_bar' ? (
                <View style={styles.strip}>
                    <View style={styles.topBarSpecimen}><VoiceTopBarAnatomy
                        mark={<IconButton accessibilityLabel={t('voiceAssistant.endVoice')} variant="plain" size={VOICE_TOP_BAR_PILL_HEIGHT}
                            minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined} icon={mark} onPress={NO_ACTION} />}
                        label={<VoiceStatusLine voice={voice} size="pill" />}
                        transport={<VoiceTransport voice={voice} size="pill" />} showDivider
                    /></View>
                </View>
            ) : null}
            {props.container === 'island' ? (
                <View style={styles.islandSpecimen}>
                    <VoiceIslandAnatomy width={VOICE_ISLAND_DESKTOP.width} height={VOICE_ISLAND_DESKTOP.height}
                        mark={mark} body={<VoiceStatusLine voice={voice} size="island" />}
                        transport={<VoiceTransport voice={voice} size="island" />} />
                </View>
            ) : null}
            {props.container === 'orb' ? (
                <View style={styles.orbSpecimen}><VoiceOrbAnatomy>{mark}</VoiceOrbAnatomy></View>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    window: {
        height: 70,
        borderRadius: 10,
        backgroundColor: theme.colors.background.canvas,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        overflow: 'hidden',
    },
    strip: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        height: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    topBarSpecimen: { position: 'absolute', right: 8, top: -5, transform: [{ scale: 0.5 }], transformOrigin: 'right center' },
    // The whole desktop capsule fits the narrowest tile (≈100 pt): 330 × 0.28 + the 8 pt inset.
    islandSpecimen: { position: 'absolute', right: 8, bottom: 8, transform: [{ scale: 0.28 }], transformOrigin: 'right bottom' },
    orbSpecimen: { position: 'absolute', right: 8, bottom: 8, transform: [{ scale: 0.65 }], transformOrigin: 'right bottom' },
}));
