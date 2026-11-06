type WebFocusableElement = HTMLElement | SVGElement;

const WEB_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Shared web focus eligibility for panels, containment and focus return. */
export function listWebFocusableElements(container: HTMLElement): WebFocusableElement[] {
  return Array.from(container.querySelectorAll<WebFocusableElement>(WEB_FOCUSABLE_SELECTOR)).filter(isEligibleFocusTarget);
}

export function isEligibleFocusTarget(target: unknown): target is WebFocusableElement {
  const isHtmlElement = typeof HTMLElement !== 'undefined' && target instanceof HTMLElement;
  const isSvgElement = typeof SVGElement !== 'undefined' && target instanceof SVGElement;
  if (!isHtmlElement && !isSvgElement) return false;
  if (typeof target.focus !== 'function' || target.isConnected === false) return false;
  if (target.hasAttribute('hidden') || target.getAttribute('aria-hidden') === 'true') return false;
  if (target.getAttribute('aria-disabled') === 'true' || target.hasAttribute('disabled')) return false;
  if (target.closest('[hidden], [aria-hidden="true"], [inert]') != null) return false;

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(target);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}
