import type { RetainedPresentationRect } from './retainedPresentationSlots';

export function intersectRetainedPresentationRects(a: RetainedPresentationRect, b: RetainedPresentationRect): RetainedPresentationRect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
        height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

/**
 * A box a hidden host (a retained pane's `display: none`) reports as 0×0 is not a size: the node is not
 * rendered. This is the rule `patches/react-native-web@0.21.2.patch` (`useElementLayout`) applies to every
 * RN `onLayout`; owners that observe the DOM directly apply it here. A rendered 0×0 box still counts, and
 * an engine without `checkVisibility` keeps reporting as before.
 */
export function isUnrenderedLayoutBox(node: unknown, width: number, height: number): boolean {
    return width === 0 && height === 0 && typeof (node as { checkVisibility?: unknown } | null)?.checkVisibility === 'function'
        && !(node as { checkVisibility: () => boolean }).checkVisibility();
}

/** A finite ancestor motion that is still moving or fading the frame (an open, close or settle). */
function isFrameInMotion(animation: Animation): boolean {
    // A paused, idle or finished (filled) animation is not moving the frame.
    if (animation.playState && animation.playState !== 'running') return false;
    const end = animation.effect?.getComputedTiming?.().endTime;
    return typeof end !== 'number' || Number.isFinite(end);
}

/**
 * DOM measurement belongs to the platform boundary, not to the retained source. `settled` says the frame
 * the placeholder stands in is drawn where it was measured: fully opaque, with no finite motion running on
 * it. A frame that is invisible (a parked or entering pane) or mid-motion is not a place to paint the body.
 */
export function readWebRetainedPresentationGeometry(node: unknown): Readonly<{
    geometry: RetainedPresentationRect;
    clipGeometry: RetainedPresentationRect;
    settled: boolean;
}> | null {
    if (typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    const geometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    let clipGeometry = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    let settled = true;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        // The same walk reads the frame's paint state; an engine that reports no opacity draws it opaque.
        if (settled && style.opacity !== undefined && style.opacity !== '' && Number(style.opacity) < 1) settled = false;
        if (settled && parent.getAnimations?.().some(isFrameInMotion)) settled = false;
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow);
        const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow);
        if (!clipsX && !clipsY) continue;
        const bounds = parent.getBoundingClientRect();
        clipGeometry = intersectRetainedPresentationRects(clipGeometry, {
            x: clipsX ? bounds.x + parent.clientLeft : clipGeometry.x,
            y: clipsY ? bounds.y + parent.clientTop : clipGeometry.y,
            width: clipsX ? parent.clientWidth : clipGeometry.width,
            height: clipsY ? parent.clientHeight : clipGeometry.height,
        });
    }
    return { geometry, clipGeometry, settled };
}

/**
 * A fixed-size placeholder can move when hydration lays out an ancestor without
 * changing its parent-relative box. An enter transform also moves it without a
 * resize: measure again when the ancestor's compositor animation settles.
 */
export function observeWebRetainedPresentationLayout(node: unknown, measure: () => void): (() => void) | undefined {
    if (typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)
        || typeof ResizeObserver === 'undefined') return undefined;
    let active = true;
    const animations = new WeakSet<Animation>();
    const observeAnimations = () => {
        if (!active) return;
        for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
            for (const animation of ancestor.getAnimations?.() ?? []) {
                if (animations.has(animation)) continue;
                animations.add(animation);
                const settled = () => { if (active) { measure(); observeAnimations(); } };
                void animation.finished.then(settled, settled);
            }
        }
    };
    const observer = new ResizeObserver(() => { measure(); observeAnimations(); });
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor);
    // Ancestor layout effects can start the pane's animation after this child binds.
    queueMicrotask(observeAnimations);
    return () => { active = false; observer.disconnect(); };
}
