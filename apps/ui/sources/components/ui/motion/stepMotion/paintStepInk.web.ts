import { stepInkCoverage, stepInkGrid, stepInkSampleScale } from './stepInk';
import type { StepAnchor, StepGrid } from './stepMotionTypes';

type StepRect = StepAnchor['rect'];
const cssLength = (value: string) => Number.parseFloat(value) || 0;
const visibleFill = (value: string) => Boolean(value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)');

function paintText(draw: CanvasRenderingContext2D, element: HTMLElement, style: CSSStyleDeclaration, rect: StepRect) {
    const text = Array.from(element.childNodes, node => node.nodeType === Node.TEXT_NODE ? node.textContent : '').join('').trim();
    if (!text || !style.fontSize) return;
    const left = rect.x + cssLength(style.paddingLeft);
    const right = rect.x + rect.width - cssLength(style.paddingRight);
    const font = cssLength(style.fontSize);
    const lineHeight = cssLength(style.lineHeight) || font * 1.2;
    const align = style.textAlign === 'center' ? 'center' : style.textAlign === 'right' || style.textAlign === 'end' ? 'right' : 'left';
    const x = align === 'center' ? (left + right) / 2 : align === 'right' ? right : left;
    draw.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`.trim();
    if ('letterSpacing' in draw) draw.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    draw.textAlign = align;
    draw.textBaseline = 'middle';
    const lines = text.split('\n').flatMap(paragraph => {
        if (style.whiteSpace === 'nowrap' || draw.measureText(paragraph).width <= right - left) return [paragraph];
        const wrapped: string[] = [];
        let line = '';
        for (const word of paragraph.split(/\s+/)) {
            const next = line ? `${line} ${word}` : word;
            if (line && draw.measureText(next).width > right - left) {
                wrapped.push(line);
                line = word;
            } else line = next;
        }
        return [...wrapped, line];
    });
    const top = rect.y + cssLength(style.paddingTop);
    draw.save();
    draw.beginPath();
    draw.rect(left - 1, rect.y, right - left + 2, rect.height);
    draw.clip();
    for (const [index, line] of lines.entries()) {
        draw.fillText(line, x, top + (index + 0.5) * lineHeight);
    }
    draw.restore();
}

export function paintQrInk(draw: CanvasRenderingContext2D, svg: SVGSVGElement, bounds: StepRect) {
    if (typeof Path2D !== 'undefined') {
        const view = svg.viewBox.baseVal;
        if (!view.width || !view.height) return;
        draw.save();
        draw.translate(bounds.x, bounds.y);
        draw.scale(bounds.width / view.width, bounds.height / view.height);
        draw.translate(-view.x, -view.y);
        // The SVG's first rect is the paper, surrounded by transparent backing.
        for (const module of Array.from(svg.children).slice(1)) {
            if (module.tagName === 'path') {
                draw.fill(new Path2D(module.getAttribute('d') ?? ''), module.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero');
            } else if (module instanceof SVGRectElement) {
                draw.fillRect(module.x.baseVal.value, module.y.baseVal.value, module.width.baseVal.value, module.height.baseVal.value);
            }
        }
        draw.restore();
    }
}

function paintSvg(draw: CanvasRenderingContext2D, svg: SVGSVGElement, bounds: StepRect) {
    if (svg.hasAttribute('data-qr-ink')) {
        paintQrInk(draw, svg, bounds);
        return;
    }
    // The lab marks a small icon by its centre ink, independent of the icon library.
    draw.beginPath();
    draw.arc(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, Math.min(bounds.width, bounds.height) * 0.2, 0, Math.PI * 2);
    draw.fill();
}

/** Replay the step's painted parts into transparent ink once. The DOM freeze remains the outgoing paint owner. */
export function paintStepInk(
    elements: readonly HTMLElement[],
    measure: (element: HTMLElement) => StepRect,
    grid: StepGrid,
) {
    if (typeof CanvasRenderingContext2D === 'undefined') return;
    const canvas = document.createElement('canvas');
    const { width, height } = stepInkGrid(grid);
    canvas.width = width;
    canvas.height = height;
    try {
        const draw = canvas.getContext('2d', { willReadFrequently: true });
        if (!draw) return;
        draw.scale(stepInkSampleScale, stepInkSampleScale);
        draw.fillStyle = draw.strokeStyle = 'white';
        draw.lineWidth = 2;
        for (const element of elements) {
            // SVG children belong to their icon or QR, not to the outer column.
            if (element instanceof SVGElement && element.tagName !== 'svg') continue;
            const style = getComputedStyle(element);
            if (style.visibility === 'hidden' || style.opacity === '0' || style.display === 'none') continue;
            const rect = measure(element);
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (element instanceof SVGSVGElement) {
                paintSvg(draw, element, rect);
                continue;
            }
            const { x, y, width, height } = rect;
            if ((element.matches('a, button, input, textarea, [role="button"], [role="link"]') &&
                (visibleFill(style.backgroundColor) || style.backgroundImage && style.backgroundImage !== 'none')) || style.boxShadow.includes('inset')) {
                const radius = Math.min(cssLength(style.borderTopLeftRadius), width / 2, height / 2);
                draw.beginPath();
                draw.roundRect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2), radius);
                draw.stroke();
            } else {
                for (const [amount, left, top, horizontal] of [
                    [style.borderTopWidth, x, y, true], [style.borderBottomWidth, x, y + height, true],
                    [style.borderLeftWidth, x, y, false], [style.borderRightWidth, x + width, y, false],
                ] as const) {
                    if (cssLength(amount)) draw.fillRect(left - 1, top - 1, horizontal ? width : 2, horizontal ? 2 : height);
                }
            }
            paintText(draw, element, style, rect);
        }
        const { data } = draw.getImageData(0, 0, width, height);
        return stepInkCoverage(grid, (x, y) => data[(y * width + x) * 4 + 3]);
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}
