import type { PlanetScene, PlanetSceneDot } from '@happier-dev/brand/planet';

/** Canvas composition ported from MO.composite; scene maths stay in Brand. */
export function paintPlanetMark(context: CanvasRenderingContext2D, scene: PlanetScene, fonts: { regular: string; semiBold: string }, ink?: string) {
    const dots = (list: readonly PlanetSceneDot[]) => {
        for (const dot of list) {
            context.globalAlpha = dot.opacity;
            context.fillStyle = ink ?? `rgb(${dot.rgb[0] | 0},${dot.rgb[1] | 0},${dot.rgb[2] | 0})`;
            context.beginPath(); context.arc(dot.x, dot.y, dot.r, 0, 6.2832); context.fill();
        }
        context.globalAlpha = 1;
    };
    const cells = (over: boolean) => {
        context.textAlign = 'center'; context.textBaseline = 'middle';
        for (const cell of scene.cells) {
            if (cell.over !== over) continue;
            context.font = `${over ? (cell.cut ? 700 : 600) : 400} ${cell.fs.toFixed(2)}px ${over ? fonts.semiBold : fonts.regular}`;
            context.globalCompositeOperation = over && !cell.cut ? 'source-atop' : 'source-over';
            context.fillStyle = `rgba(${cell.rgb.map(v => Math.round(v)).join(',')},${over ? Math.min(1, cell.a * (cell.cut ? 1.6 : 3.2)) : cell.a})`;
            context.fillText(cell.ch, cell.x, cell.y);
        }
        context.globalCompositeOperation = 'source-over';
    };
    dots(scene.body); cells(true); dots(scene.haze); cells(false);
}
