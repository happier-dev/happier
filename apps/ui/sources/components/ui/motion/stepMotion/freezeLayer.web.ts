import { inkMapFromBoxes } from '@happier-dev/brand/glyph-scene';

import { captureElementFlightRect } from '../rectFlight';
import { findWebStepAnchor } from './capturePressedElement.web';
import type { StepAnchor, StepFreeze, StepGrid, StepMotionLayerHandle, StepWebLeaf } from './stepMotionTypes';

const paintedContent = 'h1, h2, h3, [role="heading"], [role="button"], [role="link"], a, button, input, textarea, img, svg';

function ownsPaint(element: Element) {
    if (element.matches(paintedContent)) return true;
    if (Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return true;
    const style = getComputedStyle(element);
    const fill = style.backgroundColor;
    return (fill && fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)')
        || style.backgroundImage !== 'none' && style.backgroundImage !== ''
        || Number.parseFloat(style.borderTopWidth) > 0;
}

export function stepLeavesIn(root: HTMLElement, elements: readonly HTMLElement[], painted: Set<Element>) {
    return elements.flatMap((element, index) => {
        for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
            if (painted.has(parent)) return [];
        }
        if (painted.has(element) || !ownsPaint(element)) return [];
        const rect = captureElementFlightRect(element);
        if (rect.width <= 0 || rect.height <= 0) return [];
        painted.add(element);
        return [{ element, rect, index }];
    });
}

export function readStepLeaves(root: HTMLElement, grid: StepGrid) {
    const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
    const leaves = stepLeavesIn(root, elements, new Set());
    const ink = inkMapFromBoxes(
        leaves.map(({ rect }) => ({ ...rect, ink: [255, 255, 255, 255] as const })),
        { cols: grid.cols, rows: grid.rows, cell: grid.cell, origin: [0, 0] },
    );
    return { elements, leaves, ink };
}

/** Sample only the painted QR modules, once when its SVG mounts. */
export function readWebFocalInk(focal: HTMLElement, rect: StepAnchor['rect']) {
    const svg = focal.querySelector<SVGSVGElement>('svg[data-qr-ink]');
    if (!svg || typeof Path2D === 'undefined') return;
    const view = svg.viewBox.baseVal;
    const bounds = svg.getBoundingClientRect();
    if (!view.width || !view.height || !bounds.width || !bounds.height) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(bounds.width / 6);
    canvas.height = Math.ceil(bounds.height / 10);
    const draw = canvas.getContext('2d', { willReadFrequently: true });
    if (!draw) return;
    try {
        draw.scale(canvas.width / view.width, canvas.height / view.height);
        // The first rect is paper. The remaining children are the renderer's dark module geometry.
        for (const element of Array.from(svg.children).slice(1)) {
            if (element.tagName === 'path') {
                draw.fill(new Path2D(element.getAttribute('d') ?? ''), element.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero');
            } else if (element instanceof SVGRectElement) {
                draw.fillRect(element.x.baseVal.value, element.y.baseVal.value, element.width.baseVal.value, element.height.baseVal.value);
            }
        }
        const { data } = draw.getImageData(0, 0, canvas.width, canvas.height);
        const ink: Array<readonly [number, number]> = [];
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] < 128) continue;
            ink.push([
                (bounds.x - rect.x + (x + 0.5) * bounds.width / canvas.width) / rect.width,
                (bounds.y - rect.y + (y + 0.5) * bounds.height / canvas.height) / rect.height,
            ]);
        }
        return ink.length ? ink : undefined;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

function freezeRegion(root: HTMLElement, rect: StepFreeze['rect']) {
    const clone = root.cloneNode(true) as HTMLElement;
    Object.assign(clone.style, {
        position: 'fixed',
        pointerEvents: 'none',
        margin: '0',
        inset: 'auto',
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        zIndex: '1000',
    });
    return clone;
}

function mountPaintCopy(clone: HTMLElement) {
    clone.inert = true;
    clone.setAttribute('aria-hidden', 'true');
    for (const element of [clone, ...clone.querySelectorAll('[id], [data-testid], [autofocus], a[href], [name]')]) {
        for (const key of ['id', 'data-testid', 'autofocus', 'href', 'name']) element.removeAttribute(key);
    }
    document.body.append(clone);
}

export function freezeStepLayer(
    layer: StepMotionLayerHandle,
    grid: StepGrid,
    anchor?: StepAnchor | null,
    pressedChrome: readonly StepWebLeaf[] = [],
): StepFreeze | Promise<StepFreeze | null> | null {
    const root = layer.webElement();
    if (!root || typeof root.animate !== 'function') return null;
    const rect = captureElementFlightRect(root);
    if (rect.width <= 0 || rect.height <= 0) return null;
    const { elements, leaves, ink } = readStepLeaves(root, grid);
    // The copy is paint-only. Removing IDs also keeps the real destination the single owner of
    // IDs referenced by labels, focus return, form submission and the app test harness.
    const clone = freezeRegion(root, rect);
    const chrome = layer.webChrome?.() ?? [];
    const webChrome = chrome.map(region => freezeRegion(region, captureElementFlightRect(region)));
    for (const { element, rect } of pressedChrome) {
        if (!chrome.some(region => region === element || region.dataset.testid === element.dataset.testid)) {
            webChrome.push(freezeRegion(element, rect));
        }
    }
    const testID = anchor?.testID;
    const control = testID
        ? [clone, ...webChrome].map(copy => findWebStepAnchor(copy, testID)).find(Boolean)
        : null;
    const focal = layer.focal();
    const cloneElements = clone.querySelectorAll<HTMLElement>('*');
    const webFocal = focal instanceof HTMLElement ? cloneElements[elements.indexOf(focal)] : undefined;
    const webLeaves = leaves.map(({ rect: leafRect, index }) => ({ element: cloneElements[index], rect: leafRect }));
    const copies = [clone, ...webChrome];
    for (const copy of copies) mountPaintCopy(copy);
    return { clone, rect, ink, control, webLeaves, webFocal, webChrome, release: () => copies.forEach(copy => copy.remove()) };
}
