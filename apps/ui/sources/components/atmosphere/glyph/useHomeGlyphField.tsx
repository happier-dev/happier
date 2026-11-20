import * as React from 'react';
import { Platform, type GestureResponderEvent, type View } from 'react-native';
import {
    fieldDotLayer, glyphFieldDurationS, glyphFieldPhase, glyphFieldRippleLifeS, glyphFieldTrailCell, glyphFieldTrailLifeS,
    type FieldDotLayer, type GlyphFieldMode,
} from '@happier-dev/brand/glyph-scene';
import { measureInWindow } from '@/components/ui/popover/measure';
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
type GlyphFieldTap = (x: number, y: number) => void;
type FieldRun = {
    epoch: number;
    phase: number;
    lastStir: number;
    lastCell: string | null;
    trail: Map<string, Stamp>;
    stirs: Stamp[];
    ripples: Stamp[];
};

/** The native host receives touch events from its whole painted area, including foreground controls. */
export function useGlyphFieldTap(host: React.RefObject<View | null>) {
    const tap = React.useRef<GlyphFieldTap | null>(null);
    const onTouchEnd = React.useCallback((event: GestureResponderEvent) => {
        const send = tap.current;
        if (!send) return;
        const { pageX, pageY } = event.nativeEvent;
        void measureInWindow(host.current).then(box => {
            if (box && tap.current === send) send(pageX - box.x, pageY - box.y);
        });
    }, [host]);
    return { tap, onTouchEnd: Platform.OS === 'web' ? undefined : onTouchEnd };
}

function advanceStir(run: FieldRun, at: number) {
    run.phase += glyphFieldPhase(at - run.lastStir);
    run.lastStir = at;
}

export function useHomeGlyphField(input: Readonly<{
    mode: GlyphFieldMode;
    arriving: boolean;
    arrivalEpoch?: number;
    quiet?: FieldDotLayer['quiet'];
    /** How strongly the field shows (Brand `homeFieldStrength`), and the planet it gives way around. */
    strength?: number;
    planet?: Readonly<{ cx: number; cy: number; R: number }>;
    host?: React.RefObject<View | null>;
    nativeTap?: React.RefObject<GlyphFieldTap | null>;
    scrollY?: React.RefObject<number>;
    canStir?: () => boolean;
}>) {
    const { mode, arriving, arrivalEpoch, quiet, host, nativeTap, scrollY, strength, planet, canStir } = input;
    const [epoch, setEpoch] = React.useState<number | null>(null);
    const run = React.useRef<FieldRun | null>(null);
    const restingPhase = React.useRef(0);

    const start = React.useCallback((at = performance.now()) => {
        const current = run.current ?? {
            epoch: at, phase: restingPhase.current, lastStir: 0, lastCell: null,
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
    const canWake = React.useCallback(() => readHostActivelyViewed() && (canStir?.() ?? true), [canStir]);
    const stir = React.useCallback(() => {
        if (mode !== 'animated' || !canWake()) return null;
        const now = performance.now();
        const current = start(now);
        const at = Math.max(0, (now - current.epoch) / 1000);
        advanceStir(current, at);
        return at;
    }, [canWake, mode, start]);
    React.useEffect(() => {
        if (mode !== 'animated') { settle(); return; }
        if (arriving) start(arrivalEpoch);
        const node = host?.current as unknown as HTMLElement | undefined;
        function stamp(x: number, y: number, click: boolean) {
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
            advanceStir(current, at);
        }
        const move = (event: PointerEvent) => {
            if (event.pointerType === 'touch' || !canWake()) return;
            const box = node?.getBoundingClientRect();
            if (box) stamp(event.clientX - box.x, event.clientY - box.y + (scrollY?.current ?? 0), false);
        };
        const click = (event: MouseEvent) => {
            if (event.detail === 0 || !canWake()) return;
            const box = node?.getBoundingClientRect();
            if (box) stamp(event.clientX - box.x, event.clientY - box.y + (scrollY?.current ?? 0), true);
        };
        if (Platform.OS === 'web') {
            node?.addEventListener?.('pointermove', move, { passive: true });
            node?.addEventListener?.('click', click, { passive: true });
        } else if (nativeTap) nativeTap.current = (x, y) => {
            if (canWake()) stamp(x, y + (scrollY?.current ?? 0), true);
        };
        return () => {
            if (nativeTap) nativeTap.current = null;
            if (Platform.OS === 'web') {
                node?.removeEventListener?.('pointermove', move);
                node?.removeEventListener?.('click', click);
            }
        };
    }, [arriving, arrivalEpoch, canWake, host, mode, nativeTap, scrollY, settle, start]);

    const layer = React.useCallback((seconds: number, posedPlanet = planet): FieldDotLayer | null => {
        if (mode === 'off') return null;
        const current = run.current;
        if (mode === 'still' || !current) return fieldDotLayer({ mode: 'still', quiet, strength, planet: posedPlanet, phaseS: restingPhase.current - glyphFieldPhase(glyphFieldDurationS) });
        const elapsedS = Math.max(0, seconds - current.lastStir);
        return fieldDotLayer({ mode, quiet, strength, planet: posedPlanet, phaseS: current.phase, elapsedS, stampTimeS: seconds,
            stirs: current.stirs, ripples: current.ripples });
    }, [mode, planet, quiet, strength]);
    const readDurationS = React.useCallback(() => (run.current?.lastStir ?? 0) + glyphFieldDurationS, []);
    return { epoch, layer, readDurationS, settle, stir };
}
