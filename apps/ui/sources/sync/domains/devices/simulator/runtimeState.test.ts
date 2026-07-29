import { describe, expect, it } from 'vitest';

import {
    applySimulatorPreviewDaemonActionResult,
    createSimulatorPreviewDaemonState,
} from './runtimeState';

describe('simulator preview daemon runtime state', () => {
    it('stores accepted sideband request messages by kind', () => {
        const state = applySimulatorPreviewDaemonActionResult(
            createSimulatorPreviewDaemonState(),
            {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_1',
                kind: 'capture_health',
            },
            {
                v: 1,
                eventType: 'simulator.sideband.request',
                status: 'accepted',
                diagnostics: [],
                sideband: {
                    v: 1,
                    simulatorId: 'sim_1',
                    emittedAtMs: 1_000,
                    kind: 'capture_health',
                    status: 'available',
                },
            },
        );

        expect(state.previewStatesBySimulatorId.sim_1?.sidebandsByKind?.capture_health).toMatchObject({
            kind: 'capture_health',
            status: 'available',
        });
    });
});
