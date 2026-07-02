export function clampNumber(value: number, min: number, max: number): number {
    const effectiveMin = Math.min(min, max);
    return Math.max(effectiveMin, Math.min(max, value));
}

export function computeAvailableHeight(screenHeight: number, keyboardHeight: number, reservedHeight = 0): number {
    const safeScreen = Number.isFinite(screenHeight) ? screenHeight : 0;
    const safeKeyboard = Number.isFinite(keyboardHeight) ? keyboardHeight : 0;
    const safeReserved = Number.isFinite(reservedHeight) ? Math.max(0, reservedHeight) : 0;
    return Math.max(0, safeScreen - safeKeyboard - safeReserved);
}

export type AgentInputPanelMaxHeightMode = 'native-floating' | 'host-constrained';

export function resolveAgentInputHostPanelMaxHeight(params: {
    platform: string;
    maxPanelHeight?: number | null;
    mode?: AgentInputPanelMaxHeightMode;
}): number | undefined {
    if (typeof params.maxPanelHeight !== 'number' || !Number.isFinite(params.maxPanelHeight)) {
        return undefined;
    }
    if (params.platform === 'web' && params.mode !== 'host-constrained') {
        return undefined;
    }
    return Math.max(0, params.maxPanelHeight);
}

export function computeMeasuredPanelInputMaxHeight(params: {
    panelMaxHeight?: number | null;
    panelHeight?: number | null;
    inputContainerHeight?: number | null;
    inputContainerChromeHeight?: number | null;
    minimumFixedChromeHeight?: number | null;
    fallbackMaxHeight: number;
    fallbackMaxHeightMode?: 'cap' | 'seed';
}): number {
    const safePanelMaxHeight = Number.isFinite(params.panelMaxHeight) ? Math.max(0, params.panelMaxHeight ?? 0) : null;
    const safePanelHeight = Number.isFinite(params.panelHeight) ? Math.max(0, params.panelHeight ?? 0) : null;
    const safeInputContainerHeight = Number.isFinite(params.inputContainerHeight) ? Math.max(0, params.inputContainerHeight ?? 0) : null;
    const safeInputContainerChromeHeight = Number.isFinite(params.inputContainerChromeHeight)
        ? Math.max(0, params.inputContainerChromeHeight ?? 0)
        : 0;
    const safeMinimumFixedChromeHeight = Number.isFinite(params.minimumFixedChromeHeight)
        ? Math.max(0, params.minimumFixedChromeHeight ?? 0)
        : 0;
    if (
        safePanelMaxHeight == null
        || safePanelHeight == null
        || safeInputContainerHeight == null
    ) {
        return params.fallbackMaxHeight;
    }

    const measuredFixedChromeHeight = Math.max(0, safePanelHeight - safeInputContainerHeight);
    const fixedChromeHeight = Math.max(measuredFixedChromeHeight, safeMinimumFixedChromeHeight);
    const availableInputHeight = Math.max(0, Math.round(safePanelMaxHeight - fixedChromeHeight - safeInputContainerChromeHeight));
    const safeFallbackMaxHeight = Number.isFinite(params.fallbackMaxHeight)
        ? Math.max(0, params.fallbackMaxHeight)
        : availableInputHeight;
    const cappedInputHeight = params.fallbackMaxHeightMode === 'seed'
        ? availableInputHeight
        : Math.min(availableInputHeight, safeFallbackMaxHeight);
    return clampNumber(cappedInputHeight, Math.min(120, cappedInputHeight), cappedInputHeight);
}

const NEW_SESSION_WIZARD_COMPOSER_PANEL_MAX_HEIGHT = 360;
const NEW_SESSION_WIZARD_COMPOSER_PANEL_VIEWPORT_RATIO = 0.4;
const EXISTING_SESSION_COMPOSER_INPUT_COLLAPSED_VIEWPORT_RATIO = 0.25;
const EXISTING_SESSION_COMPOSER_INPUT_COLLAPSED_KEYBOARD_VIEWPORT_RATIO = 0.15;
const EXISTING_SESSION_COMPOSER_INPUT_EXPANDED_VIEWPORT_RATIO = 0.65;

export function computeExistingSessionComposerPanelMaxHeight(params: {
    availablePanelHeight?: number | null;
    viewportHeight?: number | null;
}): number | undefined {
    if (typeof params.availablePanelHeight !== 'number' || !Number.isFinite(params.availablePanelHeight) || params.availablePanelHeight <= 0) {
        return undefined;
    }

    const available = Math.max(0, Math.round(params.availablePanelHeight));
    if (available <= 0) return undefined;
    return available;
}

export function computeExistingSessionComposerInputMaxHeight(params: {
    availablePanelHeight?: number | null;
    expanded?: boolean;
    keyboardHeight?: number | null;
    viewportHeight?: number | null;
}): number | undefined {
    const keyboardVisible = typeof params.keyboardHeight === 'number'
        && Number.isFinite(params.keyboardHeight)
        && params.keyboardHeight > 0;
    const viewportRatio = params.expanded === true
        ? EXISTING_SESSION_COMPOSER_INPUT_EXPANDED_VIEWPORT_RATIO
        : keyboardVisible
            ? EXISTING_SESSION_COMPOSER_INPUT_COLLAPSED_KEYBOARD_VIEWPORT_RATIO
            : EXISTING_SESSION_COMPOSER_INPUT_COLLAPSED_VIEWPORT_RATIO;
    const viewportCap = typeof params.viewportHeight === 'number'
        && Number.isFinite(params.viewportHeight)
        && params.viewportHeight > 0
        ? Math.max(0, Math.round(params.viewportHeight * viewportRatio))
        : undefined;

    if (typeof params.availablePanelHeight !== 'number' || !Number.isFinite(params.availablePanelHeight) || params.availablePanelHeight <= 0) {
        return viewportCap && viewportCap > 0 ? viewportCap : undefined;
    }

    const available = Math.max(0, Math.round(params.availablePanelHeight));
    if (available <= 0) return viewportCap && viewportCap > 0 ? viewportCap : undefined;
    return Math.min(available, viewportCap ?? available);
}

export function computeNewSessionComposerPanelMaxHeight(params: {
    mode: 'simple' | 'wizard';
    availablePanelHeight?: number | null;
    reservedHeight?: number;
    viewportHeight?: number | null;
}): number | undefined {
    if (typeof params.availablePanelHeight !== 'number' || !Number.isFinite(params.availablePanelHeight) || params.availablePanelHeight <= 0) {
        return undefined;
    }
    const safeReservedHeight = Number.isFinite(params.reservedHeight)
        ? Math.max(0, Math.round(params.reservedHeight ?? 0))
        : 0;
    const available = Math.max(0, Math.round(params.availablePanelHeight) - safeReservedHeight);
    if (available <= 0) return undefined;

    const viewportCap = typeof params.viewportHeight === 'number'
        && Number.isFinite(params.viewportHeight)
        && params.viewportHeight > 0
        ? Math.max(0, Math.round(params.viewportHeight * NEW_SESSION_WIZARD_COMPOSER_PANEL_VIEWPORT_RATIO))
        : available;
    const capped = params.mode === 'wizard'
        ? Math.min(available, NEW_SESSION_WIZARD_COMPOSER_PANEL_MAX_HEIGHT, viewportCap)
        : available;
    return clampNumber(capped, 120, capped);
}

export function computeAgentInputDefaultMaxHeight(params: {
    platform: string;
    screenHeight: number;
    keyboardHeight: number;
}): number {
    const available = computeAvailableHeight(params.screenHeight, params.keyboardHeight);
    if (params.platform === 'web') {
        return clampNumber(Math.round(available * 0.75), 200, 900);
    }
    return clampNumber(Math.round(available * 0.4), 120, 360);
}

export function computeNewSessionInputMaxHeight(params: {
    useEnhancedSessionWizard: boolean;
    screenHeight: number;
    keyboardHeight: number;
    reservedHeight?: number;
}): number {
    const available = computeAvailableHeight(
        params.screenHeight,
        params.keyboardHeight,
        params.reservedHeight ?? 0,
    );
    const keyboardVisible = params.keyboardHeight > 0;
    const ratio = params.useEnhancedSessionWizard
        ? 0.25
        : keyboardVisible
            ? 0.75
            : 0.75;
    const cap = params.useEnhancedSessionWizard
        ? 240
        : keyboardVisible
            ? 360
            : 900;
    return clampNumber(Math.round(available * ratio), 120, cap);
}

export function computeAgentInputKeyboardOpenPanelMaxHeight(params: {
    screenHeight: number;
    keyboardHeight: number;
}): number | undefined {
    const available = computeAvailableHeight(params.screenHeight, params.keyboardHeight);
    if (available <= 0 || params.keyboardHeight <= 0) return undefined;
    const availablePanelHeight = Math.max(0, Math.round(available - 16));
    return clampNumber(availablePanelHeight, 220, Math.min(680, availablePanelHeight));
}

export function computeAgentInputKeyboardOpenVariableSectionMaxHeight(params: {
    panelMaxHeight: number;
    footerHeight: number;
}): number {
    const safePanel = Number.isFinite(params.panelMaxHeight) ? Math.max(0, params.panelMaxHeight) : 0;
    const safeFooter = Number.isFinite(params.footerHeight) ? Math.max(0, Math.trunc(params.footerHeight)) : 0;
    const availableVariableSectionHeight = Math.max(0, safePanel - safeFooter);
    return clampNumber(availableVariableSectionHeight, 120, availableVariableSectionHeight);
}
