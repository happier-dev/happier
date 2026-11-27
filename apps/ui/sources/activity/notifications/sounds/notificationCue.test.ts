import { describe, expect, it } from 'vitest';
import { resolveAttentionDeliveryPolicyDecision } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { resolveNotificationCue } from './notificationCue';

describe('notification cue admission', () => {
    const plan = (sound: string, foregroundBehavior: 'full' | 'silent' | 'off' = 'full') =>
        resolveAttentionDeliveryPolicyDecision({
            policy: { foregroundBehavior, sounds: { eventSoundIds: { task_failed: sound } } },
            event: 'task_failed', channel: 'local_notification', foregroundState: 'foreground', now: new Date(0),
        });

    it('respects delivery and the device switch before offering a document cue', () => {
        expect(resolveNotificationCue(plan('drop'), 'desktop', {})).toMatchObject({ id: 'drop' });
        expect(resolveNotificationCue(plan('drop'), 'browser', {})).toBeNull();
        expect(resolveNotificationCue(plan('drop'), 'browser', { inApp: true })).toMatchObject({ id: 'drop' });
        expect(resolveNotificationCue(plan('drop'), 'desktop', { enabled: false })).toBeNull();
        expect(resolveNotificationCue(plan('drop', 'silent'), 'desktop', {})).toBeNull();
        expect(resolveNotificationCue(plan('drop', 'off'), 'desktop', {})).toBeNull();
    });

    it('leaves bundled phone cues with the OS and carries the approved fallback for custom sounds', () => {
        expect(resolveNotificationCue(plan('drop'), 'native', {})).toBeNull();
        expect(resolveNotificationCue(plan('local/coin'), 'native', { volume: 0.5 }))
            .toEqual({ id: 'local/coin', fallbackSoundId: 'drop', volume: 0.5 });
    });
});
