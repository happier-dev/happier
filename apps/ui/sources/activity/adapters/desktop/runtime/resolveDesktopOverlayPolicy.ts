import { AttentionDeviceOverridesV1Schema } from '@/sync/domains/settings/attentionDeviceOverridesV1';

export type DesktopOverlayVisibilityMode = 'attention_only' | 'active_sessions' | 'always_when_enabled';
export type DesktopOverlayDisplayMode = 'automatic' | 'main' | 'built_in' | `named:${string}`;
/** The screen edge the notch docks to, or Floating anywhere on the display. */
export type DesktopOverlayDock = 'top' | 'left' | 'right' | 'floating';
/** What the notch shows when nothing needs you: a tip, the standard notch, or nothing. */
export type DesktopOverlayIdle = 'tip' | 'full' | 'hidden';
export type DesktopOverlayHoverExpandDelay = 'instant' | 'normal' | 'slow';

export type DesktopOverlayPolicy = Readonly<{
    enabled: boolean;
    visibilityMode: DesktopOverlayVisibilityMode;
    alwaysOnTop: boolean;
    hoverExpandDelayMs: number;
    dock: DesktopOverlayDock;
    idle: DesktopOverlayIdle;
    /** Where a face or Bot-row click opens that Bot's conversation (N4's "Open Bot conversations"). */
    botConversationPresentation: 'overlay' | 'window';
    displayMode?: DesktopOverlayDisplayMode;
    quickReplyPhrases: readonly string[];
}>;


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

function readHoverExpandDelayMs(value: unknown): number {
    const mode = readEnum(
        value,
        ['instant', 'normal', 'slow'] as const,
        'normal',
    );
    return DESKTOP_OVERLAY_HOVER_EXPAND_DELAY_MS_BY_MODE[mode];
}

export function resolveDesktopOverlayPolicy(settings: Readonly<Record<string, unknown>>): DesktopOverlayPolicy {
    const desktopOverlayOverrides = AttentionDeviceOverridesV1Schema.parse(settings.attentionDeviceOverridesV1).desktopOverlay;

    return {
        enabled: readBoolean(settings.desktopOverlayEnabled, false),
        visibilityMode: readEnum(settings.desktopOverlayVisibilityMode, ['attention_only', 'active_sessions', 'always_when_enabled'], 'attention_only'),
        alwaysOnTop: readBoolean(settings.desktopOverlayAlwaysOnTop, true),
        hoverExpandDelayMs: readHoverExpandDelayMs(desktopOverlayOverrides.hoverExpandDelay),
        dock: readEnum(settings.desktopOverlayDock, ['top', 'left', 'right', 'floating'] as const, 'top'),
        idle: readEnum(settings.desktopOverlayIdle, ['tip', 'full', 'hidden'] as const, 'tip'),
        botConversationPresentation: readEnum(settings.desktopBotConversationPresentation, ['overlay', 'window'] as const, 'overlay'),
        displayMode: typeof settings.desktopOverlayDisplayMode === 'string'
            && settings.desktopOverlayDisplayMode.startsWith('named:')
            && settings.desktopOverlayDisplayMode.length > 'named:'.length
            ? settings.desktopOverlayDisplayMode as DesktopOverlayDisplayMode
            : readEnum(settings.desktopOverlayDisplayMode, ['automatic', 'main', 'built_in'] as const, 'automatic'),
        quickReplyPhrases: desktopOverlayOverrides.quickReplyPhrases,
    };
}
