export const RA21_MEASUREMENT_ARTIFACT_NAME: 'ra21-runtime-limit-measurement.v1.json';

export type RuntimeLimitMeasurementCapture = Readonly<{
  recordEnvelope(params: Readonly<{
    direction: 'send' | 'event';
    family: string;
    decodedValue?: unknown;
    decodedBytes?: number;
    encodedValue?: string | Uint8Array | ArrayBuffer;
    encodedBytes?: number;
    itemCount?: number;
    itemCountStats?: Readonly<{
      samples: number;
      min: number;
      max: number;
      total: number;
    }>;
  }>): void;
  recordQueueSample(params: Readonly<{
    family: string;
    queuedItems: number;
    queuedBytes: number;
    backpressured?: boolean;
    sequence?: number;
    expectedFirstSequence?: number;
    sequenceBasis?: 'source' | 'observer';
  }>): void;
  finishQueueFamily(params: Readonly<{ family: string; expectedLastSequence: number }>): void;
  recordPhaseSample(params: Readonly<{
    surface: 'host' | 'ui';
    phase: string;
    family: string;
    durationMs: number;
    memoryBytes?: number;
    stallMs?: number;
  }>): void;
  snapshot(): unknown;
  writeArtifact(params: Readonly<{ artifactDir: string }>): Promise<unknown>;
}>;

export function createRuntimeLimitMeasurementCapture(options: Readonly<{
  provenance: Readonly<{
    runId: string;
    runnerId: string;
    providerId: string;
    scenarioId: string;
    buildId: string;
    platformId: string;
  }>;
  maxFamilies?: number;
}>): RuntimeLimitMeasurementCapture;

export function createRuntimeLimitMeasurementCaptureFromEnv(params: Readonly<{
  env: NodeJS.ProcessEnv;
  runnerId: string;
  scenarioId: string;
}>): Readonly<{ artifactDir: string; capture: RuntimeLimitMeasurementCapture }> | null;

export function recordJsonlTraceMeasurements(
  capture: RuntimeLimitMeasurementCapture | null,
  params: Readonly<{
    traceRaw: string;
    traceEvents: readonly unknown[];
    decodeDurationMs: number;
  }>,
): void;

export function recordHostRuntimeLimitMeasurement(
  capture: RuntimeLimitMeasurementCapture,
  sample:
    | Readonly<{
        family: string;
        decodedBytes: number;
        itemCount: number;
      }>
    | Readonly<{
        family: string;
        queuedItems: number;
        queuedBytes: number;
        backpressured: boolean;
        sequence?: number;
      }>,
): void;

export function recordAgentBrowserPerfMeasurements(
  capture: RuntimeLimitMeasurementCapture,
  results: readonly unknown[],
): void;

export function recordWebMemoryProfileMeasurements(
  capture: RuntimeLimitMeasurementCapture,
  summary: unknown,
): void;
