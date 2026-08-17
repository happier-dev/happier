import { AccessibilityInfo, Platform } from 'react-native';

const WEB_LIVE_REGION_ATTRIBUTE = 'data-happier-live-region';
/**
 * Screen readers ignore a live region whose text is set in the same frame it is
 * created, and they re-announce only when the text actually changes. Clearing
 * first and writing on the next tick makes repeated identical messages audible.
 */
const WEB_LIVE_REGION_SETTLE_MS = 30;

function ensureWebLiveRegion(doc: Document): HTMLElement {
    const existing = doc.querySelector<HTMLElement>(`[${WEB_LIVE_REGION_ATTRIBUTE}="true"]`);
    if (existing) return existing;
    const region = doc.createElement('div');
    region.setAttribute(WEB_LIVE_REGION_ATTRIBUTE, 'true');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.style.position = 'absolute';
    region.style.left = '-10000px';
    region.style.width = '1px';
    region.style.height = '1px';
    region.style.overflow = 'hidden';
    doc.body.appendChild(region);
    return region;
}

/**
 * Canonical polite screen-reader announcement for a change the user caused but
 * cannot see, such as a selection applied by a surface that then closes.
 *
 * Native uses the platform announcement API; web uses one shared visually hidden
 * `aria-live="polite"` region. Announcements are best effort and never throw.
 */
export function announceAccessibilityMessage(message: string): void {
    const announcement = message.trim();
    if (!announcement) return;

    if (Platform.OS === 'web') {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc?.body) return;
        const region = ensureWebLiveRegion(doc);
        region.textContent = '';
        setTimeout(() => {
            region.textContent = announcement;
        }, WEB_LIVE_REGION_SETTLE_MS);
        return;
    }

    try {
        AccessibilityInfo.announceForAccessibility?.(announcement);
    } catch {
        // Accessibility announcements are best effort.
    }
}
