import {
    type AccountSettings,
    accountSettingsParse,
} from '@happier-dev/protocol';

import { localSettingsParse, type LocalSettings } from '@/sync/domains/settings/localSettings';

import { resolveActivityAttentionDeliveryPlan } from '../delivery/resolveActivityAttentionDeliveryPlan';

export type ForegroundNotificationBehavior = 'full' | 'silent' | 'off';

export function resolveForegroundNotificationBehavior(params: Readonly<{
    localSettings: Partial<LocalSettings> | null | undefined;
    accountSettings: Partial<AccountSettings> | null | undefined;
}>): ForegroundNotificationBehavior {
    const parsedLocalSettings = localSettingsParse(params.localSettings ?? {});
    const parsedAccountSettings = accountSettingsParse(params.accountSettings ?? {});

    const unifiedPlan = resolveActivityAttentionDeliveryPlan({
        localSettings: parsedLocalSettings,
        accountSettings: parsedAccountSettings,
        event: 'ready',
        channel: 'local_notification',
        foregroundState: 'foreground',
        now: new Date('2026-01-01T00:00:00.000Z'),
    });
    if (unifiedPlan.reason === 'channel_disabled') {
        return 'off';
    }
    return unifiedPlan.foregroundBehavior;
}
