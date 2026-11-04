import { describe, expect, it } from 'vitest';
import { resolveCaptureDeliveryOutcome } from './captureDeliveryOutcome';

describe('settled Capture delivery receipts', () => {
    it.each(['send', 'addToDraft', 'newSession'] as const)('keeps applied %s truthful when only cleanup fails', delivery => {
        const delivered = delivery === 'send' ? { captureRef: 'capture', messageRef: 'accepted' }
            : delivery === 'addToDraft' ? { captureRef: 'capture', imageNumber: 3 }
            : { kind: 'opened', seedId: 'seed' };
        expect(resolveCaptureDeliveryOutcome({ delivery: delivery === 'newSession' ? 'addToDraft' : delivery, newSession: delivery === 'newSession', session: 'Session', detail: '/repo', result: {
            windowLabel: 'capture', requestId: 'request', ok: false, errorCode: 'native_failure',
            details: { captureStaged: true, delivered },
        } })).toMatchObject({ ok: true, pill: {
            kind: delivery === 'send' ? 'sent' : delivery === 'addToDraft' ? 'added' : 'started',
            cleanupWarning: 'native_failure', ...(delivery === 'addToDraft' ? { imageNumber: 3 } : {}),
        } });
    });

    it.each(['send', 'addToDraft', 'newSession'] as const)('preserves the failed %s operation and its concrete cause', delivery => {
        expect(resolveCaptureDeliveryOutcome({ delivery: delivery === 'newSession' ? 'addToDraft' : delivery, newSession: delivery === 'newSession', session: 'Session', detail: '/repo', result: {
            windowLabel: 'capture', requestId: 'request', ok: false, errorCode: 'operation_unavailable', error: 'Cannot reach the machine',
        } })).toEqual({ ok: false, phase: 'delivery', cause: 'Cannot reach the machine' });
    });
});
