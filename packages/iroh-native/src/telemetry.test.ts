import { describe, expect, it } from 'vitest';
import { createIrohTelemetryRecorder } from './telemetry';

describe('Iroh telemetry recorder', () => {
  it('aggregates path/byte/failure counters without retaining identifiers', () => {
    const recorder = createIrohTelemetryRecorder();
    recorder.endpointStarted();
    recorder.tunnelStarted();
    recorder.streamOpened();
    recorder.pathObserved('direct');
    recorder.bytesTransferred('direct', 12.8);
    recorder.pathObserved('relay');
    recorder.bytesTransferred('relay', 8);
    recorder.failure('relay_auth_failed');
    recorder.httpsFallback();

    expect(recorder.snapshot()).toEqual({
      endpointStarts: 1,
      endpointStops: 0,
      tunnelStarts: 1,
      tunnelStops: 0,
      streamsOpened: 1,
      streamsRejected: 0,
      bytesByPath: { direct: 12, relay: 8, unknown: 0 },
      pathTransitions: 1,
      failures: { relay_auth_failed: 1 },
      httpsFallbacks: 1,
    });
    expect(JSON.stringify(recorder.snapshot())).not.toContain('endpoint-secret');
  });
});
