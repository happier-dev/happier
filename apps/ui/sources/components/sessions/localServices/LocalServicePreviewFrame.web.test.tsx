import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

type PreviewFrameModule = typeof import('./LocalServicePreviewFrame.web');

async function loadPreviewFrameModule(): Promise<PreviewFrameModule | null> {
    return import('./LocalServicePreviewFrame.web').catch(() => null);
}

describe('LocalServicePreviewFrame web sandbox', () => {
    it('does not grant same-origin privileges to path-mode preview URLs', async () => {
        const mod = await loadPreviewFrameModule();

        expect(mod?.LocalServicePreviewFrame).toBeTypeOf('function');
        if (!mod) return;

        const screen = await renderScreen(
            <mod.LocalServicePreviewFrame
                title="Preview"
                url="https://app.happier.test/v1/local-services/preview/preview_1/"
                testID="local-preview-frame"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(String(iframe.props.sandbox)).toContain('allow-scripts');
        expect(String(iframe.props.sandbox)).not.toContain('allow-same-origin');
    });

    it('keeps same-origin privileges available for dedicated host-origin preview URLs', async () => {
        const mod = await loadPreviewFrameModule();

        expect(mod?.LocalServicePreviewFrame).toBeTypeOf('function');
        if (!mod) return;

        const screen = await renderScreen(
            <mod.LocalServicePreviewFrame
                title="Preview"
                url="https://preview-1.preview.happier.test/dashboard"
                testID="local-preview-frame"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(String(iframe.props.sandbox)).toContain('allow-same-origin');
    });
});
