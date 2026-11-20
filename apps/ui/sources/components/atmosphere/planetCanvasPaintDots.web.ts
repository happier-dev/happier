import type { PlanetMarkDot } from './planetCanvasDots';

export function paintPlanetDots(context: CanvasRenderingContext2D, dots: readonly PlanetMarkDot[], ink?: string) {
    for (const dot of dots) {
        context.globalAlpha = dot.opacity;
        context.fillStyle = ink ?? `rgb(${dot.rgb[0] | 0},${dot.rgb[1] | 0},${dot.rgb[2] | 0})`;
        context.beginPath();
        context.arc(dot.x, dot.y, dot.r, 0, 6.2832);
        context.fill();
    }
    context.globalAlpha = 1;
}
