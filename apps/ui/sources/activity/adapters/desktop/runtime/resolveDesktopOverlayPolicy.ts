export type DesktopOverlayVisibilityMode = 'attention_only' | 'active_sessions' | 'always_when_enabled';
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
    showAutoHideDelay: boolean;
    showCollapsedClickAction: boolean;
    showExpandedBehavior: boolean;
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
    return {
        enabled: readBoolean(settings.desktopOverlayEnabled, false),
        visibilityMode: readEnum(settings.desktopOverlayVisibilityMode, ['attention_only', 'active_sessions', 'always_when_enabled'], 'attention_only'),
        showWhenRunning: readBoolean(settings.desktopOverlayShowWhenRunning, true),
        showWhenAttentionRequired: readBoolean(settings.desktopOverlayShowWhenAttentionRequired, true),
        showWhenReady: readBoolean(settings.desktopOverlayShowWhenReady, true),
        alwaysOnTop: readBoolean(settings.desktopOverlayAlwaysOnTop, true),
        autoHideEnabled: readBoolean(settings.desktopOverlayAutoHideEnabled, true),
        autoHideDelayMs: readNumber(settings.desktopOverlayAutoHideDelayMs, 6000, 1000, 120000),
        expandedBehavior: readEnum(settings.desktopOverlayExpandedBehavior, ['click', 'hover'], 'click'),
        interactiveCollapsed: readBoolean(settings.desktopOverlayInteractiveCollapsed, true),
        clickAction: readEnum(settings.desktopOverlayClickAction, ['expand_overlay', 'open_primary_session', 'open_sessions'], 'expand_overlay'),
        density: readEnum(settings.desktopOverlayDensity, ['compact', 'comfortable'], 'compact'),
        compactStyle: readEnum(settings.desktopOverlayCompactStyle, ['pill', 'panel'], 'pill'),
        showSessionCount: readBoolean(settings.desktopOverlayShowSessionCount, true),
        showPreviewText: readBoolean(settings.desktopOverlayShowPreviewText, false),
        placementMode: readEnum(settings.desktopOverlayPlacementMode, ['anchored', 'custom'], 'anchored'),
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
        offsetX: readNumber(settings.desktopOverlayOffsetX, 0, -4000, 4000),
        offsetY: readNumber(settings.desktopOverlayOffsetY, 0, -4000, 4000),
        enableDragReposition: readBoolean(settings.desktopOverlayEnableDragReposition, false),
        lockPosition: readBoolean(settings.desktopOverlayLockPosition, true),
    };
}

export function resolveDesktopOverlaySettingsVisibilityState(
    policy: DesktopOverlayPolicy,
): DesktopOverlaySettingsVisibilityState {
    const showOverlayConfiguration = policy.enabled;
    const showCollapsedClickAction = showOverlayConfiguration && policy.interactiveCollapsed;

    return {
        showOverlayConfiguration,
        showAutoHideDelay: showOverlayConfiguration && policy.autoHideEnabled,
        showCollapsedClickAction,
        showExpandedBehavior: showCollapsedClickAction && policy.clickAction === 'expand_overlay',
        showCustomPlacementControls: showOverlayConfiguration && policy.placementMode === 'custom',
    };
}
