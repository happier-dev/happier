import { randomUUID } from 'node:crypto';

import type { SessionImageMediaWriter } from '@/session/media/createSessionImageMediaWriter';

import type { SimulatorPreviewRoutes } from '../previewRoutes.types';
import type { SimulatorDeviceOperations } from './deviceOperations';

export function createSimulatorDeviceOperationRoutes(input: Readonly<{
    previewRoutes: SimulatorPreviewRoutes;
    operations: SimulatorDeviceOperations;
    mediaWriter: SessionImageMediaWriter;
}>): SimulatorPreviewRoutes {
    return {
        ...input.previewRoutes,
        async dispatchDeviceOperation(operation, context) {
            if (operation.operation === 'screenshot') {
                // Agent captures belong to the admitting Session; the caller cannot choose
                // another Session's artifact bucket through Action input.
                const sessionId = context.defaultSessionId?.trim();
                if (sessionId && sessionId !== operation.sessionId) {
                    return { ok: false, errorCode: 'simulator_screenshot_session_mismatch', step: 'screenshot' };
                }
                if (!sessionId && context.authority !== 'present_user') {
                    return { ok: false, errorCode: 'simulator_screenshot_session_required', step: 'screenshot' };
                }
            }
            const result = await input.operations.execute(operation, context.signal);
            if (!result.ok) {
                return { ok: false, errorCode: result.errorCode, step: result.step,
                    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) };
            }
            if (operation.operation !== 'screenshot') {
                return { ok: true, ...(result.device ? { device: result.device } : {}),
                    ...(result.snapshot ? { snapshot: result.snapshot } : {}),
                    ...(result.pressedIdentifier ? { pressedIdentifier: result.pressedIdentifier } : {}) };
            }
            if (!result.png) return { ok: false, errorCode: 'simulator_screenshot_unavailable', step: 'screenshot' };
            const written = await input.mediaWriter.write({ sessionId: operation.sessionId,
                captureId: randomUUID(), png: result.png });
            return written.ok ? { ok: true, media: written.media }
                : { ok: false, errorCode: written.disabledReason ?? written.reason, step: 'screenshot' };
        },
    };
}
