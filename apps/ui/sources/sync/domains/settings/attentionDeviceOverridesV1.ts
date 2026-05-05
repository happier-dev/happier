import { z } from 'zod';

const AttentionDeviceOverridePreviewBehaviorSchema = z.enum([
    'account',
    'status_only',
    'title_only',
    'include_preview',
]);

const AttentionDeviceOverrideEventTogglesSchema = z.object({
    ready: z.boolean().default(true),
    permission_request: z.boolean().default(true),
    user_action_request: z.boolean().default(true),
});

const AttentionDeviceOverrideLocalNotificationsSchema = z.object({
    enabled: z.boolean().default(true),
    events: AttentionDeviceOverrideEventTogglesSchema.default(AttentionDeviceOverrideEventTogglesSchema.parse({})),
    previewBehavior: AttentionDeviceOverridePreviewBehaviorSchema.default('account'),
}).passthrough();

const AttentionDeviceOverrideBadgeSchema = z.object({
    enabled: z.boolean().default(true),
    includeUnread: z.boolean().default(true),
    includePendingPermissionRequests: z.boolean().default(true),
    includePendingUserActionRequests: z.boolean().default(true),
    includeQueuedUserInput: z.boolean().default(true),
    includeFriendRequestsInboxCount: z.boolean().default(true),
    includeDesktopNonNumericDot: z.boolean().default(true),
}).passthrough();

const AttentionDeviceOverrideQuietHoursWindowSchema = z.object({
    startLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional(),
}).passthrough();

const AttentionDeviceOverrideQuietHoursSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('account') }).passthrough(),
    z.object({ mode: z.literal('disabled') }).passthrough(),
    z.object({
        mode: z.literal('custom'),
        timezone: z.string().trim().min(1).default('UTC'),
        windows: z.array(AttentionDeviceOverrideQuietHoursWindowSchema).default([]),
    }).passthrough(),
]).default({ mode: 'account' });

const DEFAULT_QUICK_REPLY_PHRASES = ['Continue', 'OK', 'Explain', 'Retry'] as const;

const QuickReplyPhrasesSchema = z.preprocess((raw) => {
    if (!Array.isArray(raw)) return [...DEFAULT_QUICK_REPLY_PHRASES];
    const phrases = raw
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 6);
    return phrases.length > 0 ? phrases : [...DEFAULT_QUICK_REPLY_PHRASES];
}, z.array(z.string().min(1)).min(1).max(6));

const AttentionDeviceOverrideDesktopOverlaySchema = z.object({
    hoverExpandDelay: z.enum(['instant', 'normal', 'slow']).default('normal'),
    compactCollapsedMode: z.boolean().default(false),
    collapsedCarouselEnabled: z.boolean().default(true),
    physicalNotchMode: z.enum(['automatic', 'physical_only', 'force_virtual']).default('automatic'),
    autoDismissDelayMs: z.number().int().positive().max(120_000).default(10_000),
    quickReplyPhrases: QuickReplyPhrasesSchema.default([...DEFAULT_QUICK_REPLY_PHRASES]),
}).passthrough();

const AttentionDeviceOverrideLiveActivitiesSchema = z.object({
    registerRemoteUpdateTargets: z.boolean().default(true),
    allowBackgroundWakeFallback: z.boolean().default(false),
    privacyMode: AttentionDeviceOverridePreviewBehaviorSchema.default('account'),
    showFreshnessDiagnostics: z.boolean().default(false),
    remoteUpdateModeOverride: z.enum(['account', 'local_only', 'disabled']).default('account'),
}).passthrough();

const AttentionDeviceOverrideWidgetsSchema = z.object({
    enabled: z.boolean().default(true),
    privacyMode: AttentionDeviceOverridePreviewBehaviorSchema.default('account'),
}).passthrough();

const AttentionDeviceOverridePrivacySchema = z.object({
    previewBehavior: AttentionDeviceOverridePreviewBehaviorSchema.default('account'),
}).passthrough();

const AttentionDeviceOverrideSoundsSchema = z.object({
    enabled: z.boolean().default(true),
    volume: z.number().min(0).max(1).default(1),
}).passthrough();

const AttentionDeviceOverrideTerminalSmartSuppressionSchema = z.object({
    enabled: z.boolean().default(true),
}).passthrough();

export const AttentionDeviceOverridesV1Schema = z.object({
    v: z.literal(1).default(1),
    enabled: z.boolean().default(true),
    localNotifications: AttentionDeviceOverrideLocalNotificationsSchema.default(AttentionDeviceOverrideLocalNotificationsSchema.parse({})),
    foregroundBehavior: z.enum(['account', 'full', 'silent', 'off']).default('account'),
    badge: AttentionDeviceOverrideBadgeSchema.default(AttentionDeviceOverrideBadgeSchema.parse({})),
    sounds: AttentionDeviceOverrideSoundsSchema.default(AttentionDeviceOverrideSoundsSchema.parse({})),
    quietHoursOverride: AttentionDeviceOverrideQuietHoursSchema,
    desktopOverlay: AttentionDeviceOverrideDesktopOverlaySchema.default(AttentionDeviceOverrideDesktopOverlaySchema.parse({})),
    liveActivities: AttentionDeviceOverrideLiveActivitiesSchema.default(AttentionDeviceOverrideLiveActivitiesSchema.parse({})),
    widgets: AttentionDeviceOverrideWidgetsSchema.default(AttentionDeviceOverrideWidgetsSchema.parse({})),
    privacy: AttentionDeviceOverridePrivacySchema.default(AttentionDeviceOverridePrivacySchema.parse({})),
    terminalSmartSuppression: AttentionDeviceOverrideTerminalSmartSuppressionSchema.default(AttentionDeviceOverrideTerminalSmartSuppressionSchema.parse({})),
}).passthrough().catch({
    v: 1,
    enabled: true,
    localNotifications: AttentionDeviceOverrideLocalNotificationsSchema.parse({}),
    foregroundBehavior: 'account',
    badge: AttentionDeviceOverrideBadgeSchema.parse({}),
    sounds: AttentionDeviceOverrideSoundsSchema.parse({}),
    quietHoursOverride: { mode: 'account' },
    desktopOverlay: AttentionDeviceOverrideDesktopOverlaySchema.parse({}),
    liveActivities: AttentionDeviceOverrideLiveActivitiesSchema.parse({}),
    widgets: AttentionDeviceOverrideWidgetsSchema.parse({}),
    privacy: AttentionDeviceOverridePrivacySchema.parse({}),
    terminalSmartSuppression: AttentionDeviceOverrideTerminalSmartSuppressionSchema.parse({}),
});

export type AttentionDeviceOverridesV1 = z.infer<typeof AttentionDeviceOverridesV1Schema>;

export const DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1: AttentionDeviceOverridesV1 =
    AttentionDeviceOverridesV1Schema.parse({});

const LEGACY_ATTENTION_DEVICE_OVERRIDE_KEYS = [
    'localNotificationsEnabled',
    'localNotificationsShowReady',
    'localNotificationsShowReadyMessageText',
    'localNotificationsShowPendingPermissionRequests',
    'localNotificationsShowPendingUserActionRequests',
    'localNotificationsForegroundBehavior',
    'activityBadgesEnabled',
    'activityBadgeShowUnread',
    'activityBadgeShowPendingPermissionRequests',
    'activityBadgeShowPendingUserActionRequests',
    'activityBadgeShowQueuedUserInput',
    'activityBadgeShowFriendRequestsInboxCount',
    'activityBadgeShowDesktopNonNumericDot',
    'desktopOverlayAutoHideDelayMs',
    'liveActivitiesShowPreviewText',
    'activitySurfacePrivacyMode',
    'widgetsEnabled',
    'widgetsShowPreviewText',
] as const;

type LegacyAttentionDeviceOverrideKey = typeof LEGACY_ATTENTION_DEVICE_OVERRIDE_KEYS[number];

function hasOwn(record: Readonly<Record<string, unknown>>, key: LegacyAttentionDeviceOverrideKey): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function readBoolean(
    record: Readonly<Record<string, unknown>>,
    key: LegacyAttentionDeviceOverrideKey,
    fallback: boolean,
): boolean {
    return typeof record[key] === 'boolean' ? record[key] : fallback;
}

function readForegroundBehavior(
    record: Readonly<Record<string, unknown>>,
    fallback: AttentionDeviceOverridesV1['foregroundBehavior'],
): AttentionDeviceOverridesV1['foregroundBehavior'] {
    const value = record.localNotificationsForegroundBehavior;
    return value === 'full' || value === 'silent' || value === 'off' ? value : fallback;
}

function readPreviewBehavior(
    value: unknown,
    fallback: AttentionDeviceOverridesV1['privacy']['previewBehavior'],
): AttentionDeviceOverridesV1['privacy']['previewBehavior'] {
    return value === 'status_only' || value === 'title_only' || value === 'include_preview' || value === 'account'
        ? value
        : fallback;
}

export function hasLegacyAttentionDeviceOverrideFields(record: Readonly<Record<string, unknown>>): boolean {
    return LEGACY_ATTENTION_DEVICE_OVERRIDE_KEYS.some((key) => hasOwn(record, key));
}

export function deriveAttentionDeviceOverridesV1FromLegacyLocalSettings(params: {
    legacy: Readonly<Record<string, unknown>>;
    base?: unknown;
}): AttentionDeviceOverridesV1 {
    const base = AttentionDeviceOverridesV1Schema.parse(params.base);
    const legacy = params.legacy;
    const activitySurfacePrivacyMode = readPreviewBehavior(
        legacy.activitySurfacePrivacyMode,
        base.liveActivities.privacyMode,
    );
    const liveActivityPrivacyMode = readBoolean(legacy, 'liveActivitiesShowPreviewText', true)
        ? activitySurfacePrivacyMode
        : 'status_only';
    const widgetPrivacyMode = readBoolean(legacy, 'widgetsShowPreviewText', true)
        ? base.widgets.privacyMode
        : 'status_only';
    const readyPreviewBehavior = readBoolean(legacy, 'localNotificationsShowReadyMessageText', true)
        ? base.localNotifications.previewBehavior
        : 'status_only';

    return AttentionDeviceOverridesV1Schema.parse({
        ...base,
        foregroundBehavior: readForegroundBehavior(legacy, base.foregroundBehavior),
        localNotifications: {
            ...base.localNotifications,
            enabled: readBoolean(legacy, 'localNotificationsEnabled', base.localNotifications.enabled),
            events: {
                ...base.localNotifications.events,
                ready: readBoolean(legacy, 'localNotificationsShowReady', base.localNotifications.events.ready),
                permission_request: readBoolean(
                    legacy,
                    'localNotificationsShowPendingPermissionRequests',
                    base.localNotifications.events.permission_request,
                ),
                user_action_request: readBoolean(
                    legacy,
                    'localNotificationsShowPendingUserActionRequests',
                    base.localNotifications.events.user_action_request,
                ),
            },
            previewBehavior: readyPreviewBehavior,
        },
        badge: {
            ...base.badge,
            enabled: readBoolean(legacy, 'activityBadgesEnabled', base.badge.enabled),
            includeUnread: readBoolean(legacy, 'activityBadgeShowUnread', base.badge.includeUnread),
            includePendingPermissionRequests: readBoolean(
                legacy,
                'activityBadgeShowPendingPermissionRequests',
                base.badge.includePendingPermissionRequests,
            ),
            includePendingUserActionRequests: readBoolean(
                legacy,
                'activityBadgeShowPendingUserActionRequests',
                base.badge.includePendingUserActionRequests,
            ),
            includeQueuedUserInput: readBoolean(
                legacy,
                'activityBadgeShowQueuedUserInput',
                base.badge.includeQueuedUserInput,
            ),
            includeFriendRequestsInboxCount: readBoolean(
                legacy,
                'activityBadgeShowFriendRequestsInboxCount',
                base.badge.includeFriendRequestsInboxCount,
            ),
            includeDesktopNonNumericDot: readBoolean(
                legacy,
                'activityBadgeShowDesktopNonNumericDot',
                base.badge.includeDesktopNonNumericDot,
            ),
        },
        desktopOverlay: {
            ...base.desktopOverlay,
            autoDismissDelayMs: typeof legacy.desktopOverlayAutoHideDelayMs === 'number'
                ? legacy.desktopOverlayAutoHideDelayMs
                : base.desktopOverlay.autoDismissDelayMs,
        },
        liveActivities: {
            ...base.liveActivities,
            privacyMode: liveActivityPrivacyMode,
        },
        widgets: {
            ...base.widgets,
            enabled: readBoolean(legacy, 'widgetsEnabled', base.widgets.enabled),
            privacyMode: widgetPrivacyMode,
        },
    });
}
