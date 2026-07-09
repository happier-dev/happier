import { describe, expect, it } from 'vitest';

import { resolveNativeSettledReturnAnchorCaptureEffects } from './nativeSettledReturnAnchorCapture';

describe('native settled return anchor capture', () => {
    it('emits a pinned anchor-capture effect for the current session', () => {
        expect(resolveNativeSettledReturnAnchorCaptureEffects({
            sessionId: 'session-a',
        })).toEqual([
            {
                sessionId: 'session-a',
                type: 'capture-native-settled-return-anchor',
                viewportState: {
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            },
        ]);
    });
});
