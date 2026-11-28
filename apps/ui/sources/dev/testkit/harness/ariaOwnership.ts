/**
 * What axe 4.10's `aria-required-children` sees under a composite (a tree, a grid): the elements it owns are its
 * nearest descendants that expose a role, a global ARIA attribute (`aria-busy`, `aria-label`, ...) or a tab stop.
 * Generic and presentational wrappers are walked through, and so is a `group` the composite allows. Each owned
 * element whose role is not allowed is a violation, named by its test id (or its role and text).
 */
export function ariaOwnedChildViolations(
  composite: Element,
  allowedRoles: readonly string[],
): string[] {
  const allowed = new Set(allowedRoles);
  const violations: string[] = [];
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (child.getAttribute('aria-hidden') === 'true') continue;
      const role = roleOf(child);
      const exposed =
        role !== null || hasGlobalAria(child) || child.hasAttribute('tabindex');
      if (
        !exposed ||
        role === 'presentation' ||
        role === 'none' ||
        (role === 'group' && allowed.has('group'))
      ) {
        visit(child);
        continue;
      }
      if (role === null || !allowed.has(role)) {
        violations.push(
          child.getAttribute('data-testid') ??
            `${role ?? child.tagName.toLowerCase()}: ${child.textContent?.slice(0, 24) ?? ''}`,
        );
      }
    }
  };
  visit(composite);
  return violations;
}

/** axe `aria-prohibited-attr`: an element with no role (a generic div) cannot be named with `aria-label`. */
export function ariaProhibitedLabelViolations(root: Element): string[] {
  return [...root.querySelectorAll('[aria-label]')]
    .filter((element) => roleOf(element) === null)
    .map(
      (element) =>
        element.getAttribute('data-testid') ??
        element.getAttribute('aria-label') ??
        '',
    );
}

/** The role an element exposes: its explicit role, else the implicit role of the few hosts a row renders. */
function roleOf(element: Element): string | null {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.split(' ')[0]!;
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listitem';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return tag;
  return null;
}

const GLOBAL_ARIA_ATTRIBUTES = [
  'aria-busy',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-live',
  'aria-owns',
  'aria-controls',
  'aria-details',
  'aria-keyshortcuts',
  'aria-roledescription',
] as const;

function hasGlobalAria(element: Element): boolean {
  return GLOBAL_ARIA_ATTRIBUTES.some((name) => element.hasAttribute(name));
}
