import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';

import { SessionCompanionItemFrame } from '@/components/sessions/companion/SessionCompanionItemFrame';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useIsNearViewport, type NearViewportSpan, type NearViewportTracker } from '@/components/widgets/nearViewport';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useVoiceSurfaceModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import {
    getVoiceSessionEndedAttempt,
    subscribeToVoiceSessionEndedAttempt,
} from '@/voice/session/voiceSessionStore';

import { VoiceGlance } from './VoiceGlance';
import { registerVoiceCompanionSection } from './voiceCompanionSectionReveal';

const SURFACE_PROPS = Object.freeze({ variant: 'sidebar' as const });

/**
 * The Companion's Voice section (§4.3): while a conversation runs it leads the Companion beside
 * whatever session is open, in every presence mode — status, the latest turns, the handoff and
 * Mute · Interrupt · End. It is a section of the Companion (the same item frame and ⋯ menu as its
 * neighbours), not another floating container.
 *
 * After a clean End it stays as "Voice ended" with the way back to the conversation, until the next
 * start or a dismiss. Closed, it costs one snapshot read: the surface model and its transcript
 * subscription mount only while a conversation exists or has just ended.
 */
export const VoiceCompanionSection = React.memo(function VoiceCompanionSection(props: Readonly<{
    testID?: string;
    onReveal?: () => boolean;
    tracker: NearViewportTracker;
}>): React.ReactElement | null {
    const voiceEnabled = useFeatureEnabled('voice');
    const live = useVoiceSessionSnapshot().status !== 'disconnected';
    const ended = React.useSyncExternalStore(
        subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionEndedAttempt,
        getVoiceSessionEndedAttempt,
    ) !== null;
    if (voiceEnabled !== true || (!live && !ended)) return null;
    return <VoiceCompanionSectionPresentation tracker={props.tracker} testID={props.testID ?? 'voice-companion-section'} onReveal={props.onReveal} />;
});

function VoiceCompanionSectionPresentation(props: Readonly<{ tracker: NearViewportTracker; testID: string; onReveal?: () => boolean }>) {
    const [span, setSpan] = React.useState<NearViewportSpan | null>(null);
    const presented = useIsNearViewport(props.tracker, span);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { y, height } = event.nativeEvent.layout;
        setSpan((current) => current?.top === y && current.height === height ? current : { top: y, height });
    }, []);
    // Keep the model, turns and semantic pose mounted; only presentation demand changes on scroll.
    return <View onLayout={onLayout} testID={`${props.testID}-presentation`}>
        <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
            <VoiceCompanionSectionRuntime testID={props.testID} onReveal={props.onReveal} />
        </PluginSurfaceFocusEligibilityProvider>
    </View>;
}

function VoiceCompanionSectionRuntime(props: Readonly<{ testID: string; onReveal?: () => boolean }>): React.ReactElement | null {
    const router = useRouter();
    const model = useVoiceSurfaceModel(SURFACE_PROPS);
    const voice = model?.attemptControl ?? null;
    const canOpenConversation = voice?.canOpenConversation === true;
    const onOpenConversation = voice?.onOpenConversation;
    const onDismissEnded = voice?.ended ? voice.onDismissEnded : undefined;
    const actions = React.useMemo<readonly ItemAction[]>(() => [
        ...(canOpenConversation && onOpenConversation
            ? [{ id: 'open-conversation', title: t('voicePresence.openConversation'), icon: 'arrow-square-out' as const, onPress: onOpenConversation }]
            : []),
        { id: 'voice-settings', title: t('voicePresence.settings'), icon: 'gear' as const, onPress: () => router.push(SETTINGS_ROUTES.voice as never) },
        ...(onDismissEnded ? [{ id: 'dismiss', title: t('voicePresence.dismiss'), icon: 'x' as const, onPress: onDismissEnded }] : []),
    ], [canOpenConversation, onDismissEnded, onOpenConversation, router]);

    // A container's caption reveals this section instead of opening a popover copy: one ring that
    // answers "where did it go?", once, then still.
    const [revealCount, setRevealCount] = React.useState(0);
    React.useEffect(() => model ? registerVoiceCompanionSection(() => {
        if (!props.onReveal?.()) return false;
        setRevealCount((count) => count + 1);
        return true;
    }) : undefined, [model !== null, props.onReveal]);

    if (!model) return null;
    return (
        <SessionCompanionItemFrame label={t('voicePresence.title')} actions={actions} flush="plain" testID={props.testID}>
            {(accessory) => (
                <VoiceGlance
                    model={model}
                    presentation="companion"
                    menu={accessory}
                    fresh={revealCount}
                    testID={`${props.testID}-glance`}
                />
            )}
        </SessionCompanionItemFrame>
    );
}
