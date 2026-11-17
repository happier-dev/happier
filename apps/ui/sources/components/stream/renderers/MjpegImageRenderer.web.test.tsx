import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

describe('MjpegImageRenderer web', () => {
    it('revokes replaced and unmounted object URLs while leaving data URLs alone', async () => {
        const mod = await import('./MjpegImageRenderer.web').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('MjpegImageRenderer');
        if (!('MjpegImageRenderer' in mod)) return;

        const originalUrl = globalThis.URL;
        const revokeObjectURL = vi.fn();
        Object.defineProperty(globalThis, 'URL', {
            configurable: true,
            value: {
                ...(originalUrl ?? {}),
                revokeObjectURL,
            },
        });

        try {
            const screen = await renderScreen(
                <mod.MjpegImageRenderer
                    frameUrl="blob:frame-1"
                    testID="mjpeg-frame"
                />,
            );

            await screen.update(
                <mod.MjpegImageRenderer
                    frameUrl="data:image/jpeg;base64,AQID"
                    testID="mjpeg-frame"
                />,
            );
            await screen.update(
                <mod.MjpegImageRenderer
                    frameUrl="blob:frame-2"
                    testID="mjpeg-frame"
                />,
            );
            await screen.unmount();

            expect(revokeObjectURL).toHaveBeenCalledTimes(2);
            expect(revokeObjectURL).toHaveBeenNthCalledWith(1, 'blob:frame-1');
            expect(revokeObjectURL).toHaveBeenNthCalledWith(2, 'blob:frame-2');
        } finally {
            Object.defineProperty(globalThis, 'URL', {
                configurable: true,
                value: originalUrl,
            });
        }
    });
});

describe('MjpegImageRenderer accessible name', () => {
    it('names the live frame it draws, so the picture is not an unnamed image (C77 role-img-alt)', async () => {
        const { t } = await import('@/text');
        const { MjpegImageRenderer } = await import('./MjpegImageRenderer.shared');
        const screen = await renderScreen(<MjpegImageRenderer frameUrl="data:image/jpeg;base64,AQID" testID="mjpeg-frame" />);
        expect(screen.findByTestId('mjpeg-frame')?.props.accessibilityLabel).toBe(t('streamPlayer.frameAccessibilityLabel'));
        await screen.unmount();
    });
});
