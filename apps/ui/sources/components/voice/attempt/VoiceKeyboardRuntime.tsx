import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { getDesktopHostWindowLabel, isDesktopHost } from '@/utils/platform/desktopHost';
import { DESKTOP_VOICE_TOGGLE, emitDesktopWindowActionResult, executeDesktopWindowActionWithResult, listenDesktopWindowAction } from '@/utils/platform/desktopWindowActionBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_DEFAULT,
} from './useVoiceAttemptControl';

/** One app-level registration; composers never register or retarget the active command. */
export const VoiceKeyboardRuntime = React.memo(function VoiceKeyboardRuntime() {
    return resolveDesktopWindowContext().role === 'primary' ? <PrimaryVoiceKeyboardRuntime /> : <SecondaryVoiceKeyboardRuntime />;
});

function PrimaryVoiceKeyboardRuntime() {
    const enabled = useFeatureEnabled('voice');
    const control = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_DEFAULT);
    const current = React.useRef({ enabled, control });
    current.current = { enabled, control };
    React.useEffect(() => {
        if (!isDesktopHost()) return;
        let disposed = false;
        let stop: (() => void) | undefined;
        fireAndForget(listenDesktopWindowAction(request => {
            if (request.actionIdentifier !== DESKTOP_VOICE_TOGGLE || !request.requestId) return;
            const { enabled: available, control: latest } = current.current;
            const requestId = request.requestId;
            fireAndForget((async () => {
                const ok = (available || latest.canStop) && await latest.onToggle();
                await emitDesktopWindowActionResult({ windowLabel: request.windowLabel, requestId,
                    phase: 'settled', ok: ok === true, ...(ok ? {} : { errorCode: 'target_unavailable', error: 'target_unavailable' }) });
            })(), { tag: 'VoiceKeyboardRuntime.toggle' });
        }).then(release => { if (disposed) release(); else stop = release; }), { tag: 'VoiceKeyboardRuntime.listen' });
        return () => { disposed = true; stop?.(); };
    }, []);
    // A gate changing during an admitted attempt must not remove the way to End it.
    useKeyboardShortcutHandlers(enabled || control.canStop ? { 'voice.toggle': control.onToggle } : {});
    return null;
}

function SecondaryVoiceKeyboardRuntime() {
    const enabled = useFeatureEnabled('voice');
    const lifetime = React.useMemo(() => new AbortController(), []);
    React.useEffect(() => () => lifetime.abort(), [lifetime]);
    const toggle = React.useCallback(() => {
        const label = getDesktopHostWindowLabel();
        if (!label?.startsWith('destination_')) return;
        fireAndForget(executeDesktopWindowActionWithResult({ windowLabel: label as `destination_${string}`,
            actionIdentifier: DESKTOP_VOICE_TOGGLE, data: {} }, { signal: lifetime.signal }), { tag: 'VoiceKeyboardRuntime.forward' });
    }, [lifetime]);
    useKeyboardShortcutHandlers(enabled ? { 'voice.toggle': toggle } : {});
    return null;
}
