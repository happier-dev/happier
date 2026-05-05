export type DesktopOverlayVisibilityMode = 'attention_only' | 'active_sessions' | 'always_when_enabled';
export type DesktopOverlayPresentationMode = 'automatic' | 'notch_integrated' | 'floating_overlay';
export type DesktopOverlayDisplayMode = 'automatic' | 'focused' | 'main' | 'built_in';
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
export type DesktopOverlayHoverExpandDelay = 'instant' | 'normal' | 'slow';
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
    hoverExpandDelayMs?: number;
    expandedBehavior: DesktopOverlayExpandedBehavior;
    interactiveCollapsed: boolean;
    presentationMode: DesktopOverlayPresentationMode;
    displayMode?: DesktopOverlayDisplayMode;
    clickAction: DesktopOverlayClickAction;
    density: DesktopOverlayDensity;
    compactStyle: DesktopOverlayCompactStyle;
    showSessionCount: boolean;
    showPreviewText: boolean;
    collapsedCarouselEnabled?: boolean;
    quickReplyPhrases: readonly string[];
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

// Legacy local setting keys for these fields still parse for compatibility, but
// the active overlay pins them to the product defaults while old controls stay hidden.
const DESKTOP_OVERLAY_HOVER_EXPAND_DELAY_MS_BY_MODE = {
    instant: 0,
    normal: 500,
    slow: 1000,
} as const satisfies Record<DesktopOverlayHoverExpandDelay, number>;

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

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function readQuickReplyPhrases(value: unknown): readonly string[] {
    const defaultPhrases = ['Continue', 'OK', 'Explain', 'Retry'];
    if (!Array.isArray(value)) {
        return defaultPhrases;
    }
    const phrases = value
        .filter((phrase): phrase is string => typeof phrase === 'string')
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length > 0)
        .slice(0, 6);
    return phrases.length > 0 ? phrases : defaultPhrases;
}

function readHoverExpandDelayMs(value: unknown): number {
    const mode = readEnum(
        value,
        ['instant', 'normal', 'slow'] as const,
        'normal',
    );
    return DESKTOP_OVERLAY_HOVER_EXPAND_DELAY_MS_BY_MODE[mode];
}

export function resolveDesktopOverlayPolicy(settings: Readonly<Record<string, unknown>>): DesktopOverlayPolicy {
    const placementMode = readEnum(settings.desktopOverlayPlacementMode, ['anchored', 'custom'], 'anchored');
    const offsetX = readNumber(settings.desktopOverlayOffsetX, 0, -4000, 4000);
    const offsetY = readNumber(settings.desktopOverlayOffsetY, 0, -4000, 4000);
    const attentionDeviceOverrides = readRecord(settings.attentionDeviceOverridesV1);
    const desktopOverlayOverrides = readRecord(attentionDeviceOverrides.desktopOverlay);

    return {
        enabled: readBoolean(settings.desktopOverlayEnabled, false),
        visibilityMode: readEnum(settings.desktopOverlayVisibilityMode, ['attention_only', 'active_sessions', 'always_when_enabled'], 'attention_only'),
        showWhenRunning: readBoolean(settings.desktopOverlayShowWhenRunning, true),
        showWhenAttentionRequired: readBoolean(settings.desktopOverlayShowWhenAttentionRequired, true),
        showWhenReady: readBoolean(settings.desktopOverlayShowWhenReady, true),
        alwaysOnTop: readBoolean(settings.desktopOverlayAlwaysOnTop, true),
        autoHideEnabled: readBoolean(settings.desktopOverlayAutoHideEnabled, true),
        autoHideDelayMs: readNumber(settings.desktopOverlayAutoHideDelayMs, 6000, 1000, 120000),
        hoverExpandDelayMs: readHoverExpandDelayMs(desktopOverlayOverrides.hoverExpandDelay),
        expandedBehavior: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.expandedBehavior,
        interactiveCollapsed: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.interactiveCollapsed,
        presentationMode: readEnum(settings.desktopOverlayPresentationMode, ['automatic', 'notch_integrated', 'floating_overlay'], 'automatic'),
        displayMode: readEnum(settings.desktopOverlayDisplayMode, ['automatic', 'focused', 'main', 'built_in'] as const, 'automatic'),
        clickAction: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.clickAction,
        density: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.density,
        compactStyle: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.compactStyle,
        showSessionCount: DESKTOP_OVERLAY_FIXED_PRODUCT_DEFAULTS.showSessionCount,
        showPreviewText: readBoolean(settings.desktopOverlayShowPreviewText, false),
        collapsedCarouselEnabled: readBoolean(desktopOverlayOverrides.collapsedCarouselEnabled, true),
        quickReplyPhrases: readQuickReplyPhrases(desktopOverlayOverrides.quickReplyPhrases),
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
