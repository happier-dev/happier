import { vi } from 'vitest';

/** jsdom has no physical scroll extent; the installed Legend runtime remains real. */
export function installClampedWebScrollGeometry(physicalExtent = Number.POSITIVE_INFINITY): void {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')!.get!;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return Math.min(physicalExtent, Reflect.apply(scrollHeight, this, []) as number);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number) {
        const top = typeof options === 'object' ? options.top ?? 0 : 0;
        this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
        this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
        configurable: true,
        value(this: HTMLElement, options: ScrollToOptions) {
            this.scrollTo({ top: this.scrollTop + (options.top ?? 0) });
        },
    });
}

/** Read the real virtualizer's DOM placement instead of treating a pinned row as visible. */
export function readVirtualizedWebRowTop(row: HTMLElement, scroller: HTMLElement): number {
    let top = 0;
    for (let node: HTMLElement | null = row; node && node !== scroller; node = node.parentElement) {
        top += Number.parseFloat(node.style.top) || 0;
    }
    return top - scroller.scrollTop;
}
