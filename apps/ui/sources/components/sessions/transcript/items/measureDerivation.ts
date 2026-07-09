import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

export function measureTranscriptDerivation<T>(
    name: string,
    buildFields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, buildFields(), fn);
}
