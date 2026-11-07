import { useEffect, useState } from 'react';
import { usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';

/**
 * Wall-clock time for running durations. It ticks once a second only while `live` is true and the surface is
 * visible; a settled run renders from one fixed reading and schedules nothing.
 */
export function useForgeCiNowMsV1(live: boolean): number {
  const { active } = usePluginSurfaceActivity();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !active) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, active]);
  return nowMs;
}
