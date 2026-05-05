import { useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalTypingPrompt } from '../timeline/scenarioTypes';

type Props = {
    prompt: TerminalTypingPrompt;
    /**
     * Key used to replay the animation from scratch. Pass the beat id so
     * the typewriter restarts when the scenario loops.
     */
    replayKey?: string | number;
    /**
     * Called once when the animation reaches its final state. Optional —
     * letting the component "just hold" after landing is the usual case.
     */
    onComplete?: () => void;
};

type Frame = {
    t: number;
    text: string;
    selecting: boolean;
};

/**
 * Precompute an ordered list of (time, snapshot) frames for the cycle.
 * At render time we binary-search for the latest frame whose t is <= elapsed.
 *
 * Cycle shape:
 *   for each non-last token: type → flash-select → backspace
 *   final token: type → hold (no backspace)
 */
function buildFrames(prompt: TerminalTypingPrompt): { frames: Frame[]; totalMs: number } {
    const perCharMs = prompt.perCharMs ?? 45;
    const backspaceMs = prompt.backspaceMs ?? 30;
    const flashMs = prompt.flashMs ?? 140;
    const holdFinalMs = prompt.holdFinalMs ?? 400;

    const frames: Frame[] = [{ t: 0, text: '', selecting: false }];
    let t = 0;

    for (let i = 0; i < prompt.tokens.length; i++) {
        const token = prompt.tokens[i];
        const isLast = i === prompt.tokens.length - 1;

        // Type char-by-char
        for (let c = 1; c <= token.length; c++) {
            t += perCharMs;
            frames.push({ t, text: token.slice(0, c), selecting: false });
        }

        if (isLast) {
            t += holdFinalMs;
            frames.push({ t, text: token, selecting: false });
            break;
        }

        // Brief selection flash
        t += flashMs;
        frames.push({ t, text: token, selecting: true });

        // Backspace char-by-char
        for (let c = token.length - 1; c >= 0; c--) {
            t += backspaceMs;
            frames.push({ t, text: token.slice(0, c), selecting: false });
        }
    }

    return { frames, totalMs: t };
}

export function TypewriterTerminalPrompt({ prompt, replayKey, onComplete }: Props) {
    const schedule = useMemo(() => buildFrames(prompt), [prompt]);
    const [snapshot, setSnapshot] = useState<Frame>(schedule.frames[0]);
    const completedRef = useRef(false);

    useEffect(() => {
        completedRef.current = false;
        let raf = 0;
        const start = performance.now();
        let cursor = 0;

        const tick = (now: number) => {
            const elapsed = now - start;
            // Advance cursor while the next frame is already in the past.
            while (
                cursor + 1 < schedule.frames.length &&
                schedule.frames[cursor + 1].t <= elapsed
            ) {
                cursor += 1;
            }
            setSnapshot(schedule.frames[cursor]);

            if (elapsed >= schedule.totalMs) {
                if (!completedRef.current) {
                    completedRef.current = true;
                    onComplete?.();
                }
                return;
            }
            raf = requestAnimationFrame(tick);
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
        // replayKey intentionally in deps — changing it restarts the RAF loop.
    }, [schedule, replayKey, onComplete]);

    return (
        <div
            className="font-mono text-[12.5px] leading-[1.55]"
            style={{ color: 'var(--terminal-text)' }}
        >
            <span style={{ color: 'var(--terminal-prompt)' }}>$ </span>
            <span>{prompt.prefix}</span>
            {snapshot.selecting ? (
                <span
                    style={{
                        background: 'rgba(100, 140, 255, 0.35)',
                        color: 'var(--terminal-text)',
                    }}
                >
                    {snapshot.text}
                </span>
            ) : (
                <span>{snapshot.text}</span>
            )}
            <span className="terminal-cursor" aria-hidden />
        </div>
    );
}
