import type { IrohObservedPath } from './types';

/** Privacy-safe aggregate telemetry for an Iroh carrier instance.
 *
 * The recorder intentionally has no endpoint, account, machine, URL, or payload
 * fields.  Consumers can periodically snapshot and publish these counters through
 * their existing diagnostics sink.
 */
export type IrohTelemetrySnapshot = Readonly<{
  endpointStarts: number;
  endpointStops: number;
  tunnelStarts: number;
  tunnelStops: number;
  streamsOpened: number;
  streamsRejected: number;
  bytesByPath: Readonly<Record<IrohObservedPath, number>>;
  pathTransitions: number;
  failures: Readonly<Record<string, number>>;
  httpsFallbacks: number;
}>;

const PATHS: readonly IrohObservedPath[] = ['direct', 'relay', 'unknown'];

export function createIrohTelemetryRecorder() {
  let endpointStarts = 0;
  let endpointStops = 0;
  let tunnelStarts = 0;
  let tunnelStops = 0;
  let streamsOpened = 0;
  let streamsRejected = 0;
  let pathTransitions = 0;
  let httpsFallbacks = 0;
  let lastPath: IrohObservedPath | null = null;
  const bytesByPath: Record<IrohObservedPath, number> = { direct: 0, relay: 0, unknown: 0 };
  const failures = new Map<string, number>();

  return {
    endpointStarted() { endpointStarts += 1; },
    endpointStopped() { endpointStops += 1; },
    tunnelStarted() { tunnelStarts += 1; },
    tunnelStopped() { tunnelStops += 1; },
    streamOpened() { streamsOpened += 1; },
    streamRejected() { streamsRejected += 1; },
    pathObserved(path: IrohObservedPath) {
      if (lastPath !== null && lastPath !== path) pathTransitions += 1;
      lastPath = path;
    },
    bytesTransferred(path: IrohObservedPath, bytes: number) {
      if (!Number.isFinite(bytes) || bytes < 0) return;
      bytesByPath[path] += Math.floor(bytes);
    },
    failure(reason: string) {
      const key = reason.trim().slice(0, 64);
      if (!key) return;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    },
    httpsFallback() { httpsFallbacks += 1; },
    snapshot(): IrohTelemetrySnapshot {
      const failureSnapshot: Record<string, number> = {};
      for (const [key, value] of failures) failureSnapshot[key] = value;
      return {
        endpointStarts,
        endpointStops,
        tunnelStarts,
        tunnelStops,
        streamsOpened,
        streamsRejected,
        bytesByPath: Object.fromEntries(PATHS.map((path) => [path, bytesByPath[path]])) as Record<IrohObservedPath, number>,
        pathTransitions,
        failures: failureSnapshot,
        httpsFallbacks,
      };
    },
    reset() {
      endpointStarts = 0;
      endpointStops = 0;
      tunnelStarts = 0;
      tunnelStops = 0;
      streamsOpened = 0;
      streamsRejected = 0;
      pathTransitions = 0;
      httpsFallbacks = 0;
      lastPath = null;
      bytesByPath.direct = 0;
      bytesByPath.relay = 0;
      bytesByPath.unknown = 0;
      failures.clear();
    },
  };
}
