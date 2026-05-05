import { useEffect, useRef } from 'react';

/**
 * Ambient terminal-noise background.
 *
 * A canvas-rendered dense field of small monospace tokens covering the
 * whole viewport. Per-cell opacity varies via a sum of sine waves,
 * producing organic "hot zones" and "gaps" without importing a noise
 * library. Most cells are barely visible; a few are slightly brighter.
 *
 * Every ~800ms a handful of cells update to new values and briefly
 * flash a touch brighter before settling. Cheap: one `<canvas>`, one
 * redraw per tick, no per-cell React state.
 *
 * Respects prefers-reduced-motion: static draw, no ticks.
 */

const TOKEN_GENERATORS: Array<() => string> = [
    () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
    () => `0x${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`,
    () => `${(Math.random() * 9).toFixed(2)}ms`,
    () => `${Math.floor(Math.random() * 900 + 100)}kB`,
    () => `${Math.floor(Math.random() * 99)}%`,
    () => `t+${Math.floor(Math.random() * 999).toString().padStart(3, '0')}`,
    () => Array.from({ length: 8 }, () => (Math.random() > 0.5 ? '1' : '0')).join(''),
    () => `seq:${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`,
    () => `${Math.floor(Math.random() * 999)}ns`,
    () => `+${Math.floor(Math.random() * 99)}`,
    () => `−${Math.floor(Math.random() * 99)}`,
    () => `#${Math.floor(Math.random() * 999).toString().padStart(3, '0')}`,
];

function randomToken(): string {
    return TOKEN_GENERATORS[Math.floor(Math.random() * TOKEN_GENERATORS.length)]();
}

/**
 * 2D "noise" via a sum of sine waves at several frequencies. Cheap,
 * smooth, and gives organic-looking continents of higher/lower opacity.
 * The small random offsets per cell break up any visible grid-alignment.
 */
function opacityAt(x: number, y: number, seed: number): number {
    const n =
        0.50 +
        0.32 * Math.sin(x * 0.0125 + y * 0.018 + seed) +
        0.22 * Math.sin(x * 0.034 - y * 0.023 + seed * 1.3) +
        0.15 * Math.cos(x * 0.061 + y * 0.008 + seed * 2.1) +
        0.10 * Math.sin(x * 0.094 + y * 0.104 + seed * 0.7);
    // Cube to bias distribution toward low values: most cells are very faint.
    const clamped = Math.max(0, Math.min(1, n));
    return Math.pow(clamped, 2.6);
}

type Cell = {
    x: number;
    y: number;
    baseOpacity: number;
    value: string;
    flashUntil: number;
};

export function TerminalBackground() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let cells: Cell[] = [];
        let dpr = 1;
        let cssWidth = 0;
        let cssHeight = 0;

        const seed = Math.random() * 1000;

        // Cell grid — dense enough that tokens blur into a texture rather
        // than reading as individual characters. Small font + tight grid +
        // very low opacity = the near-fog effect from vibeisland.app.
        const CELL_W = 38;
        const CELL_H = 15;
        // Maximum cell opacity. Keep this VERY low so the densest tokens
        // are still barely noticeable — the effect is atmosphere, not text.
        const MAX_OPACITY = 0.055;
        // Cells with computed opacity below this become gaps. We want
        // relatively few gaps; the field should feel continuous.
        const GAP_THRESHOLD = 0.02;

        const rebuildCells = () => {
            cells = [];
            const cols = Math.ceil(cssWidth / CELL_W) + 1;
            const rows = Math.ceil(cssHeight / CELL_H) + 1;
            // Radial vignette — edges get slightly dimmer than the middle.
            // Ratio is opacity multiplier; never below 0.4 so edges still show.
            const cx = cssWidth / 2;
            const cy = cssHeight / 2;
            const maxDist = Math.sqrt(cx * cx + cy * cy);
            for (let i = 0; i < cols; i += 1) {
                for (let j = 0; j < rows; j += 1) {
                    // Tight jitter so cells don't visually grid-line but also
                    // don't cluster — we want a uniform-looking fog.
                    const xJitter = (Math.random() - 0.5) * 4;
                    const yJitter = (Math.random() - 0.5) * 4;
                    const x = i * CELL_W + xJitter;
                    const y = j * CELL_H + yJitter;
                    const noise = opacityAt(x, y, seed);
                    if (noise < GAP_THRESHOLD) continue; // rare natural gap
                    const dx = x - cx;
                    const dy = y - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
                    // Slight radial dim toward edges (edges get ×0.55, center ×1).
                    const radial = 1 - dist * 0.45;
                    cells.push({
                        x,
                        y,
                        baseOpacity: noise * MAX_OPACITY * radial,
                        value: randomToken(),
                        flashUntil: 0,
                    });
                }
            }
        };

        const drawAll = () => {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.scale(dpr, dpr);
            // Smaller font → tokens read as texture, not readable numbers.
            ctx.font = '8.5px "IBM Plex Mono", ui-monospace, monospace';
            ctx.textBaseline = 'top';
            const now = performance.now();
            for (const cell of cells) {
                let op = cell.baseOpacity;
                if (cell.flashUntil > now) {
                    const t = (cell.flashUntil - now) / 700;
                    op = Math.min(MAX_OPACITY * 2.5, op + 0.04 * t);
                }
                ctx.fillStyle = `rgba(255, 255, 255, ${op.toFixed(3)})`;
                ctx.fillText(cell.value, cell.x, cell.y);
            }
        };

        const resize = () => {
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            cssWidth = window.innerWidth;
            cssHeight = window.innerHeight;
            canvas.width = cssWidth * dpr;
            canvas.height = cssHeight * dpr;
            canvas.style.width = `${cssWidth}px`;
            canvas.style.height = `${cssHeight}px`;
            rebuildCells();
            drawAll();
        };

        resize();
        window.addEventListener('resize', resize);

        let raf = 0;
        let tickTimer = 0;
        let cancelled = false;

        const tick = () => {
            if (cancelled) return;
            // Change 3-6 random cells per tick.
            const changeCount = 3 + Math.floor(Math.random() * 4);
            for (let i = 0; i < changeCount; i += 1) {
                const idx = Math.floor(Math.random() * cells.length);
                if (!cells[idx]) continue;
                cells[idx].value = randomToken();
                cells[idx].flashUntil = performance.now() + 600;
            }
            drawAll();
            // Keep RAF active for ~0.6s to animate the flash decay.
            const flashEnd = performance.now() + 650;
            const animateFlash = () => {
                if (cancelled) return;
                drawAll();
                if (performance.now() < flashEnd) {
                    raf = requestAnimationFrame(animateFlash);
                }
            };
            raf = requestAnimationFrame(animateFlash);
            // Stochastic interval so it never feels metronomic.
            const delay = 600 + Math.random() * 900;
            tickTimer = window.setTimeout(tick, delay);
        };

        if (!reducedMotion) {
            tickTimer = window.setTimeout(tick, 500);
        }

        return () => {
            cancelled = true;
            window.removeEventListener('resize', resize);
            window.clearTimeout(tickTimer);
            if (raf) cancelAnimationFrame(raf);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden
            className="pointer-events-none fixed inset-0"
            style={{
                // Behind everything except the page background color.
                // The grain-overlay (z:1) + main (z:2) stack above.
                zIndex: 0,
            }}
        />
    );
}
