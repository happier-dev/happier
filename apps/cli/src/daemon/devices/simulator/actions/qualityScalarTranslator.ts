import {
    createSimulatorPreviewSetQualityEventV1,
    type SimulatorPreviewActionV1,
} from '@happier-dev/protocol';

/**
 * The two encoder-reconfiguration runtime actions whose public input is a bare positive SCALAR
 * (`{ simulatorId, streamId, sourceId, value }`) rather than a full `simulator.quality.set` event.
 */
export type SimulatorQualityScalarRuntimeActionId =
    | 'devices.simulator.stream.fps.set'
    | 'devices.simulator.stream.scale.set';

export type SimulatorQualityScalarInput = Readonly<{
    simulatorId: string;
    streamId: string;
    sourceId: string;
    value: number;
}>;

const QUALITY_SCALAR_RUNTIME_ACTION_IDS: ReadonlySet<string> = new Set<SimulatorQualityScalarRuntimeActionId>([
    'devices.simulator.stream.fps.set',
    'devices.simulator.stream.scale.set',
]);

export function isSimulatorQualityScalarRuntimeActionId(
    actionId: string,
): actionId is SimulatorQualityScalarRuntimeActionId {
    return QUALITY_SCALAR_RUNTIME_ACTION_IDS.has(actionId);
}

/**
 * Fold an `fps.set` / `scale.set` stream-control SCALAR into the single `set_quality` sideband the
 * simulator producer actually backs (X3).
 *
 * scrcpy runs raw_stream with the H.264 encoder configured at server launch, so there is no in-band
 * fps/resolution control channel. The Android scrcpy server-restart producer
 * (`android/restartProducer.ts`) exposes exactly ONE encoder-reconfiguration sink — `setQuality`,
 * implemented by `mergeEncoder`, which carries bitrate, fps, and a longest-edge resolution cap. There
 * is NO separate `setFps` / `setScale` producer method (the prior backing doc misnamed them). fps and
 * scale are dimensions of the SAME `set_quality` control, so this translator maps each scalar runtime
 * action onto that one sideband:
 *   - `fps.set`   → `set_quality.maxFramesPerSecond`
 *   - `scale.set` → `set_quality.maxWidth` = `maxHeight` (a longest-edge cap; `mergeEncoder` collapses
 *                   `max(maxWidth, maxHeight)` into scrcpy's single `max_size`)
 *
 * The control schema requires positive integers, so the scalar is rounded and clamped to `>= 1`.
 */
export function translateSimulatorQualityScalarRuntimeAction(input: Readonly<{
    actionId: SimulatorQualityScalarRuntimeActionId;
    scalar: SimulatorQualityScalarInput;
    createEventId: (kind: string) => string;
}>): Extract<SimulatorPreviewActionV1, { type: 'simulator.quality.set' }> {
    const { simulatorId, streamId, sourceId, value } = input.scalar;
    const eventId = input.createEventId('quality');
    const magnitude = Math.max(1, Math.round(value));

    const control = input.actionId === 'devices.simulator.stream.fps.set'
        ? {
            v: 1 as const,
            streamId,
            sourceId,
            eventId,
            kind: 'set_quality' as const,
            maxFramesPerSecond: magnitude,
        }
        : {
            v: 1 as const,
            streamId,
            sourceId,
            eventId,
            kind: 'set_quality' as const,
            maxWidth: magnitude,
            maxHeight: magnitude,
        };

    return createSimulatorPreviewSetQualityEventV1({ simulatorId, streamId, sourceId, control });
}
