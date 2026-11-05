import { z } from 'zod/mini';

const AttentionDeviceOverridePreviewBehaviorSchema = z.enum([
    'account',
    'status_only',
    'title_only',
    'include_preview',
]);

const AttentionDeviceOverrideEventTogglesSchema = z.object({
    ready: z._default(z.boolean(), true),
    permission_request: z._default(z.boolean(), true),
    user_action_request: z._default(z.boolean(), true),
});

const AttentionDeviceOverrideLocalNotificationsSchema = z.looseObject({
    enabled: z._default(z.boolean(), true),
    events: z._default(AttentionDeviceOverrideEventTogglesSchema, AttentionDeviceOverrideEventTogglesSchema.parse({})),
    previewBehavior: z._default(AttentionDeviceOverridePreviewBehaviorSchema, 'account'),
    requestPreviewBehavior: z._default(AttentionDeviceOverridePreviewBehaviorSchema, 'account'),
});

const AttentionDeviceOverrideBadgeSchema = z.looseObject({
    enabled: z._default(z.boolean(), true),
    includeUnread: z._default(z.boolean(), true),
    includePendingPermissionRequests: z._default(z.boolean(), true),
    includePendingUserActionRequests: z._default(z.boolean(), true),
    includeQueuedUserInput: z._default(z.boolean(), true),
    includeFriendRequestsInboxCount: z._default(z.boolean(), true),
    includeDesktopNonNumericDot: z._default(z.boolean(), true),
});

const AttentionDeviceOverrideQuietHoursWindowSchema = z.looseObject({
    startLocalTime: z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
    endLocalTime: z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
    days: z.optional(z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))),
});

const AttentionDeviceOverrideQuietHoursSchema = z._default(z.discriminatedUnion('mode', [
    z.looseObject({ mode: z.literal('account') }),
    z.looseObject({ mode: z.literal('disabled') }),
    z.looseObject({
        mode: z.literal('custom'),
        timezone: z._default(z.string().check(z.trim(), z.minLength(1)), 'UTC'),
        windows: z._default(z.array(AttentionDeviceOverrideQuietHoursWindowSchema), []),
    }),
]), { mode: 'account' });

const DEFAULT_QUICK_REPLY_PHRASES = ['Continue', 'OK', 'Explain', 'Retry'] as const;

const QuickReplyPhrasesSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => {
    if (!Array.isArray(raw)) return [...DEFAULT_QUICK_REPLY_PHRASES];
    const phrases = raw
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    return phrases.length > 0 ? phrases : [...DEFAULT_QUICK_REPLY_PHRASES];
}), z.array(z.string().check(z.minLength(1))).check(z.minLength(1)));

export const AttentionDeviceOverrideDesktopOverlaySchema = z.pipe(z.transform((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const { compactCollapsedMode, collapsedCarouselEnabled, physicalNotchMode, autoDismissDelayMs, ...current } = raw as Record<string, unknown>;
    return current;
}), z.looseObject({
    hoverExpandDelay: z._default(z.enum(['instant', 'normal', 'slow']), 'normal'),
    quickReplyPhrases: z._default(QuickReplyPhrasesSchema, [...DEFAULT_QUICK_REPLY_PHRASES]),
}));

const AttentionDeviceOverrideLiveActivitiesSchema = z.looseObject({
    registerRemoteUpdateTargets: z._default(z.boolean(), true),
    allowBackgroundWakeFallback: z._default(z.boolean(), false),
    privacyMode: z._default(AttentionDeviceOverridePreviewBehaviorSchema, 'account'),
    showFreshnessDiagnostics: z._default(z.boolean(), false),
    remoteUpdateModeOverride: z._default(z.enum(['account', 'local_only', 'disabled']), 'account'),
});

const AttentionDeviceOverrideWidgetsSchema = z.looseObject({
    enabled: z._default(z.boolean(), true),
    privacyMode: z._default(AttentionDeviceOverridePreviewBehaviorSchema, 'account'),
});

const AttentionDeviceOverridePrivacySchema = z.looseObject({
    previewBehavior: z._default(AttentionDeviceOverridePreviewBehaviorSchema, 'account'),
});

const AttentionDeviceOverrideSoundsSchema = z.looseObject({
    enabled: z._default(z.boolean(), true),
    volume: z._default(z.number().check(z.minimum(0), z.maximum(1)), 1),
});

const AttentionDeviceOverrideTerminalSmartSuppressionSchema = z.looseObject({
    enabled: z._default(z.boolean(), true),
});

export const AttentionDeviceOverridesV1Schema = z.catch(z.looseObject({
    v: z._default(z.literal(1), 1),
    enabled: z._default(z.boolean(), true),
    localNotifications: z._default(AttentionDeviceOverrideLocalNotificationsSchema, AttentionDeviceOverrideLocalNotificationsSchema.parse({})),
    foregroundBehavior: z._default(z.enum(['account', 'full', 'silent', 'off']), 'account'),
    badge: z._default(AttentionDeviceOverrideBadgeSchema, AttentionDeviceOverrideBadgeSchema.parse({})),
    sounds: z._default(AttentionDeviceOverrideSoundsSchema, AttentionDeviceOverrideSoundsSchema.parse({})),
    quietHoursOverride: AttentionDeviceOverrideQuietHoursSchema,
    desktopOverlay: z._default(AttentionDeviceOverrideDesktopOverlaySchema, AttentionDeviceOverrideDesktopOverlaySchema.parse({})),
    liveActivities: z._default(AttentionDeviceOverrideLiveActivitiesSchema, AttentionDeviceOverrideLiveActivitiesSchema.parse({})),
    widgets: z._default(AttentionDeviceOverrideWidgetsSchema, AttentionDeviceOverrideWidgetsSchema.parse({})),
    privacy: z._default(AttentionDeviceOverridePrivacySchema, AttentionDeviceOverridePrivacySchema.parse({})),
    terminalSmartSuppression: z._default(AttentionDeviceOverrideTerminalSmartSuppressionSchema, AttentionDeviceOverrideTerminalSmartSuppressionSchema.parse({})),
}), {
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
    'localNotificationsShowRequestMessageText',
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
            requestPreviewBehavior: readBoolean(legacy, 'localNotificationsShowRequestMessageText', true)
                ? base.localNotifications.requestPreviewBehavior
                : 'status_only',
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
