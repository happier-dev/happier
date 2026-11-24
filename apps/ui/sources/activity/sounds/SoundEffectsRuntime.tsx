import * as React from 'react';

import { subscribeActivityLocalNotifications } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { createSessionSoundWatcher } from './createSessionSoundWatcher';
import { playSoundEffect } from './playSoundEffect';
import type { SoundEffectEvent } from './soundEffectCatalog';

const SOUND_SETTING_KEYS = {
    error: 'soundEffectsErrorSound',
    attention: 'soundEffectsAttentionSound',
    success: 'soundEffectsSuccessSound',
    resume: 'soundEffectsResumeSound',
} as const;

function play(event: SoundEffectEvent): void {
    const settings = storage.getState().localSettings;
    fireAndForget(playSoundEffect(settings[SOUND_SETTING_KEYS[event]], settings.soundEffectsVolumePercent), {
        tag: `SoundEffectsRuntime.${event}`,
    });
}

/**
 * Plays this device's sound effects: error when a session fails (red), attention when it asks for
 * approval or input (yellow), success when a turn finishes (green), and resume when a session
 * continues on its own after a usage limit. Request events come from the activity notification
 * bus that also drives local notifications. Turn outcomes and resumes come from the session
 * records, since a ready event can arrive before the outcome is known.
 */
export function SoundEffectsRuntime(): null {
    const enabled = useLocalSetting('soundEffectsEnabled');

    React.useEffect(() => {
        if (!enabled) return undefined;

        const watcher = createSessionSoundWatcher((event) => {
            switch (event) {
                case 'completed':
                    play('success');
                    break;
                case 'failed':
                    play('error');
                    break;
                case 'resumedAfterUsageLimit':
                    play('resume');
                    break;
            }
        });
        watcher.observe(storage.getState(), false);
        const unsubscribeStore = storage.subscribe((state) => watcher.observe(state, true));

        const unsubscribeBus = subscribeActivityLocalNotifications((event) => {
            if (event.kind === 'agent-request') play('attention');
        });

        return () => {
            unsubscribeStore();
            unsubscribeBus();
        };
    }, [enabled]);

    return null;
}
