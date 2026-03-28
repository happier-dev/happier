export const MOBILE_LAYOUT_WEB_BREAKPOINT_PX = 768;

export function isMobileLayoutWidth(windowWidth: number): boolean {
    return windowWidth < MOBILE_LAYOUT_WEB_BREAKPOINT_PX;
}
