import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { LocalPreviewTarget } from './LocalPreviewTarget.web';

describe('LocalPreviewTarget web', () => {
    it('keeps path-mode previews sandboxed without same-origin privileges', async () => {
        const screen = await renderScreen(
            <LocalPreviewTarget
                title="Preview"
                url="https://app.happier.test/v1/local-services/preview/preview_1/"
                testID="local-preview"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.sandbox).toContain('allow-scripts');
        expect(iframe.props.sandbox).not.toContain('allow-same-origin');
    });

    it('allows same-origin only for dedicated host-origin previews', async () => {
        const screen = await renderScreen(
            <LocalPreviewTarget
                title="Preview"
                url="https://preview-1.preview.happier.test/dashboard"
                testID="local-preview"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.sandbox).toContain('allow-same-origin');
    });
});
