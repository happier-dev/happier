import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } from '@/components/voice/attempt/useVoiceAttemptControl';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { getVoiceSessionPresentedAttemptId } from '@/voice/session/voiceSessionStore';

/**
 * Home's quiet "Brief me" (lab `voice-moments` B0): one press turns the greeting into the brief.
 * Closed, it costs nothing — no Inbox subscription, no Voice start. While Voice is not set up a brief
 * could not be spoken, so the entry is the attempt owner's own "Set up Voice" and opens setup.
 */
export const VoiceBriefButton = React.memo(function VoiceBriefButton(props: Readonly<{
    open: boolean;
    /** Phone (lab B0p): the button spans the page under the greeting instead of sitting beside it. */
    block?: boolean;
}>): React.ReactElement | null {
    const voiceEnabled = useFeatureEnabled('voice');
    if (voiceEnabled !== true || props.open) return null;
    return <EnabledVoiceBriefButton block={props.block} />;
});

function EnabledVoiceBriefButton({ block }: Readonly<{ block?: boolean }>) {
    const { execute, ready } = useMountedActionExecution(getActiveServerAccountScope());
    const request = React.useCallback(() => {
        const expectedAttemptId = getVoiceSessionPresentedAttemptId();
        return execute('ui.voice_global.brief.request', expectedAttemptId ? { expectedAttemptId } : {});
    }, [execute]);
    const openSetup = React.useCallback(() => {
        void execute('ui.voice_global.setup.open', {});
    }, [execute]);
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    // Setup's own open Action: in place where a host presents it (Home's Get set up), else Settings → Voice open.
    const setup = voice.primaryAction === 'setup' && voice.primaryActionLabel
        ? { label: voice.primaryActionLabel, onPress: openSetup }
        : voice.primaryAction === 'recover' && voice.primaryActionLabel
            ? { label: voice.live ? voice.primaryActionLabel : t('voicePresence.setUp'), onPress: () => { void voice.onPrimaryAction(); } }
        : undefined;
    return <VoiceBriefButtonView onOpen={request} block={block} disabled={!setup && !ready} setup={setup} />;
}

/** The button as drawn (the dev Home fixture draws it without the server's feature decision). */
export const VoiceBriefButtonView = React.memo(function VoiceBriefButtonView(props: Readonly<{
    onOpen: () => void;
    block?: boolean;
    disabled?: boolean;
    /** Voice is not set up: the entry names that act instead of opening a brief that cannot be spoken. */
    setup?: Readonly<{ label: string; onPress: () => void }>;
}>) {
    return (
        <RoundButton
            style={props.block ? stylesheet.block : undefined}
            testID="home-brief-me"
            disabled={props.disabled}
            size="small"
            display="secondary"
            title={props.setup?.label ?? t('voiceMoments.briefMe')}
            accessibilityLabel={props.setup?.label ?? t('voiceMoments.briefMeA11y')}
            leading={<VoiceMarkArt pose="ready" size={16} still />}
            onPress={props.setup?.onPress ?? props.onOpen}
        />
    );
});

const stylesheet = StyleSheet.create({
    block: {
        alignSelf: 'stretch',
    },
});
