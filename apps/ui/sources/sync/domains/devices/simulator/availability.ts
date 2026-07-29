import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

import type { SimulatorPreviewStreamState, SimulatorPreviewAvailability } from './types';
import type { SimulatorPreviewState } from './store';

export function projectSimulatorPreviewAvailability(input: Readonly<{
    resource: SimulatorDeviceResourceV1 | null;
    previewState: SimulatorPreviewState | null;
    stream: SimulatorPreviewStreamState | null;
}>): SimulatorPreviewAvailability {
    if (!input.resource) {
        return {
            state: 'unavailable',
            reasonCode: 'no_simulator_devices',
        };
    }

    if (input.resource.unavailableReason) {
        return {
            state: 'unavailable',
            reasonCode: input.resource.unavailableReason,
        };
    }

    if (input.resource.capture.status === 'unavailable') {
        return {
            state: 'unavailable',
            reasonCode: input.resource.capture.reasonCode,
        };
    }

    const captureHealth = input.previewState?.sidebandsByKind?.capture_health;
    if (captureHealth?.kind === 'capture_health') {
        if (captureHealth.status === 'unavailable') {
            return {
                state: 'unavailable',
                reasonCode: captureHealth.reasonCode ?? 'capture_unavailable',
            };
        }
        if (captureHealth.status === 'degraded') {
            return {
                state: 'degraded',
                reasonCode: captureHealth.reasonCode ?? 'capture_degraded',
            };
        }
    }

    const stream = input.stream;
    if (stream) {
        if (stream.phase === 'degraded') {
            return {
                state: 'degraded',
                reasonCode: stream.diagnostic?.reasonCode ?? 'stream_degraded',
            };
        }
        if ((stream.phase === 'reconnecting' || stream.phase === 'error' || stream.phase === 'stopped') && stream.lastFrameUrl) {
            return {
                state: 'degraded',
                reasonCode: stream.diagnostic?.reasonCode ?? input.previewState?.reasonCode ?? stream.phase,
            };
        }
        if (stream.phase === 'error' && !stream.lastFrameUrl) {
            return {
                state: 'unavailable',
                reasonCode: stream.diagnostic?.reasonCode ?? 'stream_error',
            };
        }
    }

    if (input.previewState?.phase === 'error' && !input.previewState.lastFrame) {
        return {
            state: 'unavailable',
            reasonCode: input.previewState.reasonCode ?? 'stream_error',
        };
    }

    if (
        input.previewState?.phase === 'reconnecting'
        || input.previewState?.phase === 'error'
        || input.previewState?.phase === 'stopped'
    ) {
        return {
            state: input.previewState.lastFrame ? 'degraded' : 'unavailable',
            reasonCode: input.previewState.reasonCode ?? input.previewState.phase,
        };
    }

    return { state: 'available' };
}
