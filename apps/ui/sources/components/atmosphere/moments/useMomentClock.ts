import * as React from 'react';
import { glyphDigitStepS } from '@happier-dev/brand/glyph-scene';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { readHostActivelyFocused, readHostActivelyViewed, subscribeToHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import type { GlyphMotion, GlyphSurfaceReadiness, GlyphViewport } from '../glyph/glyphSurfaceTypes';

const digitStepMs = glyphDigitStepS * 1000;

/** Paints directly. Presentation and digit time share one scheduler. */
export function useGlyphClock(
    motion: GlyphMotion,
    readiness: GlyphSurfaceReadiness | null,
    paint: (seconds: number, digitSeconds: number) => void,
    warmWhenHidden = false,
    viewport?: GlyphViewport,
    digitCadence = false,
): void {
    const presentation = useLayoutPresentationSignal();
    const settledEpoch = React.useRef<number | null>(null);
    const digitTimeMs = React.useRef(0);
    const elapsedTime = React.useRef(0);
    const hiddenWarm = React.useRef<GlyphSurfaceReadiness | null>(null);
    React.useEffect(() => {
        let scheduled: (() => void) | undefined;
        let digitStart: number | undefined;
        const digitTimeAt = (now: number) => digitTimeMs.current + (digitStart === undefined ? 0 : Math.max(0, now - digitStart));
        const draw = (seconds: number, now = performance.now()) => paint(seconds, digitTimeAt(now) / 1000);
        const stop = () => {
            scheduled?.();
            scheduled = undefined;
            digitTimeMs.current = digitTimeAt(performance.now());
            digitStart = undefined;
        };
        const digitsAtRest = (seconds: number) => {
            if (digitStart === undefined) return;
            const rest = () => {
                const interval = setInterval(() => draw(seconds), digitStepMs);
                scheduled = () => clearInterval(interval);
            };
            const untilStep = Math.ceil(digitStepMs - digitTimeAt(performance.now()) % digitStepMs);
            if (untilStep === digitStepMs) rest();
            else {
                const timer = setTimeout(() => { draw(seconds); rest(); }, untilStep);
                scheduled = () => clearTimeout(timer);
            }
        };
        const animate = (sample: (now: number) => boolean) => {
            let frame = requestAnimationFrame(tick);
            function tick(now: number) {
                if (sample(now)) frame = requestAnimationFrame(tick);
            }
            scheduled = () => cancelAnimationFrame(frame);
        };
        const resume = () => {
            stop();
            const presented = readHostActivelyViewed() && presentation.get();
            const inViewport = viewport?.get();
            const visible = presented && inViewport !== 'hidden';
            if (!readiness) { hiddenWarm.current = null; return; }
            if (!presented && warmWhenHidden) {
                if (hiddenWarm.current !== readiness) {
                    hiddenWarm.current = readiness;
                    draw(0);
                }
                return;
            }
            if (visible && inViewport !== 'backdrop' && readiness === 'ready' && digitCadence && readHostActivelyFocused()) digitStart = performance.now();

            if (!motion) {
                if (visible) { draw(0); digitsAtRest(0); }
                return;
            }
            if (motion.kind === 'elapsed') {
                if (!visible || motion.paused || readiness === 'still') return;
                let last = performance.now();
                const end = motion.durationS;
                if (elapsedTime.current >= end) return;
                draw(elapsedTime.current, last);
                animate(now => {
                    elapsedTime.current = Math.min(end, elapsedTime.current + Math.max(0, now - last) / 1000);
                    last = now;
                    draw(elapsedTime.current, now);
                    return elapsedTime.current < end;
                });
                return;
            }
            const duration = () => (motion.kind === 'field-calm' ? motion.readDurationS?.() : undefined) ?? motion.durationS;
            const finish = () => {
                if (settledEpoch.current === motion.epoch) return;
                settledEpoch.current = motion.epoch;
                motion.onSettled?.();
            };
            const elapsedAt = (now: number) => Math.max(0, (now - motion.epoch) / 1000);
            const now = performance.now();
            const end = duration();
            if (!visible || readiness === 'still' || settledEpoch.current === motion.epoch || elapsedAt(now) >= end) {
                if (visible) draw(end, now);
                finish();
                if (visible) digitsAtRest(end);
                return;
            }
            draw(elapsedAt(now), now);
            animate(now => {
                const seconds = elapsedAt(now);
                const end = duration();
                draw(Math.min(seconds, end), now);
                if (seconds < end) return true;
                finish();
                digitsAtRest(end);
                return false;
            });
        };
        resume();
        const unsubscribePresentation = presentation.subscribe(resume);
        const unsubscribeHost = subscribeToHostActivelyViewed(resume);
        const unsubscribeViewport = viewport?.subscribe(resume);
        return () => { stop(); unsubscribePresentation(); unsubscribeHost(); unsubscribeViewport?.(); };
    }, [motion, readiness, paint, presentation, warmWhenHidden, viewport, digitCadence]);
}
