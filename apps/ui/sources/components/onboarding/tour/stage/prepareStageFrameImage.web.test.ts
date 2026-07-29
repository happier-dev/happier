import { describe, expect, it, vi } from 'vitest';

import { decodeStageFrameImage } from './prepareStageFrameImage.web';

describe('decodeStageFrameImage', () => {
    it('pre-decodes the captured PNG before exposing it to camera motion', async () => {
        const decode = vi.fn(async () => undefined);
        const image = { src: '', decode };

        await decodeStageFrameImage('data:image/png;base64,frozen', () => image);

        expect(image.src).toBe('data:image/png;base64,frozen');
        expect(decode).toHaveBeenCalledTimes(1);
    });
});
