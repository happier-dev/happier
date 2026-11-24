import * as React from 'react';

import { subscribeActivityLocalNotifications } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { createSessionSoundWatcher, isLatestTurnFailed } from './createSessionSoundWatcher';
import { playSoundEffect } from './playSoundEffect';
import type { SoundEffectEvent, SoundEffectId } from './soundEffectCatalog';

/**
 * A turn end publishes its ready event and its failed turn status on separate channels with no
 * ordering between them. The success sound waits this long, then plays only if the session's latest
 * turn did not fail; a failure arriving inside the window cancels it.
 */
export const SUCCESS_SOUND_SETTLE_MS = 1_000;

function readSoundForEvent(event: SoundEffectEvent): SoundEffectId {
    const localSettings = storage.getState().localSettings;
    switch (event) {
        case 'error':
            return localSettings.soundEffectsErrorSound;
        case 'attention':
            return localSettings.soundEffectsAttentionSound;
        case 'success':
            return localSettings.soundEffectsSuccessSound;
        case 'resume':
            return localSettings.soundEffectsResumeSound;
    }
}

function play(event: SoundEffectEvent): void {
    fireAndForget(playSoundEffect(readSoundForEvent(event)), { tag: `SoundEffectsRuntime.${event}` });
}

/**
 * Plays this device's sound effects: error when a session fails (red), attention when it asks for
 * approval or input (yellow), success when a turn finishes (green), and resume when a session
 * continues on its own after a usage limit. Ready and request events come from the activity
 * notification bus that also drives local notifications; failures and resumes come from the
 * session records, since no event announces them.
 */
export function SoundEffectsRuntime(): null {
    const enabled = useLocalSetting('soundEffectsEnabled');

    React.useEffect(() => {
        if (!enabled) return undefined;

        const pendingSuccess = new Map<string, ReturnType<typeof setTimeout>>();

        const watcher = createSessionSoundWatcher((sessionId, event) => {
            if (event === 'resumedAfterUsageLimit') {
                play('resume');
                return;
            }
            const pending = pendingSuccess.get(sessionId);
            if (pending !== undefined) {
                clearTimeout(pending);
                pendingSuccess.delete(sessionId);
            }
            play('error');
        });
        watcher.observe(storage.getState(), false);
        const unsubscribeStore = storage.subscribe((state) => watcher.observe(state, true));

        const unsubscribeBus = subscribeActivityLocalNotifications((event) => {
            if (event.kind === 'agent-request') {
                play('attention');
                return;
            }
            const sessionId = event.sessionId;
            if (pendingSuccess.has(sessionId)) return;
            pendingSuccess.set(sessionId, setTimeout(() => {
                pendingSuccess.delete(sessionId);
                // The failed turn already played the error sound.
                if (isLatestTurnFailed(storage.getState(), sessionId)) return;
                play('success');
            }, SUCCESS_SOUND_SETTLE_MS));
        });

        return () => {
            unsubscribeStore();
            unsubscribeBus();
            for (const pending of pendingSuccess.values()) clearTimeout(pending);
            pendingSuccess.clear();
        };
    }, [enabled]);

    return null;
}
