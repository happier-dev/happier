import * as React from 'react';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/**
 * A moment's own clock, in seconds since it started: it advances once per display frame while the
 * moment runs, holds while it is paused (hidden window, nothing in progress), and stops for good once
 * the moment no longer runs. Frames are the display's; the moment's times come from the brand.
 */
export function useMomentClock(running: boolean, paused: boolean, holdAfter?: number): number {
  const presentedSignal = useLayoutPresentationSignal();
  const [seconds, setSeconds] = React.useState(0);
  const elapsed = React.useRef(0);
  React.useEffect(() => {
    // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
    const start = (presented: boolean): (() => void) | void => {
      if (!running || paused || !presented || (holdAfter !== undefined && elapsed.current > holdAfter)) return;
      let last = performance.now();
      let frame = requestAnimationFrame(function tick(now) {
        elapsed.current += Math.max(0, now - last) / 1000;
        last = now;
        setSeconds(elapsed.current);
        // A reduced-motion loader holds once the grace has passed; readiness resumes this same clock.
        if (holdAfter === undefined || elapsed.current <= holdAfter) frame = requestAnimationFrame(tick);
      });
      return () => cancelAnimationFrame(frame);
    };
    let current = presentedSignal.get();
    let stop = start(current);
    const unsubscribe = presentedSignal.subscribe(() => {
        if (presentedSignal.get() === current) return;
        current = presentedSignal.get();
        stop?.();
        stop = start(current);
    });
    return () => { unsubscribe(); stop?.(); };
  }, [holdAfter, paused, running, presentedSignal]);
  return seconds;
}
