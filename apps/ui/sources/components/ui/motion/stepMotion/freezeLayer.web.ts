import { captureElementFlightRect } from '../rectFlight';
import { findWebStepAnchor } from './capturePressedElement.web';
import { paintQrInk, paintStepInk } from './paintStepInk.web';
import { copyRegion, mountPaintCopy } from './stepPaintCopy';
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

export function stepLeavesIn(root: HTMLElement, elements: readonly HTMLElement[], painted: Set<Element>,
    measure = captureElementFlightRect) {
    return elements.flatMap((element, index) => {
        for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
            if (painted.has(parent)) return [];
        }
        if (painted.has(element) || !ownsPaint(element)) return [];
        const rect = measure(element);
        if (rect.width <= 0 || rect.height <= 0) return [];
        painted.add(element);
        return [{ element, rect, index }];
    });
}

export function readStepLeaves(root: HTMLElement, grid: StepGrid, sampleInk = true) {
    const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
    const rects = new Map<HTMLElement, StepAnchor['rect']>();
    const measure = (element: HTMLElement) => {
        const measured = rects.get(element) ?? captureElementFlightRect(element);
        rects.set(element, measured);
        return measured;
    };
    const leaves = stepLeavesIn(root, elements, new Set(), measure);
    const ink = sampleInk ? paintStepInk(elements, measure, grid) : undefined;
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
        paintQrInk(draw, svg, { x: 0, y: 0, width: canvas.width, height: canvas.height });
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
    const clone = copyRegion(root, rect);
    const chrome = layer.webChrome?.() ?? [];
    const webChrome = chrome.map(region => copyRegion(region, captureElementFlightRect(region)));
    for (const { element, rect } of pressedChrome) {
        if (!chrome.some(region => region === element || region.dataset.testid === element.dataset.testid)) {
            webChrome.push(copyRegion(element, rect));
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
    const release = mountPaintCopy([clone, ...webChrome]);
    return { clone, rect, ink, control, webLeaves, webFocal, webChrome, release };
}
