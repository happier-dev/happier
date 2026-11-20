import * as React from 'react';
import { readHostActivelyFocused, readHostActivelyViewed, subscribeToHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import type { GlyphMotion, GlyphSurfaceReadiness } from '../glyph/glyphSurfaceTypes';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/** Paints directly. The epoch belongs to the producer and uses the performance.now() time origin. */
export function useGlyphClock(
    motion: GlyphMotion,
    readiness: GlyphSurfaceReadiness | null,
    paint: (seconds: number) => void,
    warmWhenHidden = false,
): void {
    const presentation = useLayoutPresentationSignal();
    const settledEpoch = React.useRef<number | null>(null);
    const digitTime = React.useRef(0);
    const elapsedTime = React.useRef(0);
    const hiddenWarm = React.useRef<GlyphSurfaceReadiness | null>(null);
    React.useEffect(() => {
        if (!readiness) { hiddenWarm.current = null; return; }
        let scheduled: (() => void) | undefined;
        const stop = () => { scheduled?.(); scheduled = undefined; };
        const resume = () => {
            stop();
            const visible = readHostActivelyViewed() && presentation.get();
            const focused = readHostActivelyFocused();
            if (!visible && warmWhenHidden) {
                if (hiddenWarm.current !== readiness) {
                    hiddenWarm.current = readiness;
                    paint(0);
                }
                return;
            }
            if (!motion) { if (visible) paint(0); return; }
            if (motion.kind === 'digits') {
                if (!visible) return;
                paint(readiness === 'ready' ? digitTime.current : 0);
                if (focused && readiness === 'ready') {
                    const timer = setInterval(() => { digitTime.current += 2; paint(digitTime.current); }, 2000);
                    scheduled = () => clearInterval(timer);
                }
                return;
            }
            if (motion.kind === 'elapsed') {
                if (!visible || motion.paused || readiness === 'still') return;
                let last = performance.now();
                const end = motion.durationS;
                if (elapsedTime.current >= end) return;
                paint(elapsedTime.current);
                let handle = requestAnimationFrame(function tick(now) {
                    elapsedTime.current = Math.min(end, elapsedTime.current + Math.max(0, now - last) / 1000);
                    last = now;
                    paint(elapsedTime.current);
                    if (elapsedTime.current < end) handle = requestAnimationFrame(tick);
                });
                scheduled = () => cancelAnimationFrame(handle);
                return;
            }
            const duration = () => (motion.kind === 'field-calm' ? motion.readDurationS?.() : undefined) ?? motion.durationS;
            const finish = () => {
                if (settledEpoch.current === motion.epoch) return;
                settledEpoch.current = motion.epoch;
                motion.onSettled?.();
            };
            const elapsed = Math.max(0, (performance.now() - motion.epoch) / 1000);
            if (!visible || readiness === 'still' || settledEpoch.current === motion.epoch || elapsed >= duration()) {
                if (visible) paint(duration());
                finish();
                return;
            }
            paint(elapsed);
            let handle = requestAnimationFrame(function tick(now) {
                const time = Math.max(0, (now - motion.epoch) / 1000);
                const end = duration();
                if (time >= end) {
                    paint(end);
                    finish();
                    return;
                }
                paint(time);
                handle = requestAnimationFrame(tick);
            });
            scheduled = () => cancelAnimationFrame(handle);
        };
        resume();
        const unsubscribePresentation = presentation.subscribe(resume);
        const unsubscribeHost = subscribeToHostActivelyViewed(resume);
        return () => { stop(); unsubscribePresentation(); unsubscribeHost(); };
    }, [motion, readiness, paint, presentation, warmWhenHidden]);
}
