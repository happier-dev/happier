/**
 * Theme tokens mirrored 1:1 from apps/ui/sources/theme.ts.
 *
 * IMPORTANT: do not invent colors here. When apps/ui adds or renames a token,
 * update this file to match. The phone demo in apps/website must render
 * Happier's real light/dark palette so it looks identical to the real app —
 * not a custom lookalike.
 *
 * Tokens are exported two ways:
 *   - as TypeScript constants (for JS that needs the raw values)
 *   - as CSS custom property names (resolved at runtime from global.css)
 *
 * Prefer the CSS var form in components so light/dark switching is automatic:
 *     style={{ color: 'var(--fg-primary)' }}
 *     className="text-[color:var(--fg-primary)]"
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared scales (theme-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

export const spacing = {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
} as const;

export const radius = {
    sm: 4,
    md: 8,
    lg: 10,
    xl: 12,
    modalCard: 14,
    xxl: 16,
} as const;

export const iconSize = {
    small: 12,
    medium: 16,
    large: 20,
    xlarge: 24,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Real apps/ui light theme (iOS variants chosen where Platform.select split)
// ─────────────────────────────────────────────────────────────────────────────

export const lightTokens = {
    // Surfaces
    bg: '#ffffff',
    bgElevated: '#F8F8F8',
    bgSurfaceHigh: '#F8F8F8',
    bgSurfaceHighest: '#f0f0f0',
    bgGrouped: '#F5F5F5',

    // Borders / dividers
    divider: '#eaeaea',
    borderSubtle: 'rgba(0, 0, 0, 0.06)',
    borderStrong: 'rgba(0, 0, 0, 0.12)',

    // Text
    fgPrimary: '#000000',
    fgSecondary: '#6c6c70',
    fgTertiary: '#99999d',
    fgLink: '#2BACCC',
    fgDestructive: '#FF3B30',

    // Accents
    accentBlue: '#007AFF',
    accentGreen: '#34C759',
    accentOrange: '#FF9500',
    accentYellow: '#FFCC00',
    accentRed: '#FF3B30',
    accentIndigo: '#5856D6',
    accentPurple: '#AF52DE',

    // Status
    statusConnected: '#34C759',
    statusConnecting: '#007AFF',
    statusActionRequired: '#FF9500',
    statusDisconnected: '#999999',
    statusError: '#FF3B30',
    statusDefault: '#8E8E93',

    // Messages (transcript bubbles)
    userMessageBg: '#f0eee6',
    userMessageText: '#000000',
    agentMessageText: '#000000',
    agentEventText: '#666666',

    // Permission buttons
    permissionAllowBg: '#34C759',
    permissionAllowText: '#FFFFFF',
    permissionDenyBg: '#FF3B30',
    permissionDenyText: '#FFFFFF',
    permissionAllowAllBg: '#007AFF',
    permissionInactiveBg: '#E5E5EA',
    permissionInactiveBorder: '#D1D1D6',
    permissionInactiveText: '#8E8E93',

    // Warnings / errors
    warningBoxBg: '#FFF8F0',
    warningBoxBorder: '#FF9500',
    warningBoxText: '#FF9500',
    errorBoxBg: '#FFF0F0',
    errorBoxBorder: '#FF3B30',
    errorBoxText: '#FF3B30',

    // Inputs
    inputBg: '#F5F5F5',
    inputText: '#000000',
    inputPlaceholder: '#999999',

    // Terminal surface (matches app — same in both themes)
    terminalBg: '#1E1E1E',
    terminalPrompt: '#34C759',
    terminalText: '#E0E0E0',
    terminalStderr: '#FFB86C',
    terminalError: '#FF5555',

    // Diff
    diffAddedBg: '#E6FFED',
    diffAddedBorder: '#34D058',
    diffRemovedBg: '#FFEEF0',
    diffRemovedBorder: '#D73A49',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Real apps/ui dark theme (iOS variants)
// ─────────────────────────────────────────────────────────────────────────────

export const darkTokens = {
    // Surfaces
    bg: '#18171C',
    bgElevated: '#2C2C2E',
    bgSurfaceHigh: '#2C2C2E',
    bgSurfaceHighest: '#38383A',
    bgGrouped: '#1C1C1E',

    // Borders / dividers
    divider: '#38383A',
    borderSubtle: 'rgba(255, 255, 255, 0.06)',
    borderStrong: 'rgba(255, 255, 255, 0.12)',

    // Text
    fgPrimary: '#ffffff',
    fgSecondary: '#99999d',
    fgTertiary: '#747478',
    fgLink: '#2BACCC',
    fgDestructive: '#FF453A',

    // Accents (iOS dark variants)
    accentBlue: '#0A84FF',
    accentGreen: '#32D74B',
    accentOrange: '#FF9F0A',
    accentYellow: '#FFD60A',
    accentRed: '#FF453A',
    accentIndigo: '#5E5CE6',
    accentPurple: '#BF5AF2',

    // Status
    statusConnected: '#34C759',
    statusConnecting: '#FFFFFF',
    statusActionRequired: '#FF9F0A',
    statusDisconnected: '#8E8E93',
    statusError: '#FF453A',
    statusDefault: '#8E8E93',

    // Messages (transcript bubbles) — from theme.ts dark variant
    userMessageBg: '#2C2C2E',
    userMessageText: '#FFFFFF',
    agentMessageText: '#FFFFFF',
    agentEventText: '#8E8E93',

    // Permission buttons (dark)
    permissionAllowBg: '#32D74B',
    permissionAllowText: '#FFFFFF',
    permissionDenyBg: '#FF453A',
    permissionDenyText: '#FFFFFF',
    permissionAllowAllBg: '#0A84FF',
    permissionInactiveBg: '#2C2C2E',
    permissionInactiveBorder: '#38383A',
    permissionInactiveText: '#8E8E93',

    // Warnings / errors
    warningBoxBg: 'rgba(255, 159, 10, 0.15)',
    warningBoxBorder: '#FF9F0A',
    warningBoxText: '#FFAB00',
    errorBoxBg: 'rgba(255, 69, 58, 0.15)',
    errorBoxBorder: '#FF453A',
    errorBoxText: '#FF6B6B',

    // Inputs
    inputBg: '#1C1C1E',
    inputText: '#FFFFFF',
    inputPlaceholder: '#8E8E93',

    // Terminal surface (shared)
    terminalBg: '#1E1E1E',
    terminalPrompt: '#32D74B',
    terminalText: '#E0E0E0',
    terminalStderr: '#FFB86C',
    terminalError: '#FF6B6B',

    // Diff
    diffAddedBg: '#0D2E1F',
    diffAddedBorder: '#3FB950',
    diffRemovedBg: '#3F1B23',
    diffRemovedBorder: '#F85149',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// CSS variable name map (same keys, but pointing at CSS custom properties).
// Use these in JSX so the component automatically reflects the active theme.
// ─────────────────────────────────────────────────────────────────────────────

type TokenKey = keyof typeof darkTokens;
type CssVarMap = { readonly [K in TokenKey]: string };

const toCssVarName = (key: TokenKey): string =>
    `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;

const buildCssVars = (): CssVarMap => {
    const result: Record<string, string> = {};
    for (const key of Object.keys(darkTokens) as TokenKey[]) {
        result[key] = `var(${toCssVarName(key)})`;
    }
    return result as CssVarMap;
};

export const cssVars = buildCssVars();

/**
 * Maps a TokenKey to the CSS custom property NAME (without `var(...)`).
 * Useful when generating the CSS block that sets values per theme.
 */
export const cssVarName = toCssVarName;

// ─────────────────────────────────────────────────────────────────────────────
// Back-compat — existing imports still work
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated use darkTokens / lightTokens instead */
export const dark = {
    bg: darkTokens.bg,
    bgElevated: darkTokens.bgElevated,
    bgSurface: darkTokens.bgElevated,
    bgSurfaceHigh: darkTokens.bgSurfaceHigh,
    border: darkTokens.borderSubtle,
    borderStrong: darkTokens.borderStrong,
    text: darkTokens.fgPrimary,
    textSecondary: darkTokens.fgSecondary,
    textTertiary: darkTokens.fgTertiary,
    textLink: darkTokens.fgLink,
    divider: darkTokens.borderSubtle,
} as const;

/** @deprecated use lightTokens instead */
export const light = {
    bg: lightTokens.bg,
    bgElevated: lightTokens.bgElevated,
    bgSurface: lightTokens.bgSurfaceHigh,
    bgSurfaceHigh: lightTokens.bgSurfaceHighest,
    border: lightTokens.borderSubtle,
    borderStrong: lightTokens.borderStrong,
    text: lightTokens.fgPrimary,
    textSecondary: lightTokens.fgSecondary,
    textTertiary: lightTokens.fgTertiary,
    textLink: lightTokens.fgLink,
    divider: lightTokens.divider,
} as const;

/** @deprecated use lightTokens / darkTokens accent fields instead */
export const accent = {
    blue: lightTokens.accentBlue,
    green: lightTokens.accentGreen,
    orange: lightTokens.accentOrange,
    yellow: lightTokens.accentYellow,
    red: lightTokens.accentRed,
    indigo: lightTokens.accentIndigo,
    purple: lightTokens.accentPurple,
} as const;

/** @deprecated use lightTokens / darkTokens permission* fields */
export const permissionColor = {
    default: '#8E8E93',
    acceptEdits: lightTokens.accentBlue,
    bypass: lightTokens.accentOrange,
    plan: lightTokens.accentGreen,
    readOnly: '#8B8B8D',
    safeYolo: '#FF6B35',
    yolo: '#DC143C',
} as const;

/** @deprecated use permissionAllowBg / permissionDenyBg instead */
export const permissionButton = {
    allow: { bg: lightTokens.permissionAllowBg, text: lightTokens.permissionAllowText },
    deny: { bg: lightTokens.permissionDenyBg, text: lightTokens.permissionDenyText },
    allowAll: { bg: lightTokens.permissionAllowAllBg, text: '#FFFFFF' },
} as const;

/** @deprecated */
export const statusColor = {
    connected: lightTokens.statusConnected,
    connecting: lightTokens.statusConnecting,
    actionRequired: lightTokens.statusActionRequired,
    disconnected: lightTokens.statusDisconnected,
    error: lightTokens.statusError,
} as const;

/** @deprecated use lightTokens / darkTokens diff fields */
export const diff = {
    outline: '#E0E0E0',
    addedBg: lightTokens.diffAddedBg,
    addedBorder: lightTokens.diffAddedBorder,
    removedBg: lightTokens.diffRemovedBg,
    removedBorder: lightTokens.diffRemovedBorder,
    contextBg: '#F6F8FA',
    lineNumberText: '#959DA5',
    hunkHeaderBg: '#F1F8FF',
    hunkHeaderText: '#005CC5',
    inlineAddedBg: '#ACFFA6',
    inlineRemovedBg: '#FFCECB',
} as const;

/** @deprecated use lightTokens.userMessageBg etc. */
export const message = {
    userBackground: lightTokens.userMessageBg,
    userText: lightTokens.userMessageText,
    agentText: lightTokens.agentMessageText,
    agentEvent: lightTokens.agentEventText,
} as const;
