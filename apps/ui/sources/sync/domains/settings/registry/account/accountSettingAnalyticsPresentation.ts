import {
    ACCOUNT_SETTING_DEFINITIONS,
    type AccountSettingKey,
    type SettingAnalyticsMetadata,
} from '@happier-dev/protocol';

/**
 * UI-only analytics and presentation metadata for the Protocol-owned Account Settings catalog.
 * This type intentionally has no persistence fields: Protocol remains the sole schema/default/
 * scope owner and this module merely attaches safe serializers to canonical keys.
 */
export type AccountSettingAnalyticsPresentation = Readonly<Partial<Record<
    AccountSettingKey,
    SettingAnalyticsMetadata
>>>;

export function defineAccountSettingAnalytics<
    const TPresentation extends AccountSettingAnalyticsPresentation,
>(presentation: TPresentation): TPresentation {
    for (const key of Object.keys(presentation)) {
        if (!Object.prototype.hasOwnProperty.call(ACCOUNT_SETTING_DEFINITIONS, key)) {
            throw new Error(`Unknown Protocol Account setting analytics key: ${key}`);
        }
    }
    return presentation;
}

/**
 * A key may have one analytics presenter. Merging category-owned presentation maps here keeps
 * the UI projection authoritative without turning those category modules back into schema owners.
 */
export function mergeAccountSettingAnalytics(
    ...presentations: readonly AccountSettingAnalyticsPresentation[]
): AccountSettingAnalyticsPresentation {
    const merged: Record<string, SettingAnalyticsMetadata> = {};

    for (const presentation of presentations) {
        for (const [key, metadata] of Object.entries(presentation)) {
            if (Object.prototype.hasOwnProperty.call(merged, key)) {
                throw new Error(`Duplicate UI Account setting analytics presentation: ${key}`);
            }
            merged[key] = metadata;
        }
    }

    return defineAccountSettingAnalytics(merged);
}
