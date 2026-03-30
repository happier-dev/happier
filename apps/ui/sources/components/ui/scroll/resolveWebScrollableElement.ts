export type WebScrollablePickStrategy = 'first' | 'best';

export type ResolveWebScrollableElementOptions = Readonly<{
    win: Window;
    maxDescendants?: number;
    pick?: WebScrollablePickStrategy;
    score?: (el: HTMLElement) => number;
    minOverflowPx?: number;
}>;

const DEFAULT_MAX_DESCENDANTS = 600;

function getComputedStyleSafe(win: Window, el: HTMLElement): CSSStyleDeclaration | null {
    try {
        return typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    } catch {
        return null;
    }
}

export function isWebElementScrollable(input: Readonly<{ el: HTMLElement; win: Window; minOverflowPx?: number }>): boolean {
    const style = getComputedStyleSafe(input.win, input.el);
    if (!style) return false;

    const threshold = typeof input.minOverflowPx === 'number' && Number.isFinite(input.minOverflowPx)
        ? Math.max(0, Math.floor(input.minOverflowPx))
        : 1;

    const overflowY = style.overflowY ?? style.overflow;
    const overflowX = style.overflowX ?? style.overflow;
    const canScrollY =
        (overflowY === 'auto' || overflowY === 'scroll') &&
        input.el.scrollHeight > input.el.clientHeight + threshold;
    const canScrollX =
        (overflowX === 'auto' || overflowX === 'scroll') &&
        input.el.scrollWidth > input.el.clientWidth + threshold;
    return canScrollY || canScrollX;
}

function defaultScrollScore(el: HTMLElement): number {
    const viewport = Math.max(el.clientHeight, 0);
    const verticalOverflow = Math.max(el.scrollHeight - el.clientHeight, 0);
    const horizontalOverflow = Math.max(el.scrollWidth - el.clientWidth, 0);
    return viewport * 1_000_000 + verticalOverflow + horizontalOverflow;
}

export function iterateWebDescendantElements(root: Element, input?: Readonly<{ maxNodes?: number }>): Iterable<HTMLElement> {
    const maxNodes = typeof input?.maxNodes === 'number' && Number.isFinite(input.maxNodes)
        ? Math.max(0, Math.floor(input.maxNodes))
        : DEFAULT_MAX_DESCENDANTS;

    function* generator(): Generator<HTMLElement> {
        if (maxNodes <= 0) return;
        const doc: any = (root as any).ownerDocument ?? (globalThis as any).document;
        if (typeof doc?.createTreeWalker === 'function') {
            // NodeFilter.SHOW_ELEMENT === 1; avoid referencing DOM typings in shared RN build.
            const walker: any = doc.createTreeWalker(root, 1);
            let visited = 0;
            let node: any = walker?.nextNode?.();
            while (node && visited < maxNodes) {
                if (node && typeof node === 'object') {
                    const el = node as HTMLElement;
                    yield el;
                }
                visited += 1;
                node = walker.nextNode();
            }
            return;
        }

        try {
            const descendants = Array.from((root as any).querySelectorAll?.('*') ?? []) as HTMLElement[];
            for (let i = 0; i < descendants.length && i < maxNodes; i += 1) {
                yield descendants[i]!;
            }
        } catch {
            // ignore
        }
    }

    return { [Symbol.iterator]: generator };
}

export function resolveWebScrollableElementWithin(
    root: HTMLElement,
    input: ResolveWebScrollableElementOptions,
): HTMLElement | null {
    const pick = input.pick ?? 'best';
    const score = input.score ?? defaultScrollScore;
    const maxDescendants =
        typeof input.maxDescendants === 'number' && Number.isFinite(input.maxDescendants)
            ? Math.max(0, Math.floor(input.maxDescendants))
            : DEFAULT_MAX_DESCENDANTS;

    let best: HTMLElement | null = null;
    let bestScore = -Infinity;

    const consider = (el: HTMLElement) => {
        if (!isWebElementScrollable({ el, win: input.win, minOverflowPx: input.minOverflowPx })) return false;
        if (pick === 'first') {
            best = el;
            return true;
        }
        const nextScore = score(el);
        if (!best || nextScore >= bestScore) {
            best = el;
            bestScore = nextScore;
        }
        return false;
    };

    if (consider(root) && pick === 'first') return best;

    for (const child of iterateWebDescendantElements(root, { maxNodes: maxDescendants })) {
        if (consider(child) && pick === 'first') return best;
    }

    return best;
}

export function resolveWebScrollableElement(
    root: HTMLElement,
    input: ResolveWebScrollableElementOptions & Readonly<{ maxAncestors?: number }>,
): HTMLElement | null {
    const maxAncestors =
        typeof input.maxAncestors === 'number' && Number.isFinite(input.maxAncestors)
            ? Math.max(0, Math.floor(input.maxAncestors))
            : 40;

    const within = resolveWebScrollableElementWithin(root, input);
    if (within) return within;

    let cursor: HTMLElement | null = root.parentElement;
    let steps = 0;
    while (cursor && steps < maxAncestors) {
        if (isWebElementScrollable({ el: cursor, win: input.win, minOverflowPx: input.minOverflowPx })) return cursor;
        cursor = cursor.parentElement;
        steps += 1;
    }
    return null;
}
