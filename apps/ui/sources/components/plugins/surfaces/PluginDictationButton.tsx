import * as React from 'react';
import type { DictationButtonProps } from '@happier-dev/plugin-ui';
import { Platform, View } from 'react-native';
import { AgentInputDictationButton } from '@/components/sessions/agentInput/components/AgentInputDictationButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useTextInputDictation } from '@/voice/dictation/useTextInputDictation';

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
    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    return <View style={{ width: minimumTargetSize, height: minimumTargetSize }}>
        <AgentInputDictationButton testID={props.testID} disabled={!featureEnabled || props.disabled}
            status={dictation.status} onPress={() => { void dictation.onPress(); }} />
    </View>;
}
