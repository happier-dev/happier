import { useEffect, useRef } from 'react';
import { useTheme } from './ThemeContext';

/**
 * Ambient terminal-noise background.
 *
 * Canvas-rendered dense field of small monospace tokens covering the
 * whole viewport. Per-cell opacity varies via a sum of sine waves so we
 * get organic "hot zones" and "gaps" without a noise library. Most cells
 * are barely visible; a handful flash slightly brighter on each tick.
 *
 * Theme-aware: white tokens on dark, dark tokens on light.
 *
 * Respects prefers-reduced-motion: static draw, no ticks.
 *
 * The hero section paints its own opaque planet image on top of this, so
 * the matrix only reads in sections beyond the hero.
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

/** Cheap smooth-noise via a sum of sines. */
function opacityAt(x: number, y: number, seed: number): number {
    const n =
        0.5 +
        0.32 * Math.sin(x * 0.0125 + y * 0.018 + seed) +
        0.22 * Math.sin(x * 0.034 - y * 0.023 + seed * 1.3) +
        0.15 * Math.cos(x * 0.061 + y * 0.008 + seed * 2.1) +
        0.1 * Math.sin(x * 0.094 + y * 0.104 + seed * 0.7);
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
    const { theme } = useTheme();

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const baseRgb = theme === 'dark' ? '255, 255, 255' : '10, 10, 11';

        let cells: Cell[] = [];
        let dpr = 1;
        let cssWidth = 0;
        let cssHeight = 0;

        const seed = Math.random() * 1000;

        const CELL_W = 38;
        const CELL_H = 15;
        const MAX_OPACITY = theme === 'dark' ? 0.055 : 0.08;
        const GAP_THRESHOLD = 0.02;

        const rebuildCells = () => {
            cells = [];
            const cols = Math.ceil(cssWidth / CELL_W) + 1;
            const rows = Math.ceil(cssHeight / CELL_H) + 1;
            const cx = cssWidth / 2;
            const cy = cssHeight / 2;
            const maxDist = Math.sqrt(cx * cx + cy * cy);
            for (let i = 0; i < cols; i += 1) {
                for (let j = 0; j < rows; j += 1) {
                    const xJitter = (Math.random() - 0.5) * 4;
                    const yJitter = (Math.random() - 0.5) * 4;
                    const x = i * CELL_W + xJitter;
                    const y = j * CELL_H + yJitter;
                    const noise = opacityAt(x, y, seed);
                    if (noise < GAP_THRESHOLD) continue;
                    const dx = x - cx;
                    const dy = y - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
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
            ctx.font = '8.5px "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace';
            ctx.textBaseline = 'top';
            const now = performance.now();
            for (const cell of cells) {
                let op = cell.baseOpacity;
                if (cell.flashUntil > now) {
                    const t = (cell.flashUntil - now) / 700;
                    op = Math.min(MAX_OPACITY * 2.5, op + 0.04 * t);
                }
                ctx.fillStyle = `rgba(${baseRgb}, ${op.toFixed(3)})`;
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
            const changeCount = 3 + Math.floor(Math.random() * 4);
            for (let i = 0; i < changeCount; i += 1) {
                const idx = Math.floor(Math.random() * cells.length);
                if (!cells[idx]) continue;
                cells[idx].value = randomToken();
                cells[idx].flashUntil = performance.now() + 600;
            }
            drawAll();
            const flashEnd = performance.now() + 650;
            const animateFlash = () => {
                if (cancelled) return;
                drawAll();
                if (performance.now() < flashEnd) {
                    raf = requestAnimationFrame(animateFlash);
                }
            };
            raf = requestAnimationFrame(animateFlash);
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
    }, [theme]);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden
            className="pointer-events-none fixed inset-0"
            style={{ zIndex: 0 }}
        />
    );
}
