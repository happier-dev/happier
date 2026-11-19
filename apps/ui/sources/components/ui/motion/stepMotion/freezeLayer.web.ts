import { inkMapFromBoxes } from '@happier-dev/brand/glyph-scene';

import { captureElementFlightRect } from '../rectFlight';
import { findWebStepAnchor } from './capturePressedElement.web';
import type { StepAnchor, StepFreeze, StepGrid, StepMotionLayerHandle } from './stepMotionTypes';

const paintedContent = '[role="heading"], [role="button"], button, input, textarea, img, svg';

function ownsPaint(element: Element) {
    if (element.matches(paintedContent)) return true;
    if (Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return true;
    const style = getComputedStyle(element);
    const fill = style.backgroundColor;
    return (fill && fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)')
        || style.backgroundImage !== 'none' && style.backgroundImage !== ''
        || Number.parseFloat(style.borderTopWidth) > 0;
}

export function readStepLeaves(root: HTMLElement, grid: StepGrid) {
    const painted = new Set<Element>();
    const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
    const leaves = elements.flatMap((element, index) => {
        for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
            if (painted.has(parent)) return [];
        }
        if (!ownsPaint(element)) return [];
        const rect = captureElementFlightRect(element);
        if (rect.width <= 0 || rect.height <= 0) return [];
        painted.add(element);
        return [{ element, rect, index }];
    });
    const ink = inkMapFromBoxes(
        leaves.map(({ rect }) => ({ ...rect, ink: [255, 255, 255, 255] as const })),
        { cols: grid.cols, rows: grid.rows, cell: grid.cell, origin: [0, 0] },
    );
    return { elements, leaves, ink };
}

export function freezeStepLayer(
    layer: StepMotionLayerHandle,
    grid: StepGrid,
    anchor?: StepAnchor | null,
): StepFreeze | Promise<StepFreeze | null> | null {
    const root = layer.webElement();
    if (!root || typeof root.animate !== 'function') return null;
    const rect = captureElementFlightRect(root);
    if (rect.width <= 0 || rect.height <= 0) return null;
    const { elements, leaves, ink } = readStepLeaves(root, grid);
    // The copy is paint-only. Removing IDs also keeps the real destination the single owner of
    // IDs referenced by labels, focus return, form submission and the app test harness.
    const clone = root.cloneNode(true) as HTMLElement;
    clone.inert = true;
    clone.setAttribute('aria-hidden', 'true');
    clone.removeAttribute('id');
    clone.removeAttribute('data-testid');
    const control = anchor?.testID ? findWebStepAnchor(clone, anchor.testID) : null;
    const focal = layer.focal();
    const cloneElements = clone.querySelectorAll<HTMLElement>('*');
    const webFocal = focal instanceof HTMLElement ? cloneElements[elements.indexOf(focal)] : undefined;
    const webLeaves = leaves.map(({ rect: leafRect, index }) => ({ element: cloneElements[index], rect: leafRect }));
    for (const element of clone.querySelectorAll('[id], [data-testid], [autofocus], a[href], [name]')) {
        for (const key of ['id', 'data-testid', 'autofocus', 'href', 'name']) element.removeAttribute(key);
    }
    Object.assign(clone.style, {
        position: 'fixed',
        pointerEvents: 'none',
        margin: '0',
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        zIndex: '1000',
    });
    document.body.append(clone);
    return { clone, rect, ink, control, webLeaves, webFocal, release: () => clone.remove() };
}
