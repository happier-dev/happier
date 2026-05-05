import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';

export type ResolvedDeviceQuietHoursOverride = Readonly<
    | { mode: 'account' }
    | { mode: 'disabled' }
    | {
        mode: 'custom';
        timezone: string;
        windows: readonly {
            startLocalTime: string;
            endLocalTime: string;
            days?: readonly ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[];
        }[];
    }
>;

export function resolveDeviceQuietHoursOverride(
    overrides: AttentionDeviceOverridesV1,
): ResolvedDeviceQuietHoursOverride {
    return overrides.quietHoursOverride;
}
