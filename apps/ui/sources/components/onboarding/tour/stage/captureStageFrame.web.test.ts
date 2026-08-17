import { describe, expect, it } from 'vitest';

import {
    captureStageFrame,
    releaseStageFrame,
    stageFrameCaptureSupported,
} from './captureStageFrame.web';

describe('stage frame capture on web', () => {
    it('reports the capture seam as unsupported so the stage keeps its live layer', () => {
        expect(stageFrameCaptureSupported).toBe(false);
    });

    it('rejects instead of rasterizing the document when called', async () => {
        await expect(captureStageFrame(null, 'demo-stage-surface-x-capture-source'))
            .rejects.toThrow(/not supported on web/i);
    });

    it('releases a capture without throwing', () => {
        expect(() => releaseStageFrame({ kind: 'image', uri: 'data:image/png;base64,x' })).not.toThrow();
    });
});
