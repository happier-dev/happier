import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/**
 * Replays an asciinema v2 cast file on an xterm.js terminal at the original
 * recorded timing. Casts are JSON-lines: the first line is a header object,
 * each subsequent line is `[timestamp, "o"|"i", data]`. We only replay "o"
 * (output) events; "i" (input) is the user typing and is already represented
 * in the cast's output via the shell's local echo.
 *
 * IMPORTANT: the xterm grid is locked to the cast's recorded `cols × rows`
 * dimensions. Cast escape sequences encode absolute cursor positions
 * (`\x1b[24C`, `\x1b[3B`, etc.) that only render correctly on a grid of the
 * exact same size as the recording. Running on a wider/narrower grid scrambles
 * box-drawing and prompt placement. We instead scale the rendered terminal
 * with a CSS `transform: scale()` so it visually fits whatever container the
 * marketing frame gives us, while preserving the byte-perfect cell layout.
 */

type Props = {
    src: string;
    replayKey?: string | number;
    speed?: number;
    endAtSeconds?: number;
    startAtSeconds?: number;
    /** Pixel font size used by xterm. The natural terminal size is
     * cols × charWidth × rows × lineHeight; we then CSS-scale that to fit. */
    fontSize?: number;
    theme?: Partial<ITheme>;
};

type CastHeader = {
    version: number;
    width: number;
    height: number;
};

type CastOutputEvent = readonly [number, 'o', string];

function parseCast(text: string): { header: CastHeader; events: CastOutputEvent[] } {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) throw new Error('empty cast');
    const header = JSON.parse(lines[0]) as CastHeader;
    const events: CastOutputEvent[] = [];
    for (let i = 1; i < lines.length; i++) {
        try {
            const parsed = JSON.parse(lines[i]) as readonly [number, string, string];
            if (parsed[1] === 'o') events.push(parsed as CastOutputEvent);
        } catch {
            // skip malformed lines
        }
    }
    return { header, events };
}

function readCssColor(varName: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
}

export function CastPlayer({
    src,
    replayKey,
    speed = 1,
    endAtSeconds,
    startAtSeconds = 0,
    fontSize = 12.5,
    theme,
}: Props) {
    const outerRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const dimsRef = useRef<{ cols: number; rows: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [scale, setScale] = useState(1);

    // Fetch the cast header up-front to know the recorded grid size, then
    // mount xterm at exactly that size. We re-mount when the src changes so
    // the dimensions stay aligned with the active recording.
    useEffect(() => {
        let aborted = false;
        let term: Terminal | null = null;

        fetch(src)
            .then((res) => {
                if (!res.ok) throw new Error(`fetch ${src} → ${res.status}`);
                return res.text();
            })
            .then((text) => {
                if (aborted || !innerRef.current) return;
                const { header } = parseCast(text);
                const cols = header.width || 80;
                const rows = header.height || 24;
                dimsRef.current = { cols, rows };

                const resolvedTheme: ITheme = {
                    background: readCssColor('--terminal-bg', '#0d0d12'),
                    foreground: readCssColor('--terminal-text', '#e6e6e6'),
                    cursor: readCssColor('--terminal-text', '#e6e6e6'),
                    ...theme,
                };
                term = new Terminal({
                    cols,
                    rows,
                    convertEol: true,
                    cursorBlink: true,
                    fontFamily:
                        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    fontSize,
                    lineHeight: 1.2,
                    theme: resolvedTheme,
                    scrollback: 1_000,
                    disableStdin: true,
                    allowTransparency: false,
                });
                term.open(innerRef.current);
                termRef.current = term;
                computeScale();
            })
            .catch((err) => {
                if (!aborted) setError(err.message);
            });

        function computeScale() {
            if (!outerRef.current || !innerRef.current) return;
            const outer = outerRef.current.getBoundingClientRect();
            const inner = innerRef.current.getBoundingClientRect();
            if (inner.width === 0 || inner.height === 0) return;
            const sx = outer.width / inner.width;
            const sy = outer.height / inner.height;
            // Use the smaller axis so the terminal always fits without overflow.
            // Cap at 1 — never upscale (xterm's font rendering doesn't benefit
            // from CSS upscaling and would look blurry).
            setScale(Math.min(1, sx, sy));
        }

        const ro =
            typeof ResizeObserver !== 'undefined'
                ? new ResizeObserver(() => computeScale())
                : null;
        if (ro && outerRef.current) ro.observe(outerRef.current);

        return () => {
            aborted = true;
            ro?.disconnect();
            term?.dispose();
            termRef.current = null;
        };
    }, [src, fontSize, theme]);

    // Schedule cast playback. Cancel and re-run on replayKey change so beat
    // advancement restarts cleanly.
    useEffect(() => {
        let aborted = false;
        const timers: number[] = [];

        // The terminal mount is async (we have to fetch the cast header first
        // to know cols/rows). Poll briefly for it before scheduling — keeps the
        // playback in sync with the latest replayKey on the next React tick.
        let attempts = 0;
        const tryStart = () => {
            const term = termRef.current;
            if (aborted) return;
            if (!term) {
                if (attempts++ < 30) {
                    timers.push(window.setTimeout(tryStart, 50));
                }
                return;
            }
            term.reset();
            fetch(src)
                .then((res) => res.text())
                .then((text) => {
                    if (aborted) return;
                    const { events } = parseCast(text);
                    const epoch = performance.now();
                    const start = startAtSeconds;
                    const end = endAtSeconds ?? Infinity;
                    for (const [t, , data] of events) {
                        if (t < start) continue;
                        if (t > end) break;
                        const delayMs = ((t - start) * 1000) / Math.max(0.05, speed);
                        const elapsed = performance.now() - epoch;
                        const id = window.setTimeout(
                            () => {
                                if (!aborted) term.write(data);
                            },
                            Math.max(0, delayMs - elapsed),
                        );
                        timers.push(id);
                    }
                })
                .catch(() => {
                    // surface fetch errors in the mount effect, not here
                });
        };
        tryStart();

        return () => {
            aborted = true;
            timers.forEach((id) => clearTimeout(id));
        };
    }, [src, replayKey, speed, startAtSeconds, endAtSeconds]);

    if (error) {
        return (
            <div
                className="font-mono text-[12px] text-red-400 px-5 py-4"
                style={{ background: 'var(--terminal-bg)' }}
            >
                cast error: {error}
            </div>
        );
    }

    return (
        <div
            ref={outerRef}
            className="relative h-full w-full overflow-hidden flex items-center justify-center"
            style={{ background: 'var(--terminal-bg)' }}
        >
            <div
                ref={innerRef}
                style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'center center',
                    // The inner element is sized by xterm to its natural cols×rows;
                    // we just place it and let scale handle visual fit.
                }}
            />
        </div>
    );
}
