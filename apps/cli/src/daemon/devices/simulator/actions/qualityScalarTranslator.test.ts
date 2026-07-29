import { describe, expect, it } from 'vitest';

import {
    isSimulatorQualityScalarRuntimeActionId,
    translateSimulatorQualityScalarRuntimeAction,
} from './qualityScalarTranslator';

describe('simulator quality scalar translator (X3 fps/scale → set_quality fold)', () => {
    it('recognizes only the fps.set / scale.set scalar runtime actions', () => {
        expect(isSimulatorQualityScalarRuntimeActionId('devices.simulator.stream.fps.set')).toBe(true);
        expect(isSimulatorQualityScalarRuntimeActionId('devices.simulator.stream.scale.set')).toBe(true);
        expect(isSimulatorQualityScalarRuntimeActionId('devices.simulator.stream.quality.set')).toBe(false);
        expect(isSimulatorQualityScalarRuntimeActionId('devices.simulator.stream.keyframe')).toBe(false);
    });

    it('folds an fps scalar into a single set_quality sideband carrying maxFramesPerSecond', () => {
        const event = translateSimulatorQualityScalarRuntimeAction({
            actionId: 'devices.simulator.stream.fps.set',
            scalar: { simulatorId: 'sim_1', streamId: 'stream_1', sourceId: 'source_1', value: 24 },
            createEventId: () => 'event_fps',
        });

        expect(event.type).toBe('simulator.quality.set');
        expect(event).toMatchObject({
            type: 'simulator.quality.set',
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            control: {
                v: 1,
                kind: 'set_quality',
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'event_fps',
                maxFramesPerSecond: 24,
            },
        });
        // fps does NOT set a resolution cap.
        expect(event.control).not.toHaveProperty('maxWidth');
        expect(event.control).not.toHaveProperty('maxHeight');
    });

    it('folds a scale scalar into a single set_quality sideband as a longest-edge cap', () => {
        const event = translateSimulatorQualityScalarRuntimeAction({
            actionId: 'devices.simulator.stream.scale.set',
            scalar: { simulatorId: 'sim_1', streamId: 'stream_1', sourceId: 'source_1', value: 720 },
            createEventId: () => 'event_scale',
        });

        expect(event.control).toMatchObject({
            kind: 'set_quality',
            maxWidth: 720,
            maxHeight: 720,
        });
        // scale does NOT set a frame-rate cap.
        expect(event.control).not.toHaveProperty('maxFramesPerSecond');
    });

    it('rounds and clamps the scalar to the positive-integer the set_quality control requires', () => {
        const event = translateSimulatorQualityScalarRuntimeAction({
            actionId: 'devices.simulator.stream.fps.set',
            scalar: { simulatorId: 'sim_1', streamId: 'stream_1', sourceId: 'source_1', value: 0.4 },
            createEventId: () => 'event_fps',
        });

        expect(event.control).toMatchObject({ kind: 'set_quality', maxFramesPerSecond: 1 });
    });
});
