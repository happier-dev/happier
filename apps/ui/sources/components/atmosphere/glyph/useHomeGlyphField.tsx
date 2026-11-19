import * as React from 'react';
import { Platform, type View } from 'react-native';
import {
    fieldDotLayer, glyphFieldDurationS, glyphFieldPhase, glyphFieldRippleLifeS, glyphFieldTrailCell, glyphFieldTrailLifeS,
    type FieldDotLayer, type GlyphFieldMode, type GlyphRect,
} from '@happier-dev/brand/glyph-scene';
import { useSetting } from '@/sync/store/hooks';
import { readHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

export const HomeFieldPreference = React.memo(function HomeFieldPreference({ onMode }: {
    onMode: (mode: GlyphFieldMode) => void;
}) {
    const mode = useSetting('homeBackgroundField');
    React.useLayoutEffect(() => onMode(mode), [mode, onMode]);
    return null;
});

type Stamp = { x: number; y: number; at: number };
type FieldRun = {
    epoch: number;
    phase: number;
    lastStir: number;
    lastCell: string | null;
    trail: Map<string, Stamp>;
    stirs: Stamp[];
    ripples: Stamp[];
};

export function useHomeGlyphField(input: Readonly<{
    mode: GlyphFieldMode;
    quiet?: readonly GlyphRect[];
    host?: React.RefObject<View | null>;
    nativeTap?: React.RefObject<((x: number, y: number) => void) | null>;
    scrollY?: React.RefObject<number>;
}>) {
    const { mode, quiet, host, nativeTap, scrollY } = input;
    const [epoch, setEpoch] = React.useState<number | null>(null);
    const run = React.useRef<FieldRun | null>(null);
    const restingPhase = React.useRef(0);

    const start = React.useCallback(() => {
        const current = run.current ?? {
            epoch: performance.now(), phase: restingPhase.current, lastStir: 0, lastCell: null,
            trail: new Map<string, Stamp>(), stirs: [], ripples: [],
        };
        if (!run.current) {
            run.current = current;
            setEpoch(current.epoch);
        }
        return current;
    }, []);
    const settle = React.useCallback(() => {
        if (!run.current) return;
        restingPhase.current = run.current.phase + glyphFieldPhase(glyphFieldDurationS);
        run.current = null;
        setEpoch(null);
    }, []);
    React.useEffect(() => {
        if (mode !== 'animated') { settle(); return; }
        start();
        const node = host?.current as unknown as HTMLElement | undefined;
        function stir(x: number, y: number, click: boolean) {
            if (!readHostActivelyViewed()) return;
            const current = start();
            const at = Math.max(0, (performance.now() - current.epoch) / 1000);
            if (click) {
                current.ripples = current.ripples.filter(stamp => at - stamp.at < glyphFieldRippleLifeS);
                current.ripples.push({ x, y, at });
            } else {
                const cell = `${Math.floor(x / glyphFieldTrailCell)}:${Math.floor(y / glyphFieldTrailCell)}`;
                if (cell === current.lastCell) return;
                current.lastCell = cell;
                for (const [key, stamp] of current.trail) if (at - stamp.at >= glyphFieldTrailLifeS) current.trail.delete(key);
                current.trail.set(cell, { x, y, at });
                current.stirs = Array.from(current.trail.values());
            }
            current.phase += glyphFieldPhase(at - current.lastStir);
            current.lastStir = at;
        }
        const move = (event: PointerEvent) => {
            if (event.pointerType === 'touch') return;
            const box = node?.getBoundingClientRect();
            if (box) stir(event.clientX - box.x, event.clientY - box.y + (scrollY?.current ?? 0), false);
        };
        const click = (event: MouseEvent) => {
            if (event.detail === 0) return;
            const box = node?.getBoundingClientRect();
            if (box) stir(event.clientX - box.x, event.clientY - box.y + (scrollY?.current ?? 0), true);
        };
        if (Platform.OS === 'web') {
            node?.addEventListener?.('pointermove', move, { passive: true });
            node?.addEventListener?.('click', click, { passive: true });
        } else if (nativeTap) nativeTap.current = (x, y) => stir(x, y + (scrollY?.current ?? 0), true);
        return () => {
            if (nativeTap) nativeTap.current = null;
            if (Platform.OS === 'web') {
                node?.removeEventListener?.('pointermove', move);
                node?.removeEventListener?.('click', click);
            }
        };
    }, [host, mode, nativeTap, scrollY, settle, start]);

    const layer = React.useCallback((seconds: number): FieldDotLayer | null => {
        if (mode === 'off') return null;
        const current = run.current;
        if (mode === 'still' || !current) return fieldDotLayer({ mode: 'still', quiet, phaseS: restingPhase.current - glyphFieldPhase(glyphFieldDurationS) });
        const elapsedS = Math.max(0, seconds - current.lastStir);
        return fieldDotLayer({ mode, quiet, phaseS: current.phase, elapsedS, stampTimeS: seconds,
            stirs: current.stirs, ripples: current.ripples });
    }, [mode, quiet]);
    const readDurationS = React.useCallback(() => (run.current?.lastStir ?? 0) + glyphFieldDurationS, []);
    return { epoch, layer, readDurationS, settle };
}
