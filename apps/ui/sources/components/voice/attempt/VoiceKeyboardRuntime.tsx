import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_DEFAULT,
} from './useVoiceAttemptControl';

/** One app-level registration; composers never register or retarget the active command. */
export const VoiceKeyboardRuntime = React.memo(function VoiceKeyboardRuntime() {
    const enabled = useFeatureEnabled('voice');
    const control = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_DEFAULT);
    // A gate changing during an admitted attempt must not remove the way to End it.
    useKeyboardShortcutHandlers(enabled || control.canStop ? { 'voice.toggle': control.onToggle } : {});
    return null;
});
