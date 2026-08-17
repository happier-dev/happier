import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';

/**
 * Returns whether the current webview is one of the dedicated desktop
 * presenter windows. These windows consume state projected by the main
 * webview and must not boot app-owned runtimes of their own.
 */
export function isDesktopOverlayWindowContext(): boolean {
    return isDesktopActivityOverlayWindowContext()
        || isDesktopPetOverlayWindowContext();
}
