import * as React from 'react';
import type { DictationButtonProps } from '@happier-dev/plugin-ui';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { AgentInputDictationButton } from '@/components/sessions/agentInput/components/AgentInputDictationButton';
import { useDictationRecoveryFailure } from '@/components/sessions/agentInput/components/AgentInputDictationRecovery';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useTextInputDictation } from '@/voice/dictation/useTextInputDictation';
import { resolveVoiceDictationFailureTranslationKey } from '@/voice/dictation/voiceDictationErrorCopy';

/** The drawn size of the field accessory, the same as the dictation microphone it replaces. */
const ACCESSORY_SIZE = 24;

/** Same-realm binding only: the field is origin-neutral, never fabricated into a Session target. */
export function PluginDictationButton(props: Omit<DictationButtonProps, 'fallback'>) {
    const controlId = React.useId();
    const featureEnabled = useFeatureEnabled('voice');
    const presented = useLayoutPresentationActive();
    const viewed = useHostActivelyViewed();
    const dictation = useTextInputDictation({
        controlId,
        enabled: featureEnabled,
        presented: presented && viewed && props.presented !== false,
        editable: props.disabled !== true,
        transcriptionSessionId: null,
        onTranscription: props.onTranscription,
    });
    const failure = useDictationRecoveryFailure(dictation.failure, dictation.status);
    if (failure) {
        // A plugin owns its field's layout, so the kept recording's recovery takes the microphone's
        // place: Retry (its tooltip and name carry the cause) and a quiet Discard.
        const reason = t(resolveVoiceDictationFailureTranslationKey(failure.reason));
        const transcribing = dictation.status === 'transcribing';
        return <View style={styles.recovery}>
            <IconButton testID={props.testID ? `${props.testID}-retry` : 'plugin-dictation-retry'}
                iconName="arrow-clockwise" variant="plain" tone="danger" size={ACCESSORY_SIZE} iconSize={16}
                accessibilityLabel={`${t('common.retry')}. ${reason}`} tooltip={reason} tooltipPlacement="bottom"
                disabled={failure.canRetry !== true || transcribing}
                onPress={() => { void dictation.onRetry(); }} />
            <IconButton testID={props.testID ? `${props.testID}-discard` : 'plugin-dictation-discard'}
                iconName="x" variant="plain" size={ACCESSORY_SIZE} iconSize={14}
                accessibilityLabel={t('common.discard')} tooltip={t('common.discard')} tooltipPlacement="bottom"
                disabled={transcribing}
                onPress={() => { void dictation.onDiscard(); }} />
        </View>;
    }
    return <View>
        <AgentInputDictationButton testID={props.testID} disabled={!featureEnabled || props.disabled || !dictation.available}
            status={dictation.status} onFocus={() => { void dictation.onFocus(); }}
            onPress={() => { void dictation.onFocus(); void dictation.onPress(); }} />
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    recovery: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 },
}));
