export const WIZARD_FULLSCREEN_MAX_WIDTH_PX = 430;

export function shouldUseWizardFullscreenPresentation(windowWidth: number): boolean {
    return Number.isFinite(windowWidth) && windowWidth > 0 && windowWidth <= WIZARD_FULLSCREEN_MAX_WIDTH_PX;
}
