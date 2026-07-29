import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

describe('MjpegImageRenderer native', () => {
    it('renders explicit extracted frame URLs instead of relying on multipart image behavior', async () => {
        const mod = await import('./MjpegImageRenderer.native').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('MjpegImageRenderer');
        if (!('MjpegImageRenderer' in mod)) return;

        const screen = await renderScreen(
            <mod.MjpegImageRenderer
                frameUrl="data:image/jpeg;base64,AQID"
                testID="mjpeg-frame"
            />,
        );

        const image = screen.findByTestId('mjpeg-frame');
        expect(image?.props.source).toEqual({ uri: 'data:image/jpeg;base64,AQID' });
        expect(image?.props.src).toBeUndefined();
    });
});
