import type { FocusReturnTarget } from './focusReturn';

const WEB_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

export function listWebFocusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(WEB_FOCUSABLE_SELECTOR)).filter(
        isEligibleFocusTarget,
    );
}

export function isEligibleFocusTarget(target: FocusReturnTarget): target is HTMLElement {
    if (!canFocus(target)) return false;
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
    if (target.hidden || target.getAttribute('aria-hidden') === 'true') return false;
    if (target.getAttribute('aria-disabled') === 'true' || target.hasAttribute('disabled')) return false;
    if (target.closest('[hidden], [aria-hidden="true"], [inert]') != null) return false;

    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(target);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
    }

    return true;
}

function canFocus(target: FocusReturnTarget): target is HTMLElement {
    if (!target || typeof target !== 'object') return false;
    return typeof target.focus === 'function' && target.isConnected !== false;
}
