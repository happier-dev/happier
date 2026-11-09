import * as React from 'react';
import type { DictationButtonProps } from '@happier-dev/plugin-ui';
import { View } from 'react-native';
import { AgentInputDictationButton } from '@/components/sessions/agentInput/components/AgentInputDictationButton';
import { DictationRecoveryAccessory, useDictationRecoveryFailure } from '@/components/sessions/agentInput/components/AgentInputDictationRecovery';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useTextInputDictation } from '@/voice/dictation/useTextInputDictation';

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
    const { notice } = dictation;
    if (!failure && notice) {
        // A dictation that kept nothing: its one action (or a close) takes the microphone's place, the cause in its name.
        return <IconButton testID={props.testID ? `${props.testID}-notice` : 'plugin-dictation-notice'}
            iconName={notice.action ? 'warning' : 'x'} variant="plain" tone="danger" size={ACCESSORY_SIZE} iconSize={16}
            accessibilityLabel={notice.action ? `${notice.action.label}. ${notice.title}` : `${t('common.close')}. ${notice.title}`}
            tooltip={notice.title} tooltipPlacement="bottom"
            onPress={notice.action ? notice.action.onPress : dictation.onDismissNotice} />;
    }
    if (failure) {
        return <DictationRecoveryAccessory failure={failure} status={dictation.status}
            testID={props.testID ?? 'plugin-dictation'} onRetry={dictation.onRetry}
            onDiscard={dictation.onDiscard} onOpenSetup={dictation.onOpenSetup} />;
    }
    return <View>
        <AgentInputDictationButton testID={props.testID} disabled={!featureEnabled || props.disabled || !dictation.available}
            status={dictation.status} onFocus={() => { void dictation.onFocus(); }}
            onPress={() => { void dictation.onFocus(); void dictation.onPress(); }} />
    </View>;
}
