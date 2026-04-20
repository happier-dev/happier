export type DesktopOverlayVisibilityMode = 'attention_only' | 'active_sessions' | 'always_when_enabled';
export type DesktopOverlayPresentationMode = 'automatic' | 'notch_integrated' | 'floating_overlay';
export type DesktopOverlayPlacementMode = 'anchored' | 'custom';
export type DesktopOverlayAnchor =
    | 'top_center'
    | 'top_left'
    | 'top_right'
    | 'bottom_center'
    | 'bottom_left'
    | 'bottom_right'
    | 'left_center'
    | 'right_center';
export type DesktopOverlayClickAction = 'expand_overlay' | 'open_primary_session' | 'open_sessions';
export type DesktopOverlayDensity = 'compact' | 'comfortable';
export type DesktopOverlayCompactStyle = 'pill' | 'panel';
export type DesktopOverlayExpandedBehavior = 'click' | 'hover';
export type DesktopOverlaySettingsVisibilityState = Readonly<{
    showOverlayConfiguration: boolean;
    showAttentionFilterControls: boolean;
    showAutoHideDelay: boolean;
    showHostModeFallbackNotice: boolean;
    showFloatingPlacementControls: boolean;
    showCustomPlacementControls: boolean;
}>;

export type DesktopOverlayPolicy = Readonly<{
    enabled: boolean;
    visibilityMode: DesktopOverlayVisibilityMode;
    showWhenRunning: boolean;
    showWhenAttentionRequired: boolean;
    showWhenReady: boolean;
    alwaysOnTop: boolean;
    autoHideEnabled: boolean;
    autoHideDelayMs: number;
    expandedBehavior: DesktopOverlayExpandedBehavior;
    interactiveCollapsed: boolean;
    presentationMode: DesktopOverlayPresentationMode;
    clickAction: DesktopOverlayClickAction;
    density: DesktopOverlayDensity;
    compactStyle: DesktopOverlayCompactStyle;
    showSessionCount: boolean;
    showPreviewText: boolean;
    placementMode: DesktopOverlayPlacementMode;
    anchor: DesktopOverlayAnchor;
    offsetX: number;
    offsetY: number;
    enableDragReposition: boolean;
    lockPosition: boolean;
}>;

export type DesktopOverlayEffectiveHostMode = 'floating' | 'notch_integrated' | null;

const DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS = {
    expandedBehavior: 'click',
    interactiveCollapsed: true,
    clickAction: 'expand_overlay',
    density: 'compact',
    compactStyle: 'pill',
    showSessionCount: true,
} as const satisfies Pick<
    DesktopOverlayPolicy,
    'expandedBehavior' | 'interactiveCollapsed' | 'clickAction' | 'density' | 'compactStyle' | 'showSessionCount'
>;

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, value));
}

export function resolveDesktopOverlayPolicy(settings: Readonly<Record<string, unknown>>): DesktopOverlayPolicy {
    const placementMode = readEnum(settings.desktopOverlayPlacementMode, ['anchored', 'custom'], 'anchored');
    const offsetX = readNumber(settings.desktopOverlayOffsetX, 0, -4000, 4000);
    const offsetY = readNumber(settings.desktopOverlayOffsetY, 0, -4000, 4000);

    return {
        enabled: readBoolean(settings.desktopOverlayEnabled, false),
        visibilityMode: readEnum(settings.desktopOverlayVisibilityMode, ['attention_only', 'active_sessions', 'always_when_enabled'], 'attention_only'),
        showWhenRunning: readBoolean(settings.desktopOverlayShowWhenRunning, true),
        showWhenAttentionRequired: readBoolean(settings.desktopOverlayShowWhenAttentionRequired, true),
        showWhenReady: readBoolean(settings.desktopOverlayShowWhenReady, true),
        alwaysOnTop: readBoolean(settings.desktopOverlayAlwaysOnTop, true),
        autoHideEnabled: readBoolean(settings.desktopOverlayAutoHideEnabled, true),
        autoHideDelayMs: readNumber(settings.desktopOverlayAutoHideDelayMs, 6000, 1000, 120000),
        expandedBehavior: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.expandedBehavior,
        interactiveCollapsed: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.interactiveCollapsed,
        presentationMode: readEnum(settings.desktopOverlayPresentationMode, ['automatic', 'notch_integrated', 'floating_overlay'], 'automatic'),
        clickAction: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.clickAction,
        density: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.density,
        compactStyle: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.compactStyle,
        showSessionCount: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.showSessionCount,
        showPreviewText: readBoolean(settings.desktopOverlayShowPreviewText, false),
        placementMode,
        anchor: readEnum(settings.desktopOverlayAnchor, [
            'top_center',
            'top_left',
            'top_right',
            'bottom_center',
            'bottom_left',
            'bottom_right',
            'left_center',
            'right_center',
        ], 'top_center'),
        offsetX: placementMode === 'custom' ? offsetX : 0,
        offsetY: placementMode === 'custom' ? offsetY : 0,
        enableDragReposition: readBoolean(settings.desktopOverlayEnableDragReposition, false),
        lockPosition: readBoolean(settings.desktopOverlayLockPosition, true),
    };
}

export function resolveDesktopOverlaySettingsVisibilityState(
    policy: DesktopOverlayPolicy,
    hostMode: DesktopOverlayEffectiveHostMode = null,
): DesktopOverlaySettingsVisibilityState {
    const showOverlayConfiguration = policy.enabled;
    const effectiveHostMode = hostMode
        ?? (policy.presentationMode === 'notch_integrated'
            ? 'notch_integrated'
            : policy.presentationMode === 'floating_overlay'
                ? 'floating'
                : null);
    const showHostModeFallbackNotice = showOverlayConfiguration
        && effectiveHostMode === 'floating'
        && policy.presentationMode !== 'floating_overlay';
    const showFloatingPlacementControls = showOverlayConfiguration
        && (
            effectiveHostMode === 'floating'
            || (effectiveHostMode === null && policy.presentationMode === 'floating_overlay')
        );

    return {
        showOverlayConfiguration,
        showAttentionFilterControls: showOverlayConfiguration && policy.visibilityMode === 'attention_only',
        showAutoHideDelay: showOverlayConfiguration && policy.autoHideEnabled,
        showHostModeFallbackNotice,
        showFloatingPlacementControls,
        showCustomPlacementControls: showFloatingPlacementControls && policy.placementMode === 'custom',
    };
}
