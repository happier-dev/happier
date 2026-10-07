import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { DeviceRemoteAlertPolicyV1Schema, type DeviceRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';

import {
    AttentionDeviceOverridesV1Schema,
    type AttentionDeviceOverridesV1,
} from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { localSettingsParse, type LocalSettings } from '@/sync/domains/settings/localSettings';

import { resolveDeviceQuietHoursOverride } from './resolveQuietHoursState';

/**
 * The platform support actually reported by this build's shipped native alert
 * consumer. A device may only claim `nativeConsumer` once that consumer exists;
 * a capability report is not itself proof that an enriched alert can be
 * rendered (Lane 09C §10.4 C5b step 5).
 */
export type DeviceRemoteAlertNativeSupport = Readonly<{ platform: 'ios' | 'android' }>;

/** One mapping from reported platform support to the registered consumer id. */
export function resolveDeviceRemoteAlertNativeConsumer(
    support: DeviceRemoteAlertNativeSupport,
): DeviceRemoteAlertPolicyV1['nativeConsumer'] {
    return support.platform === 'ios' ? 'ios_service_extension_v1' : 'android_native_v1';
}

function projectQuietHoursOverride(
    overrides: AttentionDeviceOverridesV1,
): DeviceRemoteAlertPolicyV1['quietHoursOverride'] {
    const override = resolveDeviceQuietHoursOverride(overrides);
    if (override.mode !== 'custom') return { mode: override.mode };
    return {
        mode: 'custom',
        timezone: override.timezone,
        windows: override.windows.map(({ startLocalTime, endLocalTime, days }) => ({
            startLocalTime,
            endLocalTime,
            ...(days ? { days: [...days] } : {}),
        })),
    };
}

/**
 * Derive the narrow device overlay this device may publish with its push-token
 * registration.
 *
 * It is not a second Account policy: it carries only the quiet-hours,
 * foreground, preview-ceiling and volume semantics the existing device-override
 * owner already expresses, plus the explicit per-device opt-in. Local-only
 * controls (`localNotifications.*`, `sounds.enabled`, badges, widgets, Live
 * Activities, desktop overlay) stay local and never become remote switches.
 *
 * `null` means this device publishes no policy at all: either the Account has
 * not opted into limited policy disclosure, or this build ships no native alert
 * consumer that could present an enriched alert.
 */
export function deriveDeviceRemoteAlertPolicyV1(params: Readonly<{
    accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>> | null | undefined;
    localSettings: Partial<LocalSettings> | Readonly<Record<string, unknown>> | null | undefined;
    nativeSupport: DeviceRemoteAlertNativeSupport | null;
}>): DeviceRemoteAlertPolicyV1 | null {
    if (!params.nativeSupport) return null;
    if (accountSettingsParse(params.accountSettings ?? {}).sessionRemoteAlertsEnabled !== true) return null;

    const local = localSettingsParse(params.localSettings ?? {});
    const overrides = AttentionDeviceOverridesV1Schema.parse(local.attentionDeviceOverridesV1);
    // `overrides.enabled === false` means this device ignores its own overrides
    // and inherits the Account policy. It is not a remote mute, so the inherited
    // arm carries the canonical defaults rather than the retained override values.
    const inherits = !overrides.enabled;
    const accountSoundVolume = accountSettingsParse(params.accountSettings ?? {})
        .attentionDeliveryPolicyV1.sounds.volume;

    const parsed = DeviceRemoteAlertPolicyV1Schema.safeParse({
        v: 1,
        enabled: local.deviceRemoteAlertsEnabled === true,
        nativeConsumer: resolveDeviceRemoteAlertNativeConsumer(params.nativeSupport),
        quietHoursOverride: inherits ? { mode: 'account' } : projectQuietHoursOverride(overrides),
        foregroundBehavior: inherits ? 'account' : overrides.foregroundBehavior,
        previewCeiling: inherits ? 'account' : overrides.privacy.previewBehavior,
        soundVolume: inherits ? accountSoundVolume : overrides.sounds.volume,
    });
    return parsed.success ? parsed.data : null;
}

/** Structural equality so an unchanged overlay never re-writes the token row. */
export function areDeviceRemoteAlertPoliciesEqual(
    left: DeviceRemoteAlertPolicyV1 | null,
    right: DeviceRemoteAlertPolicyV1 | null,
): boolean {
    if (left === null || right === null) return left === right;
    if (left.enabled !== right.enabled) return false;
    if (left.nativeConsumer !== right.nativeConsumer) return false;
    if (left.foregroundBehavior !== right.foregroundBehavior) return false;
    if (left.previewCeiling !== right.previewCeiling) return false;
    if (left.soundVolume !== right.soundVolume) return false;
    if (left.quietHoursOverride.mode !== right.quietHoursOverride.mode) return false;
    if (left.quietHoursOverride.mode !== 'custom' || right.quietHoursOverride.mode !== 'custom') return true;
    if (left.quietHoursOverride.timezone !== right.quietHoursOverride.timezone) return false;
    if (left.quietHoursOverride.windows.length !== right.quietHoursOverride.windows.length) return false;
    return left.quietHoursOverride.windows.every((window, index) => {
        const other = right.quietHoursOverride.mode === 'custom' ? right.quietHoursOverride.windows[index] : undefined;
        return Boolean(other)
            && window.startLocalTime === other!.startLocalTime
            && window.endLocalTime === other!.endLocalTime
            && (window.days ?? []).join(',') === (other!.days ?? []).join(',');
    });
}
