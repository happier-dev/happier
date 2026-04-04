export function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function computeAvailableHeight(screenHeight: number, keyboardHeight: number): number {
    const safeScreen = Number.isFinite(screenHeight) ? screenHeight : 0;
    const safeKeyboard = Number.isFinite(keyboardHeight) ? keyboardHeight : 0;
    return Math.max(0, safeScreen - safeKeyboard);
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
}): number {
    const available = computeAvailableHeight(params.screenHeight, params.keyboardHeight);
    const keyboardVisible = params.keyboardHeight > 0;
    const ratio = params.useEnhancedSessionWizard
        ? 0.25
        : keyboardVisible
            ? 0.5
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
    return clampNumber(Math.round(available - 16), 220, 680);
}

export function computeAgentInputKeyboardOpenVariableSectionMaxHeight(params: {
    panelMaxHeight: number;
    footerHeight: number;
}): number {
    const safePanel = Number.isFinite(params.panelMaxHeight) ? Math.max(0, params.panelMaxHeight) : 0;
    const safeFooter = Number.isFinite(params.footerHeight) ? Math.max(0, Math.trunc(params.footerHeight)) : 0;
    return clampNumber(safePanel - safeFooter, 120, safePanel || 120);
}
